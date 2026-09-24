"""Тесты сервисов пайплайна: bandpass_filter и epoch_segmenter."""
import mne
import pytest

from app.core.config import settings
from app.services.bandpass_filter import apply_band_filter, compute_band_power
from app.services.epoch_segmenter import segment_epochs

# ---------- compute_band_power ----------

def test_compute_band_power_all_bands_present(epochs_alpha):
    powers = compute_band_power(epochs_alpha, settings.freq_bands)
    assert set(powers) == set(settings.freq_bands)
    assert all(isinstance(v, float) for v in powers.values())


def test_compute_band_power_alpha_dominates(epochs_alpha):
    """Сигнал 10 Гц → мощность alpha выше delta/gamma."""
    powers = compute_band_power(epochs_alpha, settings.freq_bands)
    assert powers["alpha"] > powers["delta"]
    assert powers["alpha"] > powers["gamma"]


def test_compute_band_power_empty_bands(epochs_alpha):
    assert compute_band_power(epochs_alpha, {}) == {}


# ---------- apply_band_filter ----------

def test_apply_band_filter_all_returns_input(epochs_alpha):
    """'all' не фильтрует — возвращает исходный объект без копии."""
    assert apply_band_filter(epochs_alpha, "all") is epochs_alpha


def test_apply_band_filter_unknown_band_raises(epochs_alpha):
    with pytest.raises(ValueError, match="Неизвестный диапазон"):
        apply_band_filter(epochs_alpha, "bogus")


def test_apply_band_filter_custom_requires_bounds(epochs_alpha):
    with pytest.raises(ValueError, match="custom_min и custom_max"):
        apply_band_filter(epochs_alpha, "custom")


@pytest.mark.parametrize("band", ["delta", "theta", "alpha", "beta", "gamma"])
def test_apply_band_filter_standard_bands(epochs_alpha, band):
    out = apply_band_filter(epochs_alpha, band)
    assert out is not epochs_alpha
    assert len(out) == len(epochs_alpha)


def test_apply_band_filter_custom_range(epochs_alpha):
    out = apply_band_filter(epochs_alpha, "custom", custom_min=7.0, custom_max=9.5)
    assert out is not epochs_alpha
    assert len(out) == len(epochs_alpha)


def test_apply_band_filter_single_freq(epochs_alpha):
    out = apply_band_filter(epochs_alpha, "all", single_freq=10.0, bandwidth_hz=1.0)
    assert out is not epochs_alpha
    assert len(out) == len(epochs_alpha)


def test_apply_band_filter_accepts_raw(raw_eeg):
    """Фильтр применяется и к continuous raw (пайплайн фильтрует raw до нарезки)."""
    out = apply_band_filter(raw_eeg, "alpha")
    assert out is not raw_eeg
    assert out.info["nchan"] == raw_eeg.info["nchan"]


def test_standard_montage_helper_applies(raw_eeg):
    from app.services.edf_loader import _apply_standard_montage

    _apply_standard_montage(raw_eeg)  # идемпотентно, без исключений
    assert raw_eeg.get_montage() is not None


# ---------- segment_epochs ----------

def test_segment_epochs_invalid_length_raises(raw_eeg, empty_annotations):
    with pytest.raises(ValueError, match="не в списке"):
        segment_epochs(raw_eeg, empty_annotations, epoch_length_ms=123.0)


def test_segment_epochs_non_overlapping(raw_eeg, empty_annotations):
    """4 с записи, эпоха 1 с → 3 полные эпохи (последняя не влезает и отбрасывается)."""
    epochs = segment_epochs(raw_eeg, empty_annotations, epoch_length_ms=1000.0)
    assert len(epochs) == 3


def test_segment_epochs_returns_mne_epochs(raw_eeg, empty_annotations):
    """4 с записи, эпоха 2 с → 1 полная эпоха умещается."""
    epochs = segment_epochs(raw_eeg, empty_annotations, epoch_length_ms=2000.0)
    assert isinstance(epochs, mne.Epochs)
    assert len(epochs) == 1


def test_segment_epochs_all_rejected_error_lists_bad_coverage(raw_eeg):
    """«Все эпохи отброшены» называет тип и покрытие BAD_ (фидбэк 24.09.2026)."""
    annotations = mne.Annotations([0.0], [4.0], ["BAD_zscore_outlier"])

    with pytest.raises(ValueError) as excinfo:
        segment_epochs(raw_eeg, annotations, epoch_length_ms=1000.0)

    text = str(excinfo.value)
    assert "Покрытие" in text
    assert "zscore_outlier" in text
    assert "100 % записи (1 зон)" in text


def test_bad_coverage_text_merges_overlapping_intervals():
    """Пересекающиеся зоны одного типа сливаются — процент не задваивается."""
    import mne as mne_lib

    from app.services.epoch_segmenter import bad_coverage_text

    annotations = mne_lib.Annotations(
        [0.0, 1.0, 2.0], [2.0, 2.0, 1.0], ["BAD_zscore_outlier"] * 2 + ["BAD_peak_to_peak"],
    )

    text = bad_coverage_text(annotations, 4.0)

    # zscore: слитые интервалы 0–3 с = 75 %, 2 зоны; p2p: 2–3 с = 25 %, 1 зона
    assert "zscore_outlier — 75 % записи (2 зон)" in text
    assert "peak_to_peak — 25 % записи (1 зон)" in text
