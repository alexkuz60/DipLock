"""Строки записей в БД: upsert, каскад «TTL строки = TTL записи», сироты (4.4, шаг ①).

Реестр записей живёт в памяти + в сайдкарах на диске; таблица ``recordings`` —
его долговечное зеркало для связей и истории (B1). Правила:

* **upsert по ``recording_id``** — у записи одна строка, в отличие от прогонов
  (§8.4.2 ``docs/data-blocks.md`` «история, не UPSERT» — про ``report_runs``/
  ``analyses``);
* **каскад при удалении записи** (DELETE-роут, вытеснение лимитом истории,
  обход сирот): ``sessions``/``analyses``/``report_*`` уходят вместе с записью
  (§8.4.3) — в порядке FK, **явными** ``DELETE``: на SQLite внешние ключи по
  умолчанию не проверяются, поэтому рассчитывать на ``ON DELETE CASCADE`` там
  нельзя;
* **чистка строк-сирот** дублирует жизненный цикл ``services/orphans.py``:
  строки без живой записи (каталог на диске исчез) удаляются на старте.

Функции async и поднимают схему до head перед работой (паттерн
``save_analysis_to_db``); исключения не глотаются — решает вызывающий код
(роут / ``on_success`` задачи), для которых запись в БД best-effort.
"""
import logging
import os
from datetime import datetime
from typing import Any

from sqlalchemy import Select, delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.db import (
    Analysis,
    AnalysisBand,
    AsyncSessionLocal,
    Dipole,
    DipolePoint,
    EpochRecord,
    GroupAnalysisMember,
    RecordingRecord,
    ReportBandSummary,
    ReportDynamics,
    ReportNameCount,
    ReportRun,
    Session,
    init_db,
)
from app.services.recordings import Recording, recording_registry

logger = logging.getLogger(__name__)


async def _delete_recording_rows(session: AsyncSession, recording_id: str) -> None:
    """Каскад одной записи: ребёнок → родитель, все таблицы одним коммитом."""
    # Аннотация обязательна для SQLAlchemy >= 2.1 (иначе var-annotated в CI).
    session_ids: Select[Any] = select(Session.id).where(
        Session.recording_id == recording_id
    )
    await session.execute(
        delete(EpochRecord).where(EpochRecord.session_id.in_(session_ids))
    )
    await session.execute(
        delete(Dipole).where(Dipole.session_id.in_(session_ids))
    )
    await session.execute(delete(Session).where(Session.recording_id == recording_id))

    analysis_ids = select(Analysis.id).where(Analysis.recording_id == recording_id)
    await session.execute(
        delete(DipolePoint).where(DipolePoint.analysis_id.in_(analysis_ids))
    )
    await session.execute(
        delete(AnalysisBand).where(AnalysisBand.analysis_id.in_(analysis_ids))
    )
    await session.execute(delete(Analysis).where(Analysis.recording_id == recording_id))

    run_ids = select(ReportRun.id).where(ReportRun.recording_id == recording_id)
    for model in (ReportBandSummary, ReportNameCount, ReportDynamics):
        await session.execute(
            delete(model).where(model.report_run_id.in_(run_ids))
        )
    await session.execute(
        delete(ReportRun).where(ReportRun.recording_id == recording_id)
    )
    await session.execute(
        delete(RecordingRecord).where(RecordingRecord.recording_id == recording_id)
    )
    # Членство в групповых прогонах (остаток 4.7): сам прогон — история и
    # остаётся, состав убывает вместе с записью (§8.4.3, явный DELETE).
    await session.execute(
        delete(GroupAnalysisMember).where(GroupAnalysisMember.recording_id == recording_id)
    )


def _passport(recording: Recording) -> dict[str, object]:
    """Паспорт записи из сайдкара для колонок ``recordings``."""
    meta = recording.meta
    created = meta.get("created_at")
    if isinstance(created, str):
        try:
            created = datetime.fromisoformat(created)
        except ValueError:
            created = None
    return {
        "filename": recording.filename,
        "digest": recording.digest,
        "patient_alias": meta.get("patient_alias"),
        "n_channels": meta.get("n_channels"),
        "sfreq": meta.get("sfreq"),
        "duration_sec": meta.get("duration_sec"),
        "created_at": created,
    }


async def upsert_recording(recording: Recording) -> None:
    """Вставляет или освежает строку записи (дедуп и TTL-касание — сюда же)."""
    await init_db()
    values = _passport(recording)
    values["accessed_at"] = datetime.utcnow()
    if values["created_at"] is None:
        values["created_at"] = values["accessed_at"]
    async with AsyncSessionLocal() as session:
        row = await session.get(RecordingRecord, recording.recording_id)
        if row is None:
            session.add(RecordingRecord(recording_id=recording.recording_id, **values))
        else:
            for name, value in values.items():
                setattr(row, name, value)
        await session.commit()


async def drop_recording_rows(recording_id: str) -> None:
    """Удаляет строку записи и все дочерние строки (каскад §8.4.3)."""
    await init_db()
    async with AsyncSessionLocal() as session:
        await _delete_recording_rows(session, recording_id)
        await session.commit()


def _disk_recording_ids() -> set[str]:
    """Имена каталогов записей на диске (каталог без сайдкара всё ещё живая запись)."""
    root = recording_registry.upload_root(settings)
    if not os.path.isdir(root):
        return set()
    return {name for name in os.listdir(root) if os.path.isdir(os.path.join(root, name))}


async def drop_orphan_rows() -> list[str]:
    """Удаляет строки записей, у которых нет ни реестра, ни каталога на диске.

    Зеркало обхода сирот ``services/orphans.py`` для БД: вызывается на старте
    приложения и после вытеснения записей загрузкой (``POST /recordings``).
    Возвращает id удалённых записей (для лога и тестов).
    """
    await init_db()
    protected = recording_registry.known_ids(settings) | _disk_recording_ids()
    orphans: list[str] = []
    async with AsyncSessionLocal() as session:
        # list() + аннотация: SQLAlchemy >= 2.1 (var-annotated в CI).
        ids: list[str] = list(
            (await session.scalars(select(RecordingRecord.recording_id))).all()
        )
        for recording_id in ids:
            if recording_id in protected:
                continue
            await _delete_recording_rows(session, recording_id)
            orphans.append(recording_id)
        await session.commit()
    if orphans:
        logger.info("Строки записей-сирот удалены: %s", ", ".join(orphans))
    return orphans
