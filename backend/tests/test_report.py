"""Тесты сквозного автоотчёта (раздел «Итоги», задача ``kind=report``).

Часть 1 — те же числа, что стадии EDF (три ``run_preprocess``), часть 2 —
пакет диполей с агрегатами структур/BA по полосам; HTML — самодостаточный
``mne.Report`` в дисковом кэше, отдаётся ассетом с ETag/304.
"""
import os
import shutil
from itertools import pairwise

import numpy as np
import pytest

from app.core.config import settings
from app.schemas.analysis import ReportResult
from app.services.preprocess import PreprocessParams
from app.services.recordings import recording_registry
from app.services.report import (
    TIME_BINS,
    ReportError,
    ReportParams,
    clear_report_cache,
    read_report_html,
    report_band_catalog,
    report_signature,
    resolve_band_keys,
    run_report,
    summarize_band,
)
from tests.test_dipole_scanner import _register, _wait_finished

_PREFIX = "/api/v1"


def _upload_dirs() -> set[str]:
    root = settings.upload_dir
    if not os.path.isdir(root):
        return set()
    return {name for name in os.listdir(root) if os.path.isdir(os.path.join(root, name))}


def _report_dirs() -> set[str]:
    root = os.path.join(settings.cache_dir, "reports")
    if not os.path.isdir(root):
        return set()
    return set(os.listdir(root))


@pytest.fixture(autouse=True)
def clean_state():
    """Изоляция реестра, каталогов загрузок и кэша отчётов между тестами."""
    recording_registry.clear()
    uploads_before = _upload_dirs()
    reports_before = _report_dirs()
    yield
    recording_registry.clear()
    for name in _upload_dirs() - uploads_before:
        shutil.rmtree(os.path.join(settings.upload_dir, name), ignore_errors=True)
    root = os.path.join(settings.cache_dir, "reports")
    for name in _report_dirs() - reports_before:
        shutil.rmtree(os.path.join(root, name), ignore_errors=True)


def _two_bands() -> list[str]:
    """Две средние полосы — минимальный «пакет» для теста.

    θ/α выбираются сознательно: у δ (0.5–2 Гц) FIR-ядро на 6-секундной записи
    съедает всё окно краевым буфером и эпох для пакета не остаётся.
    """
    return ["theta", "alpha"]


def _report_edf(tmp_path, seconds: float = 6.0):
    """EDF для отчёта:8 каналов 10-20, чистые синусы с растущей амплитудой.

    Амплитуды и частоты разные у каждого канала не случайно: average-reference
    вычитает среднее по монтажу, и совпадающие синусы превратили бы часть
    каналов в почти плоские — детектор клиппинга честно нашёл бы их (первый
    прогон этих тестов ровно так и упал: «clipping — 100 % записи»).
    """
    from tests.conftest import write_minimal_edf

    path = tmp_path / "report.edf"
    channels = list(settings.standard_channels[:8])
    sfreq = 250.0
    times = np.arange(int(seconds * sfreq)) / sfreq
    data = np.stack([
        np.sin(2 * np.pi * (6 + index) * times) * (10.0 + 3.0 * index)
        for index in range(len(channels))
    ])
    write_minimal_edf(path, channels, data, sfreq)
    return path


def _progress_log(log: list[tuple[str, float | None]]):
    """Колбэк прогресса, запоминающий (этап, дробь) — для проверки монотонности."""

    def _cb(stage, progress=None, message="", **kwargs):
        log.append((stage, progress))

    return _cb


# ---------- сервис: полосы, подписи, агрегаты ----------

def test_resolve_band_keys_all_unknown_and_dedup():
    catalog = report_band_catalog(settings)
    assert resolve_band_keys(settings, []) == list(catalog)

    first, second = list(catalog)[:2]
    assert resolve_band_keys(settings, [first, second]) == [first, second]
    # Дубль ключа не заставляет считать полосу дважды
    assert resolve_band_keys(settings, [first, first]) == [first]

    with pytest.raises(ReportError, match="Неизвестные полосы"):
        resolve_band_keys(settings, ["omega"])


def test_report_signature_tracks_params():
    params = ReportParams(preprocess=PreprocessParams(epoch_length_ms=1000.0), grid_mm=7.0, band_keys=["a"])
    same = ReportParams(preprocess=PreprocessParams(epoch_length_ms=1000.0), grid_mm=7.0, band_keys=["a"])
    other = ReportParams(preprocess=PreprocessParams(epoch_length_ms=1000.0), grid_mm=4.0, band_keys=["a"])
    assert report_signature(settings, params, ["a"]) == report_signature(
        settings, same, ["a"],
    )
    assert report_signature(settings, params, ["a"]) != report_signature(
        settings, other, ["a"],
    )


def _point(index, structure, area, gof, riv=None):
    return {
        "epoch_index": index,
        "gof": gof,
        "riv": riv,
        "anatomical_structure": structure,
        "brodmann_area": area,
    }


def test_summarize_band_counts_shares_and_dynamics():
    """Топы считают эпохи по структурам, динамика — 5 бинов с долями 0..1."""
    points = [_point(i, "Precuneus" if i < 6 else "Cingulate", "BA7-lh" if i < 4 else "BA23-lh",
                     0.5 + 0.05 * i, riv=0.3)
              for i in range(10)]
    points.append(_point(10, None, None, 0.9))  # точка без атрибуции
    summary = summarize_band("alpha", (8.0, 13.0), {
        "n_epochs_used": 11,
        "points": points,
        "warnings": ["пример"],
    })

    assert summary["band_key"] == "alpha"
    assert summary["band_hz"] == [8.0, 13.0]
    assert summary["n_points"] == 11
    assert summary["n_no_attribution"] == 1
    top = summary["top_structures"][0]
    assert top["name"] == "Precuneus" and top["count"] == 6
    assert top["share"] == pytest.approx(6 / 11)
    assert summary["median_gof"] is not None
    assert summary["median_riv"] == pytest.approx(0.3)
    assert len(summary["dynamics"]) >= 1
    for row in summary["dynamics"]:
        assert len(row["shares"]) == TIME_BINS
        assert all(0.0 <= share <= 1.0 for share in row["shares"])
    # Предупреждения расчёта полосы доходят до сводки с ключом полосы
    assert summary["warnings"] == ["alpha: пример"]


# ---------- сервис: сборка отчёта ----------

def test_run_report_builds_html_and_contract_result(tmp_path):
    """Обе части собираются: контракт ReportResult, HTML в кэше, прогресс растёт."""
    edf = _report_edf(tmp_path)
    recording = _register(tmp_path, edf, "rec-report")
    log: list[tuple[str, float | None]] = []
    bands = _two_bands()

    result = run_report(
        recording, settings,
        ReportParams(preprocess=PreprocessParams(epoch_length_ms=1000.0), grid_mm=7.0, band_keys=bands),
        progress=_progress_log(log),
    )

    out = ReportResult(**result)  # контракт API валидируется на месте
    assert out.recording_id == recording.recording_id
    assert [band.band_key for band in out.bands] == bands
    assert out.n_epochs_total > 0 and out.n_epochs_used > 0
    assert out.qc.n_channels == len(settings.standard_channels[:8])
    assert out.html_url == ""  # заполняет роут по job_id

    cached = read_report_html(settings, recording.recording_id, out.html_sig)
    assert cached is not None, "HTML должен лежать в дисковом кэше"
    data, version = cached
    assert version == out.report_version
    text = data.decode("utf-8")
    # Часть 1: числа QC и предупреждения стадий
    assert "Качество сырого файла" in text
    assert "Нарезка эпох" in text
    # Часть 2: обязательная подпись о несравнимости GOF + сами полосы
    assert "GOF между полосами не сравним" in text
    for key in bands:
        assert f"Полоса {key}" in text

    fractions = [fraction for _, fraction in log if fraction is not None]
    # Допуск на плавающую точку: окна считаются как lo+0.09, и 0.2 vs 0.19999…98
    # — это одна и та же граница
    assert all(
        before <= after + 1e-9
        for before, after in pairwise(fractions)
    ), "прогресс обязан расти монотонно"
    assert log[-1][0] == "done" and log[-1][1] == 1.0

    # Очистка кэша убирает HTML (то, что делает _drop_signal_cache записи)
    clear_report_cache(settings, recording.recording_id)
    assert read_report_html(settings, recording.recording_id, out.html_sig) is None


def test_run_report_rejects_unknown_band(tmp_path):
    edf = _report_edf(tmp_path)
    recording = _register(tmp_path, edf, "rec-report-bad")

    with pytest.raises(ReportError, match="Неизвестные полосы"):
        run_report(
            recording, settings, ReportParams(band_keys=["omega"]),
            progress=lambda *args, **kwargs: None,
        )


def test_theme_layers_are_print_safe():
    """Слои темы: печать принудительно светлая, тёмная — только по data-theme.

    Тёмная тема живёт на CSS-переменных (THEME_CSS), поэтому блок
    ``@media print`` возвращает светлую палитру простой подменой
    переменных — без дублирования правил.
    """
    from app.services.report import THEME_CSS, THEME_JS

    assert 'html[data-theme="dark"]' in THEME_CSS
    assert "@media print" in THEME_CSS
    # печать: палитра возвращается в светлые значения, кнопка темы скрыта
    assert THEME_CSS.split("@media print", 1)[1].count("--dl-") >= 8
    assert "#diplock-theme-toggle,\n  .accordion-button::after { display: none !important; }" \
        in THEME_CSS
    # JS: стартовая тема из ?theme=, кнопка и синхронизация URL
    assert "searchParams.get('theme')" in THEME_JS
    assert "diplock-theme-toggle" in THEME_JS
    assert "history.replaceState" in THEME_JS


# ---------- API: задача, результат, HTML-ассет ----------

def _upload(client, path) -> dict:
    with open(path, "rb") as fh:
        response = client.post(
            f"{_PREFIX}/recordings",
            files={"file": (path.name, fh, "application/octet-stream")},
        )
    assert response.status_code == 201, response.text
    return response.json()


def test_report_job_flow_with_html_asset(client, tmp_path):
    """202 → поллинг → результат с html_url → HTML 200 с ETag → повтор 304."""
    edf = _report_edf(tmp_path)
    recording_id = _upload(client, edf)["recording_id"]

    form = {"bands": ",".join(_two_bands()), "epoch_length_ms": "1000", "grid_mm": "7"}
    created = client.post(f"{_PREFIX}/recordings/{recording_id}/report", data=form)
    assert created.status_code == 202, created.text
    job_id = created.json()["job_id"]

    status = _wait_finished(client, job_id, timeout=90.0)
    assert status["status"] == "succeeded", status.get("error")

    result = client.get(f"{_PREFIX}/recordings/{recording_id}/report/{job_id}").json()
    assert result["html_url"] == f"{_PREFIX}/recordings/{recording_id}/report/{job_id}/html"
    assert len(result["bands"]) == len(_two_bands())

    # html_url уже содержит префикс API — не склеиваем его с _PREFIX повторно
    html = client.get(result["html_url"])
    assert html.status_code == 200, html.text[:200]
    assert html.headers["content-type"].startswith("text/html")
    assert "GOF между полосами не сравним" in html.text
    # Тема отчёта вшита в сам HTML: тёмная по data-theme/?theme=, печать — светлая
    assert 'html[data-theme="dark"]' in html.text
    assert "@media print" in html.text
    assert "#diplock-theme-toggle" in html.text
    assert "searchParams.get('theme')" in html.text
    etag = html.headers["etag"]
    assert etag

    cached = client.get(result["html_url"], headers={"If-None-Match": etag})
    assert cached.status_code == 304
    assert cached.content == b""

    # Чужой recording_id задачу не подбирает (как у всех задач записи)
    foreign = client.get(f"{_PREFIX}/recordings/rec-foreign/report/{job_id}")
    assert foreign.status_code == 404

    # Кэш очищен — ассет честно просит пересобрать отчёт
    clear_report_cache(settings, recording_id)
    missing = client.get(result["html_url"])
    assert missing.status_code == 404
    assert "соберите отчёт заново" in missing.json()["detail"]


def test_report_unknown_band_key_is_400(client, tmp_path):
    edf = _report_edf(tmp_path)
    recording_id = _upload(client, edf)["recording_id"]

    response = client.post(
        f"{_PREFIX}/recordings/{recording_id}/report", data={"bands": "omega"},
    )
    assert response.status_code == 400
    assert "Неизвестные полосы" in response.json()["detail"]


def test_report_unknown_recording_is_404(client):
    response = client.post(f"{_PREFIX}/recordings/rec-nope/report")
    assert response.status_code == 404

