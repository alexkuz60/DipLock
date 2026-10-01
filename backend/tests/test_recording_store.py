"""Строки записей в БД (4.4, шаг ①; ``services/recording_store.py``).

Тесты работают на изолированной tmp-БД из ``conftest`` (``DATABASE_URL``).
Проверяем: upsert без дублей, каскад «TTL строки = TTL записи» по всем таблицам
(§8.4.3) и чистку строк-сирот (каталог на диске защищает строку).
"""
import asyncio
import hashlib
import os
import shutil
import time
from datetime import datetime

from sqlalchemy import func, select

from app.core.config import settings
from app.models import db as db_module
from app.models.db import (
    Analysis,
    AnalysisBand,
    Dipole,
    DipolePoint,
    EpochRecord,
    RecordingRecord,
    ReportBandSummary,
    ReportDynamics,
    ReportNameCount,
    ReportRun,
    Session,
    init_db,
)
from app.services import recording_store
from app.services.recordings import Recording


def _recording(recording_id: str) -> Recording:
    """Фейковая запись реестра: у write-API от неё нужны только id и паспорт.

    ``digest`` — уникальный на запись (unique-индекс дедупа в схеме).
    """
    return Recording(
        recording_id=recording_id,
        filename="probe.edf",
        path=os.path.join("/nonexistent", "probe.edf"),
        upload_dir=os.path.join("/nonexistent", recording_id),
        created_at=time.time(),
        meta={
            "n_channels": 18,
            "sfreq": 250.0,
            "duration_sec": 120.0,
            "channels": ["Fp1", "Fp2"],
            "patient_alias": "Patient-abc123",
            "created_at": datetime.utcnow(),
        },
        digest=hashlib.sha256(recording_id.encode()).hexdigest(),
    )


async def _count(model, **filters) -> int:
    """Число строк модели с простыми фильтрами по колонкам."""
    query = select(func.count()).select_from(model)
    for name, value in filters.items():
        query = query.where(getattr(model, name) == value)
    async with db_module.AsyncSessionLocal() as session:
        return int(await session.scalar(query) or 0)


async def _seed_full_tree(recording_id: str) -> None:
    """Запись + все дочерние строки: session/epochs/dipoles, analyses, report_*."""
    async with db_module.AsyncSessionLocal() as session:
        session.add(RecordingRecord(recording_id=recording_id, filename="probe.edf"))
        session.flush()
        row = Session(id=f"{recording_id}-s", recording_id=recording_id, kind="dipoles")
        session.add(row)
        await session.flush()
        epoch = EpochRecord(session_id=row.id, epoch_index=0)
        session.add(epoch)
        await session.flush()
        session.add(Dipole(session_id=row.id, epoch_id=epoch.id, method="fast_grid"))
        analysis = Analysis(recording_id=recording_id, kind="fast_grid")
        session.add(analysis)
        await session.flush()
        session.add(AnalysisBand(analysis_id=analysis.id, band_key="alpha"))
        session.add(DipolePoint(analysis_id=analysis.id, band_key="alpha", epoch_index=0))
        run = ReportRun(recording_id=recording_id, analyses_id=analysis.id)
        session.add(run)
        await session.flush()
        session.add(ReportBandSummary(report_run_id=run.id, band_key="alpha"))
        session.add(ReportNameCount(
            report_run_id=run.id, kind="structure", name="Precuneus",
        ))
        session.add(ReportDynamics(report_run_id=run.id, name="Precuneus", bin_index=0))
        await session.commit()


async def _first_row(recording_id: str):
    """Первая (и единственная) строка записи — для проверок без дублей."""
    await init_db()
    async with db_module.AsyncSessionLocal() as session:
        rows = list((
            await session.scalars(
                select(RecordingRecord).where(
                    RecordingRecord.recording_id == recording_id
                )
            )
        ).all())
    assert len(rows) == 1, (
        f"ожидалась ровно одна строка {recording_id}, найдено {len(rows)}"
    )
    return rows[0]


def test_upsert_inserts_once_and_refreshes(tmp_path):
    """Одна запись — одна строка: повтор (дедуп/TTL-касание) освежает, не плодит."""
    rec = _recording("rec-upsert")

    asyncio.run(recording_store.upsert_recording(rec))
    first = asyncio.run(_first_row("rec-upsert"))
    assert first.digest == hashlib.sha256(b"rec-upsert").hexdigest()
    assert first.patient_alias == "Patient-abc123"
    assert first.sfreq == 250.0
    assert first.accessed_at is not None

    asyncio.run(recording_store.upsert_recording(rec))
    second = asyncio.run(_first_row("rec-upsert"))
    assert second.accessed_at >= first.accessed_at


def test_drop_recording_rows_cascades_everything(tmp_path):
    """Каскад §8.4.3: с записью уходят session/epochs/dipoles, analyses, report_*."""
    asyncio.run(_seed_full_tree("rec-drop"))
    asyncio.run(_seed_full_tree("rec-keep"))  # соседняя запись не страдает

    asyncio.run(recording_store.drop_recording_rows("rec-drop"))

    async def _check():
        await init_db()
        assert await _count(RecordingRecord, recording_id="rec-drop") == 0
        assert await _count(Session, recording_id="rec-drop") == 0
        assert await _count(Analysis, recording_id="rec-drop") == 0
        assert await _count(ReportRun, recording_id="rec-drop") == 0
        # Дочерние строки соседа целы
        assert await _count(RecordingRecord, recording_id="rec-keep") == 1
        assert await _count(Session, recording_id="rec-keep") == 1
        assert await _count(Analysis, recording_id="rec-keep") == 1
        assert await _count(DipolePoint, band_key="alpha") == 1
        assert await _count(ReportNameCount, name="Precuneus") == 1

    asyncio.run(_check())


def test_drop_orphan_rows_spares_recordings_with_dir(tmp_path):
    """Строка без каталога на диске — сирота; каталог защищает строку."""
    upload_root = settings.upload_dir
    live_dir = os.path.join(upload_root, "rec-orphan-live")
    os.makedirs(live_dir, exist_ok=True)
    try:
        asyncio.run(recording_store.upsert_recording(_recording("rec-orphan-live")))
        asyncio.run(recording_store.upsert_recording(_recording("rec-orphan-gone")))

        removed = asyncio.run(recording_store.drop_orphan_rows())

        async def _check():
            await init_db()
            # Список может содержать сирот других тестов (общая tmp-БД) —
            # важна судьба именно этих двух записей.
            assert "rec-orphan-gone" in removed
            assert "rec-orphan-live" not in removed
            assert await _count(RecordingRecord, recording_id="rec-orphan-live") == 1
            assert await _count(RecordingRecord, recording_id="rec-orphan-gone") == 0

        asyncio.run(_check())
    finally:
        shutil.rmtree(live_dir, ignore_errors=True)