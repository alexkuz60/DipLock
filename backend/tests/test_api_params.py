"""Тесты разбора форм запроса (A1, этап 3).

Раньше эти проверки были скопированы в каждый эндпоинт (полоса, длина эпохи,
референс, набор ``*Params``). Здесь проверяется единственная реализация:
тексты ошибок важны — UI показывает их пользователю как есть.
"""
import pytest
from fastapi import HTTPException

from app.api.params import (
    dipole_scan_params,
    parse_filter_band,
    parse_reference_channels,
    preprocess_params,
    require_epoch_length,
    spectrogram_params,
    spectrum_params,
    stored_spectrogram_params,
    validate_analysis_request,
)
from app.core.config import settings
from app.services.spectrogram import SPECTROGRAM_WINDOW_RANGE_MS

# ---------- полоса фильтра ----------

def test_parse_filter_band_none_means_no_filter():
    """«Без фильтра» — это None: значение по умолчанию для всех расчётов."""
    assert parse_filter_band(None, None) is None


def test_parse_filter_band_keeps_pair():
    assert parse_filter_band(8.0, 13.0) == (8.0, 13.0)


@pytest.mark.parametrize("band_min,band_max,text", [
    (8.0, None, "band_min и band_max"),
    (None, 13.0, "band_min и band_max"),
    (13.0, 8.0, "меньше"),
    (8.0, 8.0, "меньше"),
])
def test_parse_filter_band_rejects_bad_pair(band_min, band_max, text):
    """Односторонняя или вывернутая полоса — 400: догадываться о границе нельзя."""
    with pytest.raises(HTTPException) as err:
        parse_filter_band(band_min, band_max)

    assert err.value.status_code == 400
    assert text in err.value.detail


# ---------- референс и длина эпохи ----------

@pytest.mark.parametrize("raw,expected", [
    (None, None),
    ("", None),
    ("   ", None),
    ("F3", ["F3"]),
    (" F3, F4 ,", ["F3", "F4"]),
])
def test_parse_reference_channels(raw, expected):
    """Список каналов референса — из формы ``F3,F4`` (мусорные пробелы отбрасываются)."""
    assert parse_reference_channels(raw) == expected


def test_require_epoch_length_accepts_configured_value():
    assert require_epoch_length(settings.epoch_lengths_ms[0]) is None


def test_require_epoch_length_rejects_unknown_value():
    """Длина эпохи — из активного набора (DRY с панелью UI), иначе 400."""
    with pytest.raises(HTTPException) as err:
        require_epoch_length(123.0)

    assert err.value.status_code == 400
    assert "epoch_length_ms" in err.value.detail


# ---------- файловый анализ (/analyze, /jobs) ----------

def test_validate_analysis_request_accepts_defaults():
    assert validate_analysis_request(2000.0, "all", None) is None


def test_validate_analysis_request_rejects_unknown_band():
    with pytest.raises(HTTPException) as err:
        validate_analysis_request(2000.0, "bogus", None)

    assert err.value.status_code == 400
    assert "freq_band" in err.value.detail


def test_validate_analysis_request_rejects_single_freq_outside_all():
    """``single_freq`` ставится только вместе с ``freq_band='all'``."""
    with pytest.raises(HTTPException) as err:
        validate_analysis_request(2000.0, "alpha", 10.0)

    assert err.value.status_code == 400
    assert "single_freq" in err.value.detail


# ---------- сборка параметров сервисов ----------

def test_preprocess_params_filter_stage_ignores_epoch_length():
    """Стадия ``filter`` не режет эпохи — зажим длины эпохи её не касается."""
    params = preprocess_params(
        stage="filter", band_min=8.0, band_max=13.0, notch_hz=50.0,
        reference="custom", reference_channels="F3,F4",
        z_threshold=4.0, pp_threshold_uv=120.0, flat_line_uv=6.0, flat_line_ms=250.0,
        run_ica=True, epoch_length_ms=123.0, reject_threshold_uv=160.0,
    )

    assert params.filter_band == (8.0, 13.0)
    assert params.notch_hz == 50.0
    assert params.reference_channels == ["F3", "F4"]
    assert params.epoch_length_ms == 123.0  # значение не тронуто: стадия не про эпохи


def test_preprocess_params_epochs_stage_validates_epoch_length():
    with pytest.raises(HTTPException) as err:
        preprocess_params(
            stage="epochs", band_min=None, band_max=None, notch_hz=None,
            reference="average", reference_channels=None,
            z_threshold=5.0, pp_threshold_uv=100.0, flat_line_uv=5.0, flat_line_ms=200.0,
            run_ica=False, epoch_length_ms=123.0, reject_threshold_uv=150.0,
        )

    assert err.value.status_code == 400
    assert "epoch_length_ms" in err.value.detail


def test_spectrum_params_carry_band_notch_and_thresholds():
    params = spectrum_params(
        band_min=4.0, band_max=8.0, notch_hz=50.0, reference="average",
        reference_channels=None, epoch_length_ms=1000.0, reject_threshold_uv=140.0,
    )

    assert params.filter_band == (4.0, 8.0)
    assert params.notch_hz == 50.0
    assert params.epoch_length_ms == 1000.0
    assert params.reject_threshold_uv == 140.0


def test_dipole_scan_params_keep_grid_step():
    params = dipole_scan_params(
        band_min=None, band_max=None, notch_hz=None, reference="average",
        reference_channels=None, epoch_length_ms=1000.0,
        reject_threshold_uv=150.0, grid_mm=4.0,
    )

    assert params.grid_mm == 4.0
    assert params.filter_band is None


def test_spectrogram_params_validate_window_before_queueing():
    """Плохое окно STFT — 400 сразу: задача не должна падать в фоне."""
    with pytest.raises(HTTPException) as err:
        spectrogram_params(
            channel="Fp1", band_min=None, band_max=None, notch_hz=None,
            reference="average", reference_channels=None,
            window_ms=SPECTROGRAM_WINDOW_RANGE_MS[1] + 1000.0,
            overlap_pct=75.0, fmax_hz=40.0,
        )

    assert err.value.status_code == 400
    assert "Окно STFT" in err.value.detail


def test_spectrogram_params_require_channel():
    with pytest.raises(HTTPException) as err:
        spectrogram_params(
            channel="  ", band_min=None, band_max=None, notch_hz=None,
            reference="average", reference_channels=None,
            window_ms=500.0, overlap_pct=75.0, fmax_hz=40.0,
        )

    assert err.value.status_code == 400
    assert "канал" in err.value.detail


def test_stored_spectrogram_params_come_from_job_result():
    """Сетка ``grid.bin`` строится по параметрам **своего** расчёта, не по query."""
    params = stored_spectrogram_params({
        "channel": "Fp1",
        "filter_band_hz": [8.0, 13.0],
        "notch_hz": 50.0,
        "window_ms": 250.0,
        "overlap_pct": 50.0,
        "fmax_hz": 30.0,
    })

    assert params.channel == "Fp1"
    assert params.filter_band == (8.0, 13.0)
    assert params.notch_hz == 50.0
    assert (params.window_ms, params.overlap_pct, params.fmax_hz) == (250.0, 50.0, 30.0)


def test_stored_spectrogram_params_accept_missing_band():
    """Расчёт без фильтра хранит ``filter_band_hz = None`` — это не ошибка."""
    params = stored_spectrogram_params({
        "channel": "Fz", "filter_band_hz": None, "notch_hz": None,
        "window_ms": 500.0, "overlap_pct": 75.0, "fmax_hz": 40.0,
    })

    assert params.filter_band is None


def test_stored_spectrogram_params_read_reference():
    """Референс сетки берётся из результата задачи, а не подставляется молча (A11)."""
    params = stored_spectrogram_params({
        "channel": "Fp1", "filter_band_hz": None, "notch_hz": None,
        "reference": "custom", "reference_channels": ["F3", "F4"],
        "window_ms": 500.0, "overlap_pct": 75.0, "fmax_hz": 40.0,
    })

    assert params.reference == "custom"
    assert params.reference_channels == ["F3", "F4"]


def test_stored_spectrogram_params_fall_back_for_old_results():
    """Результаты, записанные до A11 (без ``reference``), читаются как ``average``."""
    params = stored_spectrogram_params({
        "channel": "Fz", "filter_band_hz": None, "notch_hz": None,
        "window_ms": 500.0, "overlap_pct": 75.0, "fmax_hz": 40.0,
    })

    assert params.reference == "average"
    assert params.reference_channels is None
