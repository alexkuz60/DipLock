"""Дизайн фильтра (шаг 2.5, N11–N14): метод FIR/IIR, переходные полосы, буфер края, АЧХ.

Дрейф-тест переходных полос («auto == явные») — страховка от обновлений MNE:
формула ``"auto"`` зафиксирована числом в ``filter_design.transition_bandwidths``,
и смена дефолтов MNE не должна пройти молча (правило ``docs/rules/safety.md``).
"""
import mne
import numpy as np
import pytest

from app.services.bandpass_filter import apply_band_filter, band_bounds
from app.services.epoch_segmenter import EDGE_DESC, edge_annotations, segment_epochs
from app.services.filter_design import (
    band_filter_kwargs,
    design_filter,
    filter_response,
    harmonic_frequencies,
    notch_frequencies,
    resolve_filter_method,
    transition_bandwidths,
)


def _raw(duration: float = 30.0, sfreq: float = 100.0, n_channels: int = 3) -> mne.io.RawArray:
    """Синтетический raw для тестов краёв: шум + тон 10 Гц, без монтажа."""
    rng = np.random.RandomState(0)
    n_times = int(duration * sfreq)
    data = rng.randn(n_channels, n_times) * 1e-6
    t = np.arange(n_times) / sfreq
    data += 5e-6 * np.sin(2 * np.pi * 10.0 * t)
    return mne.io.RawArray(
        data, mne.create_info([f"C{i}" for i in range(n_channels)], sfreq, "eeg"), verbose=False,
    )


# ---------- N11: переходные полосы и метод ----------

def test_transition_bandwidths_match_mne_auto():
    """Явные переходные полосы дают те же тапы, что и MNE 'auto' (дрейф-тест)."""
    sfreq = 500.0
    data = np.zeros((1, 20000))
    for l_freq, h_freq in [(1.0, 40.0), (8.0, 12.0), (0.5, 100.0), (None, 30.0), (2.0, None)]:
        auto = mne.filter.create_filter(data, sfreq, l_freq, h_freq, verbose=False)
        l_trans, h_trans = transition_bandwidths(l_freq, h_freq, sfreq)
        kwargs: dict = {}
        if l_trans is not None:
            kwargs["l_trans_bandwidth"] = l_trans
        if h_trans is not None:
            kwargs["h_trans_bandwidth"] = h_trans
        explicit = mne.filter.create_filter(data, sfreq, l_freq, h_freq, verbose=False, **kwargs)
        assert np.array_equal(auto, explicit), (l_freq, h_freq, l_trans, h_trans)


def test_resolve_filter_method_wide_fir_narrow_iir():
    assert resolve_filter_method(1.0, 40.0) == "fir"
    assert resolve_filter_method(7.58, 8.08) == "iir"  # «одиночная частота» kimi3
    assert resolve_filter_method(1.0, 2.0) == "iir"  # ровно на пороге 1 Гц
    assert resolve_filter_method(1.0, 2.5) == "fir"
    assert resolve_filter_method(None, None) == "none"
    assert resolve_filter_method(1.0, None) == "fir"  # односторонняя — всегда FIR


def test_design_filter_reports_kernel_and_edge_buffer():
    wide = design_filter(1.0, 40.0, 500.0)
    assert wide.method == "fir"
    assert wide.filter_length_sec == pytest.approx(3.302, abs=0.05)  # 1651 тап @500 Гц
    assert wide.edge_buffer_sec == pytest.approx(wide.filter_length_sec / 2)
    assert wide.l_trans_bandwidth == 1.0 and wide.h_trans_bandwidth == 10.0

    narrow = design_filter(7.58, 8.08, 500.0)
    assert narrow.method == "iir"
    assert narrow.filter_length_sec is None
    assert narrow.edge_buffer_sec == 0.0  # у короткого IIR-ядра буфера нет

    assert design_filter(None, None, 500.0).method == "none"


def test_band_filter_kwargs_by_method():
    assert band_filter_kwargs(1.0, 40.0, 500.0) == {
        "l_trans_bandwidth": 1.0, "h_trans_bandwidth": 10.0,
    }
    assert band_filter_kwargs(7.58, 8.08, 500.0) == {"method": "iir"}
    assert band_filter_kwargs(None, None, 500.0) == {}


# ---------- N13: гармоники notch ----------

def test_harmonic_frequencies_and_nyquist_guard():
    assert harmonic_frequencies(50.0, 3, 500.0) == [100.0, 150.0, 200.0]
    assert harmonic_frequencies(50.0, 0, 500.0) == []
    assert harmonic_frequencies(None, 3, 500.0) == []
    # 60×4=240 < 250−1 проходит; гармоники выше Nyquist − 1 Гц режутся
    assert harmonic_frequencies(60.0, 4, 500.0) == [120.0, 180.0, 240.0]
    assert harmonic_frequencies(60.0, 2, 250.0) == [120.0]  # 180 > 124 → отрезана
    assert notch_frequencies(50.0, 2, 500.0) == [50.0, 100.0, 150.0]
    assert notch_frequencies(None, 2, 500.0) == []


# ---------- АЧХ ----------

def test_filter_response_passband_flat_notch_dips():
    response = filter_response(1.0, 40.0, notch_hz=50.0, notch_harmonics=1, sfreq=500.0)
    assert response.design.method == "fir"
    assert len(response.freqs_hz) == len(response.gain_db) and len(response.freqs_hz) > 300

    def gain_at(freq: float) -> float:
        return float(response.gain_db[int(np.argmin(np.abs(response.freqs_hz - freq)))])

    for freq in (2.0, 10.0, 30.0, 40.0):
        assert abs(gain_at(freq)) < 1.0, freq  # 0 дБ в полосе пропускания
    assert gain_at(50.0) < -30.0  # провал основной частоты notch
    assert gain_at(100.0) < -30.0  # провал гармоники (N13)
    assert gain_at(0.5) < -3.0  # обрез нижней границы
    assert gain_at(60.0) < -30.0  # стоп-полоса выше 40 Гц
    assert response.notch_freqs == (50.0, 100.0)
    assert response.band_hz == (1.0, 40.0)


def test_filter_response_narrow_band_uses_iir():
    response = filter_response(7.58, 8.08, sfreq=500.0)
    assert response.design.method == "iir"

    def gain_at(freq: float) -> float:
        return float(response.gain_db[int(np.argmin(np.abs(response.freqs_hz - freq)))])

    assert abs(gain_at(7.83)) < 1.5  # центр полосы — 0 дБ
    assert gain_at(5.0) < -10.0
    assert gain_at(12.0) < -10.0


def test_narrow_iir_keeps_center_tone():
    """Узкая IIR-полоса (kimi3) выделяет тон центра и гасит соседний (7.83±0.25)."""
    sfreq = 250.0
    t = np.arange(int(30.0 * sfreq)) / sfreq
    tone = 5e-6 * np.sin(2 * np.pi * 7.83 * t)
    neighbor = 5e-6 * np.sin(2 * np.pi * 12.0 * t)
    raw = mne.io.RawArray(
        (tone + neighbor)[None, :],
        mne.create_info(["C3"], sfreq, "eeg"), verbose=False,
    )
    filtered = apply_band_filter(raw, "all", single_freq=7.83, bandwidth_hz=0.5)
    # Спектр по середине записи (без краёв): тон центра сохранён, сосед гасится
    mid = slice(int(5 * sfreq), int(25 * sfreq))
    spec_in = np.abs(np.fft.rfft(raw.get_data()[0, mid]))
    spec_out = np.abs(np.fft.rfft(filtered.get_data()[0, mid]))
    freqs = np.fft.rfftfreq(int(20 * sfreq), 1.0 / sfreq)

    def amplitude(spec: np.ndarray, freq: float) -> float:
        return float(spec[int(np.argmin(np.abs(freqs - freq)))])

    assert amplitude(spec_out, 7.83) > 0.5 * amplitude(spec_in, 7.83)
    assert amplitude(spec_out, 12.0) < 0.1 * amplitude(spec_in, 12.0)


# ---------- N12: краевой буфер ----------

def test_edge_annotations_fir_edges_iir_none():
    raw = _raw(duration=30.0, sfreq=100.0)
    edge = edge_annotations(raw, (1.0, 40.0))
    assert list(edge.description) == [EDGE_DESC, EDGE_DESC]
    assert float(edge.onset[0]) == 0.0
    assert float(edge.duration[0]) == pytest.approx(1.651, abs=0.05)  # половина ядра
    assert float(edge.onset[1]) == pytest.approx(30.0 - 1.651, abs=0.05)
    # У IIR и без полосы буфера нет
    assert len(edge_annotations(raw, (7.58, 8.08)).onset) == 0
    assert len(edge_annotations(raw, None).onset) == 0
    # Запись короче 2×буфера — честная пометка всей записи
    short = _raw(duration=2.0, sfreq=100.0)
    whole = edge_annotations(short, (1.0, 40.0))
    assert list(whole.description) == [EDGE_DESC]
    assert float(whole.duration[0]) == pytest.approx(2.0)


def test_segment_epochs_drops_edge_epochs_with_bad_edge():
    raw = _raw(duration=30.0, sfreq=100.0)
    epochs = segment_epochs(
        raw, mne.Annotations([], [], []),
        epoch_length_ms=2000.0, filter_band=(1.0, 40.0),
    )
    dropped = [log for log in epochs.drop_log if log]
    assert dropped, "края записи должны отбрасываться"
    assert all(log == (EDGE_DESC,) for log in dropped)
    # Центр записи цел: эпохи есть, и первая/последняя — не у краёв
    starts = sorted(float(event[0]) / raw.info["sfreq"] for event in epochs.events)
    assert starts and starts[0] > 1.0 and starts[-1] < 28.0


def test_segment_epochs_without_band_keeps_edges(raw_eeg, empty_annotations):
    """Без полосы фильтра края не помечаются — поведение до шага 2.5 сохранено."""
    epochs = segment_epochs(raw_eeg, empty_annotations, epoch_length_ms=1000.0)
    assert len(epochs) == 3
    assert not any(EDGE_DESC in log for log in epochs.drop_log)


def test_band_bounds_matches_apply_band_filter_cases():
    from app.core.config import settings

    assert band_bounds("all") is None
    assert band_bounds("alpha") == settings.freq_bands["alpha"]
    assert band_bounds("custom", 7.0, 9.5) == (7.0, 9.5)
    assert band_bounds("all", single_freq=7.83, bandwidth_hz=0.5) == (7.58, 8.08)
    with pytest.raises(ValueError, match="custom_min"):
        band_bounds("custom")
    with pytest.raises(ValueError, match="Неизвестный диапазон"):
        band_bounds("bogus")
