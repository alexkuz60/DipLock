"""Читающие адаптеры досье: владельцы результатов, никаких новых MNE-вычислений."""

import asyncio
import copy
import hashlib
import json
from datetime import datetime
from typing import Any

from app.core.config import settings
from app.schemas.consilium import (
    ConsiliumEvidence,
    ConsiliumSource,
    ConsiliumSourcesPage,
    SourceKind,
)
from app.services import group_analysis, job_store, recording_store, results_store
from app.services.consilium.store import ConsiliumError, get_case
from app.services.job_manager import job_manager

ANALYTICAL_JOBS = frozenset({
    "preprocess", "spectrum", "dipoles", "dipole_refine", "eloreta", "evoked",
    "spectrogram", "report", "compare",
})
METHOD_WARNING = (
    "Состояние подготовки сигнала относится к этому прогону; общий протокол чистки "
    "между разделами не гарантирован. GOF сравним только внутри полосы."
)


def json_copy(payload: Any) -> Any:
    """Копирует JSON без NaN; даты сериализуются, иные неизвестные типы запрещены."""
    def default(value: Any) -> str:
        if isinstance(value, datetime):
            return value.isoformat()
        raise TypeError("Неподдерживаемое значение материала")

    return json.loads(json.dumps(payload, default=default, ensure_ascii=False, allow_nan=False))


def canonical_bytes(payload: Any) -> bytes:
    """Стабильное представление для хеша и проверки размера."""
    return json.dumps(
        payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False,
    ).encode("utf-8")


def check_members(recording_ids: list[str], allowed: list[str]) -> None:
    """Пара/группа целиком входит в дело; пустое происхождение недопустимо."""
    if not recording_ids or not set(recording_ids) <= set(allowed):
        raise ConsiliumError(400, "Источник содержит запись вне исследования или не имеет происхождения")


def _job_members(record: dict[str, Any]) -> list[str]:
    """Полный состав пары или одна запись из паспорта задачи."""
    meta = record.get("meta") or {}
    ids = meta.get("recording_ids")
    if isinstance(ids, list):
        return [str(value) for value in ids]
    return [str(meta["recording_id"])] if meta.get("recording_id") else []


async def _jobs() -> dict[str, dict[str, Any]]:
    """Диск не ограничен RAM-историей; живая задача приоритетнее старого файла."""
    records = await asyncio.to_thread(job_store.load_records, settings)
    merged = {str(record["job_id"]): record for record in records}
    for job in job_manager.list_jobs():
        live = copy.deepcopy(job.to_record())
        disk = merged.get(job.job_id)
        if disk and "manifest" in disk:
            live["manifest"] = disk["manifest"]
        merged[job.job_id] = live
    return merged


async def _job(job_id: str) -> dict[str, Any] | None:
    """Прямая адресация законченного job через владельцев RAM/диска."""
    try:
        disk = await asyncio.to_thread(job_store.load_record, settings, job_id)
    except ValueError:
        raise ConsiliumError(400, "Некорректный идентификатор задачи") from None
    live = job_manager.get(job_id)
    if live is None:
        return disk
    record = copy.deepcopy(live.to_record())
    if disk and "manifest" in disk:
        record["manifest"] = disk["manifest"]
    return record


async def list_sources(case_id: str, limit: int, offset: int) -> ConsiliumSourcesPage:
    """Каталог конкретных прогонов, без вычисления группового агрегата."""
    case = await get_case(case_id)
    # Владельцы вызывают init_db: Alembic использует общий контекст процесса,
    # одновременные upgrade head здесь недопустимы.
    sql = await results_store.list_research_sources(case.recording_ids)
    groups = await group_analysis.list_research_groups(case.recording_ids)
    jobs = await _jobs()
    recordings = await recording_store.list_research_recordings()
    items = [ConsiliumSource.model_validate(item) for item in sql + groups]
    allowed = set(case.recording_ids)
    for record in jobs.values():
        members = _job_members(record)
        if record.get("kind") not in ANALYTICAL_JOBS or not members or not set(members) <= allowed:
            continue
        available = record.get("status") == "succeeded" and isinstance(record.get("result"), dict)
        items.append(ConsiliumSource(
            kind="job", id=str(record["job_id"]),
            title=f"Задача · {record['kind']} · {record['job_id']}", recording_ids=members,
            created_at=record.get("created_at"), available=available,
            warnings=[] if available else ["Результат не готов, не сохранён или задача неуспешна"],
        ))
    existing = {item["id"] for item in recordings}
    warnings = [f"Связанная запись {rid} недоступна; принятые копии материалов сохранены"
                for rid in case.recording_ids if rid not in existing]
    items.sort(key=lambda item: (str(item.created_at or ""), item.kind, item.id), reverse=True)
    return ConsiliumSourcesPage(total=len(items), items=items[offset:offset + limit], warnings=warnings)


async def capture(kind: SourceKind, source_id: str, allowed: list[str]) -> ConsiliumEvidence:
    """Фиксирует конкретный источник, предупреждения и пробелы без модельных defaults."""
    data: dict[str, Any] | None = None
    warnings = [METHOD_WARNING]
    missing: list[str] = []
    versions: dict[str, str] = {}
    parameters: dict[str, Any] | None = None
    signal_state: str | None = None
    completeness = "full"
    if kind == "job":
        record = await _job(source_id)
        if record is None:
            raise ConsiliumError(404, "Файл задачи недоступен; ранее принятые материалы не изменены")
        check_members(_job_members(record), allowed)
        if record.get("kind") not in ANALYTICAL_JOBS:
            raise ConsiliumError(400, "Этот вид задачи не является аналитическим материалом")
        if record.get("status") != "succeeded" or not isinstance(record.get("result"), dict):
            raise ConsiliumError(409, "Результат задачи не готов или не сохранён")
        payload = record["result"]
        if payload.get("recording_id") and str(payload["recording_id"]) not in _job_members(record):
            raise ConsiliumError(409, "Происхождение результата не совпадает с паспортом задачи")
        data = {"recording_ids": _job_members(record), "payload": payload}
        manifest = record.get("manifest") or {}
        versions = {str(k): str(v) for k, v in (manifest.get("versions") or {}).items()}
        params_sig = (record.get("meta") or {}).get("params_sig")
        parameters = {"params_sig": params_sig} if params_sig else None
        missing.append("structured_parameters")  # repr не притворяется рецептом
        if record["kind"] in {"spectrum", "report", "compare", "evoked", "spectrogram", "eloreta"}:
            completeness = "aggregate"
        if record["kind"] == "spectrogram":
            missing.append("spectrogram_grid")  # payload — метаданные, не DPS2-кэш
        if record["kind"] == "report":
            missing.append("package_points_in_job")  # полный пакет можно принять отдельно из SQL
    elif kind == "session":
        data = await results_store.get_session_research_result(source_id, settings.consilium_source_max_rows)
    elif kind == "analysis":
        try:
            numeric_id = int(source_id)
        except ValueError:
            raise ConsiliumError(400, "Некорректный идентификатор пакета") from None
        data = await results_store.get_analysis_research_result(numeric_id, settings.consilium_source_max_rows)
        missing.append("full_cleaning_recipe")
    else:
        try:
            numeric_id = int(source_id)
        except ValueError:
            raise ConsiliumError(400, "Некорректный идентификатор группы") from None
        members = await group_analysis.research_group_members(numeric_id)
        if members is None:
            raise ConsiliumError(404, "Групповой прогон не найден")
        check_members(members, allowed)
        result = await group_analysis.get_group_analysis(numeric_id, settings)
        if result is not None:
            actual = [str(p["recording_id"]) for p in result["aggregate"]["participants"]]
            check_members(actual, allowed)
            data = {"recording_ids": actual, "payload": result}
            parameters = dict(result["aggregate"]["filters"])
            warnings.append("Зафиксирован текущий агрегат определения группы, не числа первоначального сохранения")
            completeness = "top_n"
    if data is None:
        raise ConsiliumError(404, "Аналитический источник больше недоступен")
    check_members(data["recording_ids"], allowed)
    parameters = data.get("parameters", parameters)
    payload = data["payload"]
    warnings.extend(payload.get("warnings") or [])
    clean = payload.get("clean")
    if isinstance(clean, dict):
        warnings.extend(clean.get("warnings") or [])
    for band in payload.get("bands") or []:
        if isinstance(band, dict):
            warnings.extend(band.get("warnings") or [])
    if kind == "analysis":
        warnings.extend(payload["analysis"].get("warnings") or [])
    if kind == "group":
        warnings.extend(payload["aggregate"].get("warnings") or [])
        warnings.extend(payload["aggregate"].get("notes") or [])
    if not versions:
        missing.append("versions")
    if parameters is None:
        missing.append("parameters")
    missing.append("signal_state")  # не выводим состояние из текущих настроек UI
    missing.append("units_catalog")  # единицы исходных полей сохранены, общего паспорта ещё нет
    normalized = await asyncio.to_thread(json_copy, payload)
    packed = await asyncio.to_thread(canonical_bytes, normalized)
    if len(packed) > settings.consilium_material_max_bytes:
        raise ConsiliumError(413, "Материал превышает лимит размера; данные не были обрезаны")
    return ConsiliumEvidence.model_validate({
        "id": "pending", "revision": 1, "source_kind": kind, "source_id": source_id,
        "recording_ids": data["recording_ids"], "payload": normalized,
        "parameters": await asyncio.to_thread(json_copy, parameters), "signal_state": signal_state,
        "versions": versions, "units": {}, "warnings": list(dict.fromkeys(warnings)),
        "missing": missing, "completeness": completeness, "sha256": hashlib.sha256(packed).hexdigest(),
        "title": f"{kind} · {source_id}", "captured_at": datetime.utcnow(),
    })
