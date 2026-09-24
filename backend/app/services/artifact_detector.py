"""Детекторы артефактов ЭЭГ: 11 видов зон, правило BAD_ и QC-сводки.

Каталог видов (``kind`` зоны, он же ключ ``artifact_types`` в API):

* **reject-виды** (``EPOCH_REJECT_KINDS``) — аннотации с префиксом ``BAD_`` роняют
  эпохи при нарезке: ``zscore_outlier``, ``peak_to_peak``, ``flat_line``,
  ``clipping``, ``break``, ``electrode_pop``;
* **информационные виды** — только зоны слоёв вьюера и QC, эпохи не трогают:
  ``muscle_emg``, ``line_noise``, ``ocular``, ``ecg``, ``ica_eog``.

Правило BAD_ (N6): ``mne.Epochs`` отбраковывает эпохи, пересекающиеся с
аннотациями, только если описание начинается с ``BAD``
(``reject_by_annotation=True`` по умолчанию). Информационные виды в аннотации
raw не попадают **вовсе** — эпоху они убить не могут (инвариант держит тест
``test_bad_rule_annotations_only_reject_kinds``). Имена зон (``kind``) для слоёв
вьюера префикса не имеют — это отдельный контракт.

Счётчики ``stats["by_type"]`` — число зон каждого вида; исключение —
``ica_eog``: там число найденных EOG-компонент (исторический смысл счётчика),
а **зон не создаёт вовсе** — компоненты не привязаны ко времени, полоса «на всю
запись» перекрывала вьюер и читалась как блокировка нарезки (фидбэк 24.09.2026).
Пороги берутся из ``settings``: стадия передаёт копию конфига со своими
значениями (``preprocess._detect``), детектор состояние не держит (DRY).

Новые детекторы (этап «поиск + QC») — MNE/NumPy/SciPy only, без новых
зависимостей: мускулатура — ``mne.preprocessing.annotate_muscle_zscore``,
сетевой шум — свой Welch-PSD по гармоникам 50/60 Гц, окулярный — прокси
Fp1/Fp2, ЭКГ — QRS-пики T7/T8, клиппинг/разрыв/pop — оконные критерии,
ICA-EOG — ``find_bads_eog`` по EOG-каналам либо прокси Fp1/Fp2 (N8).
"""
import logging
from typing import Any

import mne
import numpy as np
from numpy.typing import NDArray
from scipy import ndimage

from app.core.config import Settings
from app.services.artifact_cleaner import (
    FRONTAL_PROXY,
    find_eog_component_inds,
    fit_ica,
)

logger = logging.getLogger(__name__)

# Каталог видов — синхронно с `ArtifactKind` в `schemas/analysis.py` и
# `ARTIFACT_KINDS` фронтенда (`shared/lib/artifacts.ts`).
ARTIFACT_KINDS: tuple[str, ...] = (
    "zscore_outlier",
    "peak_to_peak",
    "flat_line",
    "clipping",
    "break",
    "electrode_pop",
    "muscle_emg",
    "line_noise",
    "ocular",
    "ecg",
    "ica_eog",
)

# Правило BAD_: только эти виды роняют эпохи (см. докстринг модуля).
EPOCH_REJECT_KINDS: frozenset[str] = frozenset({
    "zscore_outlier", "peak_to_peak", "flat_line", "clipping", "break", "electrode_pop",
})

# Виды, считающиеся «плохим временем» в QC: без ica_eog (весь монтаж на всю
# запись) и без line_noise (спектральная метрика, её меряет `line_noise_level`).
QC_TIME_KINDS: tuple[str, ...] = tuple(
    kind for kind in ARTIFACT_KINDS if kind not in ("ica_eog", "line_noise")
)

BAD_PREFIX = "BAD_"

# Описания аннотаций reject-видов (префикс BAD_ — контракт отбраковки N6)
ANNOTATION_DESC: dict[str, str] = {
    "zscore_outlier": f"{BAD_PREFIX}zscore_outlier",
    "peak_to_peak": f"{BAD_PREFIX}peak_to_peak",
    "flat_line": f"{BAD_PREFIX}flat_line",
    "clipping": f"{BAD_PREFIX}clipping",
    "break": f"{BAD_PREFIX}break",
    "electrode_pop": f"{BAD_PREFIX}electrode_pop",
}

# Прокси-каналы для окулярного и ЭКГ-детекторов (10-20; T3/T4 — старые имена)
_FRONTAL = ("FP1", "FP2", "FPZ")
_TEMPORAL = ("T7", "T8", "T3", "T4")


def _robust_stats(x: NDArray) -> tuple[float, float]:
    """Медиана и устойчивый масштаб (1.4826·MAD, фолбэк — std) по M11.

    Обычное среднее/std съедаются самими артефактами (выброс тянет std вверх и
    прячется за собственным порогом) — детектор считает «норму» по медиане.
    """
    x = np.asarray(x, dtype=float)
    x = x[np.isfinite(x)]
    if x.size == 0:
        return 0.0, 0.0
    med = float(np.median(x))
    scale = float(np.median(np.abs(x - med))) * 1.4826
    if scale <= 0.0:
        scale = float(np.std(x))
    return med, scale


def _runs_to_zones(
    flag: NDArray, kind: str, min_samples: int, sfreq: float,
) -> list[dict[str, Any]]:
    """Слияние истинных отсчётов в зоны длительностью от ``min_samples``."""
    zones: list[dict[str, Any]] = []
    lab, n_found = ndimage.label(flag)
    for r in range(1, n_found + 1):
        idx = np.where(lab == r)[0]
        if len(idx) >= min_samples:
            zones.append({
                "kind": kind,
                "onset_sec": round(float(idx[0]) / sfreq, 3),
                "duration_sec": round(float(len(idx)) / sfreq, 3),
            })
    return zones


def _detect_flat_or_clipping(
    data: NDArray, names: list[str], sfreq: float, settings: Settings,
) -> list[dict[str, Any]]:
    """«Почти константа» в окне: клиппинг (у предела АЦП) либо плоская линия.

    Критерий — размах (peak-to-peak) в окне ``flat_line_window_ms`` ниже
    ``flat_line_threshold_uv`` (N7/F20). Нулевой размах у **края** диапазона
    канала (доля отсчётов у rails ≥ ``clipping_share``) — это клиппинг
    (насыщение/перегрузка АЦП, PDF «эпизоды клиппинга»); константа в середине
    диапазона — плоская линия (мёртвый электрод). Абсолютная амплитуда (|x| <
    порога) ловила обычный шум — замер 19.09.2026: 4 ложные зоны на 30 с.
    """
    flat_win = max(1, int(settings.flat_line_window_ms / 1000.0 * sfreq))
    flat_min = max(1, int(settings.flat_line_min_duration_ms / 1000.0 * sfreq))
    flat_thr = settings.flat_line_threshold_uv * 1e-6
    clip_share = float(settings.clipping_share)
    zones: list[dict[str, Any]] = []
    for i, ch in enumerate(names):
        ch_data = data[i]
        n_win = ch_data.shape[0] // flat_win
        if n_win == 0:
            continue
        windows = ch_data[: n_win * flat_win].reshape(n_win, flat_win)
        flat_mask = np.nanmax(windows, axis=1) - np.nanmin(windows, axis=1) < flat_thr
        hi, lo = float(np.nanmax(ch_data)), float(np.nanmin(ch_data))
        rng = hi - lo
        if rng > 0 and np.isfinite(rng):
            eps = max(1e-15, 0.01 * rng)
            at_rail = (ch_data >= hi - eps) | (ch_data <= lo + eps)
            rail_share = at_rail[: n_win * flat_win].reshape(n_win, flat_win).mean(axis=1)
        else:
            rail_share = np.zeros(n_win)
        clip_mask = flat_mask & (rail_share >= clip_share)
        for mask, kind in ((clip_mask, "clipping"), (flat_mask & ~clip_mask, "flat_line")):
            for zone in _runs_to_zones(np.repeat(mask, flat_win), kind, flat_min, sfreq):
                zone["channels"] = [ch]
                zones.append(zone)
    return zones


def _detect_breaks(
    data: NDArray, names: list[str], sfreq: float, settings: Settings,
) -> list[dict[str, Any]]:
    """Разрывы записи: не-конечные отсчёты (NaN/inf) длиннее ``break_min_duration_ms``."""
    break_min = max(1, int(settings.break_min_duration_ms / 1000.0 * sfreq))
    zones: list[dict[str, Any]] = []
    for i, ch in enumerate(names):
        for zone in _runs_to_zones(~np.isfinite(data[i]), "break", break_min, sfreq):
            zone["channels"] = [ch]
            zones.append(zone)
    return zones


def _detect_pops(
    data: NDArray, names: list[str], sfreq: float, settings: Settings,
) -> list[dict[str, Any]]:
    """Всплески электродов (pop): ступенька ≥ ``pop_step_uv`` с возвратом ≤ 0.5 с.

    Pop — единичный скачок смещения электрода, который затем «отыгрывается»
    обратно: на производной это два противоположных выброса рядом. Без возврата
    это не pop, а дрейф/ступенька смещения — её зоной не считаем.
    """
    pop_thr = settings.pop_step_uv * 1e-6
    back_win = int(0.5 * sfreq)
    zones: list[dict[str, Any]] = []
    for i, ch in enumerate(names):
        d = np.diff(data[i])
        used: set[int] = set()
        for j in np.where(np.abs(d) >= pop_thr)[0]:
            j = int(j)
            if j in used or not np.isfinite(d[j]):
                continue
            seg = d[j + 1: j + 1 + back_win]
            back = np.where((np.sign(seg) == -np.sign(d[j])) & (np.abs(seg) >= 0.5 * abs(d[j])))[0]
            if back.size == 0:
                continue
            end = j + 1 + int(back[0]) + 1
            used.update(range(j, end))
            zones.append({
                "kind": "electrode_pop",
                "onset_sec": round(j / sfreq, 3),
                "duration_sec": round((end - j) / sfreq, 3),
                "channels": [ch],
            })
    return zones


def _detect_muscle(raw: mne.io.BaseRaw, settings: Settings) -> list[dict[str, Any]]:
    """Мышечный (ЭМГ): ``mne.preprocessing.annotate_muscle_zscore`` (MNE-only).

    Ищет всплески мощности 20–100 Гц (PDF: «высокочастотные всплески») и
    возвращает **зоны без аннотаций**: ЭМГ-участок информативен для QC, но
    сам по себе не бракует эпоху (правило BAD_). Запуск идёт **по каналу**:
    MNE считает z-power по всему монтажу сразу и пропускает локальный всплеск
    на одном электроде (замер: z=3.1 при пороге 4). Сбой детектора — в лог и
    дальше без ЭМГ-зон: опциональный шаг не должен срывать остальной поиск.
    """
    nyq = float(raw.info["sfreq"]) / 2.0
    band = (20.0, min(100.0, nyq * 0.95))
    min_length = settings.muscle_min_duration_ms / 1000.0
    zones: list[dict[str, Any]] = []
    for ch in raw.ch_names:
        try:
            result = mne.preprocessing.annotate_muscle_zscore(
                raw.copy().pick([ch]), threshold=4.0, min_length_good=min_length,
                filter_freq=band, verbose=False,
            )
        except Exception as exc:  # опциональный шаг: причина в лог, поиск не рвётся
            logger.warning("Детектор ЭМГ (%s) не сработал: %s", ch, exc)
            continue
        # MNE ≥1.x отдаёт кортеж (аннотации, z-оценки мощности); короче
        # muscle_min_duration_ms — не эпизод (суб-мс хвосты детектора, они же
        # округляются до duration_sec = 0 и ломают контракт зоны)
        anns = result[0] if isinstance(result, tuple) else result
        zones.extend({
            "kind": "muscle_emg",
            "onset_sec": round(float(onset), 3),
            "duration_sec": round(float(duration), 3),
            "channels": [ch],
        } for onset, duration in zip(anns.onset, anns.duration, strict=True)
            if duration >= min_length)
    return zones


def line_noise_zones(
    data: NDArray, sfreq: float, names: list[str], settings: Settings,
) -> tuple[list[dict[str, Any]], float | None]:
    """Сетевой шум 50/60 Гц + 3 гармоники: пик Welch-PSD против фона соседних частот.

    Свой детектор (без новых зависимостей): отношение мощности на гармонике к
    медиане фона ±3…12 Гц ≥ ``line_noise_ratio`` — канал в зоне. Возвращает зоны
    (по одной на загрязнённую гармонику, каналы — списком) и максимальное
    отношение пик/фон («уровень 50 Гц» для QC, ``line_noise_level``).
    """
    from scipy.signal import welch

    n_times = data.shape[1]
    # Окно ~4 с с 50 % перекрытием: больше сегментов — у́же фон PSD и меньше
    # ложных «пиков» на коротких записях.
    nperseg = int(min(4.0 * sfreq, n_times))
    if nperseg < 32 or not np.isfinite(data).any():
        return [], None
    freqs, psd = welch(np.nan_to_num(data), fs=sfreq, nperseg=nperseg, axis=-1)
    df = float(freqs[1] - freqs[0])
    f0 = float(settings.line_noise_hz)
    ratio_thr = float(settings.line_noise_ratio)
    nyquist = sfreq / 2.0
    duration = round(n_times / sfreq, 3)
    zones: list[dict[str, Any]] = []
    max_ratio = 0.0

    def _ratio(i: int, idx: int) -> float:
        """Пик/фон: медиана PSD в ±3…12 Гц от гармоники — «уровень шума»."""
        peak = float(psd[i, idx])
        inner = max(1, round(3.0 / df))
        outer = max(inner + 1, round(12.0 / df))
        bg = np.concatenate([
            psd[i, max(0, idx - outer): max(0, idx - inner)],
            psd[i, idx + inner: idx + outer],
        ])
        ref = float(np.median(bg)) if bg.size and np.median(bg) > 0 else 1e-30
        return peak / ref

    # Канал помечается только по основной гармонике (50/60 Гц): одиночный
    # случайный пик на 150 Гц не делает канал «сетевым».
    fundamental: list[tuple[int, str]] = []
    for i, name in enumerate(names):
        if f0 >= nyquist - 1.0:
            break
        ratio = _ratio(i, round(f0 / df))
        max_ratio = max(max_ratio, ratio)
        if ratio >= ratio_thr:
            fundamental.append((i, name))
    for k in range(1, 5):  # 50/100/150/200 Гц (или 60/120/180/240)
        f_peak = f0 * k
        if f_peak >= nyquist - 1.0:
            break
        idx = round(f_peak / df)
        affected = [name for i, name in fundamental if _ratio(i, idx) >= ratio_thr]
        if affected:
            zones.append({
                "kind": "line_noise",
                "onset_sec": 0.0,
                "duration_sec": duration,
                "channels": affected,
            })
    return zones, (round(max_ratio, 2) if max_ratio else None)


def _detect_ocular(
    data: NDArray, names: list[str], sfreq: float, settings: Settings,
) -> list[dict[str, Any]]:
    """Окулярный (моргание): медленные волны высокой амплитуды на Fp1/Fp2 (прокси EOG).

    Без EOG-канала моргание видно на фронтальных электродах: сглаженный сигнал
    (200 мс) с robust z ≥ порога дольше 150 мс — зона ``ocular``. Информационный
    вид: эпоху не роняет, глазные артефакты убирает ICA/SSP-очистка.
    """
    smooth = max(1, int(0.2 * sfreq))
    min_len = max(1, int(0.15 * sfreq))
    kernel = np.ones(smooth) / smooth
    zones: list[dict[str, Any]] = []
    for i, ch in enumerate(names):
        if ch.upper() not in _FRONTAL:
            continue
        x = np.convolve(np.nan_to_num(data[i]), kernel, mode="same")
        med, scale = _robust_stats(x)
        if scale <= 0:
            continue
        for zone in _runs_to_zones(
            np.abs(x - med) / scale > float(settings.z_score_threshold), "ocular", min_len, sfreq,
        ):
            zone["channels"] = [ch]
            zones.append(zone)
    return zones


def _detect_ecg(data: NDArray, names: list[str], sfreq: float) -> list[dict[str, Any]]:
    """ЭКГ-наводка: периодические QRS-пики на T7/T8 (ритм проверяется по IBI).

    Прокси ЭКГ без ECG-канала — височные отведения: полоса 5–20 Гц (QRS), пики
    огибающей ≥ 4 robust-z; если пики квазипериодичны (интервал 0.3–1.5 с,
    разброс < 40 % медианы) — это сердечный ритм, а не случайные всплески.
    """
    from scipy.signal import butter, filtfilt, find_peaks

    nyq = sfreq / 2.0
    if nyq <= 25.0:
        return []
    zones: list[dict[str, Any]] = []
    for i, ch in enumerate(names):
        if ch.upper() not in _TEMPORAL:
            continue
        x = np.nan_to_num(data[i])
        b, a = butter(2, [5.0 / nyq, 20.0 / nyq], btype="band")
        env = np.abs(filtfilt(b, a, x))
        med, scale = _robust_stats(env)
        if scale <= 0:
            continue
        peaks, _ = find_peaks(env, height=med + 4.0 * scale, distance=max(1, int(0.3 * sfreq)))
        if peaks.size < 4:
            continue
        ibi = np.diff(peaks) / sfreq
        median_ibi = float(np.median(ibi))
        if not 0.3 <= median_ibi <= 1.5 or float(np.std(ibi)) >= 0.4 * median_ibi:
            continue
        half = int(0.15 * sfreq)
        for peak in peaks:
            onset = max(0, int(peak) - half) / sfreq
            end = min(x.shape[0], int(peak) + half) / sfreq
            zones.append({
                "kind": "ecg",
                "onset_sec": round(onset, 3),
                "duration_sec": round(end - onset, 3),
                "channels": [ch],
            })
    return zones


def detect_artifacts(
    raw: mne.io.BaseRaw,
    settings: Settings,
    z_threshold: float = 5.0,
    pp_threshold_uv: float = 100.0,
    run_ica: bool = True,
) -> tuple[mne.Annotations, dict[str, Any]]:
    """Детекция артефактов: 11 видов зон + аннотации reject-видов (правило BAD_).

    Reject-виды (``EPOCH_REJECT_KINDS``) получают аннотации ``BAD_*`` и роняют
    эпохи; информационные (мышечный, сетевой, окулярный, ЭКГ, ICA-EOG) дают
    только зоны слоёв вьюера и QC (исключение — ``ica_eog``: только счётчик
    компонент, без зоны). ``stats["by_type"]`` — число зон по видам
    (исключение: ``ica_eog`` — число EOG-компонент). ``run_ica=False`` полностью
    пропускает ICA-ветку (быстрый профиль); ICA ищется и применяется только при
    наличии EOG-подобных каналов **или** фронтального прокси Fp1/Fp2 (N8 —
    `load_edf` отрезает EOG-каналы), факт — в ``stats["ica_applied"]``.

    Peak-to-peak держит историческую геометрию зоны (onset — центр окна):
    на неё завязан инвариант «зоны ↔ drop_log» в тестах (N6).
    """
    names = list(raw.ch_names)
    sfreq = float(raw.info["sfreq"])
    data = raw.get_data()
    zones: list[dict[str, Any]] = []

    # 1. Z-score: устойчивый (медиана/MAD, M11) — выброс не тянет порог за собой
    for i, ch in enumerate(names):
        med, scale = _robust_stats(data[i])
        if scale <= 0:
            continue
        for zone in _runs_to_zones(
            np.abs(data[i] - med) / scale > z_threshold, "zscore_outlier", 3, sfreq,
        ):
            zone["channels"] = [ch]
            zones.append(zone)

    # 2. Peak-to-peak (скользящее окно 2 с): превышение размаха
    win = int(2.0 * sfreq)
    if win >= 2 and data.shape[1] > win:
        for w_start in range(0, data.shape[1] - win, max(1, win // 2)):
            window = data[:, w_start: w_start + win]
            pp = np.nanmax(window, axis=1) - np.nanmin(window, axis=1)
            exceeded = np.where(pp > pp_threshold_uv * 1e-6)[0]
            if exceeded.size:
                zones.append({
                    "kind": "peak_to_peak",
                    "onset_sec": round((w_start + win // 2) / sfreq, 3),
                    "duration_sec": round(win / sfreq, 3),
                    "channels": [names[int(i)] for i in exceeded],
                })

    # 3. Плоская линия / клиппинг (N7/F20 + «эпизоды клиппинга» PDF)
    zones.extend(_detect_flat_or_clipping(data, names, sfreq, settings))
    # 4. Разрывы записи (NaN/inf-участки)
    zones.extend(_detect_breaks(data, names, sfreq, settings))
    # 5. Всплески электродов (pop)
    zones.extend(_detect_pops(data, names, sfreq, settings))
    # 6. Мышечный (ЭМГ), 8. Окулярный, 9. ЭКГ — информационные виды
    zones.extend(_detect_muscle(raw, settings))
    zones.extend(_detect_ocular(data, names, sfreq, settings))
    zones.extend(_detect_ecg(data, names, sfreq))
    # 7. Сетевой шум 50/60 Гц: зоны + уровень (QC)
    line_zones, line_level = line_noise_zones(data, sfreq, names, settings)
    zones.extend(line_zones)

    # 10. ICA EOG: EOG-каналы либо фронтальный прокси Fp1/Fp2 (N8: EOG-каналы
    # отрезаются `load_edf`, ветка обязана быть достижимой без них). Зона не
    # создаётся: компоненты EOG не привязаны ко времени, а полоса «на всю запись»
    # перекрывала вьюер и читалась пользователем как блокировка нарезки
    # (фидбэк 24.09.2026). Наружу идут только счётчик `by_type.ica_eog`
    # (число компонент) и факт `ica_applied`.
    eog_like = [ch for ch in names if "eog" in ch.lower()]
    frontal = [ch for ch in names if ch.upper() in FRONTAL_PROXY]
    ica_applied = False
    ica_components = 0
    if run_ica and (eog_like or frontal):
        try:
            ica = fit_ica(raw, min(18, len(names)))
            eog_inds, _ = find_eog_component_inds(ica, raw)
            ica_components = len(eog_inds)
            ica_applied = True
        except Exception as exc:
            logger.warning("ICA-EOG не применена: %s", exc)

    counts: dict[str, int] = dict.fromkeys(ARTIFACT_KINDS, 0)
    # Контракт зоны: длительность строго больше нуля (суб-мс хвосты округления
    # не должны попадать в слои вьюера)
    zones = [z for z in zones if z["duration_sec"] > 0]
    for zone in zones:
        if zone["kind"] != "ica_eog":
            counts[zone["kind"]] += 1
    counts["ica_eog"] = ica_components

    # Аннотации — только reject-виды (правило BAD_, см. докстринг модуля)
    reject_zones = [z for z in zones if z["kind"] in EPOCH_REJECT_KINDS]
    annotations = mne.Annotations(
        onset=[z["onset_sec"] for z in reject_zones],
        duration=[z["duration_sec"] for z in reject_zones],
        description=[ANNOTATION_DESC[z["kind"]] for z in reject_zones],
    )
    return annotations, {
        "total": sum(counts.values()),
        "by_type": counts,
        "ica_applied": ica_applied,
        "zones": zones,
        "line_noise_level": line_level,
    }


def find_bad_channels(raw: mne.io.BaseRaw, bad_channel_z: float) -> list[str]:
    """Плохие каналы: robust z «шумности» (MAD канала) за порогом в обе стороны.

    Высокий z — шумный/с дрейфом, отрицательный — почти константа (мёртвый):
    оба случая интерполяция чинит лучше, чем оставляет (PDF «плохие каналы»).
    Список идёт в QC (`bad_channels`) и в параметры очистки (stage `filter`).
    """
    scales = np.array([_robust_stats(ch)[1] for ch in raw.get_data()])
    med, mad_scale = _robust_stats(scales)
    if mad_scale <= 0:
        return []
    z = (scales - med) / mad_scale
    # Мёртвый канал (константа) ловится и отдельно: на малых монтажах его MAD-z
    # незначителен, а интерполировать его надо (PDF «плохие каналы»).
    dead = scales <= 0.01 * max(med, 1e-30)
    flagged = (np.abs(z) >= bad_channel_z) | dead
    return [str(name) for name, bad in zip(raw.ch_names, flagged, strict=True) if bad]


def find_dead_channels(raw: mne.io.BaseRaw) -> list[str]:
    """Мёртвые электроды по данным ДО референса (шаг 2.2/N10).

    Отвалившийся электрод — канал-константа (потеря контакта). После среднего
    референса он становится «−средним остальных» и уже не выглядит мёртвым
    (стратегия `01-signal-quality` §2 п.1: QC — по сырому), поэтому искать его
    надо до ``set_eeg_reference`` — вызывается из ``edf_loader.load_edf``,
    который помечает найденные каналы в ``raw.info['bads']`` стандартным
    механизмом MNE (интерполяция чинит их наравне с bad-каналами формы).
    Критерий: std канала ≤ 1 % медианы std монтажа (или абсолютно, если монтаж
    сам по себе константен — запись без сигнала).

    MNE 1.13: `annotate_nan`/`annotate_break` из N10 ищут NaN-сегменты и
    пропуски между блоками событий; константный канал с ненулевым значением
    они не ловят — этот критерий именно про «электрод отвалился».
    """
    data = raw.get_data(verbose=False)
    scales = np.array([
        float(np.std(ch[np.isfinite(ch)])) if np.isfinite(ch).any() else 0.0
        for ch in data
    ])
    finite = scales[np.isfinite(scales)]
    if finite.size == 0:
        return []
    threshold = max(float(np.median(finite)) * 0.01, 1e-15)
    flagged = scales <= threshold
    return [str(name) for name, bad in zip(raw.ch_names, flagged, strict=True) if bad]


# SNR (шаг 2.2/N10): сигнальная полоса ритмов δ…β против высокочастотного шума.
_SNR_SIGNAL_HZ = (2.0, 30.0)
_SNR_FLOOR_POWER = 1e-30
_SNR_CEILING_DB = 120.0


def channel_snr_db(raw: mne.io.BaseRaw) -> dict[str, float]:
    """SNR канала, дБ (шаг 2.2/N10): ритмические полосы против шумовой полки.

    ``SNR_30 = 10·log10(P(2–30 Гц) / P(30 Гц…Найквист))`` по Welch-PSD на всём
    канале: «мозговая активность» (δ…β) против высокочастотного шума (мышечный,
    аппаратный). Это грубая QC-оценка, не классический SNR радиосвязи; при
    band-pass подготовке (h_freq ≤ 40) верх спектра уже подрезан — цифра
    оптимистична, честнее сравнивать записи «Без фильтра». Нулевая шумовая
    полка (точно чистый сигнал) получает потолок ``_SNR_CEILING_DB``.
    """
    from scipy.signal import welch

    data = raw.get_data(verbose=False)
    sfreq = float(raw.info["sfreq"] or 0.0)
    n_times = data.shape[1]
    nperseg = int(min(4.0 * sfreq, n_times))
    result: dict[str, float] = {}
    if sfreq <= 0 or nperseg < 32 or not np.isfinite(data).any():
        return result
    freqs, psd = welch(np.nan_to_num(data), fs=sfreq, nperseg=nperseg, axis=-1)
    lo, hi = _SNR_SIGNAL_HZ
    sig_mask = (freqs >= lo) & (freqs <= hi)
    noise_mask = freqs > hi
    if not sig_mask.any() or not noise_mask.any():
        return result
    for i, name in enumerate(raw.ch_names):
        signal = float(np.mean(psd[i, sig_mask]))
        noise = float(np.mean(psd[i, noise_mask]))
        if noise <= _SNR_FLOOR_POWER:
            result[str(name)] = _SNR_CEILING_DB
        else:
            result[str(name)] = round(
                10.0 * float(np.log10(max(signal, _SNR_FLOOR_POWER) / noise)), 1,
            )
    return result


def record_qc_status(
    good_data_percent: float,
    line_noise_level: float | None,
    snr_db: float | None,
    bad_channels: list[str],
    settings: Settings,
) -> tuple[str, list[str]]:
    """Вердикт QC-светофора записи (шаг 2.2/N10): худший из четырёх категорий.

    Категории: чистые данные (``good_data_percent``), сетевой шум
    (``line_noise_level``, пик/фон), SNR (медиана по каналам, ``channel_snr_db``),
    плохие каналы (авто-список ``find_bad_channels`` ∪ мёртвые до референса).
    Статус — худший по категориям (``ok`` < ``warn`` < ``bad``); причины —
    короткие тексты для тултипа пилюли UI. Пороги — ``qc_*`` из ``Settings``
    (ручки владельца, не хардкод: числа порогов уточнятся с реальными
    записями — стратегия `01-signal-quality` §14).
    """
    rank = {"ok": 0, "warn": 1, "bad": 2}
    status = "ok"
    reasons: list[str] = []

    def _raise(new: str, reason: str) -> None:
        nonlocal status
        if rank[new] > rank[status]:
            status = new
        if new != "ok":
            reasons.append(reason)

    if good_data_percent < settings.qc_good_data_bad_percent:
        _raise("bad", f"чистых данных {good_data_percent:.0f} %")
    elif good_data_percent < settings.qc_good_data_warn_percent:
        _raise("warn", f"чистых данных {good_data_percent:.0f} %")

    if line_noise_level is not None and line_noise_level >= settings.qc_line_noise_warn:
        level = "bad" if line_noise_level >= settings.qc_line_noise_bad else "warn"
        _raise(level, f"сетевой шум ×{line_noise_level:.1f}")

    if snr_db is not None:
        if snr_db < settings.qc_snr_bad_db:
            _raise("bad", f"SNR {snr_db:.0f} дБ")
        elif snr_db < settings.qc_snr_warn_db:
            _raise("warn", f"SNR {snr_db:.0f} дБ")

    n_bad = len(bad_channels)
    if n_bad >= settings.qc_bad_channels_bad:
        _raise("bad", f"плохих каналов: {n_bad}")
    elif n_bad >= settings.qc_bad_channels_warn:
        _raise("warn", f"плохих каналов: {n_bad}")

    return status, reasons


def channel_qc_summary(
    zones: list[dict[str, Any]], channels: list[str], duration_sec: float,
    snr_db: dict[str, float] | None = None,
    dead_channels: list[str] | None = None,
) -> list[dict[str, Any]]:
    """QC-сводка по каналам из зон артефактов (шаг 0.4, расширена шагом 2.2).

    Для иконок состояния слева от имён каналов вьюера нужна не география зон,
    а «сколько времени канал был плохим»: суммарные секунды в зонах (интервалы
    сливаются, чтобы пересекающиеся детекторы не задваивались), доля от записи
    и разбивка по типам для тултипа. Считаются виды ``QC_TIME_KINDS``: зоны
    ``ica_eog`` (весь монтаж на всю запись) и ``line_noise`` (спектральный шум,
    его меряет ``line_noise_level``) обнулили бы смысл метрики.

    Шаг 2.2 добавил в строку SNR канала (``channel_snr_db``) и признак
    «мёртвый» (константный до референса, ``find_dead_channels``): иконка
    учитывает их наравне с долей времени в зонах (``channelQcStatus`` UI).
    """
    duration = max(float(duration_sec), 1e-9)
    dead = set(dead_channels or ())
    summary: list[dict[str, Any]] = []
    for name in channels:
        own = [
            (float(zone["onset_sec"]), float(zone["onset_sec"]) + float(zone["duration_sec"]),
             str(zone["kind"]))
            for zone in zones
            if name in zone.get("channels", []) and zone.get("kind") in QC_TIME_KINDS
        ]
        by_kind: dict[str, float] = {}
        for onset, end, kind in own:
            by_kind[kind] = round(by_kind.get(kind, 0.0) + (end - onset), 3)
        # Слияние интервалов: пересекающиеся зоны разных детекторов — одно время
        merged_sec = 0.0
        cur_start: float | None = None
        cur_end = 0.0
        for onset, end, _ in sorted(own):
            if cur_start is None or onset > cur_end:
                if cur_start is not None:
                    merged_sec += cur_end - cur_start
                cur_start, cur_end = onset, end
            else:
                cur_end = max(cur_end, end)
        if cur_start is not None:
            merged_sec += cur_end - cur_start
        merged_sec = round(merged_sec, 3)
        summary.append({
            "channel": name,
            "artifact_sec": merged_sec,
            "artifact_share": round(min(merged_sec / duration, 1.0), 4),
            "by_kind": by_kind,
            "snr_db": (snr_db or {}).get(name),
            "dead": name in dead,
        })
    return summary


def qc_summary(
    zones: list[dict[str, Any]],
    channels: list[str],
    duration_sec: float,
    line_noise_level: float | None = None,
    bad_channels: list[str] | None = None,
    snr_db_by_channel: dict[str, float] | None = None,
    dead_channels: list[str] | None = None,
) -> dict[str, Any]:
    """Сводные числа QC (этап «числа QC» + светофор шага 2.2): что куда идёт.

    * ``good_data_percent`` — 100 % минус **средняя по каналам** доля времени в
      зонах ``QC_TIME_KINDS``: «сколько записи пригодно без правок»;
    * ``artifact_share_by_kind`` — средняя по каналам доля времени в зонах вида
      (доля «грязного» времени по типам артефактов);
    * ``line_noise_level`` — уровень сетевого шума (пик/фон, см. ``line_noise_zones``);
    * ``bad_channels`` — авто-список плохих каналов (``find_bad_channels``);
    * ``snr_db`` / ``snr_db_min`` / ``snr_db_by_channel`` — SNR каналов
      (``channel_snr_db``): медиана, худший и по-канально для иконок;
    * ``dead_channels`` — мёртвые/помеченные каналы (константные до референса
      либо bads формы, не исправленные интерполяцией).

    Вердикт светофора (``record_status``) считает ``record_qc_status`` — здесь
    только числа, чтобы сервис чисел не зависел от порогов.
    """
    duration = max(float(duration_sec), 1e-9)
    rows = channel_qc_summary(
        zones, channels, duration_sec,
        snr_db=snr_db_by_channel, dead_channels=dead_channels,
    )
    dirty = float(np.mean([row["artifact_share"] for row in rows])) if rows else 0.0
    share_by_kind: dict[str, float] = {}
    for kind in QC_TIME_KINDS:
        sec = sum(float(row["by_kind"].get(kind, 0.0)) for row in rows)
        share = sec / (duration * max(len(channels), 1))
        if share > 0:
            share_by_kind[kind] = round(share, 4)
    snr_values = [v for v in (snr_db_by_channel or {}).values() if np.isfinite(v)]
    return {
        "good_data_percent": round(100.0 * (1.0 - min(dirty, 1.0)), 1),
        "artifact_share_by_kind": share_by_kind,
        "line_noise_level": line_noise_level,
        "bad_channels": list(bad_channels or []),
        "snr_db": round(float(np.median(snr_values)), 1) if snr_values else None,
        "snr_db_min": round(float(np.min(snr_values)), 1) if snr_values else None,
        "snr_db_by_channel": dict(snr_db_by_channel or {}),
        "dead_channels": list(dead_channels or []),
    }
