"""Тесты полосы фильтра в задачах расчёта (срез 3.6, `docs/ui.md` §3.3).

Форма фильтров в панели раздела «Диполи» отправляет полосу парой
`band_min`/`band_max` и сетевой фильтр `notch_hz`. Здесь проверяется **контракт
задач** с этой полосой: сервер считает именно на ней и возвращает её эхом
результата (по нему UI сверяет «результат посчитан на этих параметрах»).

Синтетическая запись — альфа-ритм 10 Гц (без локальных данных), поэтому тесты
быстрые и не помечены `integration`.
"""
import os
import shutil

import numpy as np
import pytest

from app.core.config import settings
from app.services.recordings import recording_registry
from tests.conftest import write_minimal_edf
from tests.test_dipole_scanner import _alpha_edf, _register, _wait_finished

_PREFIX = "/api/v1"


@pytest.fixture(autouse=True)
def clean_state():
    """Изоляция реестра записей и каталогов загрузок между тестами."""
    recording_registry.clear()
    before = _upload_dirs()
    yield
    recording_registry.clear()
    for name in _upload_dirs() - before:
        shutil.rmtree(os.path.join(settings.upload_dir, name), ignore_errors=True)


def _upload_dirs() -> set[str]:
    root = settings.upload_dir
    if not os.path.isdir(root):
        return set()
    return {name for name in os.listdir(root) if os.path.isdir(os.path.join(root, name))}


def _tone_edf(tmp_path, freq_hz: float = 8.0, seconds: float = 6.0):
    """Синтетический EDF с тоном внутри узкой полосы: 8 Гц при полосе 7.6–8.1 Гц."""
    path = tmp_path / f"tone{int(freq_hz)}.edf"
    channels = list(settings.standard_channels[:8])
    sfreq = 250.0
    times = np.arange(int(seconds * sfreq)) / sfreq
    gain = 5.0 + np.arange(len(channels), dtype=float)
    data = np.sin(2 * np.pi * freq_hz * times)[None, :] * gain[:, None]
    write_minimal_edf(path, channels, data, sfreq)
    return path


def test_spectrum_job_honours_band_and_notch(client, tmp_path):
    """Полоса α + сетевой 50 Гц: считаются именно они и видны в результате."""
    recording = _register(tmp_path, _alpha_edf(tmp_path))
    base = f"{_PREFIX}/recordings/{recording.recording_id}/spectrum"

    created = client.post(
        base,
        data={"band_min": 8, "band_max": 13, "notch_hz": 50, "epoch_length_ms": 1000},
    )
    assert created.status_code == 202, created.text
    status = _wait_finished(client, created.json()["job_id"])
    assert status["status"] == "succeeded", status

    body = client.get(status["result_url"]).json()
    # Эхо параметров: по нему UI строит URL топокарт (ETag) и сверяет актуальность
    assert body["filter_band_hz"] == [8.0, 13.0]
    assert body["notch_hz"] == 50.0

    powers = {band["name"]: band["power_uv2"] for band in body["bands"]}
    # Полоса 8–13 Гц: альфа измерена и на порядки сильнее остатков вне полосы
    # (фильтр не идеален, поэтому «нулей» вне полосы не бывает — и не выдаётся за них)
    assert powers["alpha"] is not None and powers["alpha"] > 0
    outside = max(powers["delta"] or 0.0, powers["beta"] or 0.0, powers["gamma"] or 0.0)
    assert powers["alpha"] > 100 * outside


def test_dipole_job_honours_single_frequency_band(client, tmp_path):
    """Одиночная частота 7.83 Гц уходит полосой f ± bw/2 — и расчёт идёт по ней."""
    # Тон 8 Гц попадает в узкую полосу 7.6–8.1 Гц: если бы сервер считал по другой
    # полосе, эпохи после фильтра не дали бы точек вовсе
    recording = _register(tmp_path, _tone_edf(tmp_path))
    base = f"{_PREFIX}/recordings/{recording.recording_id}/dipoles"

    created = client.post(
        base,
        data={"band_min": 7.6, "band_max": 8.1, "epoch_length_ms": 1000, "grid_mm": 8},
    )
    assert created.status_code == 202, created.text
    status = _wait_finished(client, created.json()["job_id"])
    assert status["status"] == "succeeded", status

    body = client.get(status["result_url"]).json()
    assert body["filter_band_hz"] == [7.6, 8.1]
    assert body["n_epochs_used"] == len(body["points"]) > 0