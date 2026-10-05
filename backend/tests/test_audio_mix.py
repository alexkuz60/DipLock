"""Тесты шин и сведения (M2): группы L/C/R, веса, нормализация, мастер, пик."""
import numpy as np
import pytest

from app.core.config import settings
from app.services.audio_render.mix import (
    BOOST_DEFAULT_DB,
    BOOST_MAX_DB,
    CHANNEL_ORDER,
    PEAK_CEILING,
    TRACK_RMS_DBFS,
    apply_peak_ceiling,
    bus_weights,
    master_mix,
    normalize_track,
    track_rms,
)

# Половина схемы: по одному электроду на группу + срединные.
CHANNELS = ["F3", "F4", "Cz", "T7", "T8", "Fz"]


def test_channel_order_comes_from_config() -> None:
    """CHANNEL_ORDER — константа из config (DRY), а не второй справочник."""
    assert tuple(settings.standard_channels) == CHANNEL_ORDER
    assert "Fz" in CHANNEL_ORDER and "Cz" in CHANNEL_ORDER


def test_bus_weights_split_by_montage() -> None:
    """Шины: нечётные в L, чётные в R, срединные — 0.5 в оба (сумма = 1.0)."""
    w_left, w_right, groups = bus_weights(CHANNELS)
    index = {name: i for i, name in enumerate(CHANNELS)}

    assert groups["left"] == ["F3", "T7"]
    assert groups["right"] == ["F4", "T8"]
    assert groups["midline"] == ["Cz", "Fz"]

    # Срединные: по 0.5 в каждый buss (сумма весов группы = 1.0 по обоим
    # направлениям, приёмка ТЗ M2); доли каждого канала в L и R равны.
    for name in ("Cz", "Fz"):
        assert w_left[index[name]] == pytest.approx(w_right[index[name]])
        assert w_left[index[name]] > 0.0
    total_mid = sum(w_left[index[n]] + w_right[index[n]] for n in ("Cz", "Fz"))
    assert total_mid == pytest.approx(1.0)

    # Одиночный срединный канал (только Cz): его вклад ровно 0.5 + 0.5 = 1.0.
    w_single_left, w_single_right, _ = bus_weights(["F3", "F4", "Cz"])
    s = 2  # индекс Cz
    assert w_single_left[s] + w_single_right[s] == pytest.approx(1.0)

    # Неотрицательность и отсутствие «протечек»: левый не имеет веса в R и наоборот.
    assert (w_left >= 0).all() and (w_right >= 0).all()
    assert w_left[index["F4"]] == 0.0 and w_right[index["F3"]] == 0.0
    assert w_left[index["T8"]] == 0.0 and w_right[index["T7"]] == 0.0


def test_bus_weights_mean_formula() -> None:
    """mono = mean(группы) + 0.5·mean(срединных): веса дают ровно эту формулу."""
    w_left, w_right, _ = bus_weights(CHANNELS)
    rng = np.random.default_rng(7)
    eeg = rng.standard_normal((len(CHANNELS), 500))

    expected_left = eeg[[0, 3]].mean(axis=0) + 0.5 * eeg[[2, 5]].mean(axis=0)
    expected_right = eeg[[1, 4]].mean(axis=0) + 0.5 * eeg[[2, 5]].mean(axis=0)
    assert w_left @ eeg == pytest.approx(expected_left)
    assert w_right @ eeg == pytest.approx(expected_right)


def test_real_recording_channels_give_nonempty_busses() -> None:
    """Микс из реального набора каналов записи не даёт нулевых шин (приёмка M2)."""
    w_left, w_right, _ = bus_weights(list(CHANNELS))
    assert w_left.any(), "левая шина пуста"
    assert w_right.any(), "правая шина пуста"


def test_stranger_channel_is_rejected() -> None:
    """Канал вне схемы 10-20 — явная ошибка, а не молчаливая потеря электрода."""
    with pytest.raises(ValueError, match="вне схемы"):
        bus_weights(["F3", "F4", "EKG1"])


def test_empty_channel_list_is_rejected() -> None:
    """Пустой список каналов — ошибка входа."""
    with pytest.raises(ValueError, match="Нет каналов"):
        bus_weights([])


def test_normalize_track_hits_target_rms() -> None:
    """Трек приводится к RMS −18 dBFS; гейн сдвигает уровень, потолок — только вниз."""
    rng = np.random.default_rng(1)
    track = rng.standard_normal((1000, 2)) * 0.05  # уровень «похожий на сигнал»

    quiet, gain, rms = normalize_track(track)
    assert rms == pytest.approx(10 ** (TRACK_RMS_DBFS / 20), rel=1e-6)
    assert gain is not None
    # После +12 dB пик гауссова трека переваливает −1 dBFS: трек прижимается
    # к потолку (только вниз), applied gain/rms честно уменьшаются на величину
    # поджатия — PCM_24 не клипует значения >1.0.
    louder, gain_plus, rms_plus = normalize_track(track, gain_db=12.0)
    ideal = 10 ** ((TRACK_RMS_DBFS + 12.0) / 20)
    ceiling_db = 20.0 * float(np.log10(rms_plus / ideal))
    assert ceiling_db <= 1e-9  # поджатие может не сработать, но не раздувание
    assert gain_plus == pytest.approx(gain + 12.0 + ceiling_db)
    assert np.max(np.abs(louder)) <= PEAK_CEILING + 1e-9
    assert track_rms(louder) > track_rms(quiet)


def test_normalize_track_boost_raises_target() -> None:
    """boost_db поднимает целевой уровень: −18 + 6 = −12 dBFS (приёмка 05.10.2026)."""
    t = np.linspace(0.0, 40.0 * np.pi, 4000)
    track = np.stack([np.sin(t), np.cos(t)], axis=1) * 1e-3  # crest 3 дБ — без потолка

    _, gain, rms = normalize_track(track, boost_db=BOOST_DEFAULT_DB)
    assert gain is not None
    assert rms == pytest.approx(
        10 ** ((TRACK_RMS_DBFS + BOOST_DEFAULT_DB) / 20), rel=1e-6,
    )
    # Без boost прежний эталон −18 dBFS — контракт не изменился.
    _, _, rms_base = normalize_track(track)
    assert rms_base == pytest.approx(10 ** (TRACK_RMS_DBFS / 20), rel=1e-6)


def test_track_peak_is_capped_at_ceiling_with_boost() -> None:
    """Пик трека прижимается к 0.891: при boost громкий трек не клипнет в PCM_24."""
    spike = np.zeros((2000, 2))
    spike[1000, 0] = 1000.0  # импульсный трек с огромным crest-фактором

    out, gain, rms = normalize_track(spike, boost_db=BOOST_MAX_DB)
    assert gain is not None and rms is not None
    assert float(np.max(np.abs(out))) == pytest.approx(PEAK_CEILING)
    # Поджатие — только вниз: фактический RMS ниже целевого −18 + boost.
    assert rms < 10 ** ((TRACK_RMS_DBFS + BOOST_MAX_DB) / 20)


def test_normalize_track_applies_loudness_offset() -> None:
    """Психоакустическая поправка сдвигает целевой RMS (ISO 226, знак важен)."""
    t = np.linspace(0.0, 40.0 * np.pi, 4000)
    track = np.stack([np.sin(t), np.cos(t)], axis=1) * 1e-3  # crest 3 дБ

    # «Яма» 2–4 кГц (beta): отрицательное смещение — трек опускается ниже −18.
    _, _, rms_beta = normalize_track(track, loudness_db=-2.2)
    assert rms_beta == pytest.approx(10 ** ((TRACK_RMS_DBFS - 2.2) / 20), rel=1e-6)

    # Глухая басовая полоса (delta): положительное — поднимается.
    _, _, rms_delta = normalize_track(track, loudness_db=11.7)
    assert rms_delta == pytest.approx(10 ** ((TRACK_RMS_DBFS + 11.7) / 20), rel=1e-6)

    # Суммируется с boost: −18 + boost + loudness.
    _, _, rms_both = normalize_track(track, boost_db=6.0, loudness_db=-2.2)
    assert rms_both == pytest.approx(10 ** ((TRACK_RMS_DBFS + 6.0 - 2.2) / 20), rel=1e-6)


def test_silent_track_is_not_amplified() -> None:
    """Порог тишины: трек без сигнала не раздувается до −18 dBFS (ТЗ §3.1)."""
    tiny = np.full((100, 2), 1e-12)  # ниже AUDIO_SILENCE_FLOOR_V (1 нВ)
    out, gain, rms = normalize_track(tiny, gain_db=12.0)
    assert gain is None and rms is None
    assert np.isfinite(out).all() and not out.any()

    # Почти нулевой, но «сигнальный» трек нормализуется честно.
    weak = np.full((100, 2), 1e-6)  # 1 мкВ — физиологический уровень
    _, gain, rms = normalize_track(weak)
    assert rms == pytest.approx(10 ** (TRACK_RMS_DBFS / 20), rel=1e-6)
    assert gain is not None and gain > 0.0


def test_master_scales_down_to_peak_ceiling_only() -> None:
    """Мастер: пик прижимается к 0.891, тихий сигнал не раздувается."""
    loud = np.full((10, 2), 4.0)
    scale = apply_peak_ceiling(loud)
    assert float(np.max(np.abs(loud))) == pytest.approx(PEAK_CEILING)
    assert scale < 1.0

    quiet = np.full((10, 2), 0.1)
    scale = apply_peak_ceiling(quiet)
    assert scale == 1.0
    assert float(np.max(np.abs(quiet))) == pytest.approx(0.1)


def test_master_mix_sums_tracks() -> None:
    """Мастер — линейная сумма треков (без потерь и переполнений float64)."""
    a = np.ones((4, 2))
    b = np.full((4, 2), 2.0)
    master = master_mix([a, b])
    assert master == pytest.approx(np.full((4, 2), 3.0))
    assert master.dtype == np.float64
    with pytest.raises(ValueError):
        master_mix([])
