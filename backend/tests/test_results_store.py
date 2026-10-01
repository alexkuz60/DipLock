"""Write-API UI-разделов в ``sessions``/``epochs``/``dipoles`` (4.4, шаг ②).

Проверяем правила §8.4: история, не UPSERT (повтор = новая строка), настоящий
FK ``dipoles.epoch_id`` (F21), ``kind``/``job_id``/``params_json`` прогона и
предел 4.4 (``spectrum`` не пишется).
"""
import asyncio

from sqlalchemy import func, select

from app.models import db as db_module
from app.models.db import Dipole, EpochRecord, Session, init_db
from app.services import results_store
from app.services.dipole_scanner import DipoleRefineParams, DipoleScanParams
from app.services.preprocess import PreprocessParams
from tests.test_recording_store import _recording


def _point(index: int) -> dict:
    """Одна точка быстрого расчёта (контракт DipoleScanPointOut)."""
    return {
        "epoch_index": index,
        "time_ms": 120.0 + index,
        "head_coords": [-40.0, -20.0, 60.0],
        "mni_coords": [-42.0, -18.0, 58.0],
        "moment": [1.0, 0.0, 0.0],
        "amplitude_nam": 40.0 + index,
        "gof": 0.85,
        "anatomical_structure": "Precuneus",
        "brodmann_area": "BA7-lh",
    }


def _scan_result() -> dict:
    """Минимальный результат ``compute_dipole_scan`` для persist."""
    return {
        "recording_id": "rec-scan",
        "method": "fast_grid",
        "channels": ["Fp1"],
        "sfreq": 250.0,
        "epoch_length_ms": 1000.0,
        "filter_band_hz": [0.5, 2.0],
        "n_epochs_total": 5,
        "n_epochs_used": 2,
        "grid_mm": 7.0,
        "points": [_point(0), _point(2)],
        "warnings": [],
        "duration_sec_calc": 1.5,
    }


async def _rows(model, **filters) -> list:
    """Строки модели с фильтрами (для проверок содержимого)."""
    await init_db()
    query = select(model)
    for name, value in filters.items():
        query = query.where(getattr(model, name) == value)
    async with db_module.AsyncSessionLocal() as session:
        return list((await session.scalars(query)).all())


async def _count(model, **filters) -> int:
    query = select(func.count()).select_from(model)
    for name, value in filters.items():
        query = query.where(getattr(model, name) == value)
    async with db_module.AsyncSessionLocal() as session:
        return int(await session.scalar(query) or 0)


def test_scan_result_writes_session_epochs_dipoles():
    """Быстрый расчёт: строка прогона, эпохи по точкам, FK epoch_id настоящий."""
    rec = _recording("rec-scan")
    params = DipoleScanParams(filter_band=(0.5, 2.0), epoch_length_ms=1000.0, grid_mm=7.0)

    asyncio.run(results_store.persist_recording_result(
        "dipoles", rec, params, _scan_result(), "job-scan-1",
    ))

    async def _check():
        sessions = await _rows(Session, recording_id="rec-scan", kind="dipoles")
        assert len(sessions) == 1
        row = sessions[0]
        assert row.job_id == "job-scan-1"
        assert row.freq_band == "0.5-2"
        assert row.epoch_length_ms == 1000.0
        assert row.params_json["grid_mm"] == 7.0
        assert row.n_channels == 18 and row.sfreq == 250.0

        epochs = await _rows(EpochRecord, session_id=row.id)
        assert sorted(e.epoch_index for e in epochs) == [0, 2]
        assert all(e.duration_ms == 1000.0 and e.has_artifact == 0 for e in epochs)
        # start_time_sec не выдумываем: сетка нарезки в результате не перечислена
        assert all(e.start_time_sec is None for e in epochs)

        dipoles = await _rows(Dipole, session_id=row.id)
        assert len(dipoles) == 2
        by_index = {e.epoch_index: e.id for e in epochs}
        for dipole in dipoles:
            assert dipole.method == "fast_grid"
            assert dipole.epoch_id is not None
            assert dipole.epoch_id == by_index[dipole.time_ms - 120.0]
            assert dipole.mni_x == -42.0
            assert dipole.anatomical_roi == "Precuneus"
            assert dipole.brodmann_area == "BA7-lh"
            assert dipole.freq_band == "0.5-2"

    asyncio.run(_check())


def test_repeat_run_appends_history_not_upsert():
    """Повторный расчёт — новая строка (§8.4.2: история, не UPSERT)."""
    rec = _recording("rec-history")
    params = DipoleScanParams(filter_band=(0.5, 2.0), epoch_length_ms=1000.0)

    for job_id in ("job-a", "job-b"):
        asyncio.run(results_store.persist_recording_result(
            "dipoles", rec, params, _scan_result(), job_id,
        ))

    async def _check():
        sessions = await _rows(Session, recording_id="rec-history", kind="dipoles")
        assert sorted(s.job_id for s in sessions) == ["job-a", "job-b"]
        # Дочерние строки каждого прогона не слиплись
        assert await _count(Dipole, session_id=sessions[0].id) == 2
        assert await _count(Dipole, session_id=sessions[1].id) == 2

    asyncio.run(_check())


def test_preprocess_epochs_stage_writes_grid_with_rejects():
    """Стадия epochs: сетка окон + флаги отбраковки; мощности остаются NULL."""
    rec = _recording("rec-pp")
    params = PreprocessParams(stage="epochs", epoch_length_ms=1000.0, filter_band=(8.0, 16.0))
    result = {
        "recording_id": "rec-pp",
        "stage": "epochs",
        "sfreq": 250.0,
        "epoch_length_ms": 1000.0,
        "n_epochs_total": 4,
        "n_epochs_used": 3,
        "rejected_epochs": [1],
        "epoch_starts_sec": None,  # регулярная сетка
    }

    asyncio.run(results_store.persist_recording_result(
        "preprocess", rec, params, result, "job-pp",
    ))

    async def _check():
        sessions = await _rows(Session, recording_id="rec-pp", kind="preprocess")
        assert len(sessions) == 1
        assert sessions[0].freq_band == "8-16"
        epochs = await _rows(EpochRecord, session_id=sessions[0].id)
        assert len(epochs) == 4
        rejected = [e.epoch_index for e in epochs if e.has_artifact]
        assert rejected == [1]
        assert [e.start_time_sec for e in sorted(epochs, key=lambda e: e.epoch_index)] == [
            0.0, 1.0, 2.0, 3.0,
        ]

    asyncio.run(_check())


def test_preprocess_other_stages_write_nothing():
    """Строку прогона оставляет только стадия, порождающая эпохи."""
    rec = _recording("rec-pp-filter")
    params = PreprocessParams(stage="filter", filter_band=(1.0, 40.0))

    asyncio.run(results_store.persist_recording_result(
        "preprocess", rec, params, {"recording_id": "x", "stage": "filter"}, "job-f",
    ))

    async def _check():
        assert await _count(Session, recording_id="rec-pp-filter") == 0

    asyncio.run(_check())


def test_refine_writes_bem_fit_point():
    """Точный фитинг: свой прогон, одна эпоха, строка method='bem_fit'."""
    rec = _recording("rec-refine")
    scan = DipoleScanParams(filter_band=(8.0, 13.0), epoch_length_ms=500.0)
    params = DipoleRefineParams(scan=scan, epoch_index=3, halfwin_ms=10.0)
    result = {
        "recording_id": "rec-refine",
        "method": "bem_fit",
        "epoch_index": 3,
        "time_ms": 210.0,
        "point": {
            "epoch_index": 3,
            "time_ms": 210.0,
            "head_coords": [-41.0, -21.0, 61.0],
            "mni_coords": [-43.0, -19.0, 59.0],
            "moment": [0.0, 1.0, 0.0],
            "amplitude_nam": 52.0,
            "gof": 0.91,
            "anatomical_structure": "Cingulate",
            "brodmann_area": "BA23-lh",
        },
        "warnings": [],
        "duration_sec_calc": 8.5,
    }

    asyncio.run(results_store.persist_recording_result(
        "dipole_refine", rec, params, result, "job-refine",
    ))

    async def _check():
        sessions = await _rows(Session, recording_id="rec-refine", kind="dipole_refine")
        assert len(sessions) == 1
        assert sessions[0].epoch_length_ms == 500.0
        assert sessions[0].freq_band == "8-13"
        assert sessions[0].params_json["epoch_index"] == 3

        epochs = await _rows(EpochRecord, session_id=sessions[0].id)
        assert [e.epoch_index for e in epochs] == [3]

        dipoles = await _rows(Dipole, session_id=sessions[0].id)
        assert len(dipoles) == 1
        dipole = dipoles[0]
        assert dipole.method == "bem_fit"
        assert dipole.epoch_id == epochs[0].id
        assert dipole.gof == 0.91
        assert dipole.mni_y == -19.0

    asyncio.run(_check())


def test_spectrogram_writes_session_only():
    """Спектрограмма: строка прогона без дочерних строк (сетка живёт в кэше)."""
    rec = _recording("rec-sgram")
    params = PreprocessParams()  # параметры спектрограммы — не dataclass задачи
    result = {"recording_id": "rec-sgram", "sfreq": 250.0, "filter_band_hz": None}

    asyncio.run(results_store.persist_recording_result(
        "spectrogram", rec, params, result, "job-sgram",
    ))

    async def _check():
        sessions = await _rows(Session, recording_id="rec-sgram", kind="spectrogram")
        assert len(sessions) == 1
        assert await _count(EpochRecord, session_id=sessions[0].id) == 0
        assert await _count(Dipole, session_id=sessions[0].id) == 0

    asyncio.run(_check())


def test_spectrum_and_evoked_not_persisted():
    """Предел 4.4: spectrum/evoked не пишутся — молча, без строк."""
    rec = _recording("rec-nop")
    asyncio.run(results_store.persist_recording_result(
        "spectrum", rec, None, {"recording_id": "x"}, "job-nop",
    ))
    asyncio.run(results_store.persist_recording_result(
        "evoked", rec, None, {"recording_id": "x"}, "job-nop",
    ))

    async def _check():
        assert await _count(Session, recording_id="rec-nop") == 0

    asyncio.run(_check())


def test_on_success_callback_wired_only_for_persist_kinds():
    """Колбэк есть у пишущихся видов и None у остальных (сигнатура job_manager)."""
    rec = _recording("rec-cb")
    assert results_store.on_success_callback("dipoles", rec, None) is not None
    assert results_store.on_success_callback("report", rec, None) is not None
    assert results_store.on_success_callback("spectrum", rec, None) is None
    assert "spectrum" not in results_store.PERSIST_KINDS

