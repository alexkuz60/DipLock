"""Тесты точного уточнения эпохи (`refine_dipole_point`, kind=dipole_refine).

BEM-фитинг подменяется фейком `mne.fit_dipole` (настоящий BEM fsaverage —
интеграционная ветка): проверяется, что уточнение повторяет нарезку быстрого
расчёта (та же эпоха, тот же пик GFP, тот же узел сетки), что узел уходит во
второй вызов с фиксированной `pos` (GOF сетки на BEM), и что ошибки читаемы.
"""
import os
import shutil

import numpy as np
import pytest

from app.core.config import settings
from app.services import dipole_scanner
from app.services.dipole_scanner import (
    DipoleRefineParams,
    DipoleScanError,
    DipoleScanParams,
    compute_dipole_scan,
    refine_dipole_point,
)
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
    if os.path.isdir(root):
        for name in {n for n in os.listdir(root) if os.path.isdir(os.path.join(root, n))} - before:
            shutil.rmtree(os.path.join(root, name), ignore_errors=True)


class _FakeDipole:
    """Минимальный контракт `mne.Dipole`, который читает refine.

    `gof` — в ПРОЦЕНТАХ, как у настоящего MNE (`dipole.py`: `* 100`): фейк,
    повторявший наш контракт 0..1, пропустил бы баг нормализации (и пропустил:
    GOF 7566.7% в UI). Поэтому здесь — поведение MNE, а не схемы проекта.
    """

    def __init__(self, n_times: int, pos_m: np.ndarray | None = None):
        base = np.array([0.012, 0.024, 0.056]) if pos_m is None else np.asarray(pos_m, dtype=float)
        self.pos = np.tile(base, (n_times, 1))
        self.ori = np.tile(np.array([0.0, 0.0, 1.0]), (n_times, 1))
        self.amplitude = np.full(n_times, 12e-9)
        self.gof = np.linspace(50.0, 93.0, n_times)  # проценты, как у MNE
        self.times = np.linspace(0.0, 0.02, n_times)


@pytest.fixture
def fake_fit(monkeypatch):
    """Подмена BEM и fit_dipole: возвращает список вызовов для проверок."""
    calls: list[dict] = []

    def fake(evoked, cov, bem, trans=None, min_dist=5.0, n_jobs=None, pos=None, verbose=None):
        calls.append({"pos": pos, "n_times": int(evoked.data.shape[1]), "tmin": float(evoked.tmin)})
        return _FakeDipole(evoked.data.shape[1], pos_m=pos), None

    monkeypatch.setattr(dipole_scanner.mne, "fit_dipole", fake)
    monkeypatch.setattr(dipole_scanner, "_get_bem", lambda cfg: object())
    monkeypatch.setattr(dipole_scanner, "_get_covariance", lambda cfg: object())
    return calls


def _params(epoch_index: int = 0) -> DipoleRefineParams:
    return DipoleRefineParams(
        scan=DipoleScanParams(filter_band=(1, 40), epoch_length_ms=1000.0),
        epoch_index=epoch_index,
    )


def test_refine_repeats_scan_epoch_and_grid_start(tmp_path, fake_fit):
    """Уточнение попадает в ту же эпоху/пик GFP и стартует с того же узла сетки."""
    recording = _register(tmp_path, _alpha_edf(tmp_path), "rec-refine")
    scan = compute_dipole_scan(recording, settings, _params().scan)
    epoch_index = int(scan["points"][1]["epoch_index"])

    result = refine_dipole_point(recording, settings, _params(epoch_index))

    # «Было» совпадает с точкой быстрого расчёта в точности — та же нарезка
    fast_point = scan["points"][1]
    assert result["epoch_index"] == epoch_index
    assert result["time_ms"] == pytest.approx(fast_point["time_ms"])
    assert result["fast_head_coords"] == pytest.approx(fast_point["head_coords"])
    assert result["fast_gof"] == pytest.approx(fast_point["gof"])
    # fit_dipole вызван дважды: свободный + фиксированная позиция узла сетки
    assert len(fake_fit) == 2
    fixed = fake_fit[1]
    assert fixed["pos"] is not None
    assert np.allclose(
        np.asarray(fixed["pos"]) * 1000.0, result["fast_head_coords"], atol=1e-6,
    )
    # Окно фитинга — маленькое (±dipole_refine_halfwin_ms), не вся эпоха
    n_times = fake_fit[0]["n_times"]
    assert n_times <= 2 * round(settings.dipole_refine_halfwin_ms / 1000.0 * 250.0) + 1
    # «Стало»: точка из фейка, метод помечен, сдвиг посчитан
    assert result["method"] == "bem_fit"
    # GOF нормализован в долю 0..1 (MNE прислал проценты: 93.0 → 0.93)
    assert result["grid_gof_bem"] is not None
    assert 0.0 <= result["grid_gof_bem"] <= 1.0
    # Окно симметрично: пик — средний отсчёт, linspace(50, 93) → 71.5 % → 0.715
    assert result["grid_gof_bem"] == pytest.approx(0.715)
    assert result["point"]["gof"] == pytest.approx(0.93)
    assert result["point"]["head_coords"] == pytest.approx([12.0, 24.0, 56.0])
    assert result["shift_mm"] >= 0.0


def test_refine_epoch_out_of_range_is_clear_error(tmp_path, fake_fit):
    """Номер эпохи вне нарезки — понятная ошибка с фактическим числом эпох."""
    recording = _register(tmp_path, _alpha_edf(tmp_path), "rec-refine-oob")
    with pytest.raises(DipoleScanError, match="Эпохи №99 нет"):
        refine_dipole_point(recording, settings, _params(98))


def test_refine_without_bem_explains_itself(tmp_path, monkeypatch):
    """Нет BEM fsaverage — честный отказ, быстрый результат не тронут."""
    def no_bem(cfg):
        raise FileNotFoundError("нет bem-sol.fif")

    monkeypatch.setattr(dipole_scanner, "_get_bem", no_bem)
    recording = _register(tmp_path, _alpha_edf(tmp_path), "rec-refine-nobem")
    with pytest.raises(DipoleScanError, match="BEM-решение fsaverage"):
        refine_dipole_point(recording, settings, _params(0))


def test_refine_job_flow(client, tmp_path, fake_fit):
    """202 → поллинг → «было/стало» по result_url; чужой kind не отдаётся."""
    from tests.test_dipole_scanner import _wait_finished

    recording = _register(tmp_path, _alpha_edf(tmp_path), "rec-refine-job")
    created = client.post(
        f"{_PREFIX}/recordings/{recording.recording_id}/dipole_refine",
        data={"epoch_index": 1, "band_min": 1, "band_max": 40, "epoch_length_ms": 1000},
    )
    assert created.status_code == 202, created.text
    job_id = created.json()["job_id"]

    status = _wait_finished(client, job_id)
    assert status["status"] == "succeeded", status
    assert status["kind"] == "dipole_refine"

    result = client.get(status["result_url"])
    assert result.status_code == 200, result.text
    body = result.json()
    assert body["method"] == "bem_fit"
    assert body["epoch_index"] == 1
    assert len(body["fast_head_coords"]) == 3
    assert 0.0 <= body["point"]["gof"] <= 1.0
    assert body["shift_mm"] >= 0.0
    # Результат чужого вида задачи этой записью не отдаётся
    assert client.get(
        f"{_PREFIX}/recordings/{recording.recording_id}/dipoles/{job_id}"
    ).status_code == 404
    # Отрицательный номер эпохи — 422 схемой формы
    assert client.post(
        f"{_PREFIX}/recordings/{recording.recording_id}/dipole_refine",
        data={"epoch_index": -1},
    ).status_code == 422
    # Несуществующая эпоха — задача падает с понятным текстом (не 500-молчанием)
    created = client.post(
        f"{_PREFIX}/recordings/{recording.recording_id}/dipole_refine",
        data={"epoch_index": 999, "epoch_length_ms": 1000},
    )
    failed = _wait_finished(client, created.json()["job_id"])
    assert failed["status"] == "failed"
    assert "Эпохи №1000 нет" in (failed["error"] or "")
