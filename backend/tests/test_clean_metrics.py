"""Зоны вклада чистки и метрики потерь L1/L3/L4/L5 (шаг 2 плана).

Проверяется то, на что опирается UI: зоны локализуют вклад чистки во времени,
id стабильны между пересчётами (иначе отмена — лотерея), отмена зоны
возвращает сырые сэмплы, а метрики считаются для текущей конфигурации.
"""
import mne
import numpy as np

from app.core.config import settings
from app.services.artifact_cleaner import CleanSpec, apply_cleaning
from app.services.clean_metrics import clean_loss, detect_clean_zones

_CHANNELS = ["Fp1", "Fp2", "C3", "C4", "T7", "T8", "P3", "P4"]
_SFREQ = 500.0


def _line_raw(duration_sec: float = 10.0, seed: int = 0) -> mne.io.RawArray:
    """Шум + локальная гармоника 100 Гц в окне [4, 5] с.

    Вырезание гармоники notch (шаг 1 чистки) даёт вклад **только** в этом окне:
    diff «до − после» локален, и зона обязана найтись именно там. Длительность
    10 с — с запасом длиннее фильтра MNE (иначе warning о длине фильтра
    и краевые искажения вспыхивают на весь сигнал).
    """
    rng = np.random.default_rng(seed)
    n = int(_SFREQ * duration_sec)
    data = rng.standard_normal((len(_CHANNELS), n)) * 2e-6
    t = np.arange(n) / _SFREQ
    start, end = int(4.0 * _SFREQ), int(5.0 * _SFREQ)
    window = np.hanning(end - start)  # плавные края — честный локальный вклад
    data[:, start:end] += 40e-6 * window * np.sin(2 * np.pi * 100.0 * t[start:end])
    raw = mne.io.RawArray(data, mne.create_info(_CHANNELS, _SFREQ, "eeg"), verbose=False)
    raw.set_montage("standard_1020", verbose=False)
    return raw


def _zone_covering(report, low: float, high: float):
    """Зона, перекрывающая окно вклада (краевые транзиенты фильтра не мешают)."""
    return next(
        (z for z in report.zones
         if z["onset_sec"] <= low and z["onset_sec"] + z["duration_sec"] >= high),
        None,
    )


def test_zones_localized_and_ids_stable_between_recalculations():
    """Зона локализует окно вклада; id не едут при пересчёте с отменой."""
    report1 = apply_cleaning(_line_raw(), CleanSpec(notch_harmonics=1), settings, notch_hz=50.0)
    zone = _zone_covering(report1, 4.2, 4.8)
    assert zone is not None, "вклад вырезанной гармоники обязан дать зону в окне"
    assert zone["id"].startswith("clean-")
    assert zone["channels"], "у зоны есть каналы-виновники"
    assert set(zone["channels"]) <= set(_CHANNELS)
    assert zone["amplitude_uv"] > 0

    # Пересчёт с отменой: зоны считаются от полного вклада — id те же
    report2 = apply_cleaning(
        _line_raw(),
        CleanSpec(notch_harmonics=1, exclude_zone_ids=(zone["id"],)),
        settings, notch_hz=50.0,
    )
    assert [z["id"] for z in report2.zones] == [z["id"] for z in report1.zones]
    excluded = _zone_covering(report2, 4.2, 4.8)
    assert excluded is not None and excluded["excluded"] is True
    assert zone["excluded"] is False


def test_excluded_zone_restores_raw_samples():
    """Отменённая зона: сэмплы байт-в-байт как до чистки; вне зоны чистка есть."""
    raw = _line_raw()
    before = raw.get_data().copy()
    report_full = apply_cleaning(_line_raw(), CleanSpec(notch_harmonics=1), settings, notch_hz=50.0)
    window_zone = _zone_covering(report_full, 4.2, 4.8)
    assert window_zone is not None

    raw = _line_raw()
    report = apply_cleaning(
        raw, CleanSpec(notch_harmonics=1, exclude_zone_ids=(window_zone["id"],)),
        settings, notch_hz=50.0,
    )
    zone = _zone_covering(report, 4.2, 4.8)
    assert zone is not None and zone["excluded"] is True
    start = round(zone["onset_sec"] * _SFREQ)
    end = round((zone["onset_sec"] + zone["duration_sec"]) * _SFREQ)
    after = raw.get_data()
    # В зоне — ровно тот сигнал, что был до чистки (включая всё «плохое»)
    assert np.array_equal(after[:, start:end], before[:, start:end])
    # Вне зоны чистка применена: гармоника 100 Гц вырезана — сигнал отличается
    head = int(2 * _SFREQ)
    assert not np.allclose(after[:, :head], before[:, :head])


def test_unknown_zone_id_warns_instead_of_raising():
    """Неизвестный id — warning в отчёте: сервер не решает за клиента (2.1)."""
    report = apply_cleaning(
        _line_raw(),
        CleanSpec(notch_harmonics=1, exclude_zone_ids=("clean-99",)),
        settings, notch_hz=50.0,
    )
    assert any("clean-99" in warning for warning in report.warnings)


def test_loss_carries_l1_l3_l4_l5_for_current_config():
    """Отчёт несёт полный loss: линии сети, все полосы, доля дисперсии."""
    report = apply_cleaning(_line_raw(), CleanSpec(notch_harmonics=1), settings, notch_hz=50.0)
    loss = report.loss
    assert loss is not None
    # L1: основная 50 Гц + гармоника 100 Гц
    assert [round(line["freq_hz"]) for line in loss["line_noise"]] == [50, 100]
    # L3/L4: все полосы freq_bands (DRY: сервер не выдумывает свои)
    assert {band["name"] for band in loss["bands"]} == set(settings.freq_bands)
    for band in loss["bands"]:
        if band["delta_db"] is not None:
            assert band["correlation"] is not None
            assert 0.0 <= band["correlation"] <= 1.0
    # L5: метод none — источник честно «diff», доля в разумных пределах
    assert loss["removed_variance_source"] == "diff"
    assert 0.0 <= loss["removed_variance_percent"] <= 100.0
    # Словарь отчёта отдаёт зоны и loss наружу (валидирует CleanReportOut)
    as_dict = report.as_dict()
    assert as_dict["loss"] == loss
    assert as_dict["zones"][0]["id"] == "clean-1"
    assert "_samples" not in as_dict["zones"][0]


def test_loss_without_notch_has_no_line_noise():
    """Без notch — L1 пуста (не выдумываем частоты), полосы на месте."""
    report = apply_cleaning(_line_raw(), CleanSpec(notch_harmonics=0), settings, notch_hz=None)
    loss = report.loss
    assert loss is not None
    assert loss["line_noise"] == []
    assert len(loss["bands"]) == len(settings.freq_bands)


def test_clean_loss_respects_component_variance_from_caller():
    """ICA-оценка L5 проходит через clean_loss со своей подписью источника."""
    rng = np.random.default_rng(1)
    before = rng.standard_normal((4, 4000)) * 2e-6
    loss = clean_loss(
        before, before * 0.9, _SFREQ, settings,
        notch_hz=50.0, notch_harmonics=1,
        removed_variance_percent=42.0, removed_variance_source="ica_components",
    )
    assert loss["removed_variance_percent"] == 42.0
    assert loss["removed_variance_source"] == "ica_components"


def test_detector_drops_short_and_merges_close_intervals():
    """Короткий всплеск не зона; близкие интервалы сшиваются в один."""
    sfreq = 500.0
    n = 1500  # 3 с
    rng = np.random.default_rng(2)
    before = rng.standard_normal((2, n)) * 1e-6
    after = before - rng.standard_normal((2, n)) * 1e-7  # шумовой фон diff
    for start, end in ((250, 300), (350, 400), (1000, 1015)):
        # 100 мс, 100 мс (gap 100 мс < merge 300 мс) и 30 мс (< min 100 мс)
        after[:, start:end] = before[:, start:end] - 1e-3

    zones = detect_clean_zones(before, after, sfreq, settings)

    assert len(zones) == 1  # первые два сшиты, короткий отброшен
    onset, duration = zones[0]["onset_sec"], zones[0]["duration_sec"]
    assert abs(onset - 0.5) < 0.02
    assert abs(duration - 0.3) < 0.02
    assert zones[0]["amplitude_uv"] > 0


def test_spec_with_exclusions_is_a_different_cache_key():
    """Отмены входят в ключ кэша (CleanSpec — часть _SignalKey)."""
    assert CleanSpec(exclude_zone_ids=("clean-1",)) != CleanSpec()
    assert "отмены=clean-1" in CleanSpec(exclude_zone_ids=("clean-1",)).label()
    assert CleanSpec().label() == "без очистки"
