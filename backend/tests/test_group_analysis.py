"""Групповой анализ (остаток 4.7): агрегаты «BA × сессии» по точкам пакета.

Сид — через write-API отчёта (``persist_recording_result('report', ...)``),
как в прод: read обязан видеть ровно те строки. Три записи: две с пакетом
(одна и та же структура + разные доли), одна без прогона — честное
предупреждение, а не ошибка. Проверяем числа (count/share/ячейки/СТОД),
фильтры §3.5, шлюзы 400, перекрёстную сверку ``report_name_counts`` и
контракт роута ``POST /group/aggregate``.
"""
import asyncio

import pytest

from app.core.config import settings
from app.schemas.group import GroupAggregateIn, GroupAggregateOut
from app.services import recording_store, results_store
from app.services.group_analysis import aggregate_group
from app.services.preprocess import PreprocessParams
from app.services.recordings import recording_registry
from app.services.report import ReportParams
from tests.test_recording_store import _recording

_PREFIX = "/api/v1"
_RECS = ("rec-group-a", "rec-group-b", "rec-group-ghost")


def _point(index: int, structure: str, area: str, gof: float, amp: float) -> dict:
    """Точка пакета (контракт ``_package_points``) с управляемым GOF/моментом."""
    return {
        "epoch_index": index,
        "time_ms": 100.0 + index,
        "head_coords": [-40.0, -20.0, 60.0],
        "mni_coords": [-42.0, -18.0, 58.0],
        "moment": [1.0, 0.0, 0.0],
        "amplitude_nam": amp,
        "gof": gof,
        "anatomical_structure": structure,
        "brodmann_area": area,
        "riv": 0.2,
    }


def _report_result(recording_id: str, points: list[dict], name_counts: dict | None) -> dict:
    """Минимальный результат ``run_report``: одна полоса ``alpha`` (узел пакета)."""
    return {
        "recording_id": recording_id,
        "filename": "probe.edf",
        "html_sig": f"sig-{recording_id}",
        "report_version": "cafebabe1234",
        "qc": {"status": "ok", "good_data_percent": 95.0},
        "reference": "average",
        "n_epochs_total": 10,
        "n_epochs_used": len(points),
        "rejected_epochs": 0,
        "bands": [{
            "band_key": "alpha",
            "band_hz": [8.0, 13.0],
            "n_epochs_used": len(points),
            "n_points": len(points),
            "n_no_attribution": 0,
            "median_gof": 0.8,
            "median_riv": 0.2,
            "top_structures": [],
            "top_brodmann": [],
            "name_counts": name_counts or {"structure": [], "brodmann": []},
            "dynamics": [],
            "warnings": [],
        }],
        "_package_points": {"alpha": points},
        "warnings": [],
        "duration_sec_calc": 1.0,
    }


def _params() -> ReportParams:
    return ReportParams(
        preprocess=PreprocessParams(epoch_length_ms=1000.0),
        grid_mm=7.0,
        band_keys=["alpha"],
    )


def _seed(name_counts: dict | None = None) -> None:
    """Записи A (3 точки) и B (2 точки) с пакетом; ghost — без прогона."""
    points_a = [
        _point(0, "таламус (слева)", "BA7-lh", 0.9, 100.0),
        _point(1, "таламус (слева)", "BA7-lh", 0.7, 60.0),
        _point(2, "зрительная кора (справа)", "BA17-rh", 0.85, 40.0),
    ]
    points_b = [
        _point(0, "таламус (слева)", "BA7-lh", 0.6, 20.0),
        _point(1, "таламус (слева)", "BA7-lh", 0.8, 30.0),
    ]
    for rid, points in (("rec-group-a", points_a), ("rec-group-b", points_b)):
        rec = _recording(rid)
        asyncio.run(recording_store.upsert_recording(rec))
        asyncio.run(results_store.persist_recording_result(
            "report", rec, _params(),
            _report_result(rid, points, name_counts), f"job-{rid}",
        ))


@pytest.fixture(autouse=True)
def clean_state():
    """Строки теста убираются до и после: общая tmp-БД не помнит соседей."""
    for rid in _RECS:
        asyncio.run(recording_store.drop_recording_rows(rid))
    recording_registry.clear()
    yield
    for rid in _RECS:
        asyncio.run(recording_store.drop_recording_rows(rid))
    recording_registry.clear()


def _payload(**overrides) -> GroupAggregateIn:
    data = {"recording_ids": ["rec-group-a", "rec-group-b"], "band_key": "alpha"}
    data.update(overrides)
    return GroupAggregateIn(**data)


def _run(**overrides) -> GroupAggregateOut:
    return GroupAggregateOut(**asyncio.run(aggregate_group(_payload(**overrides), settings)))


def test_rows_cells_and_stats():
    """Групповой срез: строки по именам, ячейки по записям, два знаменателя share."""
    _seed()
    result = _run()
    # Границы — из каталога полос /meta (freq_bands), не из сида точки
    assert result.filters.band_hz == [
        settings.freq_bands["alpha"][0], settings.freq_bands["alpha"][1],
    ]
    assert result.n_points_total == 5
    assert [p.recording_id for p in result.participants] == ["rec-group-a", "rec-group-b"]
    assert [p.n_points for p in result.participants] == [3, 2]
    assert all(p.analysis_id is not None for p in result.participants)
    assert result.participants[0].filename == "probe.edf"

    rows = {row.name: row for row in result.structures}
    thalamus = rows["таламус (слева)"]
    assert thalamus.count == 4  # 2 точки A + 2 точки B
    assert thalamus.hemisphere == "lh"
    assert thalamus.n_sessions == 2  # в обеих записях
    # Доля ячейки — от своих точек: A 2/3, B 2/2
    cells = {cell.recording_id: cell for cell in thalamus.cells}
    assert cells["rec-group-a"].count == 2
    assert cells["rec-group-a"].share == pytest.approx(2 / 3)
    assert cells["rec-group-b"].share == pytest.approx(1.0)
    # Доля строки — от всех точек выборки
    assert thalamus.share == pytest.approx(4 / 5)
    # GOF/момент внутри полосы: среднее/медиана/СТОД по 4 точкам
    assert thalamus.mean_gof == pytest.approx((0.9 + 0.7 + 0.6 + 0.8) / 4)
    assert thalamus.median_gof == pytest.approx(0.75)
    assert thalamus.std_gof is not None and thalamus.std_gof > 0
    assert thalamus.mean_amplitude_nam == pytest.approx((100 + 60 + 20 + 30) / 4)
    assert thalamus.std_amplitude_nam is not None
    assert "зрительная кора (справа)" in rows

    # Поля Бродмана — отдельный словарь, ячейки в порядке участников
    areas = {row.name: row for row in result.brodmann}
    assert areas["BA7-lh"].count == 4
    assert [c.recording_id for c in areas["BA7-lh"].cells] == [
        "rec-group-a", "rec-group-b",
    ]
    assert result.n_structure_names == 2
    assert result.warnings == []  # обе записи с пакетом, точки в полосе
    assert any("полосы" in note for note in result.notes)


def test_gof_filter_narrows_points_and_disables_cross_check():
    """Фильтр GOF: точки меньше, ячейки и знаменатели — те же фильтрованные."""
    _seed()
    result = _run(gof_min=0.75)
    # Из 5 точек остаются gof 0.9 (A), 0.85 (A), 0.8 (B)
    assert result.n_points_total == 3
    assert [p.n_points for p in result.participants] == [2, 1]
    thalamus = {row.name: row for row in result.structures}["таламус (слева)"]
    assert thalamus.count == 2
    assert thalamus.mean_gof == pytest.approx(0.85)
    # Отбор точек отключает сверку счётчиков (они считались без отбора)
    assert not any("разошлись" in w for w in result.warnings)


def test_names_filter_and_top_n_keep_denominator():
    """Фильтр строк и топ-N сужают вывод, но не знаменатель share строки."""
    _seed()
    result = _run(names=["BA7-lh"], top_n=1)
    assert result.structures == []  # «BA7-lh» — поле, не структура
    assert [row.name for row in result.brodmann] == ["BA7-lh"]
    # Знаменатель не сузился: share = 4 от всех 5 точек, а не от 4 «BA7-lh»
    assert result.brodmann[0].share == pytest.approx(4 / 5)
    assert result.n_structure_names == 2  # полный счёт имён виден из разницы чисел
    assert result.n_brodmann_names == 2


def test_ghost_recording_and_date_filter_warn_honestly():
    """Запись без прогона и фильтр даты — предупреждения, не ошибка."""
    _seed()
    result = _run(recording_ids=["rec-group-a", "rec-group-ghost"])
    ghost = next(p for p in result.participants if p.recording_id == "rec-group-ghost")
    assert ghost.analysis_id is None
    assert ghost.n_points == 0
    assert any("rec-group-ghost" in w and "нет прогона" in w for w in result.warnings)

    # Дата «в будущем» отсекает оба прогона — честно пусто + предупреждения
    from datetime import datetime, timedelta
    empty = _run(date_from=datetime.utcnow() + timedelta(days=1))
    assert empty.n_points_total == 0
    assert any("нет прогона" in w for w in empty.warnings)
    assert any("нет точек" in w for w in empty.warnings)



def test_cross_check_flags_count_discrepancy():
    """Сверка счётчиков отчёта с точками: расхождение — в warnings, без падения."""
    # Сид со счётчиком «таламус: 99» против 2 реальных точек в каждой записи
    _seed(name_counts={
        "structure": [
            {"name": "таламус (слева)", "count": 99, "share": 0.9, "median_gof": 0.8},
        ],
        "brodmann": [
            {"name": "BA7-lh", "count": 2, "share": 0.5, "median_gof": 0.8},
        ],
    })
    result = _run()
    mismatches = [w for w in result.warnings if "разошлись" in w]
    assert mismatches, "расхождение 99 vs 2 обязано попасть в warnings"
    assert any("таламус (слева)" in w for w in mismatches)
    # BA7-lh в отчёте = 2, в точках = 2 — это совпадение, не warning
    assert not any("BA7-lh" in w for w in mismatches)


def test_route_validation_400_and_contract(client):
    """Роут: 400 с текстом на опечатку/пустоту, 200 + контракт на корректном входе."""
    _seed()
    bad = client.post(f"{_PREFIX}/group/aggregate", json={
        "recording_ids": ["rec-group-a"], "band_key": "alpja",
    })
    assert bad.status_code == 400
    assert "Неизвестная полоса" in bad.json()["detail"]

    empty = client.post(f"{_PREFIX}/group/aggregate", json={
        "recording_ids": [], "band_key": "alpha",
    })
    assert empty.status_code == 400
    assert "хотя бы одна запись" in empty.json()["detail"]

    ok = client.post(f"{_PREFIX}/group/aggregate", json={
        "recording_ids": ["rec-group-a", "rec-group-b"],
        "band_key": "alpha",
        "gof_min": 0.7,
    })
    assert ok.status_code == 200
    body = GroupAggregateOut(**ok.json())
    # gof_min=0.7: из 5 точек остаются 0.9, 0.7, 0.85 (A) и 0.8 (B) — отсечён только 0.6
    assert body.n_points_total == 4
    assert body.filters.gof_min == 0.7
    assert len(body.participants) == 2

