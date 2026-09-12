"""Тесты конфигурации: единый источник DRY для диапазонов и длин эпох."""
from app.core.config import Settings, settings


def test_freq_bands_exact_set():
    assert set(settings.freq_bands) == {"delta", "theta", "alpha", "beta", "gamma"}


def test_freq_bands_intervals_valid():
    for name, (fmin, fmax) in settings.freq_bands.items():
        assert 0 < fmin < fmax, f"диапазон {name} некорректен"


def test_epoch_lengths_positive_and_default_included():
    assert all(x > 0 for x in settings.epoch_lengths_ms)
    assert settings.default_epoch_length_ms in settings.epoch_lengths_ms


def test_standard_channels_10_20():
    assert len(settings.standard_channels) == 20
    assert {"Fp1", "Fp2", "Cz", "Oz"} <= set(settings.standard_channels)


def test_env_override(monkeypatch):
    """Переменные окружения имеют приоритет над дефолтами."""
    monkeypatch.setenv("APP_NAME", "TestApp")
    assert Settings().app_name == "TestApp"
