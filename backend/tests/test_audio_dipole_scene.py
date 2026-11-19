"""Тесты дипольной сцены и пространственной обработки «Монтажа» (19.11.2026).

Формулы владельца дословно: фазы ``φ_L/R = ±θ/2`` от момента диполя,
стереобаза ``S × w`` (0.8 дельта → 0.1 высокая гамма), равномощная панорама
по x, «колодезное» эхо от глубины z. Стражи «не навреди»: IR «колодца» —
шум (без периодических повторов), огибающая глубины медленнее запрещённого
диапазона фотостимуляции 3–60 Гц.
"""
import itertools

import numpy as np
import pytest

from app.core.config import settings
from app.services.audio_render import dipole_scene, dipole_spatial
from app.services.audio_render.core import band_analytic


def _frame(epoch: int, x: float, y: float, z: float, moment: tuple[float, float, float],
           amplitude: float) -> dict:
    return {
        "epoch_index": epoch,
        "time_ms": 100.0,
        "mni_coords": [x, y, z],
        "moment": list(moment),
        "amplitude_nam": amplitude,
        "gof": 0.8,
    }


def _result(points_by_band: dict[str, list[dict]], epoch_ms: float = 1000.0) -> dict:
    return {
        "epoch_length_ms": epoch_ms,
        "bands": [
            {"band_key": band, "points": points} for band, points in points_by_band.items()
        ],
    }


def test_scene_from_result_sorts_frames_and_reports_empty_bands() -> None:
    """Кадры сортируются по эпохам; полоса без точек — предупреждение, не падение."""
    result = _result({
        "delta": [
            _frame(2, 10.0, 0.0, 0.0, (1.0, 0.0, 0.0), 30.0),
            _frame(0, -10.0, 5.0, 20.0, (0.0, 1.0, 0.0), 10.0),
        ],
        "alpha": [],
    })
    scene = dipole_scene.scene_from_result(result, "job-1")
    assert scene.job_id == "job-1"
    assert scene.epoch_length_ms == 1000.0
    assert [frame.epoch_index for frame in scene.bands["delta"].frames] == [0, 2]
    assert "alpha" not in scene.bands
    assert any("alpha" in item for item in scene.warnings)
    # Точки без координат/эпохи честно пропускаются.
    result = _result({"delta": [{"epoch_index": 0, "moment": [1.0, 0.0, 0.0]}]})
    scene = dipole_scene.scene_from_result(result, None)
    assert "delta" not in scene.bands


def test_scene_from_result_requires_epoch_length() -> None:
    """Без длины эпохи времена кадров не построить — ошибка входа."""
    with pytest.raises(dipole_scene.DipoleSceneError, match="длины эпохи"):
        dipole_scene.scene_from_result({"epoch_length_ms": 0.0, "bands": []}, None)


def test_unwrap_theta_continues_across_branch_cut() -> None:
    """Азимут момента развёрнут: вращение через ±π не даёт скачка на 2π."""
    # Моменты крутятся против часовой: 150° → 180° → −150° (=210°).
    moments = [
        (np.cos(np.radians(150.0)), np.sin(np.radians(150.0)), 0.0),
        (-1.0, 0.0, 0.0),
        (np.cos(np.radians(-150.0)), np.sin(np.radians(-150.0)), 0.0),
    ]
    theta = dipole_scene._unwrap_theta(moments)
    assert theta[0] == pytest.approx(np.radians(150.0))
    assert theta[1] == pytest.approx(np.pi)
    assert theta[2] == pytest.approx(np.radians(210.0))  # а не −150°


def test_band_series_interpolates_holds_and_maps_depth() -> None:
    """Интерполяция как в playback.ts: между кадрами линейно, по краям hold.

    Глубина: z=+70 → 0, z=−70 → 1 (нижняя часть коронарного среза); сила —
    амплитуда, нормированная по пику полосы.
    """
    trajectory = dipole_scene.BandTrajectory(band="delta", frames=[
        dipole_scene.DipoleFrame(0, (0.0, 40.0, 70.0), (1.0, 0.0, 0.0), 20.0),
        dipole_scene.DipoleFrame(2, (40.0, 0.0, -70.0), (0.0, 1.0, 0.0), 40.0),
    ])
    # Кадры в 0 с и 2 с (L=1000 мс): измеренные эпохи 0 и 2, эпоха 1 — «разрыв».
    series = dipole_scene.band_series(
        trajectory, [0.0, 2.0], n_samples=2001, fs=1000.0, cfg=settings,
    )
    assert series.x_mm[0] == pytest.approx(0.0)
    assert series.depth[0] == pytest.approx(0.0)
    assert series.x_mm[-1] == pytest.approx(40.0)
    assert series.depth[-1] == pytest.approx(1.0)
    # Середина (t=1 с) — середина интерполяции (разрыв эпохи растянут).
    assert series.x_mm[1000] == pytest.approx(20.0)
    assert series.depth[1000] == pytest.approx(0.5)
    assert series.strength[0] == pytest.approx(0.5)
    assert series.strength[-1] == pytest.approx(1.0)
    # θ: от 0 до π/2 линейно (момент повернулся на 90°).
    assert series.theta[1000] == pytest.approx(np.pi / 4)


def test_stereo_base_table_is_inverse_to_band_frequency() -> None:
    """Стереобаза: 0.8 у нижней дельты → 0.1 у высокой гаммы, монотонно убывает."""
    base = settings.dipole_stereo_base
    assert set(base) == set(settings.freq_bands)
    assert base["delta"] == pytest.approx(0.8)
    assert base["high_gamma"] == pytest.approx(0.1)
    values = [base[band] for band in settings.freq_bands]
    assert all(left > right for left, right in itertools.pairwise(values))


def test_scene_payload_carries_frames_and_bases() -> None:
    """Sidecar-блок: кадры (t/x/y/z/theta/strength), стереобазы, границы глубины."""
    scene = dipole_scene.DipoleScene(
        job_id="job-9", epoch_length_ms=500.0, bands={
            "delta": dipole_scene.BandTrajectory(band="delta", frames=[
                dipole_scene.DipoleFrame(0, (1.0, 2.0, 3.0), (0.0, 1.0, 0.0), 10.0),
                dipole_scene.DipoleFrame(1, (2.0, 3.0, -4.0), (1.0, 0.0, 0.0), 30.0),
            ]),
        },
    )
    payload = dipole_scene.scene_payload(scene, settings)
    assert payload["source_job_id"] == "job-9"
    assert payload["epoch_length_ms"] == 500.0
    assert payload["bands"]["delta"]["stereo_base"] == pytest.approx(0.8)
    frames = payload["bands"]["delta"]["frames"]
    assert [frame["t"] for frame in frames] == pytest.approx([0.0, 0.5])
    assert frames[1]["strength"] == pytest.approx(1.0)
    assert frames[0]["theta"] == pytest.approx(np.pi / 2, abs=1e-3)  # момент (0,1,0)
    assert frames[1]["theta"] == pytest.approx(0.0)  # момент (1,0,0)
    assert payload["depth_z_mm"] == {
        "top": settings.dipole_depth_z_top_mm,
        "bottom": settings.dipole_depth_z_bottom_mm,
    }
    means = dipole_scene.mean_positions(payload)
    assert means["delta"] == pytest.approx((1.5, 2.5))


# --- пространственная обработка (формулы владельца) ------------------------------


def _series(theta: float, x_mm: float = 0.0, depth: float = 0.0,
            n: int = 960) -> dipole_scene.BandSeries:
    return dipole_scene.BandSeries(
        theta=np.full(n, theta),
        x_mm=np.full(n, x_mm),
        y_mm=np.zeros(n),
        depth=np.full(n, depth),
        strength=np.ones(n),
    )


def test_spatialize_phase_split_matches_owner_formula() -> None:
    """φ_L/R = ±θ/2: при φ=π/2 каналы в противофазе (θ=π → L = −R)."""
    n = 4
    amplitude = np.ones(n)
    unit = np.full(n, 1j)  # фаза сигнала φ = π/2
    out = dipole_spatial.spatialize(
        amplitude, unit, _series(np.pi, n=n), stereo_base=1.0, cfg=settings,
    )
    # y_L = cos(π/2 + π/2) = −1, y_R = cos(π/2 − π/2) = +1; x=0 → панорама
    # √2/2 в оба канала; depth=0 → «колодец» молчит.
    assert out[:, 0] == pytest.approx(np.full(n, -2**-0.5))
    assert out[:, 1] == pytest.approx(np.full(n, 2**-0.5))


def test_spatialize_stereo_base_scales_side() -> None:
    """M/S-ширина: S × w — узкая база (0.1) сводит каналы ближе к моно."""
    n = 4
    amplitude = np.ones(n)
    unit = np.full(n, 1j)
    wide = dipole_spatial.spatialize(
        amplitude, unit, _series(np.pi, n=n), stereo_base=0.8, cfg=settings,
    )
    narrow = dipole_spatial.spatialize(
        amplitude, unit, _series(np.pi, n=n), stereo_base=0.1, cfg=settings,
    )
    wide_gap = float(np.max(np.abs(wide[:, 0] - wide[:, 1])))
    narrow_gap = float(np.max(np.abs(narrow[:, 0] - narrow[:, 1])))
    # Разнос каналов ∝ стереобазе: 0.8 против 0.1 → в 8 раз шире.
    assert wide_gap == pytest.approx(8.0 * narrow_gap, rel=1e-9)


def test_spatialize_pans_by_x_position() -> None:
    """Панорама: x = +half_x MNI → всё в правый канал (левый молчит)."""
    n = 4
    out = dipole_spatial.spatialize(
        np.ones(n), np.ones(n), _series(0.0, x_mm=70.0, n=n),
        stereo_base=1.0, cfg=settings,
    )
    assert np.abs(out[:, 0]) == pytest.approx(np.zeros(n))
    assert float(np.max(np.abs(out[:, 1]))) > 0.0


def test_well_ir_is_noise_not_echo_train() -> None:
    """IR «колодца» — шум с затуханием: детерминирован, без периодических повторов.

    Чистое эхо-«колодец» с фиксированной задержкой дало бы автокорреляцию ≈1
    на лаге повтора — амплитудную модуляцию в запрещённых 3–60 Гц.
    """
    ir_a = dipole_spatial.well_ir(1.0, seed=7)
    ir_b = dipole_spatial.well_ir(1.0, seed=7)
    assert ir_a == pytest.approx(ir_b)  # детерминизм байтов
    assert float(np.max(np.abs(ir_a))) == pytest.approx(1.0)
    # Затухание: энергия последней четверти ≪ первой.
    quarter = ir_a.shape[0] // 4
    head = float(np.sum(ir_a[:quarter] ** 2))
    tail = float(np.sum(ir_a[-quarter:] ** 2))
    assert tail < head * 0.01
    # Нет периодических повторов: автокорреляция на лагах ≥ 10 мс мала.
    mono = ir_a[:, 0]
    corr = np.correlate(mono, mono, mode="full")[mono.shape[0] - 1:]
    corr = corr / corr[0]
    assert float(np.max(np.abs(corr[480:]))) < 0.2


def test_well_reverb_scales_wet_with_depth_and_stays_deterministic() -> None:
    """Глубина d: 0 → «колодец» молчит, 1 → полный wet; повтор — те же байты."""
    n = 4800
    dry = np.stack([np.sin(np.arange(n) * 0.05), np.cos(np.arange(n) * 0.05)], axis=1)
    silent = dipole_spatial.well_reverb(dry, np.zeros(n), settings)
    assert np.abs(silent) == pytest.approx(np.zeros((n, 2)))
    wet = dipole_spatial.well_reverb(dry, np.ones(n), settings)
    again = dipole_spatial.well_reverb(dry, np.ones(n), settings)
    assert wet == pytest.approx(again)  # детерминизм
    assert float(np.max(np.abs(wet))) > 0.0


def test_depth_envelope_is_slower_than_stimulation_band() -> None:
    """Огибающая глубины медленнее 3 Гц — запрет фотостимуляции 3–60 Гц.

    Худший случай: z диполя чередуется каждую эпоху (сетка 250 мс) —
    «треугольник» 2 Гц; его гармоники в 3–60 Гц обязаны быть малы против
    полезного сигнала огибающей.
    """
    n = 2000
    fs = 1000.0
    trajectory = dipole_scene.BandTrajectory(band="delta", frames=[
        dipole_scene.DipoleFrame(
            epoch, (0.0, 0.0, 70.0 if epoch % 2 == 0 else -70.0),
            (1.0, 0.0, 0.0), 10.0,
        )
        for epoch in range(9)
    ])
    series = dipole_scene.band_series(
        trajectory, [i * 0.25 for i in range(9)], n_samples=n, fs=fs, cfg=settings,
    )
    spectrum = np.abs(np.fft.rfft(series.depth - float(np.mean(series.depth))))
    freqs = np.fft.rfftfreq(n, d=1.0 / fs)
    useful = float(np.max(spectrum[(freqs > 0.1) & (freqs <= 2.0)]))
    forbidden = float(np.max(spectrum[(freqs >= 3.0) & (freqs <= 60.0)]))
    assert useful > 0.0
    assert forbidden < 0.25 * useful


def test_band_analytic_feeds_spatial_layer() -> None:
    """Ядро (a, u): |u|=1, длина N×96 — вход пространственного слоя «Монтажа»."""
    rng = np.random.default_rng(3)
    eeg = rng.standard_normal((3, 500)) * 1e-6
    amplitude, unit = band_analytic(eeg, np.full(3, 1.0 / 3.0), pitch_steps=7)
    assert amplitude.shape == (500 * 96,)
    assert unit.shape == (500 * 96,)
    assert np.abs(unit) == pytest.approx(np.ones(500 * 96), abs=1e-9)
    assert np.all(np.isfinite(amplitude))