"""Тесты спектрограммы канала (раздел «ЭЭГ», `app/services/spectrogram.py`).

Быстрая часть не требует fsaverage: сигнал синтетический (тон 10 Гц), а сетка
разбирается обратно тем же контейнером, что читает клиент. Проверяется главное:
STFT кладёт энергию тона в свою частотную строку, окно и перекрытие задают число
столбцов, уровень растёт вместе с амплитудой, контейнер ``DPS2`` читается обратно
без потерь, а задача идёт фоново с прогрессом по окнам и отдаёт сетку с ETag/304.
"""
import os
import shutil
import time

import numpy as np
import pytest

from app.api.params import stored_spectrogram_params
from app.core.config import settings
from app.schemas.analysis import SpectrogramGridHeader
from app.services.recordings import recording_registry
from app.services.spectrogram import (
    SpectrogramError,
    SpectrogramParams,
    build_grid_blob,
    cached_grid,
    clear_spectrogram_cache,
    compute_spectrogram,
    read_grid_blob,
    spectrogram_signature,
    stft_grid,
    validate_params,
)
from tests.conftest import write_minimal_edf

_PREFIX = "/api/v1"


def _upload_dirs() -> set[str]:
    root = settings.upload_dir
    if not os.path.isdir(root):
        return set()
    return {name for name in os.listdir(root) if os.path.isdir(os.path.join(root, name))}


@pytest.fixture(autouse=True)
def clean_state():
    """Изоляция реестра записей и дискового кэша сеток между тестами."""
    recording_registry.clear()
    clear_spectrogram_cache(settings)
    before = _upload_dirs()
    yield
    recording_registry.clear()
    clear_spectrogram_cache(settings)
    for name in _upload_dirs() - before:
        shutil.rmtree(os.path.join(settings.upload_dir, name), ignore_errors=True)


def _tone(seconds: float = 4.0, sfreq: float = 250.0, freq: float = 10.0, amp: float = 20.0):
    """Чистый тон: удобно проверять, в какую строку сетки попадает энергия."""
    times = np.arange(int(seconds * sfreq)) / sfreq
    return amp * np.sin(2 * np.pi * freq * times)


def _tone_edf(tmp_path, freq: float = 10.0):
    """EDF с тоном ``freq`` Гц: амплитуда растёт от канала к каналу.

    Разные амплитуды нужны не для красоты: average reference вычитает среднее по
    каналам, и одинаковые сигналы он бы «съел» в ноль — спектрограмме нечего
    было бы показывать.
    """
    path = tmp_path / f"tone{int(freq)}.edf"
    channels = list(settings.standard_channels[:4])
    sfreq = 250.0
    times = np.arange(int(6.0 * sfreq)) / sfreq
    data = np.vstack([
        50.0 * (index + 1) * np.sin(2 * np.pi * freq * times)
        for index in range(len(channels))
    ])
    write_minimal_edf(path, channels, data, sfreq)
    return path


def _register(tmp_path, edf_path):
    """Регистрирует запись так, как это делает ``POST /recordings``."""
    upload_dir = tmp_path / "rec"
    upload_dir.mkdir(parents=True, exist_ok=True)
    target = upload_dir / edf_path.name
    shutil.copyfile(edf_path, target)
    return recording_registry.register(str(target), str(upload_dir), edf_path.name, settings)


def _wait_finished(client, job_id: str, timeout: float = 60.0) -> dict:
    """Ждёт завершения задачи (поллинг, как это делает UI)."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        status = client.get(f"{_PREFIX}/jobs/{job_id}").json()
        if status["status"] in ("succeeded", "failed"):
            return status
        time.sleep(0.05)
    raise AssertionError(f"Задача {job_id} не завершилась за {timeout} с")
def test_stft_puts_tone_into_its_frequency_row():
    """Тон 10 Гц: максимум сетки — в строке 10 Гц, а не «где-то рядом»."""
    data = _tone(freq=10.0)
    params = SpectrogramParams(channel="Fp1", window_ms=500.0, overlap_pct=75.0, fmax_hz=40.0)

    freqs, times, db, n_fft = stft_grid(data, 250.0, params)

    assert n_fft == 128  # окно 500 мс = 125 отсчётов → степень двойки 128
    peak = freqs[int(np.argmax(np.mean(db, axis=1)))]
    assert peak == pytest.approx(10.0, abs=1.0)
    # Энергия тона уходит в свою строку и не «размазывается» по всей сетке
    row = float(np.mean(db, axis=1)[int(np.argmin(np.abs(freqs - 10.0)))])
    assert row > float(np.mean(db)) + 10.0
    assert times[0] > 0 and times[-1] < 4.0


def test_window_and_overlap_set_column_count():
    """Число столбцов задаётся окном и перекрытием — не «примерно»."""
    data = _tone(seconds=4.0)
    wide = stft_grid(data, 250.0, SpectrogramParams(channel="Fp1", window_ms=1000.0, overlap_pct=0.0))
    dense = stft_grid(data, 250.0, SpectrogramParams(channel="Fp1", window_ms=1000.0, overlap_pct=75.0))

    # Окно 1000 мс без перекрытия: шаг = окно → 4 окна на 4 секунды
    assert wide[1].size == 4
    # Перекрытие 75 % → шаг вчетверо меньше → окон примерно вчетверо больше
    assert dense[1].size >= 4 * wide[1].size - 4


def test_level_grows_with_amplitude():
    """Уровень в дБ растёт вместе с амплитудой: шкала — измерение, а не рисунок."""
    quiet = stft_grid(_tone(amp=10.0), 250.0, SpectrogramParams(channel="Fp1"))
    loud = stft_grid(_tone(amp=100.0), 250.0, SpectrogramParams(channel="Fp1"))

    quiet_peak = float(np.max(quiet[2]))
    loud_peak = float(np.max(loud[2]))
    assert loud_peak > quiet_peak
    # ×10 по амплитуде = +20 дБ (20·lg 10)
    assert loud_peak - quiet_peak == pytest.approx(20.0, abs=0.5)


def test_fmax_truncates_grid():
    """Верхняя частота отсекает строки: сетка не «худеет» уже на клиенте."""
    freqs, _times, db, _n_fft = stft_grid(
        _tone(), 250.0, SpectrogramParams(channel="Fp1", fmax_hz=20.0),
    )

    assert float(freqs.max()) <= 20.0
    assert db.shape[0] == freqs.size
    assert db.shape[0] < 33  # полная сетка до 125 Гц вдвое длиннее


def test_short_recording_and_too_many_frames_are_reported():
    """Запись короче окна и «окон слишком много» — понятные тексты, а не пустая сетка."""
    with pytest.raises(SpectrogramError, match="короче окна"):
        stft_grid(_tone(seconds=0.1), 250.0, SpectrogramParams(channel="Fp1", window_ms=1000.0))

    with pytest.raises(SpectrogramError, match="слишком много"):
        # 120 с на 250 Гц с окном 64 мс и перекрытием 95 %: шаг — 1 отсчёт,
        # то есть ~30 000 окон, а предохранитель стоит на 20 000.
        stft_grid(
            np.zeros(120 * 250), 250.0,
            SpectrogramParams(channel="Fp1", window_ms=64.0, overlap_pct=95.0),
        )


def test_grid_blob_reads_back_and_signature_follows_params():
    """Контейнер ``DPS2`` разбирается обратно, а подпись следует за параметрами."""
    db = np.linspace(-60.0, 0.0, 12, dtype=np.float32).reshape(3, 4)
    model = SpectrogramGridHeader(
        recording_id="rec-1", channel="Fp1", window_ms=500.0, overlap_pct=75.0,
        fmax_hz=40.0, sfreq=250.0, n_fft=128, n_freqs=3, n_times=4,
        db_min=-60.0, db_max=0.0,
    )

    parsed, values = read_grid_blob(build_grid_blob(model, db))

    assert (parsed.channel, parsed.n_freqs, parsed.n_times) == ("Fp1", 3, 4)
    assert np.allclose(values, db)

    channels = ["Fp1", "Fp2"]
    base = SpectrogramParams(channel="Fp1", window_ms=500.0, overlap_pct=75.0, fmax_hz=40.0)
    same = spectrogram_signature(base, settings, channels)
    assert same == spectrogram_signature(base, settings, channels)
    assert same != spectrogram_signature(
        SpectrogramParams(channel="Fp2", window_ms=500.0, overlap_pct=75.0, fmax_hz=40.0),
        settings, channels,
    ), "канал входит в подпись: сетки разных каналов не подменяются"
    assert same != spectrogram_signature(
        SpectrogramParams(channel="Fp1", window_ms=250.0, overlap_pct=75.0, fmax_hz=40.0),
        settings, channels,
    ), "окно входит в подпись: старый кэш не залипает"
    assert same != spectrogram_signature(
        SpectrogramParams(
            channel="Fp1", window_ms=500.0, overlap_pct=75.0, fmax_hz=40.0,
            reference="custom", reference_channels=["Fp1", "Fp2"],
        ),
        settings, channels,
    ), "каналы своей ссылки входят в подпись (A11): сетка другой ссылки не отдаётся"


def test_params_are_rejected_not_clamped():
    """Окно, перекрытие и верхняя частота вне границ — ошибка с границами в тексте."""
    validate_params(SpectrogramParams(channel="Fp1"), settings)

    for bad, match in (
        (SpectrogramParams(channel=""), "канал не указан"),
        (SpectrogramParams(channel="Fp1", window_ms=10.0), "Окно STFT"),
        (SpectrogramParams(channel="Fp1", overlap_pct=99.0), "Перекрытие"),
        (SpectrogramParams(channel="Fp1", fmax_hz=500.0), "Верхняя частота"),
        (SpectrogramParams(channel="Fp1", notch_hz=0.0), "сетевого фильтра"),
    ):
        with pytest.raises(SpectrogramError, match=match):
            validate_params(bad, settings)


def test_compute_spectrogram_writes_grid_cache(tmp_path):
    """Расчёт кладёт сетку на диск и отдаёт метаданные: ленивый пересчёт не нужен."""
    recording = _register(tmp_path, _tone_edf(tmp_path, freq=10.0))
    params = SpectrogramParams(channel="Fp1", window_ms=500.0, overlap_pct=75.0, fmax_hz=40.0)

    result = compute_spectrogram(recording, settings, params)

    assert result["channel"] == "Fp1"
    assert result["db_max"] > result["db_min"]
    # Частотная ось сетки: от нуля до верхней частоты, шаг = sfreq / n_fft
    assert result["freqs"][0] == 0.0 and result["freqs"][-1] <= 40.0
    assert len(result["freqs"]) > 10
    assert result["times"] and result["times"][0] > 0
    assert result["grid_version"]

    blob, version = cached_grid(recording, settings, params)
    assert version == result["grid_version"], "повторный запрос читает ту же сетку из кэша"
    header, values = read_grid_blob(blob)
    assert (header.n_freqs, header.n_times) == (len(result["freqs"]), len(result["times"]))
    # Тон 10 Гц в своей строке выше среднего уровня сетки
    row = int(np.argmin(np.abs(np.asarray(result["freqs"]) - 10.0)))
    assert float(np.mean(values[row])) > float(np.mean(values)) + 10.0


def test_compute_spectrogram_reports_reference(tmp_path):
    """Результат несёт референс расчёта: ленивый пересчёт его не подменит (A11)."""
    recording = _register(tmp_path, _tone_edf(tmp_path))
    params = SpectrogramParams(
        channel="Fp1", window_ms=500.0, overlap_pct=75.0, fmax_hz=40.0,
        reference="custom", reference_channels=["Fp2"],
    )

    result = compute_spectrogram(recording, settings, params)

    assert result["reference"] == "custom"
    assert result["reference_channels"] == ["Fp2"]
    # Круг «задача → grid.bin» без потерь: те же параметры и та же подпись
    assert stored_spectrogram_params(result) == params
    assert spectrogram_signature(
        stored_spectrogram_params(result), settings, result["channels"],
    ) == result["grid_version"]


def test_mix_channel_averages_group_without_reference(tmp_path):
    """Виртуальный канал — среднее группы каналов, посчитанное без референса.

    Проверка не косметическая: если бы микс считался по average reference, «Все
    каналы» были бы **нулём** — референс вычитает ровно среднее по каналам, из
    которого микс и состоит. Поэтому у микса обязана быть энергия тона.
    """
    recording = _register(tmp_path, _tone_edf(tmp_path, freq=10.0))
    params = SpectrogramParams(
        channel="mix:all", window_ms=500.0, overlap_pct=75.0, fmax_hz=40.0,
    )

    result = compute_spectrogram(recording, settings, params)

    assert result["channel"] == "mix:all"
    # Состав микса едет в результат: UI показывает, какие электроды усреднены
    assert result["mix_channels"] == ["Fp1", "Fp2", "F3", "F4"]
    # Тон 10 Гц у среднего четырёх каналов (50…200 мкВ → 125 мкВ) виден, а не пол шкалы
    assert result["db_max"] > 20.0
    row = int(np.argmin(np.abs(np.asarray(result["freqs"]) - 10.0)))
    header, values = read_grid_blob(cached_grid(recording, settings, params)[0])
    assert (header.n_freqs, header.n_times) == (len(result["freqs"]), len(result["times"]))
    assert float(np.mean(values[row])) > float(np.mean(values)) + 10.0
    # Круг «задача → grid.bin» для микса тоже без потерь
    assert stored_spectrogram_params(result) == params
    assert spectrogram_signature(
        stored_spectrogram_params(result), settings, result["channels"],
    ) == result["grid_version"]


def test_mix_without_group_channels_is_reported(client, tmp_path):
    """Группа известна, но электродов таких в записи нет — понятная ошибка задачи."""
    recording = _register(tmp_path, _tone_edf(tmp_path))

    created = client.post(
        f"{_PREFIX}/recordings/{recording.recording_id}/spectrogram",
        data={"channel": "mix:occipital", "window_ms": 500},
    )
    status = _wait_finished(client, created.json()["job_id"])

    assert status["status"] == "failed"
    assert "нет каналов этой записи" in (status["error"] or "")


def test_spectrogram_job_flow(client, tmp_path):
    """202 → поллинг с прогрессом по окнам → метаданные → сетка ``DPS2`` с ETag/304."""
    recording = _register(tmp_path, _tone_edf(tmp_path))

    created = client.post(
        f"{_PREFIX}/recordings/{recording.recording_id}/spectrogram",
        data={"channel": "Fp1", "band_min": 1, "band_max": 40, "window_ms": 500, "overlap_pct": 75},
    )
    assert created.status_code == 202, created.text
    job_id = created.json()["job_id"]

    status = _wait_finished(client, job_id)
    assert status["status"] == "succeeded", status
    assert status["kind"] == "spectrogram"
    assert status["result_url"] == (
        f"{_PREFIX}/recordings/{recording.recording_id}/spectrogram/{job_id}"
    )
    assert status["epochs_total"] > 0 and status["epochs_done"] == status["epochs_total"]

    result = client.get(status["result_url"])
    assert result.status_code == 200, result.text
    body = result.json()
    assert body["channel"] == "Fp1"
    assert body["grid_url"] == (
        f"{_PREFIX}/recordings/{recording.recording_id}/spectrogram/{job_id}/grid.bin"
    )
    assert body["grid_version"]

    grid = client.get(body["grid_url"])
    assert grid.status_code == 200, grid.text
    assert grid.headers["content-type"] == "application/octet-stream"
    assert grid.headers["x-spectrogram-channel"] == "Fp1"
    header, values = read_grid_blob(grid.content)
    assert (header.n_freqs, header.n_times) == (len(body["freqs"]), len(body["times"]))
    assert values.shape == (header.n_freqs, header.n_times)

    again = client.get(body["grid_url"], headers={"If-None-Match": grid.headers["etag"]})
    assert again.status_code == 304


def test_spectrogram_job_validates_params_and_recording(client, tmp_path):
    """Канал не указан, окно вне границ, чужая запись, чужой job — 400/404."""
    recording = _register(tmp_path, _tone_edf(tmp_path))
    base = f"{_PREFIX}/recordings/{recording.recording_id}/spectrogram"

    # Канала нет в форме или он пустой — 400 с понятным текстом: спектрограмма
    # считается по одному каналу, и «по всем сразу» её посчитать нельзя.
    assert client.post(base, data={"window_ms": 500}).status_code == 400
    assert client.post(base, data={"channel": "", "window_ms": 500}).status_code == 400
    assert client.post(base, data={"channel": "Fp1", "window_ms": 5000}).status_code == 400
    assert client.post(base, data={"channel": "Fp1", "overlap_pct": 99}).status_code == 400
    assert client.post(base, data={"channel": "Fp1", "fmax_hz": 500}).status_code == 400
    assert client.post(
        f"{_PREFIX}/recordings/nope/spectrogram", data={"channel": "Fp1"},
    ).status_code == 404
    assert client.get(f"{_PREFIX}/recordings/nope/spectrogram/job-x").status_code == 404
    assert client.get(
        f"{_PREFIX}/recordings/{recording.recording_id}/spectrogram/job-x",
    ).status_code == 404


def test_spectrogram_missing_channel_is_reported(client, tmp_path):
    """Канала нет в записи — задача падает с понятным текстом, а не с пустой сеткой."""
    recording = _register(tmp_path, _tone_edf(tmp_path))

    created = client.post(
        f"{_PREFIX}/recordings/{recording.recording_id}/spectrogram",
        data={"channel": "Fz-not-in-file", "window_ms": 500},
    )
    status = _wait_finished(client, created.json()["job_id"])

    assert status["status"] == "failed"
    assert "не найден в записи" in (status["error"] or "")

