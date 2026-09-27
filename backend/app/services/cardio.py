"""Кардио-сигнал из ЭЭГ: единый детектор QRS, прокси, зоны ``ecg`` и ряд ЧСС.

Отдельного ECG-канала в записях нет — сердечная активность проявляется как
наводка на височных отведениях (T7/T8, старые имена T3/T4). Один детектор на
три потребителя (DRY, этап «кардио»):

* зоны ``kind="ecg"`` стадии ``artifacts`` (слои вьюера, QC) — `ecg_zones`;
* прокси для корреляции с компонентами ICA (`artifact_cleaner._ica_ecg_inds`)
  — `ecg_proxy`;
* ряд ЧСС для трека пульса вьюера (слот ``heart_rate`` результата стадии) —
  `heart_rate_series`.

Метод (NumPy/SciPy, без новых зависимостей) — v2 от 27.09.2026, проверен впрыском
QRS в реальный фон (чувствительность ~5 мкВ) и прогоном по 33 реальным записям
(ритм найден в 22, ЧСС 73–87 уд/мин; контроли «белый шум/mu-ритм/моргания» —
чисто):

1. огибающие височных |bandpass 5–20 Гц|, **среднее энвелопов** (без пол —
   полярность QRS между отведениями инвертирована, «среднее сигнала» гасит
   сердце);
2. периодограмма огибающей в полосе 0.67–2.5 Гц (40–150 уд/мин): пик/медиана ≥
   `QRS_SPECTRAL_SNR_MIN` подтверждает ритм и даёт период ``T0``;
3. по каждому каналу: локальные максимумы → отбор в зону **общего фазового
   центра** (суммарная гистограмма всех височных, циркулярное среднее — сердце
   синфазно, шум канала индивидуален) ±0.2 цикла → **gap-кластеризация**
   (0.7·T0, представитель = максимум огибающей — волна зевка/моргания не
   считается ударами);
4. **уточнение периода** по собранным ударам (unwrapped RR, `k = round(ii/T0)`)
   снимает дрейф спектрального разрешения 1/duration, центр и фаза
   пересобираются; затем валидация: **заполненность** окна ≥ `QRS_OCC_MIN`,
   доля интервалов близких к T0 ≥ `QRS_SHARE_MIN`, MAD/медиана ≤
   `QRS_MAD_CV_MAX`;
5. ритм подтверждён, если валидацию прошли `QRS_MIN_RHYTHM_CHANNELS` (2)
   височных; запись без двух височных каналов — честно «не извлечено».

Честные границы: это **не** медицинская ЭКГ. sfreq ≤ 50 Гц, отсутствие
височных каналов или слабый сигнал (SNR ниже порога) → ритм не извлечён.
**Ограничение**: периодические движения субъекта с периодом ~0.5–1.5 с в обоих
височных (жевание, ритмичный зевок) по всем признакам неотличимы от ритма —
без ЭКГ-канала это фундаментально; вызывающий код обязан показывать результат
как «не извлечено», а не подставлять выдуманные числа, при сомнении — глазами
на трек.
"""
from dataclasses import dataclass
from typing import Any

import numpy as np
from numpy.typing import NDArray

# Височные отведения — носитель ЭКГ-наводки (T3/T4 — старые имена T7/T8)
TEMPORAL_CHANNELS: tuple[str, ...] = ("T7", "T8", "T3", "T4")

# Полоса комплексов QRS и пороги ритма (v2; калибровка — впрыск QRS в реальный
# фон: 5 мкВ → SNR 5.8 при пороге 3.0; контроли «белый шум/mu» — SNR ≤ 2.4)
QRS_BAND_HZ: tuple[float, float] = (5.0, 20.0)
QRS_RHYTHM_BAND_HZ: tuple[float, float] = (0.67, 2.5)  # периодограмма, Гц (40–150 уд/мин)
QRS_SPECTRAL_SNR_MIN = 3.0  # пик/медиана полосы спектра огибающей
QRS_MIN_PEAKS = 4
QRS_MIN_IBI_SEC = 0.3
QRS_MAX_IBI_SEC = 1.5
QRS_REFRACTORY_SEC = 0.25  # объединение пиков каналов: рефракторный интервал
QRS_ZONE_HALF_SEC = 0.15  # полуширина зоны `ecg` вокруг пика
# Шаги валидации ритма (v2, см. докстринг модуля)
QRS_PHASE_TOLERANCE = 0.2  # фазовый отбор: ±0.2 цикла от доминантной зоны (12 бинов)
QRS_CLUSTER_GAP_T = 0.7  # gap-кластеризация: разрыв < 0.7·T0 = один удар
QRS_OCC_MIN = 0.6  # заполненность: найдено ударов / ожидаемых
QRS_RR_TOLERANCE_T = 0.35  # интервал «близок к T0»: |rr − T0| ≤ 0.35·T0
QRS_SHARE_MIN = 0.6  # доля интервалов близких к T0 (после unwrap k·T0)
QRS_MAD_CV_MAX = 0.35  # MAD/медиана усреднённых RR
QRS_MIN_RHYTHM_CHANNELS = 2  # подтверждение на обоих височных (одиночный шум — не ритм)

# Ряд ЧСС: окно/шаг сглаживания RR → уд/мин (сотни-тысячи точек на запись —
# слот результата стадии, отдельный эндпоинт/кэш не нужен)
HR_DEFAULT_WINDOW_SEC = 5.0
HR_DEFAULT_STEP_SEC = 1.0
HR_MIN_RR_PER_WINDOW = 3  # окно без 3 RR — честный пропуск (None), не число


@dataclass
class QrsDetection:
    """Найденные QRS-пики височных отведений.

    ``peaks_sec`` содержит **только** каналы с подтверждённым ритмом (по ним
    строятся зоны), ``merged_peaks_sec`` — объединение этих пиков по времени
    (рефракторный интервал) для ряда ЧСС.
    """

    peaks_sec: dict[str, NDArray]
    rhythm_channels: list[str]
    merged_peaks_sec: NDArray
    #: Период ритма из спектра огибающей, с (None — ритм не подтверждён)
    period_sec: float | None = None
    #: Значимость спектральной линии (пик/медиана полосы) — для диагностики UI
    spectral_snr: float | None = None

    @property
    def is_rhythm(self) -> bool:
        """Есть хотя бы один канал с подтверждённым сердечным ритмом."""
        return bool(self.rhythm_channels)


@dataclass
class HeartRateSeries:
    """Ряд ЧСС: окно RR → медиана → уд/мин; ``None`` в ``bpm`` — разрыв."""

    times_sec: list[float]
    bpm: list[float | None]
    median_bpm: float | None
    n_beats: int
    coverage_percent: float
    channels: list[str]


def _nyquist_ok(sfreq: float) -> bool:
    """Верх полосы 20 Гц должен помещаться под Найквистом (sfreq > 50 Гц)."""
    return sfreq / 2.0 > 25.0


def ecg_proxy(data: NDArray, names: list[str], sfreq: float) -> NDArray | None:
    """Непрерывный прокси ЭКГ: среднее по височным, |bandpass 5–20 Гц|.

    Тот же сигнал ложится в корреляцию с источниками ICA (`_ica_ecg_inds`):
    прокси — «одноканальная ЭКГ», построенная из того, что есть в записи.
    """
    from scipy.signal import butter, filtfilt

    idx = [i for i, ch in enumerate(names) if ch.upper() in TEMPORAL_CHANNELS]
    if not idx or not _nyquist_ok(sfreq):
        return None
    x = np.nan_to_num(data[idx]).mean(axis=0)
    nyq = sfreq / 2.0
    b, a = butter(2, [QRS_BAND_HZ[0] / nyq, QRS_BAND_HZ[1] / nyq], btype="band")
    return np.abs(filtfilt(b, a, x))


def detect_qrs(data: NDArray, names: list[str], sfreq: float) -> QrsDetection:
    """QRS-ритм на височных: спектр огибающей → фаза → кластеры → заполненность.

    Рецепт (шаги 1–5) — в докстринге модуля. Возвращаются **только** каналы,
    подтвердившие ритм; без него (нет височных, sfreq ≤ 50 Гц, спектральная
    значимость ниже `QRS_SPECTRAL_SNR_MIN`, отбор не прошёл) — пустой результат,
    ``spectral_snr`` хранит измеренную значимость для диагностики.
    """
    from scipy.signal import butter, filtfilt

    empty = QrsDetection(peaks_sec={}, rhythm_channels=[], merged_peaks_sec=np.empty(0))
    if not _nyquist_ok(sfreq) or data.size == 0:
        return empty
    idx = [i for i, ch in enumerate(names) if ch.upper() in TEMPORAL_CHANNELS]
    if not idx:
        return empty
    duration_sec = float(data.shape[-1]) / sfreq
    if duration_sec <= 0:
        return empty

    nyq = sfreq / 2.0
    b, a = butter(2, [QRS_BAND_HZ[0] / nyq, QRS_BAND_HZ[1] / nyq], btype="band")
    bp = filtfilt(b, a, np.nan_to_num(data[idx]), axis=1)

    # Шаг 2: периодограмма среднего энвелопов — подтверждение ритма и период T0.
    # «Среднее энвелопов», а не «энвелоп среднего»: полярность QRS между
    # отведениями инвертирована, среднее сигнала гасит сердце (замер 27.09.2026).
    env_p = np.abs(bp).mean(axis=0)
    win = max(1, int(sfreq))
    x = env_p - np.convolve(env_p, np.ones(win) / win, mode="same")
    spec = np.abs(np.fft.rfft(x * np.hanning(x.size)))
    freqs = np.fft.rfftfreq(x.size, 1.0 / sfreq)
    band = (freqs >= QRS_RHYTHM_BAND_HZ[0]) & (freqs <= QRS_RHYTHM_BAND_HZ[1])
    if not band.any():
        return empty
    bs, bf = spec[band], freqs[band]
    peak_i = int(np.argmax(bs))
    snr = float(bs[peak_i] / (float(np.median(bs)) or 1.0))
    if snr < QRS_SPECTRAL_SNR_MIN:
        return QrsDetection(
            peaks_sec={}, rhythm_channels=[], merged_peaks_sec=np.empty(0),
            spectral_snr=round(snr, 1),
        )
    f0 = float(bf[peak_i])
    if f0 <= 0:
        return empty
    t0 = 1.0 / f0

    # Шаг 3: черновой сбор без валидации — общий фазовый центр (сердце
    # синфазно на всех височных, шум каждого канала свой — по-канальные центры
    # уводили канал в чужую фазу, замер 27.09.2026) и кластеры по грубому
    # периоду (разрешение 1/duration даёт сдвиг фазы — снимет refine).
    draft: dict[str, NDArray] = {}
    center = _phase_center(
        [np.abs(bp[row]) for row in range(len(idx))], t0, sfreq,
    )
    if center is None:
        return QrsDetection(
            peaks_sec={}, rhythm_channels=[], merged_peaks_sec=np.empty(0),
            spectral_snr=round(snr, 1),
        )
    for row, chan_idx in enumerate(idx):
        keep = _phase_clusters(np.abs(bp[row]), t0, center, sfreq)
        if keep.size:
            draft[names[chan_idx]] = keep

    # Уточнение периода по собранным ударам: unwrapped RR (k = round(ii/T0)),
    # медиана близких к T0 — снимает спектровый дрейф; центр и фаза — заново.
    merged_sec = _merge_peaks([arr / sfreq for arr in draft.values()])
    if merged_sec.size >= 2:
        ii = np.diff(merged_sec)
        kk = np.maximum(1, np.round(ii / t0))
        rr = ii / kk
        near = np.abs(rr - t0) <= QRS_RR_TOLERANCE_T * t0
        if int(near.sum()) >= QRS_MIN_PEAKS - 1:
            refined = float(np.median(rr[near]))
            if refined > 0 and abs(refined - t0) > 1e-9:
                t0 = refined
                draft = {}
                center = _phase_center(
                    [np.abs(bp[row]) for row in range(len(idx))], t0, sfreq,
                )
                if center is None:
                    return QrsDetection(
                        peaks_sec={}, rhythm_channels=[], merged_peaks_sec=np.empty(0),
                        spectral_snr=round(snr, 1),
                    )
                for row, chan_idx in enumerate(idx):
                    keep = _phase_clusters(np.abs(bp[row]), t0, center, sfreq)
                    if keep.size:
                        draft[names[chan_idx]] = keep

    # Шаг 4: валидация каждого канала при уточнённом периоде — заполненность
    # окна, интервалы после unwrap пропущенных ударов, MAD/медиана.
    peaks_sec: dict[str, NDArray] = {}
    rhythm: list[str] = []
    for ch, keep in draft.items():
        if not _validate_rhythm(keep, t0, duration_sec, sfreq):
            continue
        peaks_sec[ch] = keep / sfreq
        rhythm.append(ch)

    # Шаг 5: подтверждение минимум на двух височных (запись без двух височных
    # честно «не извлечено» — одиночный шумовой канал не ритм)
    min_ch = QRS_MIN_RHYTHM_CHANNELS
    if len(rhythm) < min_ch:
        return QrsDetection(
            peaks_sec={}, rhythm_channels=[], merged_peaks_sec=np.empty(0),
            spectral_snr=round(snr, 1),
        )
    return QrsDetection(
        peaks_sec=peaks_sec,
        rhythm_channels=rhythm,
        merged_peaks_sec=_merge_peaks(list(peaks_sec.values())),
        period_sec=round(t0, 3),
        spectral_snr=round(snr, 1),
    )


def _phase_center(envs: list[NDArray], t0: float, sfreq: float) -> float | None:
    """Общий фазовый центр (в долях цикла) по суммарной гистограмме височных.

    Сердце синфазно на всех отведениях, шум каждого канала свой: суммарная
    гистограмма усиливает общую линию и гасит индивидуальный мусор. Центр —
    середина доминантного окна 5 бинов из 12. ``None`` — пиков слишком мало.
    """
    from scipy.signal import find_peaks

    all_phases: list[NDArray] = []
    for env in envs:
        peaks, _ = find_peaks(env, distance=max(1, int(0.3 * sfreq)))
        if peaks.size:
            all_phases.append((peaks / sfreq) % t0 / t0)
    if not all_phases:
        return None
    phases = np.concatenate(all_phases)
    if phases.size < QRS_MIN_PEAKS:
        return None
    hist, edges = np.histogram(phases, bins=12, range=(0.0, 1.0))
    best, best_count = 0, -1
    for s in range(12):
        count = int(sum(hist[(s + j) % 12] for j in range(5)))
        if count > best_count:
            best, best_count = s, count
    if best_count <= 0:
        return None
    # Центр — циркулярное среднее фаз внутри доминантного окна, а не геометрический
    # центр окна: пики сконцентрированы у края бина (фаза «на грани»), и зона
    # ±tol от центра окна их не покрывала (замер 27.09.2026: 0 keep из 25).
    lo = float(edges[best])
    in_window = np.array([((p - lo) % 1.0) < (5 / 12) for p in phases])
    window_phases = phases[in_window]
    if window_phases.size == 0:
        return float((lo + (5 / 12) / 2) % 1.0)
    angle = np.exp(2j * np.pi * window_phases).mean()
    return float((np.angle(angle) / (2 * np.pi)) % 1.0)


def _phase_clusters(env: NDArray, t0: float, center: float, sfreq: float) -> NDArray:
    """Черновой сбор ударов одного канала: зона ``center`` ±tol + кластеры.

    Локальные максимумы огибающей (без порога высоты — ритм уже подтверждён
    спектром) → фазовая зона ±`QRS_PHASE_TOLERANCE` вокруг общего центра
    (`_phase_center`) → gap-кластеризация `QRS_CLUSTER_GAP_T`·T0: пики
    одной волны (моргание/зевок) считаются одним ударом, представитель —
    максимум огибающей. Возвращает времена **в отсчётах**; валидация —
    `_validate_rhythm`.
    """
    from scipy.signal import find_peaks

    peaks, _ = find_peaks(env, distance=max(1, int(0.3 * sfreq)))
    if peaks.size < QRS_MIN_PEAKS:
        return np.empty(0)
    tol = QRS_PHASE_TOLERANCE
    phases = (peaks / sfreq) % t0 / t0
    dist = np.abs(((phases - center + 0.5) % 1.0) - 0.5)
    keep = peaks[dist <= tol]
    if keep.size < QRS_MIN_PEAKS:
        return np.empty(0)
    gap = max(1, int(QRS_CLUSTER_GAP_T * t0 * sfreq))
    clusters: list[list[float]] = [[float(keep[0])]]
    for p in keep[1:]:
        if float(p) - clusters[-1][-1] < gap:
            clusters[-1].append(float(p))
        else:
            clusters.append([float(p)])
    return np.asarray([max(c, key=lambda p: env[int(p)]) for c in clusters])


def _validate_rhythm(keep: NDArray, t0: float, duration_sec: float, sfreq: float) -> bool:
    """Финальная проверка канала: заполненность, интервалы (unwrap), MAD.

    ``keep`` — времена в отсчётах от `_phase_clusters`. Пропущенные удары
    учитываются unwrap'ом ``k = round(ii/T0)``: разрыв 2·T0 — это один
    пропущенный удар, а не два интервала по T0 (для заполненности это уже
    учтено — она меряет найденные кластеры, а не интервалы).
    """
    if keep.size < QRS_MIN_PEAKS:
        return False
    occ = keep.size / max(1.0, duration_sec / t0)
    if occ < QRS_OCC_MIN:
        return False
    ii = np.diff(keep) / sfreq
    kk = np.maximum(1, np.round(ii / t0)).astype(int)
    rr = ii / kk
    near = np.abs(rr - t0) <= QRS_RR_TOLERANCE_T * t0
    share = float(near.mean()) if rr.size else 0.0
    if share < QRS_SHARE_MIN:
        return False
    rr2 = rr[near]
    med_rr = float(np.median(rr2))
    mad_rr = float(np.median(np.abs(rr2 - med_rr))) * 1.4826
    return med_rr > 0 and mad_rr / med_rr <= QRS_MAD_CV_MAX


def _merge_peaks(channel_peaks: list[NDArray]) -> NDArray:
    """Объединение пиков ритм-каналов: сортировка + рефракторный интервал.

    Пики двух височных отведений смещены на доли миллисекунд — без склейки
    сердце «удвоилось» бы, а RR-ряд оказался чередованием двух каналов.
    """
    if not channel_peaks:
        return np.empty(0)
    merged = np.sort(np.concatenate(channel_peaks))
    keep = [float(merged[0])]
    for peak in merged[1:]:
        if float(peak) - keep[-1] >= QRS_REFRACTORY_SEC:
            keep.append(float(peak))
    return np.asarray(keep, dtype=float)


def ecg_zones(
    detection: QrsDetection, sfreq: float, duration_sec: float,
) -> list[dict[str, Any]]:
    """Зоны ``kind="ecg"``: ±0.15 с вокруг каждого пика ритм-канала.

    Геометрия (полусекундная сетка отсчётов, округление до мс) — контракт
    слоёв вьюера, не меняется: зона = событие, а не окно детекции.
    """
    half = int(QRS_ZONE_HALF_SEC * sfreq) / sfreq if sfreq > 0 else QRS_ZONE_HALF_SEC
    zones: list[dict[str, Any]] = []
    for ch, peaks in detection.peaks_sec.items():
        for peak in peaks:
            onset = max(0.0, float(peak) - half)
            end = min(duration_sec, float(peak) + half)
            if end - onset <= 0:
                continue
            zones.append({
                "kind": "ecg",
                "onset_sec": round(onset, 3),
                "duration_sec": round(end - onset, 3),
                "channels": [ch],
            })
    return zones


def heart_rate_series(
    detection: QrsDetection,
    duration_sec: float,
    window_sec: float = HR_DEFAULT_WINDOW_SEC,
    step_sec: float = HR_DEFAULT_STEP_SEC,
) -> HeartRateSeries | None:
    """Ряд ЧСС по объединённым RR: окно → медиана RR → уд/мин.

    RR вне [0.3, 1.5] с отбрасываются (шум детекции); в окне должно быть не
    меньше ``HR_MIN_RR_PER_WINDOW`` интервалов — иначе точка ``None`` (разрыв
    линии на треке), а не выдуманное число. ``None`` возвращается вообще без
    данных (ритма нет, запись пустая) — трек в этом случае не показывается.
    """
    peaks = detection.merged_peaks_sec
    if peaks.size < 2 or duration_sec <= 0 or step_sec <= 0 or window_sec <= 0:
        return None
    rr = np.diff(peaks)
    valid = (rr >= QRS_MIN_IBI_SEC) & (rr <= QRS_MAX_IBI_SEC)
    rr = rr[valid]
    t_rr = peaks[1:][valid]
    if rr.size == 0:
        return None

    times = np.arange(0.0, duration_sec, step_sec)
    left = np.searchsorted(t_rr, times, side="left")
    right = np.searchsorted(t_rr, times + window_sec, side="left")
    bpm: list[float | None] = [None] * int(times.size)
    for i in range(times.size):
        if right[i] - left[i] >= HR_MIN_RR_PER_WINDOW:
            bpm[i] = round(60.0 / float(np.median(rr[left[i]:right[i]])), 1)

    covered = sum(1 for value in bpm if value is not None)
    return HeartRateSeries(
        times_sec=[round(float(t), 3) for t in times],
        bpm=bpm,
        median_bpm=round(60.0 / float(np.median(rr)), 1),
        n_beats=int(peaks.size),
        coverage_percent=round(100.0 * covered / max(1, int(times.size)), 1),
        channels=sorted(detection.peaks_sec),
    )

