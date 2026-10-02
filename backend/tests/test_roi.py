"""ROI-анализ (4.5, `app/services/roi.py`): агрегат «строка ROI × полосы».

Проверяем числа (count/share/median/gof_pass по ячейкам), производную
полушария от имени атласа, обрезку топ-N с честным полным счётом и подпись
правила «GOF сравнивается внутри полосы» в HTML-секции отчёта.
"""
from app.core.config import settings
from app.services.report import _roi_html
from app.services.roi import aggregate_roi, hemisphere_of


def _point(structure: str | None, area: str | None, gof: float, amplitude: float = 10.0) -> dict:
    """Точка пакета (контракт DipoleScanPointOut) с управляемыми полями ROI."""
    return {
        "epoch_index": 0,
        "time_ms": 100.0,
        "anatomical_structure": structure,
        "brodmann_area": area,
        "gof": gof,
        "amplitude_nam": amplitude,
    }


def test_hemisphere_of_reads_atlas_names():
    """«(слева)»/«(право)» русских подписей и `-lh`/`-rh` полей Бродмана."""
    assert hemisphere_of("таламус (слева)") == "lh"
    assert hemisphere_of("белое вещество (справа)") == "rh"
    assert hemisphere_of("BA17-lh") == "lh"
    assert hemisphere_of("BA17-rh") == "rh"
    # Срединные структуры — не «правое полушарие» по умолчанию
    assert hemisphere_of("ствол мозга") == "mid"
    assert hemisphere_of("третий желудочек") == "mid"


def test_aggregate_roi_cells_are_per_band():
    """Ячейка считает свою полосу: доля от точек полосы, GOF — внутри полосы."""
    points = {
        "theta": [
            _point("таламус (слева)", "BA17-lh", gof=0.9),
            _point("таламус (слева)", "BA17-lh", gof=0.7),
            _point("ствол мозга", None, gof=0.95),
            _point(None, "BA7-lh", gof=0.8),
        ],
        "alpha": [
            _point("таламус (слева)", "BA17-lh", gof=0.5),
        ],
    }
    roi = aggregate_roi(
        points, ["theta", "alpha"],
        gof_threshold=settings.roi_gof_threshold, top_n=12,
    )

    assert roi["gof_threshold"] == settings.roi_gof_threshold
    assert roi["bands"] == ["theta", "alpha"]
    assert roi["n_points_total"] == 5

    row = next(r for r in roi["structures"] if r["name"] == "таламус (слева)")
    theta = row["bands"]["theta"]
    # 2 точки из 4 theta; медиана GOF (0.7, 0.9) = 0.8; порог 0.8 → одна прошла
    assert theta["count"] == 2
    assert theta["share"] == 0.5
    assert theta["median_gof"] == 0.8
    assert theta["gof_pass"] == 1
    assert row["hemisphere"] == "lh"
    assert row["count"] == 3  # 2 в theta + 1 в alpha
    # Ячейка alpha — свои числа, а не сумма с theta (GOF между полосами не сравним)
    alpha = row["bands"]["alpha"]
    assert alpha["count"] == 1 and alpha["gof_pass"] == 0

    # Точка без структуры: в структуры не попала, но учтена в общем счёте
    assert roi["n_without_structure"] == 1
    assert roi["hemisphere_counts"] == {"lh": 3, "rh": 0, "mid": 1}


def test_aggregate_roi_top_cut_reports_full_counts():
    """Топ-N обрезает строки, но полный счёт имён остаётся (§8.4.4)."""
    points = {
        "theta": [
            _point("A-структура (слева)", None, gof=0.9),
            _point("B-структура (право)", None, gof=0.9),
            _point("B-структура (право)", None, gof=0.9),
        ],
    }
    roi = aggregate_roi(points, ["theta"], gof_threshold=0.8, top_n=1)
    # B встречается чаще — в топ попадает она, A скрыта, но счётчики честны
    assert [r["name"] for r in roi["structures"]] == ["B-структура (право)"]
    assert roi["n_structure_names"] == 2

    empty = aggregate_roi({}, ["theta"], gof_threshold=0.8, top_n=12)
    assert empty["n_points_total"] == 0
    assert empty["structures"] == [] and empty["brodmann"] == []


def test_roi_html_section_carries_reading_rule():
    """Секция отчёта: правило «GOF внутри полосы», ячейки «K из N», асимметрия."""
    points = {
        "theta": [
            _point("таламус (слева)", "BA17-lh", gof=0.9),
            _point("таламус (слева)", "BA17-lh", gof=0.6),
        ],
    }
    roi = aggregate_roi(points, ["theta"], gof_threshold=0.8, top_n=12)
    html = _roi_html(roi)

    assert "ROI-анализ" not in html  # заголовок задаёт роут, не тело
    assert "внутри" in html and "GOF не сравним" in html
    assert "1 из 2" in html  # gof_pass из count — ответ на «сколько с GOF ≥ 0.8»
    assert "таламус (слева)" in html and "слева" in html
    assert "Асимметрия полушарий" in html

    # Пустой агрегат — честная строка, а не пустая секция
    assert "нет точек" in _roi_html(None)
    assert "нет точек" in _roi_html(
        aggregate_roi({}, ["theta"], gof_threshold=0.8, top_n=12),
    )
