"""Сигнал сетевого фона: что вырезает notch-цепочка (L1 + вырезанная компонента).

Блок отвечает на два разных вопроса препроцессинга (стратегия, Часть 1 §7):

* **`level_db` (метрика L1)** — есть ли сетевая наводка в самой записи:
  уровень линий 50/100/150/… Гц над локальным фоном PSD (медиана ±10 Гц без
  полосы самой линии), дБ. Число оправдывает включение/выключение notch.
* **`trace_uv`** — сама вырезанная компонента во времени: ``x − notch(x)``,
  где ``x`` — сигнал **до** полосового фильтра (после average-референса, как
  в конвейере `load_edf`). Полоса в ``x`` намеренно не входит: гармоники
  100/150/200 Гц почти всегда вне полосы расчёта (1–40 Гц) и «что вырезает
  notch из полосы» не показало бы ничего. Трасса — **один канал**, выбранный
  автоматически как канал с максимальным вырезанным RMS: сумма каналов после
  average-референса тождественно ноль, поэтому любое линейное усреднение
  дало бы пустую линию.

Фильтр линейный, поэтому разность ``x − notch(x)`` — ровно полосовая
составляющая у центров notch-частот (основная + гармоники, N13): на трассе
видно и «пилу» 50 Гц, и то, режет ли цепочка гармоники.

Края записи фильтруются с переходным процессом ядра (тот же приём, что
``BAD_edge``): трасса обрезается по ``EDGE_PAD_SEC`` от краёв файла, а на
коротких записях pad сжимается, чтобы окно не вырождалось.

Стоимость: один ``prepared_raw`` (RAM-кэш A4, ключ «без полосы/notch») +
``notch_filter`` на копии — как в реальном конвейере. ETag не нужен —
расчёт лёгкий и параметры в query (та же семантика, что ``/filter-response``).
"""
import math
from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray

from app.core.config import Settings
from app.services.filter_design import notch_frequencies
from app.services.prepared_signal import prepared_raw
from app.services.recordings import Recording

# Ширина окна «пики» при замере L1, Гц: линия сети не идеально узкая
LINE_PEAK_HALF_WIDTH_HZ = 0.75
# Пол окна фона, Гц: медиана PSD в ±10 Гц вокруг линии без самой линии (±2 Гц)
LINE_BACKGROUND_HALF_WIDTH_HZ = 10.0
LINE_BACKGROUND_EXCLUDE_HZ = 2.0
# Порог измеримости: пик ниже этой доли средней мощности на бин = числовой
# шум FFT от чужого пика (отношение двух нулей давало ложные «16 дБ»)
LINE_MIN_REL_POWER = 1e-6
# Переходный процесс ядра notch у краёв записи, с (как BAD_edge)
EDGE_PAD_SEC = 2.0


@dataclass(frozen=True)
class MainsComponent:
    """Результат: уровни сетевых линий и вырезанная компонента за окно.

    ``start_sec``/``duration_sec`` — **фактическое** окно трассы после обрезки
    переходных краёв (оно может быть уже запрошенного).
    """

    freqs_hz: list[float]
    level_db: list[float]
    trace_times_sec: list[float]
    trace_uv: list[float]
    removed_rms_uv: float
    channel: str
    start_sec: float
    duration_sec: float
    sfreq: float
    notch_hz: float
    notch_harmonics: int


def line_noise_levels_db(
    data: NDArray, sfreq: float, freqs: list[float],
) -> list[float]:
    """L1: уровень линий сети над локальным фоном PSD, дБ (среднее PSD по каналам).

    PSD — Welch (``nperseg`` ≤ 2048: хватает частотного разрешения и для 4-с
    теста). Для каждой линии: максимум в ±``LINE_PEAK_HALF_WIDTH_HZ`` минус
    медиана фона в ±10 Гц без полосы ±2 Гц самой линии.

    **Порог измеримости**: если пик в абсолютных единицах ниже
    ``LINE_MIN_REL_POWER`` × средней мощности на бин (числовой шум float64
    от чужого пика даёт отношение двух нулей и ложные «16 дБ») — уровень
    0.0: «линии нет» — честнее, чем мусорный дБ.
    """
    from scipy.signal import welch

    finite = np.nan_to_num(data)
    nperseg = int(min(2048, finite.shape[-1]))
    freqs_psd, psd = welch(finite, fs=sfreq, nperseg=nperseg, axis=-1)
    mean_psd = psd.mean(axis=0)
    floor = float(np.finfo(float).tiny)
    # Средняя мощность «на бин» — масштаб, относительно которого пик заметен
    power_scale = float(mean_psd.mean()) or floor

    levels: list[float] = []
    for target in freqs:
        if target > freqs_psd[-1]:
            continue  # выше Nyquist PSD (notch_frequencies уже отсекает)
        peak_mask = np.abs(freqs_psd - target) <= LINE_PEAK_HALF_WIDTH_HZ
        bg_mask = (
            (np.abs(freqs_psd - target) <= LINE_BACKGROUND_HALF_WIDTH_HZ)
            & (np.abs(freqs_psd - target) >= LINE_BACKGROUND_EXCLUDE_HZ)
        )
        peak = float(mean_psd[peak_mask].max()) if peak_mask.any() else 0.0
        if peak < LINE_MIN_REL_POWER * power_scale:
            levels.append(0.0)  # линия неотличима от числового шума PSD
            continue
        background = float(np.median(mean_psd[bg_mask])) if bg_mask.any() else floor
        levels.append(
            round(10.0 * math.log10(max(peak, floor) / max(background, floor)), 1),
        )
    return levels


def mains_component(
    recording: Recording,
    cfg: Settings,
    notch_hz: float,
    notch_harmonics: int,
    start_sec: float = 0.0,
    duration_sec: float = 5.0,
) -> MainsComponent:
    """Вырезанная notch-компонентная трасса за окно + уровни L1 по записи.

    ``x`` — подготовленный сигнал без полосы и без notch (average-референс —
    дефолт конвейера); ``mains = x − notch(x)`` считается на **всей** записи
    (ядро notch применяется к continuous raw, как в `load_edf`), трасса —
    один канал (самый наведённый по RMS) за окно
    ``[start_sec, start_sec + duration_sec]``.

    ``ValueError`` с человекочитаемым текстом — для 400 в роуте (запись
    короче окна, notch не задан и т.п.).
    """
    if notch_hz is None or notch_hz <= 0:
        raise ValueError("Частота notch не задана — вырезать нечего")
    raw = prepared_raw(
        recording, cfg, l_freq=None, h_freq=None, notch_hz=None,
        reference_mode="average",
    )
    sfreq = float(raw.info["sfreq"])
    n_times = int(raw.n_times)
    total_sec = n_times / sfreq
    freqs = notch_frequencies(notch_hz, notch_harmonics, sfreq)
    if not freqs:
        raise ValueError("notch-цепочка пуста (частота вне пределов записи)")
    if not 0.0 <= start_sec < total_sec:
        raise ValueError(
            f"start_sec={start_sec:.1f} вне записи (длительность {total_sec:.1f} с)",
        )
    if duration_sec <= 0:
        raise ValueError("duration_sec должен быть положительным")

    data = raw.get_data()
    level_db = line_noise_levels_db(data, sfreq, freqs)

    # Notch на копии всей записи — как в реальном конвейере (prepared_raw
    # отдаёт копию из кэша, поэтому мутировать её безопасно).
    raw.notch_filter(freqs, verbose=False)
    mains = data - raw.get_data()

    # Окно трассы, обрезанное по переходным краям ядра (BAD_edge-приём);
    # на коротких записях pad сжимается, чтобы окно не выродилось.
    pad = min(EDGE_PAD_SEC, total_sec / 8.0) * sfreq
    win0 = round(start_sec * sfreq)
    win1 = min(n_times, win0 + round(duration_sec * sfreq))
    lo = max(win0, math.ceil(pad))
    hi = min(win1, n_times - math.floor(pad))
    if hi <= lo:
        # Запись вся в переходном процессе: берём без обрезки — честнее
        # показать сырьё, чем пустой график.
        lo, hi = win0, win1
    window = mains[:, lo:hi]
    # Трасса — один канал: сумма каналов после average-референса = 0, а
    # «канал с максимальным RMS» показывает самую наведённую линию.
    rms_per_channel = np.sqrt(np.mean(np.square(window), axis=1))
    channel_index = int(np.argmax(rms_per_channel))
    trace = window[channel_index] * 1e6
    removed_rms_uv = round(float(np.sqrt(np.mean(np.square(trace)))), 3)
    return MainsComponent(
        freqs_hz=[float(value) for value in freqs],
        level_db=level_db,
        trace_times_sec=[round(float(value), 3) for value in np.arange(lo, hi) / sfreq],
        trace_uv=[round(float(value), 3) for value in trace],
        removed_rms_uv=removed_rms_uv,
        channel=str(raw.ch_names[channel_index]),
        start_sec=round(lo / sfreq, 3),
        duration_sec=round((hi - lo) / sfreq, 3),
        sfreq=sfreq,
        notch_hz=notch_hz,
        notch_harmonics=notch_harmonics,
    )
