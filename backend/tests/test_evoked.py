"""Задача ERP-усреднения по событиям (kind='evoked', шаг 2.7).

Стимул → эпоха → усреднение: усреднённая волна по каналам вокруг события с
честными числами ``n_used``/``n_total`` и baseline-коррекцией. Отбраковка —
та же, что в стадии «Нарезка эпох» (``BAD_``-аннотации, включая файловые).
"""
import shutil
import time

import numpy as np
import pytest

from app.api.params import evoked_params
from app.core.config import settings
from app.services.evoked import EvokedError, EvokedParams, run_evoked
from app.services.preprocess import PreprocessParams
from app.services.recordings import recording_registry
from tests.conftest import write_minimal_edf

_PREFIX = "/api/v1"


@pytest.fixture(autouse=True)
def clean_state():
    recording_registry.clear()
    yield
    recording_registry.clear()


def _register(tmp_path, edf_file, recording_id="rec-evoked"):
    upload_dir = tmp_path / recording_id
    upload_dir.mkdir(parents=True, exist_ok=True)
    target = upload_dir / edf_file.name
    shutil.copyfile(edf_file, target)
    return recording_registry.register(str(target), str(upload_dir), edf_file.name, settings)


def _tal_file(tmp_path, name, annotations):
    """EDF+ 4 с: синусы ~20 мкВ и заданные аннотации (STIM/5 в 1.0 и 3.0 с)."""
    path = tmp_path / name
    sfreq = 250.0
    t = np.arange(int(4 * sfreq)) / sfreq
    data = np.vstack([np.sin(2 * np.pi * (6 + i) * t) * 20 for i in range(5)])
    write_minimal_edf(
        path, list(settings.standard_channels[:5]), data, sfreq, annotations=annotations,
    )
    return path


@pytest.fixture
def tal_edf(tmp_path):
    return _tal_file(tmp_path, "tal.edf", [(1.0, 0.0, "STIM/5"), (3.0, 0.0, "STIM/5")])


def _params(event_id="STIM/5", pre=200.0, post=800.0, baseline=None) -> EvokedParams:
    start, end = baseline if baseline else (None, None)
    return EvokedParams(
        preprocess=PreprocessParams(
            stage="epochs",
            epoch_mode="events", event_id=event_id,
            epoch_pre_ms=pre, epoch_post_ms=post,
        ),
        baseline_start_ms=start,
        baseline_end_ms=end,
    )


def test_run_evoked_averages_events(tmp_path, tal_edf):
    """Усреднение по событиям: волна [канал][время], ось от события, числа честные."""
    recording = _register(tmp_path, tal_edf)

    result = run_evoked(recording, settings, _params(), progress=lambda *_, **__: None)

    assert result["event_id"] == "STIM/5"
    assert result["n_total"] == 2
    assert result["n_used"] == 2
    assert result["rejected_epochs"] == []
    assert result["tmin"] == pytest.approx(-0.2)
    assert result["tmax"] == pytest.approx(0.8)
    assert result["times"][0] == pytest.approx(-0.2)
    assert result["times"][-1] == pytest.approx(0.8, abs=0.01)
    assert result["channels"] == list(settings.standard_channels[:5])
    assert len(result["data_uv"]) == 5
    assert len(result["data_uv"][0]) == len(result["times"])
    assert result["baseline"] is None
    # Волна в µV: порядок величин синтетики (~20 мкВ), а не вольты
    assert max(abs(v) for v in result["data_uv"][0]) < 1000.0


def test_run_evoked_baseline_correction(tmp_path, tal_edf):
    """Baseline (−200…0 мс): среднее по baseline-окну после коррекции ≈ 0."""
    recording = _register(tmp_path, tal_edf)

    result = run_evoked(
        recording, settings,
        _params(baseline=(-200.0, 0.0)),
        progress=lambda *_, **__: None,
    )

    assert result["baseline"] == [-0.2, 0.0]
    times = np.array(result["times"])
    baseline_mask = (times >= -0.2) & (times <= 0.0)
    for channel in result["data_uv"]:
        assert np.mean(np.array(channel)[baseline_mask]) == pytest.approx(0.0, abs=0.01)


def test_run_evoked_counts_rejected(tmp_path):
    """Файловая BAD_-зона роняет одно событие: n_used=1 из 2, индекс в rejected."""
    path = _tal_file(
        tmp_path, "tal-bad.edf",
        [
            (1.0, 0.0, "STIM/5"), (3.0, 0.0, "STIM/5"),
            (1.05, 0.1, "BAD_file_zone"),
        ],
    )
    recording = _register(tmp_path, path, recording_id="rec-bad")

    result = run_evoked(recording, settings, _params(), progress=lambda *_, **__: None)

    assert result["n_total"] == 2
    assert result["n_used"] == 1
    assert result["rejected_epochs"] == [0]
    assert any("Отброшено событий" in w for w in result["warnings"])


def test_run_evoked_unknown_event_raises(tmp_path, tal_edf):
    """Неизвестное событие — текст с перечнем доступных, а не падение MNE."""
    recording = _register(tmp_path, tal_edf)
    with pytest.raises(EvokedError, match="не найдены"):
        run_evoked(
            recording, settings,
            _params(event_id="STIM/9"),
            progress=lambda *_, **__: None,
        )


def test_evoked_params_baseline_validation():
    """Baseline: пара значений внутри окна эпохи, иначе 400 с текстом."""
    from fastapi import HTTPException

    def call(**kwargs):
        base = dict(
            event_id="STIM/5", epoch_pre_ms=200.0, epoch_post_ms=800.0,
            band_min=None, band_max=None, notch_hz=None,
            reference="average", reference_channels=None,
            z_threshold=5.0, pp_threshold_uv=100.0, flat_line_uv=1.0,
            flat_line_ms=200.0, run_ica=False,
        )
        base.update(kwargs)
        return evoked_params(**base)

    with pytest.raises(HTTPException) as excinfo:
        call(baseline_start_ms=-200.0)  # без пары
    assert excinfo.value.status_code == 400
    with pytest.raises(HTTPException) as excinfo:
        call(baseline_start_ms=-500.0, baseline_end_ms=0.0)  # вне окна
    assert excinfo.value.status_code == 400
    params = call(baseline_start_ms=-200.0, baseline_end_ms=0.0)
    assert params.baseline_start_ms == -200.0
    assert params.preprocess.event_id == "STIM/5"


def test_evoked_job_endpoint_roundtrip(client, tmp_path):
    """Полный круг API: 202 → поллинг → результат ERP рядом с записью."""
    path = _tal_file(tmp_path, "tal.edf", [(1.0, 0.0, "STIM/5"), (3.0, 0.0, "STIM/5")])
    with open(path, "rb") as fh:
        upload = client.post(
            f"{_PREFIX}/recordings", files={"file": ("tal.edf", fh, "application/octet-stream")},
        )
    assert upload.status_code == 201, upload.text
    recording_id = upload.json()["recording_id"]

    created = client.post(
        f"{_PREFIX}/recordings/{recording_id}/evoked",
        data={
            "event_id": "STIM/5",
            "epoch_pre_ms": "200", "epoch_post_ms": "800",
            "baseline_start_ms": "-200", "baseline_end_ms": "0",
        },
    )
    assert created.status_code == 202, created.text
    job_id = created.json()["job_id"]

    deadline = time.time() + 20.0
    status: dict = {}
    while time.time() < deadline:
        status = client.get(f"{_PREFIX}/jobs/{job_id}").json()
        if status["status"] in ("succeeded", "failed"):
            break
        time.sleep(0.05)
    assert status["status"] == "succeeded", status

    result = client.get(f"{_PREFIX}/recordings/{recording_id}/evoked/{job_id}")
    assert result.status_code == 200, result.text
    body = result.json()
    assert body["event_id"] == "STIM/5"
    assert body["n_total"] == 2
    assert body["n_used"] == 2
    assert body["baseline"] == [-0.2, 0.0]
