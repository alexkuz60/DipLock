"""Тесты экспорта (M3/M4): WAV roundtrip, детерминизм байтов, sidecar-партитура."""
import io
import json

import numpy as np
import soundfile as sf

from app.core.config import settings
from app.services.audio_render.export import (
    SIDECAR_SCHEMA_VERSION,
    build_sidecar,
    input_checksum,
    sidecar_bytes,
    wav_bytes,
)

FS = 48000


def _stereo(n: int = FS // 10) -> np.ndarray:
    """Синусовая стерео-пара float64 (0.1 с)."""
    t = np.arange(n) / FS
    left = 0.5 * np.sin(2 * np.pi * 440.0 * t)
    right = 0.25 * np.sin(2 * np.pi * 220.0 * t)
    return np.stack([left, right], axis=1)


def test_wav_roundtrip_is_48k_stereo_int24() -> None:
    """WAV читается обратно: fs=48000, стерео, точная длина (приёмка ТЗ M3)."""
    data = _stereo()
    blob = wav_bytes(data, FS)
    with sf.SoundFile(io.BytesIO(blob)) as handle:
        assert handle.samplerate == FS
        assert handle.channels == 2
        assert handle.subtype == "PCM_24"
        assert len(handle) == data.shape[0]
        back = handle.read(dtype="float64")
    assert back.shape == data.shape


def test_wav_bytes_are_deterministic() -> None:
    """Одинаковые входы → идентичные байты WAV (ТЗ §3.4, детерминизм)."""
    data = _stereo(1000)
    assert wav_bytes(data, FS) == wav_bytes(data, FS)


def test_wav_peak_is_capped_by_pcm24() -> None:
    """Пик ≤ 0.891 приходит в файл без переполнения (int24 из float64)."""
    data = np.full((FS // 100, 2), 0.891)
    blob = wav_bytes(data, FS)
    with sf.SoundFile(io.BytesIO(blob)) as handle:
        back = handle.read(dtype="float64")
    assert float(np.max(np.abs(back))) <= 0.891 + 1e-3


def test_input_checksum_is_stable_and_sensitive() -> None:
    """Отпечаток входа: одинаковые пакеты — один хеш, изменение — другой."""
    a = {"alpha": np.ones((3, 8)), "beta": np.zeros((3, 8))}
    b = {"alpha": np.ones((3, 8)), "beta": np.zeros((3, 8))}
    assert input_checksum(a) == input_checksum(b)
    c = {"alpha": np.ones((3, 8)), "beta": np.full((3, 8), 1e-12)}
    assert input_checksum(a) != input_checksum(c)


def test_sidecar_matches_contract_schema() -> None:
    """Sidecar: поля ТЗ §6 на месте, extensions зарезервированы, JSON валиден."""
    bands = [{
        "name": "delta",
        "fmin": 0.5,
        "fmax": 2.0,
        "audio_fmin": 64.0,
        "audio_fmax": 256.0,
        "weights_left": [1.0] * 6,
        "weights_right": [1.0] * 6,
        "gain_db": 0.0,
        "applied_gain_db": 76.0,
        "rms_out_dbfs": -18.0,
    }]
    sidecar = build_sidecar(
        duration_s=103.7,
        channels=["F3", "F4", "Cz", "T7", "T8", "Fz"],
        bands=bands,
        checksum="abc123",
        gains_db={"delta": 0.0},
        warnings=["пример"],
        clean_label="гармоник notch=3, интерполяция bad, очистка=ica",
        interpolated=["C3"],
        notch_hz=50.0,
        groups={"left": ["F3"], "right": ["F4"], "midline": ["Cz", "Fz"]},
    )
    assert sidecar["schema_version"] == SIDECAR_SCHEMA_VERSION == 1
    assert sidecar["fs_eeg"] == 500 and sidecar["fs_audio"] == FS
    assert sidecar["octave_shift"] == 7 and sidecar["pitch_factor"] == 128
    assert sidecar["duration_s"] == 103.7
    assert sidecar["extensions"] == {"dipoles": None, "intracranial_ir": None, "doppler": None}
    assert sidecar["channel_order"] == ["F3", "F4", "Cz", "T7", "T8", "Fz"]
    assert sidecar["input_checksum_sha256"] == "abc123"
    assert sidecar["busses"]["midline"] == ["Cz", "Fz"]

    blob = sidecar_bytes(sidecar)
    parsed = json.loads(blob)
    assert parsed["bands"][0]["audio_fmax"] == 256.0  # 2 Гц × 128
    # Детерминированный JSON (стабильный порядок ключей).
    assert blob == sidecar_bytes(sidecar)


def test_audio_frequency_grid_matches_octave_shift() -> None:
    """Частотная сетка: полосы config × 128 = сетка ТЗ (контроль M1/§1)."""
    expected = {
        "delta": (64.0, 256.0),
        "delta_theta": (256.0, 512.0),
        "theta": (512.0, 1024.0),
        "alpha": (1024.0, 2048.0),
        "beta": (2048.0, 4096.0),
        "gamma": (4096.0, 8192.0),
        "high_gamma": (8192.0, 16384.0),
    }
    grid = {
        name: (bounds[0] * 128, bounds[1] * 128)
        for name, bounds in settings.freq_bands.items()
    }
    assert grid == expected
