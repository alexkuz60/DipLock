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


def test_signal_levels_accepts_csv_and_json(monkeypatch):
    """SIGNAL_LEVELS пишут и через запятую (как в .env.example), и JSON-списком."""
    monkeypatch.setenv("SIGNAL_LEVELS", "1,2,4")
    assert Settings().signal_levels == [1, 2, 4]

    monkeypatch.setenv("SIGNAL_LEVELS", "[1, 8, 16]")
    assert Settings().signal_levels == [1, 8, 16]

    monkeypatch.setenv("SIGNAL_LEVELS", "1; 2 ;4")
    assert Settings().signal_levels == [1, 2, 4]


def test_signal_levels_default_and_base_points(monkeypatch):
    """Дефолт уровней согласован с дискретным зумом UI ×1…×16."""
    assert settings.signal_levels == [1, 2, 4, 8, 16]
    assert settings.signal_base_points > 0

    monkeypatch.setenv("SIGNAL_BASE_POINTS", "2000")
    assert Settings().signal_base_points == 2000
