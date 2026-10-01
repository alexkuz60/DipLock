"""Полный пайплайн на реальном EDF — задача «Тестовый EDF» (маркер `integration`).

Задача `todo.md` «Тестовый EDF»: проверка полного пайплайна на `data/edf/test.edf`
(130.7 с, 500 Гц, 18 каналов, без аннотаций/стим-каналов — событийная ветка ERP
здесь не покрывается, её держат синтетические тесты). Обычные юнит-тесты
подменяют пайплайн быстрой заготовкой (`test_api_contract.py`), здесь считается
настоящий код:

* ``POST /analyze`` — все стадии ``PIPELINE_STAGES``: load_edf → artifacts →
  filter → epochs → band_power → dipoles → localize + контракт
  ``AnalyzeResponse``;
* ``POST /jobs`` — та же работа job-путём UI (202 → поллинг → результат);
* цепочка стадий записи ``run_preprocess`` (filter → artifacts → epochs) и
  регресс п.5 01.10.2026: ``flat_line`` на δ-полосе реального ``test.edf`` равен
  0 (до лечения было 293 ложных зоны).

Локализация (MNI/структуры/BA) читает fsaverage из ``~/mne_data`` — без локальных
научных данных тесты скипаются (маркер `integration`, CI их не гоняет; см.
``docs/rules/tests.md``). Запись одна, поэтому ассерты — инварианты («> 0»,
«= 0 для flat_line», схема), а не конкретные значения; хронометраж прогона —
``docs/history.md`` (01.10.2026).
"""
import io
import os
import shutil
import time

import pytest

from app.core.config import settings
from app.schemas.analysis import AnalyzeResponse
from app.services.preprocess import PreprocessParams, run_preprocess
from app.services.recordings import recording_registry
from tests.test_api_contract import _PREFIX, _wait_finished

# DipLock/data/edf/test.edf (backend/tests -> backend -> DipLock) — та же
# конвенция пути, что в `test_edf_loader.py`.
_REAL_EDF = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "data", "edf", "test.edf")
)

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(not os.path.exists(_REAL_EDF), reason="test.edf отсутствует"),
]

# Дефолт формы /analyze: 2000 мс и «все частоты» — ветка, которой пользуется UI.
_FORM: dict[str, float | str] = {"epoch_length_ms": 2000.0, "freq_band": "all"}


@pytest.fixture
def bounded_fit(monkeypatch):
    """Ограничивает фитинг диполей продуктовыми настройками.

    На дефолтах (все 42 эпохи, `decim=5` → 200 точек, `n_jobs=1`) стадия
    `dipoles` на test.edf не завершается и за **16 мин** (замер 01.10.2026,
    два прогона остановлены; докстринг `fit_dipoles_for_epochs`: «на дефолтах
    расчёт идёт часами» — F19). Дорога каждый вызов `mne.fit_dipole` на эпоху
    (сетка guess-решений ~20 мм: forward + SVD по всем позициям), поэтому
    экономят число эпох (`dipole_fit_max_epochs`), точек времени
    (`dipole_fit_decim`) и ядра (`dipole_fit_n_jobs`). Капы — штатные настройки
    `settings`, а не обход: все стадии пайплайна (включая `dipoles` и `localize`
    — MNI/структуры/BA из fsaverage) отрабатывают на реальных данных.
    """
    monkeypatch.setattr(settings, "dipole_fit_max_epochs", 2)
    monkeypatch.setattr(settings, "dipole_fit_decim", 50)  # 200 → 20 точек/эпоху
    monkeypatch.setattr(settings, "dipole_fit_n_jobs", min(8, os.cpu_count() or 1))


def _upload() -> dict:
    """Multipart-загрузка реального test.edf (в памяти, как у TestClient)."""
    with open(_REAL_EDF, "rb") as fh:
        content = fh.read()
    return {"file": ("test.edf", io.BytesIO(content), "application/octet-stream")}


def _assert_full_pipeline(body: AnalyzeResponse) -> None:
    """Инварианты полного пайплайна на реальной записи (без конкретных чисел)."""
    # паспорт записи
    assert body.sfreq == pytest.approx(500.0)
    assert body.duration_sec == pytest.approx(130.7, abs=1.0)
    assert body.n_channels > 0
    # эпохи: нарезано (все, включая отброшенные) и прошло reject-фильтр.
    # `len(epochs) == n_epochs_total` — страж семантики «все» = drop_log, а не
    # .events (баг, пойманный этим тестом 01.10.2026, см. analysis_pipeline).
    assert body.n_epochs_total > 0
    assert 0 < body.n_epochs_used <= body.n_epochs_total
    assert len(body.epochs) == body.n_epochs_total
    assert body.n_epochs_dropped == body.n_epochs_total - body.n_epochs_used
    # артефакты и спектр
    assert body.n_artifacts >= 0
    assert body.frequency_powers
    # диполи: фитинг дал хотя бы одну эпоху
    assert body.n_dipole_fit > 0
    assert body.best_fit_dipoles
    # локализация (fsaverage → MNI/структуры/BA) заполнена
    for point in body.best_fit_dipoles:
        assert point.mni_x is not None and point.mni_y is not None and point.mni_z is not None
        assert point.anatomical_roi
    assert any(point.brodmann_area for point in body.best_fit_dipoles)
    # контракт surface/provenance
    assert body.surface.url == f"{_PREFIX}/surface"
    assert body.pipeline.app_version == settings.app_version
    assert body.pipeline.epoch_length_ms == 2000.0


def test_analyze_full_pipeline_on_real_edf(client, isolated_io, bounded_fit):
    """``POST /analyze``: настоящий пайплайн по всем стадиям на test.edf."""
    started = time.perf_counter()
    r = client.post(f"{_PREFIX}/analyze", files=_upload(), data=_FORM)
    elapsed = time.perf_counter() - started
    assert r.status_code == 200, r.text

    body = AnalyzeResponse.model_validate(r.json())
    _assert_full_pipeline(body)

    # загрузка удалена и после успеха (F10)
    assert list((isolated_io / "edf").iterdir()) == []
    print(f"\n[хронометраж] POST /analyze на test.edf: {elapsed:.1f} с", flush=True)


def test_job_full_pipeline_on_real_edf(client, isolated_io, bounded_fit):
    """``POST /jobs``: та же работа job-путём UI — 202 → поллинг → результат."""
    created = client.post(f"{_PREFIX}/jobs", files=_upload(), data=_FORM)
    assert created.status_code == 202, created.text
    job_id = created.json()["job_id"]

    started = time.perf_counter()
    status = _wait_finished(client, job_id, timeout=300.0)
    elapsed = time.perf_counter() - started
    assert status["status"] == "succeeded", status
    assert status["stage"] == "done" and status["progress"] == 1.0
    assert status["result_url"] == f"{_PREFIX}/jobs/{job_id}/result"

    result = client.get(f"{_PREFIX}/jobs/{job_id}/result")
    assert result.status_code == 200, result.text
    body = AnalyzeResponse.model_validate(result.json())
    _assert_full_pipeline(body)
    print(f"\n[хронометраж] POST /jobs (поллинг до succeeded) на test.edf: {elapsed:.1f} с",
          flush=True)


def test_preprocess_stages_on_real_edf(isolated_io):
    """Цепочка стадий записи на реальном EDF + регресс п.5 (flat_line на δ).

    ``filter`` (широкий 0.5–128) → ``artifacts`` (без фильтра и на δ-полосе) →
    ``epochs`` (2000 мс) — те же стадии, что кнопка «Пересчитать предподготовку»
    в UI; подготовленный сигнал кэшируется, поэтому EDF читается один раз на
    набор параметров (A4).
    """
    upload = isolated_io / "edf"
    upload.mkdir(parents=True, exist_ok=True)
    target = upload / "test.edf"
    shutil.copyfile(_REAL_EDF, target)
    recording = recording_registry.register(target, str(upload), "test.edf", settings)

    def _noop(*_args, **_kwargs) -> None:
        return None

    try:
        started = time.perf_counter()

        # Стадия `filter`: паспорт FIR-фильтра (N11/N12) на широкой полосе
        filt = run_preprocess(
            recording, settings,
            PreprocessParams(stage="filter", filter_band=(0.5, 128.0)), _noop,
        )
        assert filt["band_hz"] == [0.5, 128.0]
        assert filt["filter_method"] and filt["filter_length_sec"] > 0
        assert filt["edge_buffer_sec"] > 0  # краевой буфер BAD_edge обязан быть заявлен

        # Стадия `artifacts`: QC-числа на широкополосном сигнале
        art = run_preprocess(recording, settings, PreprocessParams(stage="artifacts"), _noop)
        assert 0.0 <= art["good_data_percent"] <= 100.0
        assert isinstance(art["artifact_types"], dict)
        assert art["channel_qc"]

        # Регресс п.5 (01.10.2026): на δ-полосе flat_line обязан считаться через
        # широкополосный сигнал — на test.edf это 0 зон (до лечения было 293).
        art_delta = run_preprocess(
            recording, settings,
            PreprocessParams(stage="artifacts", filter_band=(0.5, 4.0)), _noop,
        )
        assert art_delta["artifact_types"].get("flat_line", 0) == 0
        # живой замер 01.10.2026: good_data_percent 97.2% (запись «чистая»)
        assert art_delta["good_data_percent"] > 90.0

        # Стадия `epochs`: нарезка и reject по BAD_ (без полосы — edge-буфера нет)
        epochs = run_preprocess(
            recording, settings, PreprocessParams(stage="epochs", epoch_length_ms=2000.0), _noop,
        )
        assert epochs["n_epochs_total"] > 0
        assert 0 < epochs["n_epochs_used"] <= epochs["n_epochs_total"]

        elapsed = time.perf_counter() - started
        print(f"\n[хронометраж] цепочка preprocess (4 стадии) на test.edf: {elapsed:.1f} с")
    finally:
        recording_registry.clear()
