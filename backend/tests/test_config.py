"""Тесты конфигурации: единый источник DRY для диапазонов и длин эпох."""
from app.core.config import Settings, settings

# Базовые октавные полосы (фаза A): ключи стабильны — это адрес результатов
# (кэш топокарт, строки БД), поэтому тест фиксирует и набор, и границы.
FREQ_BANDS_EXACT = {
    "delta": (0.5, 2),
    "delta_theta": (2, 4),
    "theta": (4, 8),
    "alpha": (8, 16),
    "beta": (16, 32),
    "gamma": (32, 64),
    "high_gamma": (64, 128),
}

# Функциональные ритмы — только пресеты фильтра (не участвуют в спектре).
FUNCTIONAL_BANDS_EXACT = {
    "mu": (8, 13),
    "sigma": (11, 16),
    "kappa": (8, 12),
    "tau": (8, 9),
    "lambda": (4, 5),
    "psi": (35, 55),
}


def test_freq_bands_exact_set():
    assert settings.freq_bands == FREQ_BANDS_EXACT


def test_functional_bands_exact_set():
    assert settings.functional_bands == FUNCTIONAL_BANDS_EXACT
    # Функциональные ритмы — отдельный словарь: в спектр/топокартах их нет
    assert set(settings.functional_bands).isdisjoint(settings.freq_bands)


def test_freq_bands_intervals_valid():
    for name, (fmin, fmax) in {**settings.freq_bands, **settings.functional_bands}.items():
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
