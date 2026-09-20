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


@pytest.fixture
def failing_free_fit(monkeypatch):
    """Свободный фит падает, оценка узла на BEM работает (шаг 1.5).

    Так выглядит реальный случай из файла задачи: узел сферической сетки оказался
    на 0.3 мм вне внутренней границы черепа, фиксированный вызов отказал. Проверяем
    и обратный порядок: падает именно **второй** (свободный) вызов, а первый
    (дешёвый) отдаёт «стало».
    """
    calls: list[dict] = []

    def fake(evoked, cov, bem, trans=None, min_dist=5.0, n_jobs=None, pos=None, verbose=None):
        calls.append({"pos": pos, "n_times": int(evoked.data.shape[1])})
        if pos is None:
            raise RuntimeError("не сошёлся свободный фит (фейк)")
        return _FakeDipole(evoked.data.shape[1], pos_m=pos), None

    monkeypatch.setattr(dipole_scanner.mne, "fit_dipole", fake)
    monkeypatch.setattr(dipole_scanner, "_get_bem", lambda cfg: object())
    monkeypatch.setattr(dipole_scanner, "_get_covariance", lambda cfg: object())
    return calls


def _params(epoch_index: int = 0, halfwin_ms: float = 0.0) -> DipoleRefineParams:
    """Параметры уточнения: окно по умолчанию 0 — фитится только пик GFP."""
    return DipoleRefineParams(
        scan=DipoleScanParams(filter_band=(1, 40), epoch_length_ms=1000.0),
        epoch_index=epoch_index,
        halfwin_ms=halfwin_ms,
    )


def test_refine_repeats_scan_epoch_and_grid_start(tmp_path, fake_fit):
    """Уточнение попадает в ту же эпоху/пик, а первым идёт дешёвый фит узла (1.5)."""
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
    # fit_dipole вызван дважды, и ПЕРВЫМ — фит узла с фиксированной позицией:
    # он стоит ≈0.5 с против ≈8 с + ≈7 с на отсчёт у свободного (замер 20.09.2026)
    assert len(fake_fit) == 2
    fixed, free = fake_fit
    assert fixed["pos"] is not None
    assert np.allclose(
        np.asarray(fixed["pos"]) * 1000.0, result["fast_head_coords"], atol=1e-6,
    )
    assert free["pos"] is None
    # Окно по умолчанию — только пик GFP (один отсчёт), а не вся эпоха и не ±10 мс
    assert result["halfwin_ms"] == 0.0
    assert fixed["n_times"] == 1
    assert free["n_times"] == 1
    assert result["free_fit"] is True
    # «Стало»: точка из фейка, метод помечен, сдвиг посчитан
    assert result["method"] == "bem_fit"
    # GOF нормализован в долю 0..1 (MNE прислал проценты: 50.0 → 0.5)
    assert result["grid_gof_bem"] == pytest.approx(0.5)
    assert result["point"]["gof"] == pytest.approx(0.5)
    assert result["point"]["head_coords"] == pytest.approx([12.0, 24.0, 56.0])
    assert result["shift_mm"] >= 0.0


def test_refine_window_comes_from_params(tmp_path, fake_fit):
    """Окно свободного фита берётся из параметров, а не из конфига (шаг 1.5)."""
    recording = _register(tmp_path, _alpha_edf(tmp_path), "rec-refine-window")
    scan = compute_dipole_scan(recording, settings, _params().scan)
    epoch_index = int(scan["points"][0]["epoch_index"])

    result = refine_dipole_point(
        recording, settings, _params(epoch_index, halfwin_ms=10.0),
    )

    # Синтетика идёт на 250 Гц: ±10 мс — это 5 отсчётов; у края эпохи окно
    # зажимается границей, поэтому проверяем «не шире» и согласованность
    expected = 2 * round(10.0 / 1000.0 * 250.0) + 1
    n_times = fake_fit[0]["n_times"]
    assert 1 <= n_times <= expected
    assert fake_fit[1]["n_times"] == n_times
    assert result["halfwin_ms"] == 10.0
    # window_ms описывает ровно то окно, по которому шёл фит
    span_ms = result["window_ms"][1] - result["window_ms"][0]
    assert span_ms == pytest.approx((n_times - 1) * 1000.0 / 250.0, abs=1e-6)


def test_refine_keeps_grid_estimate_when_free_fit_fails(tmp_path, failing_free_fit):
    """Сбой свободного фита не уносит задачу: остаётся оценка узла на BEM (1.5)."""
    recording = _register(tmp_path, _alpha_edf(tmp_path), "rec-refine-fallback")

    result = refine_dipole_point(recording, settings, _params(0))

    assert result["free_fit"] is False
    assert result["grid_gof_bem"] == pytest.approx(0.5)
    assert result["point"]["gof"] == pytest.approx(0.5)
    # «Стало» — тот же узел сетки: сдвиг нулевой, а не выдуманный
    assert result["shift_mm"] == 0.0
    assert result["point"]["head_coords"] == pytest.approx(result["fast_head_coords"])
    assert any("Свободный фит окна не выполнен" in warning for warning in result["warnings"])


def test_refine_reports_error_when_both_fits_fail(tmp_path, monkeypatch):
    """Ни свободного фита, ни оценки узла — честная ошибка, а не пустое «стало»."""
    def boom(*args, **kwargs):
        raise RuntimeError("fixed position is 0.3mm outside the inner skull boundary")

    monkeypatch.setattr(dipole_scanner.mne, "fit_dipole", boom)
    monkeypatch.setattr(dipole_scanner, "_get_bem", lambda cfg: object())
    monkeypatch.setattr(dipole_scanner, "_get_covariance", lambda cfg: object())
    recording = _register(tmp_path, _alpha_edf(tmp_path), "rec-refine-both-fail")

    with pytest.raises(DipoleScanError, match="Точный фитинг не выполнен"):
        refine_dipole_point(recording, settings, _params(0))


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


def test_refine_form_window_is_validated(client, tmp_path, fake_fit):
    """Окно уточнения из формы: 0…предел конфига, дальше — 400 с текстом (1.5).

    Каждый лишний отсчёт окна стоит ≈7 с, поэтому «широкое окно» — это значение
    из формы, а не молчаливый дефолт; выход за предел обязан объясниться.
    """
    from tests.test_dipole_scanner import _wait_finished

    recording = _register(tmp_path, _alpha_edf(tmp_path), "rec-refine-window-form")
    url = f"{_PREFIX}/recordings/{recording.recording_id}/dipole_refine"

    too_wide = client.post(url, data={"epoch_index": 0, "halfwin_ms": 999})
    assert too_wide.status_code == 400, too_wide.text
    assert "halfwin_ms" in too_wide.json()["detail"]
    negative = client.post(url, data={"epoch_index": 0, "halfwin_ms": -1})
    assert negative.status_code == 400, negative.text

    # Предел конфига принимается, и окно доезжает до результата
    limit = settings.dipole_refine_halfwin_max_ms
    created = client.post(url, data={"epoch_index": 0, "halfwin_ms": limit})
    assert created.status_code == 202, created.text
    status = _wait_finished(client, created.json()["job_id"])
    assert status["status"] == "succeeded", status
    body = client.get(status["result_url"]).json()
    assert body["halfwin_ms"] == limit
    assert body["free_fit"] is True


def test_refine_default_window_is_peak_and_meta_declares_cost(client, tmp_path, fake_fit):
    """Дефолт окна — только пик GFP (0), а /meta объявляет цену уточнения (1.5)."""
    from tests.test_dipole_scanner import _wait_finished

    meta = client.get(f"{_PREFIX}/meta").json()
    assert meta["dipole_refine_halfwin_ms"] == 0.0
    assert meta["dipole_refine_halfwin_max_ms"] > 0.0
    assert meta["dipole_refine_sec_fixed"] > 0.0
    assert meta["dipole_refine_sec_per_sample"] > 0.0

    recording = _register(tmp_path, _alpha_edf(tmp_path), "rec-refine-default-window")
    created = client.post(
        f"{_PREFIX}/recordings/{recording.recording_id}/dipole_refine",
        data={"epoch_index": 0},
    )
    status = _wait_finished(client, created.json()["job_id"])
    body = client.get(status["result_url"]).json()
    assert body["halfwin_ms"] == meta["dipole_refine_halfwin_ms"]
