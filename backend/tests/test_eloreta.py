"""Тесты eLORETA — пик/ROI распределения одной эпохи (остаток B9, dipoles.md п.5).

Полная MNE-цепочка (forward → inverse → apply_inverse) подменяется фейками —
настоящий прогон на fsaverage интеграционный. Проверяется честность границ:
**не полные карты** (на выходе только пик и ROI-доли), та же нарезка/пик GFP,
что у быстрого расчёта, честные ошибки и отсутствие атласа без падения.
"""
import os
import shutil

import numpy as np
import pytest

from app.core.config import settings
from app.services import eloreta as eloreta_module
from app.services.dipole_scanner import DipoleScanParams, compute_dipole_scan
from app.services.eloreta import EloretaError, EloretaParams, run_eloreta
from app.services.recordings import recording_registry
from tests.test_dipole_scanner import _alpha_edf, _register

_PREFIX = "/api/v1"


@pytest.fixture(autouse=True)
def clean_state():
    """Изоляция реестра записей и каталогов загрузок между тестами."""
    recording_registry.clear()
    root = settings.upload_dir
    before = (
        {n for n in os.listdir(root) if os.path.isdir(os.path.join(root, n))}
        if os.path.isdir(root) else set()
    )
    yield
    recording_registry.clear()
    cache_clear = getattr(eloreta_module._read_src, "cache_clear", None)
    if cache_clear is not None:
        cache_clear()
    if os.path.isdir(root):
        for name in {n for n in os.listdir(root) if os.path.isdir(os.path.join(root, n))} - before:
            shutil.rmtree(os.path.join(root, name), ignore_errors=True)


class _FakeStc:
    """Минимальный контракт ``SourceEstimate``, который читает ``_peak_and_roi``."""

    def __init__(self, data: np.ndarray, lh: np.ndarray, rh: np.ndarray, tstep: float = 0.004):
        self.data = data
        self.vertices = {"lh": lh, "rh": rh}
        self.times = np.arange(data.shape[1]) * tstep


def _fake_src(n_lh: int = 4, n_rh: int = 3) -> list[dict]:
    """Фейковый source space: вершины на прямой X, координаты в метрах (как MNE)."""
    return [
        {
            "id": 101,
            "rr": np.column_stack([np.linspace(-0.06, -0.02, n_lh), np.zeros(n_lh), np.zeros(n_lh)]),
        },
        {
            "id": 102,
            "rr": np.column_stack([np.linspace(0.02, 0.06, n_rh), np.zeros(n_rh), np.zeros(n_rh)]),
        },
    ]


@pytest.fixture
def fake_pipeline(monkeypatch):
    """Подмена MNE-цепочки forward/inverse и атласа: возвращает собранные вызовы."""
    calls: dict[str, object] = {}

    def fake_forward(info, trans=None, src=None, bem=None, **kwargs):
        calls["forward"] = {"trans": trans, "n_channels": len(info["ch_names"])}
        return object()

    def fake_inverse(info, forward, cov, **kwargs):
        calls["inverse"] = True
        return object()

    src = _fake_src()

    def fake_apply(evoked, inverse, lambda2=None, method=None, **kwargs):
        calls["apply"] = {"lambda2": lambda2, "method": method, "n_times": evoked.data.shape[1]}
        # Пик: максимальный |амплитуда| на первой вершине lh в последнем отсчёте.
        # Вершины — индексы в rr, как у настоящего MNE (lh: 0..3, rh: 0..2).
        data = np.zeros((7, evoked.data.shape[1]))
        data[0, -1] = 0.5
        data[4, 0] = -0.1  # «сильная» вершина rh для ROI
        return _FakeStc(data, np.arange(4), np.arange(3))

    import mne as real_mne

    monkeypatch.setattr(eloreta_module, "_get_bem", lambda cfg: object())
    monkeypatch.setattr(eloreta_module, "_get_covariance", lambda cfg: None)
    monkeypatch.setattr(real_mne, "make_forward_solution", fake_forward)
    monkeypatch.setattr(real_mne, "compute_covariance", lambda epochs, **kw: object())
    monkeypatch.setattr(real_mne.minimum_norm, "make_inverse_operator", fake_inverse)
    monkeypatch.setattr(real_mne.minimum_norm, "apply_inverse", fake_apply)
    monkeypatch.setattr(eloreta_module, "src_path", lambda cfg: "/dev/null/fake-src.fif")
    monkeypatch.setattr(eloreta_module, "_read_src", lambda path: src)
    # Атлас: пик атрибутируется, ROI — по фейковым вершинам (X-координаты)
    from app.services import atlas_contours

    monkeypatch.setattr(
        atlas_contours, "attribution_payload",
        lambda cfg, mni: {
            "structure_name": "Left Precentral" if mni[0] < 0 else "Right Precentral",
            "structure_distance_mm": 1.0,
            "area_name": "BA4",
            "area_distance_mm": 2.0,
            "outside_brain": False,
        },
    )

    class _FakeVolumes:
        pass

    monkeypatch.setattr(atlas_contours, "_ContourCtx", type("C", (), {"from_settings": classmethod(lambda cls, cfg: cfg)}))
    monkeypatch.setattr(atlas_contours, "load_volumes", lambda ctx: _FakeVolumes())
    monkeypatch.setattr(
        atlas_contours, "nearest_structure",
        lambda volumes, mni: ("Left Precentral" if mni[0] < 0 else "Right Precentral", 1.0),
    )
    return calls


def _params(epoch_index: int = 0, halfwin_ms: float = 0.0) -> EloretaParams:
    return EloretaParams(
        scan=DipoleScanParams(filter_band=(1, 40), epoch_length_ms=1000.0),
        epoch_index=epoch_index,
        halfwin_ms=halfwin_ms,
    )


def test_eloreta_returns_peak_and_roi_not_full_maps(tmp_path, fake_pipeline):
    """Главный контракт п.5: пик + ROI-доли, никаких полных карт stc."""
    recording = _register(tmp_path, _alpha_edf(tmp_path), "rec-eloreta")
    result = run_eloreta(recording, settings, _params())

    assert result["method"] == "eloreta"
    assert result["recording_id"] == "rec-eloreta"
    # Пик: координата из фейкового src (vertno 0 → rr[0] = [-60, 0, 0] мм)
    peak = result["peak"]
    assert peak["mni_mm"] == pytest.approx([-60.0, 0.0, 0.0])
    assert peak["value"] == pytest.approx(0.5)
    assert peak["structure_name"] == "Left Precentral"
    assert peak["area_name"] == "BA4"
    assert peak["outside_brain"] is False
    # ROI: доли энергии по структурам, сумма долей + «прочие» ≤ 1
    roi = result["roi"]
    assert roi, "ROI-доли обязаны быть посчитаны"
    assert all(0.0 < row["share"] <= 1.0 for row in roi)
    assert sum(row["share"] for row in roi) + result["other_share"] <= 1.000001
    # Полных карт в контракте нет: только пик и доли (n_sources — размер src)
    assert result["n_sources"] == 7
    assert set(result) == {
        "recording_id", "method", "epoch_index", "time_ms", "window_ms",
        "halfwin_ms", "peak", "roi", "other_share", "n_sources", "n_channels",
        "lambda2", "warnings", "duration_sec_calc",
    }
    # Регуляризация пришла из конфига, apply_inverse вызван с eLORETA
    assert result["lambda2"] == pytest.approx(settings.eloreta_lambda2)
    assert fake_pipeline["apply"]["method"] == "eLORETA"
    assert fake_pipeline["apply"]["lambda2"] == pytest.approx(settings.eloreta_lambda2)
    # Предупреждение-кавет обязано сопровождать результат (не «тихая» замена фита)
    assert any("не замена точечного фита" in warning for warning in result["warnings"])


def test_eloreta_uses_scan_epoch_and_gfp_window(tmp_path, fake_pipeline):
    """Та же нарезка/пик GFP, что у быстрого расчёта; окно по halfwin_ms."""
    recording = _register(tmp_path, _alpha_edf(tmp_path), "rec-eloreta-epoch")
    scan = compute_dipole_scan(recording, settings, _params().scan)
    epoch_index = int(scan["points"][1]["epoch_index"])

    result = run_eloreta(recording, settings, _params(epoch_index, halfwin_ms=8.0))

    assert result["epoch_index"] == epoch_index
    # Пик GFP совпадает с быстрым расчётом (эпоха та же, окно симметрично)
    assert result["time_ms"] == pytest.approx(scan["points"][1]["time_ms"])
    # Окно ±8 мс при 250 Гц → ±2 отсчёта → 5 отсчётов (2+1+2)
    assert fake_pipeline["apply"]["n_times"] == 5
    assert result["halfwin_ms"] == 8.0
    assert result["window_ms"][0] < result["window_ms"][1]


def test_eloreta_epoch_out_of_range_is_clear_error(tmp_path, fake_pipeline):
    """Несуществующая эпоха — понятный текст, а не IndexError."""
    recording = _register(tmp_path, _alpha_edf(tmp_path), "rec-eloreta-bad-epoch")
    with pytest.raises(EloretaError, match="нет"):
        run_eloreta(recording, settings, _params(999))


def test_eloreta_without_atlas_keeps_peak_and_warns(tmp_path, fake_pipeline, monkeypatch):
    """Атлас недоступен: пик остаётся координатами, ROI пуст — и warning."""
    from app.services import atlas_contours

    def _boom(ctx):
        raise RuntimeError("нет атласа (фейк)")

    monkeypatch.setattr(atlas_contours, "load_volumes", _boom)
    recording = _register(tmp_path, _alpha_edf(tmp_path), "rec-eloreta-no-atlas")
    result = run_eloreta(recording, settings, _params())

    assert result["peak"]["mni_mm"] == pytest.approx([-60.0, 0.0, 0.0])
    # Атрибуция пика живёт отдельным вызовом — она не упала
    assert result["peak"]["structure_name"] == "Left Precentral"
    assert result["roi"] == []
    assert result["other_share"] == pytest.approx(1.0)
    assert any("ROI-доли не посчитаны" in warning for warning in result["warnings"])


def test_eloreta_job_flow(client, tmp_path, fake_pipeline):
    """202 → поллинг → результат по result_url; чужой kind не отдаётся."""
    from tests.test_dipole_scanner import _wait_finished

    recording = _register(tmp_path, _alpha_edf(tmp_path), "rec-eloreta-job")
    created = client.post(
        f"{_PREFIX}/recordings/{recording.recording_id}/eloreta",
        data={"epoch_index": 1, "band_min": 1, "band_max": 40, "epoch_length_ms": 1000},
    )
    assert created.status_code == 202, created.text
    job_id = created.json()["job_id"]

    status = _wait_finished(client, job_id)
    assert status["status"] == "succeeded", status
    assert status["kind"] == "eloreta"

    body = client.get(status["result_url"]).json()
    assert body["method"] == "eloreta"
    assert body["epoch_index"] == 1
    assert len(body["peak"]["mni_mm"]) == 3
    assert body["roi"]
    # Результат чужого вида задачи этой записью не отдаётся
    assert client.get(
        f"{_PREFIX}/recordings/{recording.recording_id}/dipoles/{job_id}",
    ).status_code == 404
    # Отрицательный номер эпохи — 422 схемой формы
    assert client.post(
        f"{_PREFIX}/recordings/{recording.recording_id}/eloreta",
        data={"epoch_index": -1},
    ).status_code == 422


def test_eloreta_form_window_is_validated(client, tmp_path, fake_pipeline):
    """halfwin_ms из формы валидируется тем же правилом, что у «Уточнить» (1.5)."""
    from tests.test_dipole_scanner import _wait_finished

    recording = _register(tmp_path, _alpha_edf(tmp_path), "rec-eloreta-window")
    url = f"{_PREFIX}/recordings/{recording.recording_id}/eloreta"
    too_wide = client.post(url, data={"epoch_index": 0, "halfwin_ms": 999})
    assert too_wide.status_code == 400, too_wide.text
    assert "halfwin_ms" in too_wide.json()["detail"]

    limit = settings.dipole_refine_halfwin_max_ms
    created = client.post(url, data={"epoch_index": 0, "halfwin_ms": limit})
    assert created.status_code == 202, created.text
    status = _wait_finished(client, created.json()["job_id"])
    assert status["status"] == "succeeded", status
    body = client.get(status["result_url"]).json()
    assert body["halfwin_ms"] == limit
