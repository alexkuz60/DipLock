"""Пространственная обработка «Монтажа»: фазы момента, стереобаза, «колодец».

Срез 19.11.2026 (формулы владельца, `docs/rules/neuromusic.md`
§«Дипольный рендер»). Один полосовой вход ``(a, u)`` (амплитуда и единичная
фаза после питча, ``core.band_analytic``) превращается в стерео-трек:

1. **Фазы L/R от момента диполя**: ``y_L = a·Re(u·e^{+iθ/2})``,
   ``y_R = a·Re(u·e^{−iθ/2})`` — θ(t) непрерывный азимут момента
   (``dipole_scene.band_series``); развёртка θ гарантирует плавное вращение
   фазы без скачков на ±π.
2. **Стереобаза — отдельная M/S-ширина** (решение 19.11.2026): ``S × w``,
   w полосы — 0.8 у нижней дельты до 0.1 у высокой гаммы
   (``cfg.dipole_stereo_base``): широкая база низких полос разносит фазы
   сильнее, узкая база высоких сводит к моно.
3. **Панорама позиции** — равномощная амплитудная по x диполя
   (|x| = ``cfg.dipole_mni_half_x_mm`` мм MNI → край стереополя).
4. **«Колодец» реверберации** от глубины z: уход диполя вниз по коронарному
   срезу (``series.depth`` 0..1) — свёртка с шумовой IR, RT60 и доля wet
   растут с глубиной («в глубину мозга — как в колодец»). IR —
   экспоненциально затухающий **шум** (без периодических повторов:
   инвариант «не навреди», запрет фотостимуляции 3–60 Гц), детерминированный
   seed → воспроизводимые байты WAV.

Сторонние аудиобиблиотеки (librosa/rubberband/pydub) не используются —
только numpy/scipy (правило ``docs/rules/neuromusic.md`` «Ловушки»).
"""
import numpy as np
from scipy.signal import oaconvolve

from app.core.config import Settings
from app.services.audio_render.core import FS_AUDIO
from app.services.audio_render.dipole_scene import BandSeries


def well_ir(rt60: float, seed: int, fs: int = FS_AUDIO) -> np.ndarray:
    """Шумовая IR «колодца»: экспоненциально затухающий шум (n, 2), пик 1.0.

    ``rt60`` — время затухания до −60 дБ (амплитуда ``10^(-3t/rt60)``).
    Случайность вместо периодичности (инвариант «не навреди»): чистые
    эхо-повторы с фиксированной задержкой дали бы амплитудную модуляцию
    ~8–12 Гц — запрещённый диапазон фотостимуляции. Seed фиксирован —
    байты детерминированы.
    """
    n_ir = max(2, round(float(rt60) * fs))
    rng = np.random.default_rng(int(seed))
    noise = rng.standard_normal((n_ir, 2))
    envelope = (10.0 ** (-3.0 * np.arange(n_ir, dtype=np.float64) / (float(rt60) * fs)))
    ir = noise * envelope[:, None]
    peak = float(np.max(np.abs(ir))) if ir.size else 0.0
    return ir / peak if peak > 0.0 else ir


def well_reverb(
    stereo: np.ndarray, depth: np.ndarray, cfg: Settings,
) -> np.ndarray:
    """«Колодезный» wet-сигнал (N, 2): кроссфейд двух IR по глубине d(t).

    Мелкий край (``rt60[0]``) ↔ глубокий (``rt60[1]``) — линейный кроссфейд
    по мгновенной глубине (time-varying без перестройки фильтров), общий
    уровень wet ∝ d · ``cfg.dipole_well_wet_max``. Хвост свёртки обрезается
    по длине источника (как у ``bake``: Convolver в браузере тоже не звучит
    после остановки буфера).
    """
    n = stereo.shape[0]
    rt60_shallow, rt60_deep = (float(value) for value in cfg.dipole_well_rt60_s)
    ir_shallow = well_ir(rt60_shallow, cfg.dipole_well_seed, FS_AUDIO)
    ir_deep = well_ir(rt60_deep, cfg.dipole_well_seed + 1, FS_AUDIO)

    def _conv(ir: np.ndarray) -> np.ndarray:
        return np.stack(
            [
                oaconvolve(stereo[:, channel], ir[:, channel])[:n]
                for channel in range(stereo.shape[1])
            ],
            axis=1,
        )

    d = np.clip(np.asarray(depth, dtype=np.float64), 0.0, 1.0)[:, None]
    wet = (1.0 - d) * _conv(ir_shallow) + d * _conv(ir_deep)
    return wet * (d * float(cfg.dipole_well_wet_max))


def spatialize(
    amplitude: np.ndarray,
    unit: np.ndarray,
    series: BandSeries,
    stereo_base: float,
    cfg: Settings,
) -> np.ndarray:
    """Моно-вход ``(a, u)`` → стерео-трек (N, 2) по дипольной сцене полосы.

    Порядок — формулы владельца 19.11.2026: фазы ``±θ/2`` → M/S-ширина
    ``S × w`` → равномощная панорама по x → «колодец» от глубины.
    """
    half = np.asarray(series.theta, dtype=np.float64) * 0.5
    left = amplitude * np.real(unit * np.exp(1j * half))
    right = amplitude * np.real(unit * np.exp(-1j * half))
    mid = (left + right) * 0.5
    side = (left - right) * 0.5 * float(stereo_base)
    left = mid + side
    right = mid - side
    # Равномощная панорама по позиции x: p = ±1 → полный L/R, p = 0 → центр.
    p = np.clip(
        np.asarray(series.x_mm, dtype=np.float64) / float(cfg.dipole_mni_half_x_mm),
        -1.0, 1.0,
    )
    angle = (p + 1.0) * (np.pi / 4.0)
    stereo = np.stack([left * np.cos(angle), right * np.sin(angle)], axis=1)
    return stereo + well_reverb(stereo, series.depth, cfg)