"""Дисковый носитель завершённых задач (A8, этап 6).

До этого этапа ``Job`` жил **только в RAM** (``job_manager``, история 50): при
перезапуске процесса (в dev ``--reload`` делает это на каждое изменение кода)
история пустела, а результат задачи нельзя было открыть — ``GET /jobs/{id}`` и
``/recordings/{id}/{kind}/{job_id}`` отвечали 404. «Список исследований» и
воспроизводимость результатов были невозможны.

Решение (выбор из двух вариантов аудита — сохранять, а не «жить в сессии»):

* завершённая задача (успех или ошибка) пишется в
  ``settings.results_dir/jobs/<job_id>.json`` — примитивы ``Job``, ``meta`` и
  ``result``;
* на старте приложения история поднимается с диска (``JobManager.restore``), и
  ссылки на результат снова работают, пока жива запись, к которой он относится;
* **тяжёлые артефакты по-прежнему в дисковых кэшах** (сетки ``DPS2``, PNG
  топокарт) — в файл задачи идёт только сводка. Результат, который не влезает в
  ``JOB_RESULT_MAX_BYTES``, не сохраняется: задача остаётся в истории с
  ``result_omitted``, а ``result`` отдаётся как ``null`` (UI просит пересчитать).

Файл — **не кэш**: у него нет ключа-сигнатуры, он не участвует в
``cache_clear``/ETag и не «пересчитывается при промахе». Живёт он по TTL записи:
файлы задач исчезнувших записей сносит обход сирот (``services/orphans.py``,
тот же обход, что и для каталогов кэшей), а лишние — по лимиту истории задач.

Запись — через ``cache_store.cache_write``: это единственная в проекте копия
«временный файл + ``os.replace``», и её семантика («сбой логируется и не ломает
работу») для результатов задач верна так же, как для кэшей.
"""
import json
import logging
import os
from collections.abc import Sequence
from datetime import datetime
from typing import Any

from app.core.config import Settings
from app.services.cache_store import cache_path, cache_write

logger = logging.getLogger(__name__)

# Версия формата файла: сменили состав полей — поднимите, старые файлы просто
# не поднимутся в историю (результат всегда можно пересчитать).
RECORD_VERSION = 1

# Подкаталог результатов задач внутри ``results_dir``.
JOBS_SUBDIR = "jobs"

# Ключ-маркер: результат не сохранён (не влез в предел размера).
RESULT_OMITTED_KEY = "result_omitted"


def jobs_dir(cfg: Settings) -> str:
    """Каталог файлов задач (под ``settings.results_dir``, не под кэшем ассетов)."""
    return cache_path(cfg.results_dir, JOBS_SUBDIR)


def job_path(cfg: Settings, job_id: str) -> str:
    """Путь файла задачи.

    ``job_id`` — uuid4 из ``job_manager``, но проверяем его на разделители: путь
    не должен уметь выйти за каталог задач (то же правило, что у ассетов).
    """
    safe_id = "".join(char for char in job_id if char.isalnum() or char in "-_")
    if safe_id != job_id:
        raise ValueError(f"Недопустимый job_id: {job_id!r}")
    return cache_path(jobs_dir(cfg), f"{safe_id}.json")


def _serialize(payload: dict[str, Any]) -> bytes | None:
    """JSON-байты записи; ``None`` — данные не сериализуются (не роняем задачу)."""
    try:
        return json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")
    except (TypeError, ValueError):
        logger.warning("Задача не сериализуется в JSON", exc_info=True)
        return None


def save_record(cfg: Settings, record: dict[str, Any]) -> str | None:
    """Пишет задачу на диск; ``None`` — не сохраняли (выключено, сбой, нет id)."""
    if not cfg.job_store_enabled:
        return None
    job_id = str(record.get("job_id") or "")
    if not job_id:
        return None

    payload = dict(record)
    payload["version"] = RECORD_VERSION
    payload["saved_at"] = datetime.utcnow().isoformat()
    data = _serialize(payload)
    if data is None:
        return None
    if len(data) > cfg.job_result_max_bytes and payload.get("result") is not None:
        # История важнее тяжёлого результата: пишем задачу без него.
        omitted = dict(payload)
        omitted["result"] = None
        omitted[RESULT_OMITTED_KEY] = True
        data = _serialize(omitted)
        if data is None:
            return None
        logger.info(
            "Результат задачи %s не сохранён: результат больше предела %d Б",
            job_id, cfg.job_result_max_bytes,
        )
    if len(data) > cfg.job_result_max_bytes:
        logger.warning("Задача %s не сохранена: файл больше предела размера", job_id)
        return None

    path = job_path(cfg, job_id)
    if not cache_write(path, data, label="Результат задачи"):
        return None
    return path


def load_records(cfg: Settings, limit: int | None = None) -> list[dict[str, Any]]:
    """Файлы задач от старых к новым (``limit`` — только последние N).

    Битый или чужой по версии файл пропускается: результат задачи — не источник
    истины, его всегда можно пересчитать.
    """
    root = jobs_dir(cfg)
    if not os.path.isdir(root):
        return []
    entries: list[tuple] = []
    for name in sorted(os.listdir(root)):
        if not name.endswith(".json"):
            continue
        path = os.path.join(root, name)
        try:
            entries.append((os.path.getmtime(path), name, path))
        except OSError:
            continue
    entries.sort()
    if limit is not None and limit > 0:
        entries = entries[-limit:]

    records: list[dict[str, Any]] = []
    for _, _, path in entries:
        try:
            with open(path, encoding="utf-8") as fh:
                payload = json.load(fh)
        except (OSError, ValueError):
            logger.warning("Файл задачи не читается (%s) — пропущен", path)
            continue
        if not isinstance(payload, dict) or payload.get("version") != RECORD_VERSION:
            continue
        if payload.get("job_id"):
            records.append(payload)
    return records


def prune_records(
    cfg: Settings,
    *,
    known_recording_ids: set[str] | None = None,
    limit: int | None = None,
) -> list[str]:
    """Убирает файлы задач лишних/исчезнувших записей; возвращает их ``job_id``.

    Два повода снести файл (оба — про жизненный цикл данных, а не про размер):

    * задача записи, которой реестр больше не знает (TTL/лимит истории/очистка) —
      ссылка на её результат всё равно ответит 404;
    * история задач сверх ``limit`` — самые старые файлы (в RAM история задач
      тоже ограничена, ``jobs_history_limit``).

    ``known_recording_ids=None`` — обход по записям не делаем (только лимит).
    """
    records = load_records(cfg, limit=None)
    removed: list[str] = []
    kept: list[dict[str, Any]] = []

    for record in records:
        job_id = str(record.get("job_id"))
        recording_id = (record.get("meta") or {}).get("recording_id")
        if (
            known_recording_ids is not None
            and recording_id
            and str(recording_id) not in known_recording_ids
        ):
            removed.append(job_id)
            continue
        kept.append(record)

    if limit is not None and limit > 0 and len(kept) > limit:
        # ``load_records`` отдаёт от старых к новым — режем начало.
        removed.extend(str(record.get("job_id")) for record in kept[: len(kept) - limit])

    for job_id in removed:
        try:
            os.remove(job_path(cfg, job_id))
        except OSError:
            continue
    if removed:
        logger.info("Удалены файлы задач: %d", len(removed))
    return removed


def record_files(cfg: Settings) -> Sequence[str]:
    """Все файлы задач (для диагностики и тестов)."""
    root = jobs_dir(cfg)
    if not os.path.isdir(root):
        return ()
    return tuple(os.path.join(root, name) for name in sorted(os.listdir(root)))
