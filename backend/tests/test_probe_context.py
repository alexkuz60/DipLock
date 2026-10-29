"""Контекст пробы (срез 4): признаки выборки из последнего прогона автоотчёта.

Сидятся строки ``recordings``/``analyses``/``analysis_bands``/``report_runs``/
``report_band_summaries`` напрямую (write-API шаг ③ проверен отдельно —
`test_report_store.py`); здесь проверяется **чтение**: выбор последнего
прогона (§8.4.2: история, не UPSERT), сборка признаков (КД/вращение/поток)
и честные «не измерено».
"""
import asyncio
from datetime import datetime

from app.models.db import (
    Analysis,
    AnalysisBand,
    AsyncSessionLocal,
    RecordingRecord,
    ReportBandSummary,
    ReportRun,
    init_db,
)
from app.services.probe_context import PROBE_FEATURES, probe_contexts, probe_features_by_band


async def _seed(recording_id: str, runs: list[dict]) -> None:
    """Запись + прогоны автоотчёта (словарь — параметры одного прогона)."""
    await init_db()
    async with AsyncSessionLocal() as session:
        session.add(RecordingRecord(
            recording_id=recording_id, filename=f"{recording_id}.edf",
            digest=f"digest-{recording_id}",
        ))
        for run in runs:
            analysis = Analysis(
                recording_id=recording_id, kind="fast_grid",
                created_at=run["created_at"],
            )
            session.add(analysis)
            await session.flush()
            session.add(AnalysisBand(
                analysis_id=analysis.id, band_key="alpha",
                n_points=4, n_kd_passed=run.get("n_kd_passed"),
            ))
            report_run = ReportRun(
                recording_id=recording_id, analyses_id=analysis.id,
                created_at=run["created_at"],
            )
            session.add(report_run)
            await session.flush()
            session.add(ReportBandSummary(
                report_run_id=report_run.id, band_key="alpha",
                n_points=4,
                rotation_ccw_share=run["rotation_ccw_share"],
                rotation_cw_share=run["rotation_cw_share"],
                flow_orderliness=run["flow_orderliness"],
                flow_steps=3, flow_basis="mni",
                median_gof=0.8, median_riv=0.2,
            ))
        await session.commit()


def test_probe_context_uses_latest_report_run():
    """Берётся последний прогон записи (история, не UPSERT — §8.4.2)."""
    asyncio.run(_seed("rec-latest", [
        {
            "created_at": datetime(2026, 10, 1, 12, 0),
            "rotation_ccw_share": 0.1, "rotation_cw_share": 0.9,
            "flow_orderliness": 0.1, "n_kd_passed": 0,
        },
        {
            "created_at": datetime(2026, 10, 2, 12, 0),
            "rotation_ccw_share": 0.9, "rotation_cw_share": 0.1,
            "flow_orderliness": 0.8, "n_kd_passed": 3,
        },
    ]))

    rows, warnings = asyncio.run(probe_contexts(["rec-latest"], "alpha"))

    assert warnings == []
    assert len(rows) == 1
    features = rows[0]["features"]
    assert rows[0]["measured"] is True
    assert features["rotation_ccw_share"] == 0.9  # свежий прогон, не первый
    assert features["flow_orderliness"] == 0.8
    assert features["kd_passed_share"] == 0.75  # 3 из 4 точек (AnalysisBand)
    assert set(features) == set(PROBE_FEATURES)


def test_probe_context_reports_unmeasured_without_zeros():
    """Нет прогона/полосы — честные None и предупреждение, а не нули."""
    asyncio.run(_seed("rec-noband", [{
        "created_at": datetime(2026, 10, 3, 12, 0),
        "rotation_ccw_share": 0.5, "rotation_cw_share": 0.5,
        "flow_orderliness": 0.5, "n_kd_passed": None,
    }]))

    rows, warnings = asyncio.run(probe_contexts(
        ["rec-noband", "rec-ghost"], "beta",
    ))

    assert len(rows) == 2
    assert all(row["measured"] is False for row in rows)
    assert all(row["features"]["rotation_ccw_share"] is None for row in rows)
    assert any("rec-noband" in w and "нет полосы «beta»" in w for w in warnings)
    assert any("rec-ghost" in w and "прогонов автоотчёта нет" in w for w in warnings)


def test_probe_context_dedupes_selection_and_keeps_order():
    asyncio.run(_seed("rec-b", [{
        "created_at": datetime(2026, 10, 4, 12, 0),
        "rotation_ccw_share": 0.6, "rotation_cw_share": 0.4,
        "flow_orderliness": 0.6, "n_kd_passed": 2,
    }]))
    asyncio.run(_seed("rec-a", [{
        "created_at": datetime(2026, 10, 4, 13, 0),
        "rotation_ccw_share": 0.7, "rotation_cw_share": 0.3,
        "flow_orderliness": 0.7, "n_kd_passed": 4,
    }]))

    rows, _warnings = asyncio.run(probe_contexts(["rec-b", "rec-a", "rec-b"], "alpha"))

    assert [row["recording_id"] for row in rows] == ["rec-b", "rec-a"]  # дубль снят, порядок выбора


def test_probe_context_empty_selection_is_honest():
    rows, warnings = asyncio.run(probe_contexts([], "alpha"))
    assert rows == []
    assert any("Выборка пуста" in w for w in warnings)


def test_probe_features_by_band_returns_only_measured():
    """Батч-признаки (срез 5): нет полосы/прогона — ключа нет, а не нули."""
    asyncio.run(_seed("rec-bands", [{
        "created_at": datetime(2026, 10, 5, 12, 0),
        "rotation_ccw_share": 0.9, "rotation_cw_share": 0.1,
        "flow_orderliness": 0.7, "n_kd_passed": 4,
    }]))

    features = asyncio.run(probe_features_by_band(
        ["rec-bands", "rec-ghost"], ["alpha", "beta"],
    ))

    assert features["rec-bands"]["alpha"]["rotation_ccw_share"] == 0.9
    assert features["rec-bands"]["alpha"]["kd_passed_share"] == 1.0  # 4 из 4
    assert "beta" not in features["rec-bands"]  # полосы нет в прогоне
    assert features["rec-ghost"] == {}  # прогона нет