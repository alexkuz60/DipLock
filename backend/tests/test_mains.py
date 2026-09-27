"""Сигнал сетевого фона (`GET /recordings/{id}/mains`, Части 1 §7): L1 и трасса.

Два свойства важнее прочих: (1) уровни L1 **различают** запись с наводкой и
запись без неё — число, а не «видно на глаз»; (2) трасса содержит именно
вырезанную компоненту (синус 50 Гц впрыснут — трасса его несёт, RMS > 0),
края обрезаны по переходному процессу ядра.
"""
import os
import shutil

import numpy as np
import pytest

from app.core.config import settings
from app.services.mains import line_noise_levels_db
from app.services.prepared_signal import clear_prepared_cache
from app.services.recordings import recording_registry
from tests.conftest import write_minimal_edf


def _upload_dirs() -> set[str]:
    root = settings.upload_dir
    if not os.path.isdir(root):
        return set()
    return {name for name in os.listdir(root) if os.path.isdir(os.path.join(root, name))}


@pytest.fixture(autouse=True)
def clean_state():
    """Изоляция реестра, каталогов загрузок и RAM-кэша сигнала между тестами."""
    recording_registry.clear()
    clear_prepared_cache()
    before = _upload_dirs()
    yield
    recording_registry.clear()
    clear_prepared_cache()
    for name in _upload_dirs() - before:
        shutil.rmtree(os.path.join(settings.upload_dir, name), ignore_errors=True)


def _upload(client, path, name="probe.edf"):
    with open(path, "rb") as fh:
        response = client.post(
            "/api/v1/recordings", files={"file": (name, fh, "application/octet-stream")},
        )
    assert response.status_code == 201, response.text
    return response.json()


def _line_edf(tmp_path, name="line.edf", line_uv=5.0, harmonic_uv=0.0):
    """EDF с белым шумом ~2 мкВ и линиями 50/100 Гц, 6 с, 250 Гц.

    Амплитуды линий **различаются по каналам** (0.5…1.5×): так бывает в
    реальности, и average-референс снимает только общий режим — идеально
    идентичная наводка гаслась бы средним полностью и тест мерил бы ноль.
    """
    sfreq = 250.0
    t = np.arange(int(6 * sfreq)) / sfreq
    rng = np.random.RandomState(7)
    chans = list(settings.standard_channels[:5])
    data = rng.randn(len(chans), t.size) * 2.0
    for i in range(len(chans)):
        spread = 0.5 + 0.25 * i  # каналы «видят» наводку по-разному
        data[i] += line_uv * spread * np.sin(2 * np.pi * 50.0 * t)
        if harmonic_uv:
            data[i] += harmonic_uv * spread * np.sin(2 * np.pi * 100.0 * t)
    path = tmp_path / name
    write_minimal_edf(path, chans, data, sfreq)
    return path


# ---------- L1: уровни линий над фоном PSD ----------

def test_line_levels_flag_injected_mains():
    """Впрыснутая линия 50 Гц видна числом (≥ 10 дБ), пустая — нет."""
    sfreq = 250.0
    t = np.arange(int(8 * sfreq)) / sfreq
    rng = np.random.RandomState(3)
    data = rng.randn(4, t.size) * 2.0  # фон ~2 мкВ
    data += 8.0 * np.sin(2 * np.pi * 50.0 * t)  # линия 50 Гц

    levels = line_noise_levels_db(data, sfreq, [50.0, 100.0])

    assert len(levels) == 2
    assert levels[0] >= 10.0, "50 Гц должна выделяться над фоном"
    assert abs(levels[1]) < 8.0, "100 Гц в сигнале нет — уровня нет"


def test_line_levels_quiet_on_clean_sine():
    """Чистый тон 10 Гц не даёт ложного уровня на 50 Гц."""
    sfreq = 250.0
    t = np.arange(int(8 * sfreq)) / sfreq
    data = np.vstack([10.0 * np.sin(2 * np.pi * 10.0 * t)] * 3)

    (level,) = line_noise_levels_db(data, sfreq, [50.0])

    assert abs(level) < 8.0


# ---------- API: контракт и содержимое ----------

def test_mains_trace_carries_injected_line(client, tmp_path):
    """Трасса несёт впрыснутый 50 Гц: RMS заметен, окно и цепочка в контракте."""
    path = _line_edf(tmp_path)
    recording = _upload(client, path)

    response = client.get(
        f"/api/v1/recordings/{recording['recording_id']}/mains",
        params={"notch_hz": 50, "duration_sec": 3},
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["freqs_hz"] == [50.0]
    assert len(body["level_db"]) == 1 and body["level_db"][0] >= 10.0
    assert body["removed_rms_uv"] > 0.5, "вырезанная компонента должна нести силу"
    assert len(body["trace_times_sec"]) == len(body["trace_uv"]) > 100
    # Края обрезаны по переходному процессу ядра: окно уже запрошенного
    assert body["start_sec"] > 0
    assert body["start_sec"] + body["duration_sec"] <= 6.0
    # Форма волны: трасса — колебание около нуля, а не константа
    trace = np.asarray(body["trace_uv"])
    assert abs(float(np.mean(trace))) < 0.3 * float(np.max(np.abs(trace)))


def test_mains_harmonics_enter_the_chain(client, tmp_path):
    """notch_harmonics=1 включает 100 Гц в цепочку и её уровень."""
    path = _line_edf(tmp_path, name="harm.edf", line_uv=5.0, harmonic_uv=4.0)
    recording = _upload(client, path)

    response = client.get(
        f"/api/v1/recordings/{recording['recording_id']}/mains",
        params={"notch_hz": 50, "notch_harmonics": 1, "duration_sec": 3},
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["freqs_hz"] == [50.0, 100.0]
    assert body["level_db"][1] >= 6.0, "гармоника 100 Гц впрыснута — уровень должен быть"


def test_mains_quiet_on_recording_without_line(client, edf_file):
    """Запись без сетевой наводки: уровень мал, вырезанного почти нет."""
    recording = _upload(client, edf_file, name="quiet.edf")

    response = client.get(
        f"/api/v1/recordings/{recording['recording_id']}/mains",
        params={"notch_hz": 50, "duration_sec": 2},
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert abs(body["level_db"][0]) < 8.0
    assert body["removed_rms_uv"] < 1.0


def test_mains_harmonics_respect_nyquist(client, edf_file):
    """Гармоники выше Nyquist − 1 Гц отбрасываются (250 Гц записи → 120 Гц максимум)."""
    recording = _upload(client, edf_file, name="nyq.edf")

    response = client.get(
        f"/api/v1/recordings/{recording['recording_id']}/mains",
        params={"notch_hz": 60, "notch_harmonics": 4, "duration_sec": 2},
    )

    assert response.status_code == 200, response.text
    assert response.json()["freqs_hz"] == [60.0, 120.0]  # 180/240 выше 124 Гц


# ---------- Валидация ----------

def test_mains_404_unknown_recording(client):
    response = client.get(
        "/api/v1/recordings/no-such-id/mains", params={"notch_hz": 50},
    )
    assert response.status_code == 404


def test_mains_400_without_notch(client, edf_file):
    """Без notch_hz вырезать нечего — 400 с текстом для UI."""
    recording = _upload(client, edf_file, name="nonotch.edf")

    response = client.get(
        f"/api/v1/recordings/{recording['recording_id']}/mains",
    )

    assert response.status_code == 400
    assert "notch" in response.json()["detail"].lower()


def test_mains_400_for_bad_window(client, edf_file):
    """Окно за пределами записи и отрицательная длина — 400, а не пустой 200."""
    recording = _upload(client, edf_file, name="window.edf")
    url = f"/api/v1/recordings/{recording['recording_id']}/mains"

    late = client.get(url, params={"notch_hz": 50, "start_sec": 999})
    assert late.status_code == 400
    assert "start_sec" in late.json()["detail"]

    bad = client.get(url, params={"notch_hz": 50, "duration_sec": -1})
    assert bad.status_code == 400


def test_mains_400_for_bad_harmonics(client, edf_file):
    """Гармоники вне 0…4 — 400 (тот же текст, что у /filter-response)."""
    recording = _upload(client, edf_file, name="harm400.edf")

    response = client.get(
        f"/api/v1/recordings/{recording['recording_id']}/mains",
        params={"notch_hz": 50, "notch_harmonics": 5},
    )

    assert response.status_code == 400
