"""Пакет сессии (zip) и экспорт BIDS/CSV — «пакет данных» исследователя (N40/4.6).

Три выгрузки одной записи, все без новых зависимостей (stdlib + уже
установленный стек):

* **session** — zip «EDF + параметры + результаты»: ``manifest.json``
  (версии среды и отпечатки ассетов), ``passport.json`` (паспорт записи
  с событиями), ``jobs/*.json`` (параметры и результаты задач записи,
  кроме самих пакетов), ``edf/<имя файла>`` — исходный EDF;
* **bids** — минимальная BIDS-структура: ``dataset_description.json``,
  ``participants.tsv``, ``sub-<id>/eeg/*.edf`` + сайдкар ``*_eeg.json``
  + ``*_events.tsv`` (onset/duration/trial_type из паспорта). Имя задачи
  неизвестно — честный лейбл ``task-unknown``, а не выдуманный ``rest``;
* **CSV** — таблица диполей (:func:`dipoles_csv`, RFC 4180) отдельным
  синхронным GET из read-API сессий: экспорт — чтение готовых строк,
  а не расчёт, поэтому задача ему не нужна.

Zip собирается **потоково** (``cache_write_stream``): EDF в память не
грузится целиком. Ключ кэша — входной отпечаток (:func:`bundle_signature`),
поэтому пакет пересобирается при изменении входов. Пакеты ``kind=bundle``
внутрь пакета не входят — архив не несёт сам себя.

Очистка: ``clear_bundle_cache`` из ``_drop_signal_cache``, сироты —
``orphans.RECORDING_CACHE_SUBDIRS``. Воркер кооперативно отменяем (3.2).
"""
import csv
import hashlib
import io
import json
import logging
import os
import time
import zipfile
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any

from app.core.config import Settings
from app.services import job_store, journal
from app.services.asset_versions import asset_versions
from app.services.cache_store import (
    cache_clear,
    cache_path,
    cache_read,
    cache_write_stream,
)
from app.services.recordings import Recording, ensure_record_events
from app.utils.versions import library_versions

logger = logging.getLogger(__name__)

# Форматы пакета: session — полный набор «EDF + параметры + результаты»,
# bids — минимальная BIDS-структура для передачи в другие инструменты.
BUNDLE_FORMATS: tuple[str, ...] = ("session", "bids")

# Версия BIDS в dataset_description.json (спека, а не версия нашего кода).
BIDS_VERSION = "1.9.0"
# Лейбл задачи эксперимента в имени файла BIDS: паспорт задачу не знает.
# Честное «unknown» вместо выдуманного «rest» — исследователь поправит имя.
BIDS_TASK_LABEL = "unknown"

# Версия формата пакета: сменили состав файлов — поднимите (урок A7).
BUNDLE_FORMAT_VERSION = 1


class BundleError(ValueError):
    """Ошибка параметров/сборки пакета — превращается в понятный текст задачи."""


@dataclass(frozen=True)
class BundleParams:
    """Параметры задачи пакета (плоская проекция формы запроса)."""

    format: str = "session"

    def label(self) -> str:
        """Подпись параметров для журнала шагов (тот же стиль, что у стадий)."""
        return f"формат={self.format}"


def _bundle_jobs(cfg: Settings, recording_id: str) -> list[dict[str, Any]]:
    """Файлы задач записи, кроме самих пакетов (архив не несёт сам себя)."""
    return [
        record
        for record in job_store.load_records(cfg)
        if (record.get("meta") or {}).get("recording_id") == recording_id
        and record.get("kind") != "bundle"
    ]


def _edf_stamp(recording: Recording) -> Any:
    """Отпечаток EDF: дайджест из дедупа, иначе размер + mtime файла."""
    if recording.digest:
        return recording.digest
    try:
        stat = os.stat(recording.path)
    except OSError:
        return "missing"
    return [stat.st_size, int(stat.st_mtime)]


def bundle_signature(
    cfg: Settings, recording: Recording, params: BundleParams,
    jobs: Sequence[dict[str, Any]],
) -> str:
    """Входной отпечаток пакета: любое изменение входов — новая сборка.

    Входят формат, EDF, паспорт, список задач (id, вид, время записи,
    отпечаток параметров), версии среды и ассетов: смена окружения или
    новая задача не должны отдать «старый» zip под тем же ETag.
    """
    payload = json.dumps(
        {
            "v": BUNDLE_FORMAT_VERSION,
            "format": params.format,
            "edf": _edf_stamp(recording),
            "passport": recording.meta,
            "jobs": [
                [job.get("job_id"), job.get("kind"), job.get("saved_at"),
                 (job.get("meta") or {}).get("params_sig")]
                for job in jobs
            ],
            "versions": library_versions(),
            "assets": asset_versions(str(cfg.subjects_dir or "")),
        },
        sort_keys=True,
        ensure_ascii=False,
        default=str,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


def bundle_path(cfg: Settings, recording_id: str, signature: str) -> str:
    """Путь zip пакета в дисковом кэше (корень — только из ``settings``)."""
    return cache_path(cfg.cache_dir, "bundles", recording_id, f"{signature}.zip")


def read_bundle_zip(
    cfg: Settings, recording_id: str, signature: str,
) -> tuple[bytes, str] | None:
    """Читает zip из кэша; ``None`` — очищен вместе с записью (пересоберите).

    Цельные байты — осознанный компромисс: пакет читается целиком
    (EDF-пакеты — десятки/сотни МБ, это локальный инструмент).
    """
    data = cache_read(bundle_path(cfg, recording_id, signature))
    if data is None:
        return None
    return data, signature


def clear_bundle_cache(cfg: Settings, recording_id: str) -> None:
    """Чистит zip пакетов записи (вызывается из ``_drop_signal_cache``)."""
    cache_clear(cfg.cache_dir, "bundles", recording_id)


def _bids_label(recording_id: str) -> str:
    """BIDS-лейбл субъекта из recording_id: только alnum (uuid → hex)."""
    label = "".join(char for char in recording_id if char.isalnum())
    if not label:
        raise BundleError("Идентификатор записи не даёт BIDS-лейбл (нет alnum-символов)")
    return label


def _json_bytes(payload: Any) -> bytes:
    """JSON-байты пакета: кириллица читаема, datetime — строкой."""
    return json.dumps(payload, ensure_ascii=False, indent=2, default=str).encode("utf-8")


def _events_tsv(events: Sequence[dict[str, Any]]) -> str:
    """``*_events.tsv``: onset/duration/trial_type (+ источник маркера).

    BIDS-события — **TSV**, поэтому разделитель таб (не запятая ``csv``-дефолта).
    """
    buffer = io.StringIO()
    writer = csv.writer(
        buffer, lineterminator="\r\n", delimiter="\t", quoting=csv.QUOTE_NONE,
    )
    writer.writerow(["onset", "duration", "trial_type", "source"])
    for event in events:
        writer.writerow([
            event.get("onset", ""),
            event.get("duration", ""),
            str(event.get("description", "")).replace("\t", " "),
            event.get("source", ""),
        ])
    return buffer.getvalue()


def _bids_entries(recording: Recording) -> list[tuple[str, bytes]]:
    """Файлы BIDS-выгрузки, кроме EDF (он кладётся в архив отдельно)."""
    label = _bids_label(recording.recording_id)
    subject = f"sub-{label}"
    stem = f"{subject}_task-{BIDS_TASK_LABEL}"
    meta = recording.meta
    entries: list[tuple[str, bytes]] = [
        ("dataset_description.json", _json_bytes({
            "Name": os.path.splitext(recording.filename)[0] or recording.recording_id,
            "BIDSVersion": BIDS_VERSION,
            "DatasetType": "raw",
        })),
        ("participants.tsv", f"participant_id\n{subject}\n".encode()),
        (f"{subject}/eeg/{stem}_eeg.json", _json_bytes({
            "TaskName": BIDS_TASK_LABEL,
            "SamplingFrequency": meta.get("sfreq"),
            "RecordingDuration": meta.get("duration_sec"),
            "ChannelNames": meta.get("channels", []),
            "DipLockRecordingId": recording.recording_id,
            "Note": (
                "Задача эксперимента при экспорте неизвестна — переименуйте "
                f"файл и TaskName (лейбл «{BIDS_TASK_LABEL}»), если задача была"
            ),
        })),
    ]
    events = list(meta.get("events") or [])
    if events:
        entries.append(
            (f"{subject}/eeg/{stem}_events.tsv", _events_tsv(events).encode()),
        )
    return entries


def _session_manifest(
    cfg: Settings, recording: Recording, jobs: Sequence[dict[str, Any]],
) -> dict[str, Any]:
    """Манифест пакета: версии среды, отпечатки ассетов и список задач.

    Версии/ассеты — те же источники, что manifest задачи
    (``services/run_manifest.py``): пакет обязан честно говорить, на чём и
    с какими параметрами посчитаны лежащие внутри результаты.
    """
    return {
        "bundle_format_version": BUNDLE_FORMAT_VERSION,
        "recording_id": recording.recording_id,
        "filename": recording.filename,
        "edf": _edf_stamp(recording),
        "jobs": [
            {
                "job_id": job.get("job_id"),
                "kind": job.get("kind"),
                "params_sig": (job.get("meta") or {}).get("params_sig"),
                "finished_at": job.get("finished_at"),
                "status": job.get("status"),
            }
            for job in jobs
        ],
        "versions": library_versions(),
        "assets": asset_versions(str(cfg.subjects_dir or "")),
    }


def _session_entries(
    cfg: Settings, recording: Recording, jobs: Sequence[dict[str, Any]],
) -> list[tuple[str, bytes]]:
    """Файлы session-пакета, кроме EDF."""
    return [
        ("manifest.json", _json_bytes(_session_manifest(cfg, recording, jobs))),
        ("passport.json", _json_bytes(recording.meta)),
        *[
            (f"jobs/{job['job_id']}.json", _json_bytes(job))
            for job in jobs
            if job.get("job_id")
        ],
    ]


def _edf_arcname(recording: Recording, bundle_format: str) -> str:
    """Внутренний путь EDF в архиве: BIDS-лейбл или оригинал имени файла."""
    if bundle_format == "bids":
        label = _bids_label(recording.recording_id)
        return f"sub-{label}/eeg/sub-{label}_task-{BIDS_TASK_LABEL}_eeg.edf"
    name = recording.filename.replace("\\", "/").split("/")[-1] or "recording.edf"
    return f"edf/{name}"


def run_bundle(
    recording: Recording,
    cfg: Settings,
    params: BundleParams,
    progress: Callable[..., None] | None = None,
) -> dict[str, Any]:
    """Собирает zip пакета в дисковом кэше и возвращает ``BundleResult``.

    Шаги: паспорт (дочитываются события старых сайдкаров) → список задач →
    EDF → потоковая запись zip. Кэш-попадание — те же входы, zip уже на
    диске (журнал фиксирует ``cache_hit``).
    """
    report = progress or (lambda *args, **kwargs: None)
    started = time.perf_counter()

    report("manifest", 0.05, message="Пакет: паспорт и манифест")
    ensure_record_events(recording, cfg)  # старые сайдкары без events
    jobs = _bundle_jobs(cfg, recording.recording_id)
    signature = bundle_signature(cfg, recording, params, jobs)
    path = bundle_path(cfg, recording.recording_id, signature)

    warnings: list[str] = []
    edf_exists = os.path.isfile(recording.path)
    if not edf_exists:
        warnings.append("Файл EDF не найден на диске — пакет собран без данных")

    entries = (
        _bids_entries(recording)
        if params.format == "bids"
        else _session_entries(cfg, recording, jobs)
    )
    edf_arcname = _edf_arcname(recording, params.format)
    files = [name for name, _ in entries] + ([edf_arcname] if edf_exists else [])

    cache_hit = os.path.isfile(path)
    if not cache_hit:
        report("jobs", 0.35, message="Пакет: запись zip (EDF копируется потоково)")

        def _produce(fh: Any) -> None:
            with zipfile.ZipFile(fh, "w") as archive:
                for name, data in entries:
                    # JSON/TSV жмём (маленькие), EDF — как есть: deflate на
                    # сырых сэмплах дорог и даёт мало (близки к случайным)
                    archive.writestr(
                        zipfile.ZipInfo(name), data,
                        compress_type=zipfile.ZIP_DEFLATED,
                    )
                if edf_exists:
                    archive.write(
                        recording.path, edf_arcname,
                        compress_type=zipfile.ZIP_STORED,
                    )

        report("zip", 0.7, message="Пакет: zip на диске")
        if not cache_write_stream(path, _produce, label="Кэш пакета сессии"):
            raise BundleError(
                "Zip пакета не записался на диск — проверьте место в data/cache"
            )

    size = os.path.getsize(path)
    elapsed = (time.perf_counter() - started) * 1000.0
    journal.record(
        "bundle", "build",
        ms=elapsed,
        params_key=params.label(),
        bytes_out=size,
        cache_hit=cache_hit,
        note=f"files={len(files)}",
    )
    logger.info(
        "Пакет %s записи %s: файлов %d, %.1f МБ (%s)",
        params.format, recording.recording_id, len(files),
        size / (1024 * 1024), "кэш" if cache_hit else "сборка",
    )
    return {
        "format": params.format,
        "sig": signature,
        "files": files,
        "size_bytes": size,
        "warnings": warnings,
    }


def dipoles_csv(rows: Sequence[dict[str, Any]]) -> str:
    """CSV таблицы диполей (RFC 4180: CRLF, кавычки по необходимости).

    ``rows`` — строки ``results_store.list_session_dipoles``. Пустой результат
    — честный CSV с одной шапкой («данных нет», а не ошибка). Пустые поля —
    пустые: нет координаты MNI/атрибуции → ``""``, не «None» и не «-»:
    Excel и pandas читают пустоту как отсутствие значения.
    """
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\r\n")
    writer.writerow([
        "session_id", "epoch_id", "time_ms", "freq_band",
        "mni_x", "mni_y", "mni_z",
        "amplitude_nam", "gof", "anatomical_roi", "brodmann_area", "method",
    ])
    for row in rows:
        mni = [*list(row.get("mni") or [None, None, None]), None, None, None]
        writer.writerow([
            row.get("session_id", ""),
            row.get("epoch_id", ""),
            "" if row.get("time_ms") is None else row.get("time_ms"),
            row.get("freq_band") or "",
            "" if mni[0] is None else mni[0],
            "" if mni[1] is None else mni[1],
            "" if mni[2] is None else mni[2],
            "" if row.get("amplitude_nam") is None else row.get("amplitude_nam"),
            "" if row.get("gof") is None else row.get("gof"),
            row.get("anatomical_roi") or "",
            row.get("brodmann_area") or "",
            row.get("method") or "",
        ])
    return buffer.getvalue()
