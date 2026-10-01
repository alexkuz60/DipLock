"""Кирпичный слой B6/B7/B13: persist прогона автоотчёта (4.4, шаг ③; §8.3).

Проверяем: ``analyses``/``analysis_bands``/``dipole_points`` (UNIQUE «эпоха ×
поддиапазон», базис КД), ``report_runs``+``report_*`` (история, полный счёт
имён §8.4.4), потребление внутренних ключей (``_package_points``/``name_counts``)
и каскад записи вместе с ``recording``.
"""
import asyncio
import os

import pytest
from sqlalchemy import func, select

from app.core.config import settings
from app.models import db as db_module
from app.models.db import (
    Analysis,
    AnalysisBand,
    DipolePoint,
    ReportBandSummary,
    ReportDynamics,
    ReportNameCount,
    ReportRun,
    Session,
    init_db,
)
from app.services import recording_store, results_store
from app.services.preprocess import PreprocessParams
from app.services.report import ReportParams
from tests.test_recording_store import _recording

_REC = "rec-report-store"


def _point(index: int, structure: str, amplitude: float, gof: float = 0.85) -> dict:
    """Точка пакета (контракт DipoleScanPointOut) с управляемым моментом/GOF."""
    return {
        "epoch_index": index,
        "time_ms": 100.0 + index,
        "head_coords": [-40.0, -20.0, 60.0],
        "mni_coords": [-42.0, -18.0, 58.0],
        "moment": [1.0, 0.0, 0.0],
        "amplitude_nam": amplitude,
        "gof": gof,
        "anatomical_structure": structure,
        "brodmann_area": "BA7-lh",
        "riv": 0.2,
    }


def _summary(key: str, points: list[dict], structures: list[str]) -> dict:
    """Агрегат полосы в формате ``summarize_band`` (включая name_counts §8.4.4)."""
    rows = [
        {"name": name, "count": 3, "share": 0.3, "median_gof": 0.8}
        for name in structures
    ]
    return {
        "band_key": key,
        "band_hz": [8.0, 13.0],
        "n_epochs_used": len(points),
        "n_points": len(points),
        "n_no_attribution": 1,
        "median_gof": 0.8,
        "median_riv": 0.2,
        "top_structures": rows[:5],
        "top_brodmann": rows[:12],
        "name_counts": {"structure": rows, "brodmann": rows[:2]},
        "dynamics": [{"name": structures[0], "shares": [0.1, 0.2, 0.3, 0.2, 0.1]}],
        "warnings": [f"{key}: warn"],
    }


def _report_result() -> dict:
    """Минимальный результат ``run_report`` (включая внутренний ключ точек)."""
    structures = [f"Struct{i}" for i in range(7)]  # больше TOP_STRUCTURES=5
    alpha_points = [_point(i, structures[i % 7], 100.0 - 10 * i) for i in range(6)]
    beta_points = [_point(i, structures[i % 7], 50.0) for i in range(3)]
    return {
        "recording_id": _REC,
        "filename": "probe.edf",
        "html_sig": "sig-report-1",
        "report_version": "cafebabe1234",
        "qc": {"status": "ok", "good_data_percent": 93.5},
        "reference": "average",
        "n_epochs_total": 10,
        "n_epochs_used": 8,
        "rejected_epochs": 2,
        "bands": [
            _summary("alpha", alpha_points, structures),
            _summary("beta", beta_points, structures[:3]),
        ],
        "_package_points": {"alpha": alpha_points, "beta": beta_points},
        "warnings": ["w1"],
        "duration_sec_calc": 12.3,
    }


def _params() -> ReportParams:
    return ReportParams(
        preprocess=PreprocessParams(epoch_length_ms=1000.0),
        grid_mm=7.0,
        band_keys=["alpha", "beta"],
    )


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


@pytest.fixture(autouse=True)
def _clean_recording_rows():
    """Строки теста убираются до и после: общая tmp-БД не помнит соседей."""
    asyncio.run(recording_store.drop_recording_rows(_REC))
    yield
    asyncio.run(recording_store.drop_recording_rows(_REC))


def test_report_persists_analysis_bands_and_points():
    """Прогон отчёта: analyses (паспорт+отпечаток), analysis_bands, dipole_points."""
    rec = _recording(_REC)
    result = _report_result()

    asyncio.run(results_store.persist_recording_result(
        "report", rec, _params(), result, "job-report-1",
    ))

    async def _check():
        analyses = await _rows(Analysis, recording_id=_REC)
        assert len(analyses) == 1
        analysis = analyses[0]
        assert analysis.kind == "fast_grid"
        assert analysis.params_sig == "sig-report-1"  # отпечаток = html_sig
        assert analysis.job_id == "job-report-1"
        assert analysis.grid_mm == 7.0
        assert analysis.epoch_length_ms == 1000.0
        assert analysis.n_epochs_total == 10 and analysis.n_epochs_used == 8
        assert analysis.warnings == ["w1"]
        assert analysis.channels == ["Fp1", "Fp2"]  # из паспорта записи
        assert analysis.sfreq == 250.0

        bands = {
            b.band_key: b for b in await _rows(AnalysisBand, analysis_id=analysis.id)
        }
        assert set(bands) == {"alpha", "beta"}
        alpha = bands["alpha"]
        assert alpha.state == "ok"
        assert alpha.n_points == 6
        assert alpha.band_hz_lo == 8.0 and alpha.band_hz_hi == 13.0
        assert alpha.n_errors == 1  # warnings полосы
        # Базис КД: максимум момента — внутри полосы (100 нАм у первой точки)
        assert alpha.moment_max_nam == 100.0
        # Пороги КД не заданы (concept.md §3: «своих дефолтов нет») → NULL
        assert alpha.n_kd_passed is None

        points = await _rows(DipolePoint, analysis_id=analysis.id)
        assert len(points) == 6 + 3
        # UNIQUE «эпоха × поддиапазон» (§8.3): ключ не задублирован
        keys = {(p.band_key, p.epoch_index) for p in points}
        assert len(keys) == len(points)
        alpha_point = next(p for p in points if p.band_key == "alpha")
        assert alpha_point.method == "fast_grid"
        assert alpha_point.peak_time_ms == 100.0 + alpha_point.epoch_index
        assert alpha_point.head_coords == [-40.0, -20.0, 60.0]
        assert alpha_point.mni_coords == [-42.0, -18.0, 58.0]
        assert alpha_point.moment_dir == [1.0, 0.0, 0.0]
        assert alpha_point.anatomical_structure is not None
        assert alpha_point.kd_passed is None
        assert alpha_point.kd_basis == {
            "moment_share_x": None,
            "gof_min": None,
            "moment_max_nam": 100.0,
        }

    asyncio.run(_check())


def test_report_persists_run_and_aggregates():
    """report_runs (вариант (а) с FK analyses) + сводки, полный счёт, динамика."""
    rec = _recording(_REC)
    result = _report_result()

    asyncio.run(results_store.persist_recording_result(
        "report", rec, _params(), result, "job-report-2",
    ))

    async def _check():
        runs = await _rows(ReportRun, recording_id=_REC)
        assert len(runs) == 1
        run = runs[0]
        analysis = (await _rows(Analysis, recording_id=_REC))[0]
        assert run.analyses_id == analysis.id  # одна истина на прогон
        assert run.params_sig == "sig-report-1"
        assert run.job_id == "job-report-2"
        assert run.qc_status == "ok"
        assert run.good_data_percent == 93.5
        assert run.n_epochs_rejected == 2
        assert run.html_version == "cafebabe1234"
        # Путь в БД — относительно cache_dir (переносим, не храним абсолют)
        assert run.html_path is not None
        assert not os.path.isabs(run.html_path)
        assert run.html_path.startswith("reports" + os.sep)
        assert run.html_path.endswith(".html")

        summaries = await _rows(ReportBandSummary, report_run_id=run.id)
        assert {s.band_key for s in summaries} == {"alpha", "beta"}
        alpha = next(s for s in summaries if s.band_key == "alpha")
        assert alpha.n_points == 6 and alpha.n_no_attribution == 1
        assert alpha.median_gof == 0.8 and alpha.median_riv == 0.2

        # §8.4.4: ВСЕ имена словаря, а не топ-N (7 структур при TOP_STRUCTURES=5)
        structure_counts = await _rows(
            ReportNameCount, report_run_id=run.id, kind="structure",
        )
        assert len(structure_counts) == 7 + 3  # по словарю: alpha — 7, beta — 3
        alpha_names = {c.name for c in structure_counts if c.band_key == "alpha"}
        assert alpha_names == {f"Struct{i}" for i in range(7)}
        brodmann = await _rows(ReportNameCount, report_run_id=run.id, kind="brodmann")
        assert len(brodmann) == 2 * 2  # по 2 имени на полосу

        dynamics = await _rows(ReportDynamics, report_run_id=run.id, band_key="alpha")
        assert len(dynamics) == 5  # ровно 5 бинов, как в HTML
        assert [d.bin_index for d in dynamics] == [0, 1, 2, 3, 4]

    asyncio.run(_check())


def test_internal_keys_consumed_before_job_file():
    """Точки и полный счёт уходят из результата: в файле задачи — агрегаты."""
    rec = _recording(_REC)
    result = _report_result()

    asyncio.run(results_store.persist_recording_result(
        "report", rec, _params(), result, "job-report-3",
    ))

    assert "_package_points" not in result
    for summary in result["bands"]:
        assert "name_counts" not in summary
        assert "top_structures" in summary  # агрегаты UI остались
    assert result["html_sig"] == "sig-report-1"


def test_kd_verdict_computed_when_thresholds_configured(monkeypatch):
    """С порогами методики (C0) вердикт КД считается: момент ≥ X% И GOF ≥ порога."""
    monkeypatch.setattr(settings, "kd_moment_share", 0.5)
    monkeypatch.setattr(settings, "kd_gof_min", 0.7)
    rec = _recording(_REC)
    result = _report_result()
    # Контрольные точки alpha: максимум 100 → порог момента 50 нАм
    result["_package_points"]["alpha"] = [
        _point(0, "A", 100.0, gof=0.9),   # оба условия → 1
        _point(1, "B", 30.0, gof=0.95),   # момент ниже 50 → 0
        _point(2, "C", 60.0, gof=0.5),    # GOF ниже 0.7 → 0
        _point(3, "D", 60.0, gof=0.9),    # оба условия → 1
    ]

    asyncio.run(results_store.persist_recording_result(
        "report", rec, _params(), result, "job-report-kd",
    ))

    async def _check():
        analysis = (await _rows(Analysis, recording_id=_REC))[0]
        alpha_band = next(
            b for b in await _rows(AnalysisBand, analysis_id=analysis.id)
            if b.band_key == "alpha"
        )
        assert alpha_band.n_kd_passed == 2
        assert alpha_band.moment_max_nam == 100.0

        points = {
            p.epoch_index: p
            for p in await _rows(DipolePoint, analysis_id=analysis.id)
            if p.band_key == "alpha"
        }
        assert points[0].kd_passed == 1
        assert points[1].kd_passed == 0
        assert points[2].kd_passed == 0
        assert points[3].kd_passed == 1
        assert points[0].kd_basis == {
            "moment_share_x": 0.5,
            "gof_min": 0.7,
            "moment_max_nam": 100.0,
        }

    asyncio.run(_check())


def test_repeat_report_appends_history():
    """§8.4.2: повтор с тем же отпечатком — честная новая строка, не UPSERT."""
    rec = _recording(_REC)
    for job_id in ("job-r1", "job-r2"):
        asyncio.run(results_store.persist_recording_result(
            "report", rec, _params(), _report_result(), job_id,
        ))

    async def _check():
        assert await _count(ReportRun, recording_id=_REC) == 2
        assert await _count(Analysis, recording_id=_REC) == 2

    asyncio.run(_check())


def test_recording_cascade_covers_written_report_rows():
    """Каскад §8.4.3 доходит и до строк, записанных write-API (не только тестовых)."""
    rec = _recording(_REC)
    asyncio.run(results_store.persist_recording_result(
        "report", rec, _params(), _report_result(), "job-r-cascade",
    ))

    async def _ids():
        await init_db()
        analysis = (await _rows(Analysis, recording_id=_REC))[0]
        run = (await _rows(ReportRun, recording_id=_REC))[0]
        return analysis.id, run.id

    analysis_id, run_id = asyncio.run(_ids())
    asyncio.run(recording_store.drop_recording_rows(_REC))

    async def _check():
        assert await _count(Analysis, recording_id=_REC) == 0
        assert await _count(ReportRun, recording_id=_REC) == 0
        assert await _count(Session, recording_id=_REC) == 0
        # Дочерние строки ушли вместе с родителями — без «осиротевших» точек
        assert await _count(AnalysisBand, analysis_id=analysis_id) == 0
        assert await _count(DipolePoint, analysis_id=analysis_id) == 0
        assert await _count(ReportBandSummary, report_run_id=run_id) == 0
        assert await _count(ReportNameCount, report_run_id=run_id) == 0
        assert await _count(ReportDynamics, report_run_id=run_id) == 0

    asyncio.run(_check())
