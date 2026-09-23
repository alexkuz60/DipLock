"""Тесты edf_loader: нормализация имён каналов и загрузка реального EDF."""
import os

import mne
import numpy as np
import pytest

from app.core.config import settings
from app.services.edf_loader import load_edf, normalize_channel_name

# DipLock/data/edf/test.edf (backend/tests -> backend -> DipLock)
_REAL_EDF = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "data", "edf", "test.edf")
)


@pytest.mark.parametrize(
    "raw_name,expected",
    [
        ("EEG F7", "F7"),
        ("EEG Fz", "Fz"),
        ("EEG T3", "T7"),
        ("EEG T4", "T8"),
        ("EEG T5", "P7"),
        ("EEG T6", "P8"),
        ("eeg-fp1", "Fp1"),
        ("FP2", "Fp2"),
        ("POL C3", "C3"),
        ("Cz", "Cz"),
        ("O1", "O1"),
    ],
)
def test_normalize_channel_name(raw_name, expected):
    assert normalize_channel_name(raw_name) == expected


def test_normalize_unknown_channel_unchanged():
    assert normalize_channel_name("EEG X99") == "X99"


@pytest.mark.skipif(not os.path.exists(_REAL_EDF), reason="test.edf отсутствует")
def test_load_edf_real_file_normalizes_channels():
    """Реальный EDF с 'EEG ' префиксами и T3/T4/T5/T6 загружается и мапится."""
    raw = load_edf(_REAL_EDF, settings.standard_channels)

    assert isinstance(raw, mne.io.BaseRaw)
    assert len(raw.ch_names) > 0
    # все выбранные каналы — из стандартного набора
    assert set(raw.ch_names) <= set(settings.standard_channels)
    # устаревшая номенклатура заменена на современную
    assert {"T7", "T8", "P7", "P8"} & set(raw.ch_names)
    assert raw.get_montage() is not None


@pytest.mark.skipif(not os.path.exists(_REAL_EDF), reason="test.edf отсутствует")
def test_load_edf_rejects_unknown_channels():
    with pytest.raises(ValueError, match="Ни один из стандартных каналов"):
        load_edf(_REAL_EDF, ["Zz", "Qq"])


@pytest.mark.skipif(not os.path.exists(_REAL_EDF), reason="test.edf отсутствует")
def test_load_edf_auto_scales_units():
    """EDF без physical dimension не должен давать нефизиологичный масштаб (вольты).

    Иначе амплитуды уедут в «вольты» и детекторы/отбраковка эпох собьются
    (см. audit.md, баг #8).
    """
    raw = load_edf(_REAL_EDF, settings.standard_channels)
    median_std_v = float(np.median(np.std(raw.get_data(verbose=False), axis=1)))
    # физиологичный ЭЭГ: единицы-сотни мкВ, т.е. < 1 мВ
    assert median_std_v < 1e-3, f"масштаб завышен: median std = {median_std_v} В"


@pytest.mark.skipif(not os.path.exists(_REAL_EDF), reason="test.edf отсутствует")
def test_load_edf_explicit_units_respected():
    """Явные единицы передаются в MNE и не пересчитываются эвристикой."""
    raw = load_edf(_REAL_EDF, settings.standard_channels, units="uV")
    median_std_v = float(np.median(np.std(raw.get_data(verbose=False), axis=1)))
    assert 1e-6 < median_std_v < 1e-3
