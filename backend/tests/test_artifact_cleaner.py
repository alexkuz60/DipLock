"""Очистка сигнала MNE-only (этап 4): гармоники notch, bad-каналы, ICA, SSP."""
import mne
import numpy as np

from app.core.config import settings
from app.services.artifact_cleaner import CLEAN_METHODS, CleanSpec, apply_cleaning

_CHANNELS = ["Fp1", "Fp2", "C3", "C4", "T7", "T8", "P3", "P4"]
_SFREQ = 500.0


def _raw(duration_sec: float = 30.0, seed: int = 0) -> mne.io.RawArray:
    rng = np.random.default_rng(seed)
    data = rng.standard_normal((len(_CHANNELS), int(_SFREQ * duration_sec))) * 2e-6
    raw = mne.io.RawArray(data, mne.create_info(_CHANNELS, _SFREQ, "eeg"), verbose=False)
    raw.set_montage("standard_1020", verbose=False)
    return raw


def test_clean_spec_label_mentions_steps():
    """Метка спец-ключа читается в журнале: что именно применили."""
    spec = CleanSpec(
        notch_harmonics=2, bad_channels=("C3",), interpolate_bads=True, method="ica",
    )
    label = spec.label()
    assert "гармоник" in label and "C3" in label and "интерполяция" in label and "ica" in label
    assert CleanSpec().label() == "без очистки"
    assert set(CLEAN_METHODS) == {"none", "ica", "ssp"}


def test_interpolate_bads_replaces_channel_and_reports():
    """Bad-канал интерполируется и попадает в отчёт; чужие имена — в предупреждение."""
    rng = np.random.default_rng(4)
    n = int(_SFREQ * 30.0)
    data = rng.standard_normal((len(_CHANNELS), n)) * 2e-6
    data[2] = 200e-6 * np.sin(2 * np.pi * 8 * np.arange(n) / _SFREQ)  # C3 «испорчен»
    raw = mne.io.RawArray(data, mne.create_info(_CHANNELS, _SFREQ, "eeg"), verbose=False)
    raw.set_montage("standard_1020", verbose=False)

    report = apply_cleaning(
        raw, CleanSpec(bad_channels=("C3", "XYZ"), interpolate_bads=True), settings,
    )

    assert report.interpolated_channels == ["C3"]
    assert any("XYZ" in warning for warning in report.warnings)
    assert report.amplitude_p95_uv_after <= report.amplitude_p95_uv_before


def test_notch_harmonics_counted_in_report():
    """Гармоники notch (100/150/200 Гц для 50 Гц) считаются в отчёте."""
    report = apply_cleaning(
        _raw(), CleanSpec(notch_harmonics=3), settings, notch_hz=50.0,
    )
    assert report.notch_harmonics == 3


def test_ica_clean_reports_removed_components():
    """ICA-очистка: отчёт содержит число/индексы компонент и метрики до/после."""
    report = apply_cleaning(_raw(), CleanSpec(method="ica", ica_n_components=6), settings)

    assert report.method == "ica"
    assert report.n_components_removed == len(report.removed_components)
    assert report.amplitude_p95_uv_before is not None
    assert report.amplitude_p95_uv_after is not None


def test_ssp_clean_is_reported():
    """SSP: проекторы применяются и считаются (или честное предупреждение)."""
    report = apply_cleaning(_raw(), CleanSpec(method="ssp"), settings)

    assert report.n_projectors >= 0
    assert report.n_projectors > 0 or report.warnings