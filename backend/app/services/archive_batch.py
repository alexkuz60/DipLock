"""Пакетная обработка архива (С8): серия прогонов + отчёт «обработано/ошибки/дубли».

Продуктовый шаг «просмотр одной записи → анализ архива» (``concept.md`` §6 С8):
обход каталога записей → предподготовка/эпохи/расчёты **по снимку параметров**
→ запись в БД → отчёт серии. Инфраструктура была готова (очередь задач,
``job_store``, реестр записей) — здесь появляется планировщик серии.

Устройство серии:

* одна задача ``archive_batch`` обходит записи **последовательно** (серия не
  занимает все слоты параллелизма и не задыхается под собственной очередью);
* расчёт каждой записи — тот же прогон пакета (С1, ``run_dipole_batch``),
  исполняется в потоке (``asyncio.to_thread``), запись в БД — write-API
  ``results_store`` после каждой записи (успешные строки видны read-API 4.7
  ещё до конца серии);
* **дубли** — записи с одинаковым содержимым (``Recording.digest``, sha256):
  повтор файла в серии считается один раз, остальные честно идут в
  «дубли» с указанием, какой записью уже посчитано содержимое;
* отчёт — «обработано / ошибки / дубли» построчно (``ArchiveBatchResult``):
  одна упавшая запись не валит серию, её ошибка — в своей строке.

Прогресс — по номеру записи (сообщение «Запись i из N», доля 0..1).
"""
import asyncio
import time
from dataclasses import dataclass, field
from typing import Any

from app.core.config import Settings
from app.services import journal, results_store
from app.services.dipole_batch import DipoleBatchParams, batch_signature, run_dipole_batch
from app.services.dipole_scanner import DipoleScanError
from app.services.recordings import Recording, recording_registry


class ArchiveBatchError(ValueError):
    """Ошибка параметров серии — понятный текст для задачи."""


@dataclass
class ArchiveBatchParams:
    """Параметры серии (С8): набор записей + снимок параметров расчёта.

    ``recording_ids`` пуст — обрабатывается весь каталог реестра (лимит —
    ``archive_batch_max_recordings``). Снимок ``batch`` один на серию —
    «расчёты по снимку параметров» (``concept.md`` §6 С8): все записи серии
    считаются одинаково, и отпечаток снимка (``params_sig``) в отчёте позволяет
    сверить, чем именно посчитано.
    """

    recording_ids: list[str] = field(default_factory=list)
    batch: DipoleBatchParams = field(
        default_factory=lambda: DipoleBatchParams(bands=[]),
    )


def resolve_series(
    cfg: Settings, recording_ids: list[str],
) -> list[Recording]:
    """Записи серии по id или весь каталог; неизвестный id — ошибка.

    Форма (``api/params.py``) уже проверяет id по реестру; здесь — последний
    рубеж (запись могла устареть между формой и запуском задачи).
    """
    if recording_ids:
        resolved: list[Recording] = []
        missing: list[str] = []
        for recording_id in recording_ids:
            recording = recording_registry.get(recording_id)
            if recording is None:
                missing.append(recording_id)
            else:
                resolved.append(recording)
        if missing:
            raise ArchiveBatchError(
                "Записи не найдены или уже удалены: " + ", ".join(missing)
            )
        return resolved
    catalog = recording_registry.list()
    if len(catalog) > int(cfg.archive_batch_max_recordings):
        raise ArchiveBatchError(
            f"В каталоге {len(catalog)} записей — больше лимита серии "
            f"{cfg.archive_batch_max_recordings}; укажите записи списком"
        )
    return catalog


def _error_item(
    recording: Recording, started: float, error: str,
) -> dict[str, Any]:
    """Строка отчёта серии для упавшей/пропущенной записи."""
    return {
        "recording_id": recording.recording_id,
        "filename": recording.filename,
        "state": "error",
        "duplicate_of": None,
        "n_points": None,
        "n_kd_passed": None,
        "n_bands_ok": None,
        "duration_sec": round(time.perf_counter() - started, 3),
        "error": error,
    }


async def run_archive_batch(
    cfg: Settings,
    params: ArchiveBatchParams,
    progress: Any = None,
) -> dict[str, Any]:
    """Исполняет серию прогонов пакета (С1) и собирает отчёт «обработано/ошибки/дубли».

    Возвращает dict под схему ``ArchiveBatchResult`` (её валидирует API).
    Асинхронный воркер (``job_manager`` исполняет ``async def`` в event-loop):
    тяжёлый расчёт уходит в поток, запись в БД — штатная write-API после
    каждой записи. Одна упавшая запись не валит серию.
    """
    report = progress or (lambda *args, **kwargs: None)
    started = time.perf_counter()
    recordings = resolve_series(cfg, params.recording_ids)
    job_id = journal.current_job_id()
    n_total = len(recordings)

    items: list[dict[str, Any]] = []
    warnings: list[str] = []
    processed_by_digest: dict[str, str] = {}
    processed = errors = duplicates = 0

    for index, recording in enumerate(recordings):
        report(
            "dipoles",
            (index / max(1, n_total)),
            message=f"Запись {index + 1} из {n_total}: {recording.filename}",
        )
        item_started = time.perf_counter()
        digest = recording.digest
        if digest and digest in processed_by_digest:
            # Дубль содержимого (sha256): считать один и тот же файл дважды —
            # ложное «подтверждение» результата; честнее строка «дубль».
            duplicates += 1
            items.append({
                "recording_id": recording.recording_id,
                "filename": recording.filename,
                "state": "duplicate",
                "duplicate_of": processed_by_digest[digest],
                "n_points": None,
                "n_kd_passed": None,
                "n_bands_ok": None,
                "duration_sec": 0.0,
                "error": None,
            })
            continue
        try:
            result = await asyncio.to_thread(
                run_dipole_batch, recording, cfg, params.batch,
            )
            bands = list(result.get("bands") or [])
            if bands and all(b.get("state") == "error" for b in bands):
                # Ни одна полоса не посчиталась — запись в отчёте «ошибка»,
                # а не тихий «processed» с нулём точек.
                first = (bands[0].get("warnings") or ["все полосы пакета дали ошибку"])[0]
                raise DipoleScanError(str(first))
            await results_store.persist_recording_result(
                "dipole_batch", recording, params.batch, result, job_id,
            )
        except (DipoleScanError, ArchiveBatchError, ValueError) as exc:
            errors += 1
            items.append(_error_item(recording, item_started, str(exc)))
            warnings.append(f"{recording.filename}: {exc}")
            continue
        except Exception as exc:  # одна запись не валит серию (текст — в отчёт)
            errors += 1
            items.append(
                _error_item(recording, item_started, f"Неожиданная ошибка расчёта: {exc}"),
            )
            warnings.append(f"{recording.filename}: {exc}")
            continue

        if digest:
            processed_by_digest.setdefault(digest, recording.recording_id)
        processed += 1
        items.append({
            "recording_id": recording.recording_id,
            "filename": recording.filename,
            "state": "processed",
            "duplicate_of": None,
            "n_points": sum(int(b.get("n_points") or 0) for b in bands),
            "n_kd_passed": (
                sum(
                    int(b.get("n_kd_passed") or 0)
                    for b in bands if b.get("n_kd_passed") is not None
                )
                if any(b.get("n_kd_passed") is not None for b in bands) else None
            ),
            "n_bands_ok": sum(1 for b in bands if b.get("state") == "ok"),
            "duration_sec": round(time.perf_counter() - item_started, 3),
            "error": None,
        })

    report(
        "done", 1.0,
        message=(
            f"Серия завершена: обработано {processed}, ошибок {errors}, "
            f"дублей {duplicates}"
        ),
    )
    return {
        "pipeline": "dipole_batch",
        "params_sig": batch_signature(params.batch),
        "requested": [recording.recording_id for recording in recordings],
        "items": items,
        "summary": {
            "total": n_total,
            "processed": processed,
            "errors": errors,
            "duplicates": duplicates,
        },
        "warnings": warnings,
        "duration_sec_calc": round(time.perf_counter() - started, 3),
    }
