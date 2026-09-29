"""Зоны вклада чистки и метрики потерь L1/L3/L4/L5 (шаг 2 плана).

Две чистые функции, которые вызывает ``artifact_cleaner.apply_cleaning``:

* **зоны вклада** (``detect_clean_zones``): интервалы, где чистка заметно
  изменила сигнал (diff «без очистки − с очисткой»). Порог — конвенция
  robust-детекторов (медиана + k·MAD через ``utils/robust.py``), параметры — в
  ``core/config.py``. Зоны считаются от **полного** вклада чистки (до применения
  отмен ``exclude_zone_ids``): id (``clean-1``, ``clean-2``, … по порядку
  onset) обязаны быть стабильны между пересчётами — UI отменяет их по id, и
  «поехавшие» id превращают отмену в лотерею;
* **метрики потерь** (``clean_loss``) считаются для **текущей** конфигурации
  (с учётом отмен): отменил зону — числа изменились, видно цену отмены.

Метрики (Части 1 §10): **L1** — остаток наводки сети в дБ (``mains`` — тот же
расчёт, DRY), **L3** — Δ-спектр по семи полосам ``freq_bands`` (интеграл PSD
до/после), **L4** — сохранённая дисперсия (коherентность до/после по полосам,
0..1), **L5** — удалённая дисперсия в процентах (доля компонент ICA либо, для
прочих способов, доля дисперсии diff — источник честно подписан).
"""
from typing import Any

import numpy as np
from numpy.typing import NDArray

from app.core.config import Settings
from app.services.filter_design import harmonic_frequencies
from app.utils.robust import robust_stats

# Защита от log(0)/деления на ноль в спектральных метриках: шум float64 ниже
# этого отношения «две нули» — честный отказ (None), а не −200 дБ.
_SPECTRAL_FLOOR = np.finfo(np.float64).tiny


def detect_clean_zones(
    before: NDArray,
    after: NDArray,
    sfreq: float,
    settings: Settings,
) -> list[dict[str, Any]]:
    """Зоны вклада чистки: интервалы, где ``before − after`` заметно выше фона.

    ``before`` — сигнал до чистки, ``after`` — после **полной** чистки (без
    применения отмен: см. шапку модуля). Возвращает dict'ы для
    ``CleanZoneOut`` без ``id``/``channels`` (их дописывает ``apply_cleaning``):
    ``onset_sec``/``duration_sec``/``amplitude_uv``/``_samples``.
    """
    diff = np.asarray(before, dtype=np.float64) - np.asarray(after, dtype=np.float64)
    # Огибающая вклада: RMS по каналам на каждый сэмпл (чистка режет все каналы
    # разом — общий огибающий честнее «максимума по шумному каналу»).
    envelope = np.sqrt(np.mean(diff * diff, axis=0))
    med, scale = robust_stats(envelope)
    if not np.isfinite(scale) or scale <= 0.0:
        return []  # чистка ничего не изменила (или изменила ровно везде)
    threshold = med + settings.clean_zone_mad_k * scale
    mask = envelope > threshold
    if not mask.any():
        return []

    # Разрезы на интервалы → сшивка коротких промежутков → отсев коротких зон
    min_len = max(1, round(settings.clean_zone_min_duration_ms * sfreq / 1000.0))
    merge_gap = max(1, round(settings.clean_zone_merge_gap_ms * sfreq / 1000.0))
    edges = np.flatnonzero(np.diff(np.concatenate(([0], mask.view(np.uint8), [0]))))
    intervals = [(int(s), int(e)) for s, e in edges.reshape(-1, 2)]

    merged: list[tuple[int, int]] = []
    for start, end in intervals:
        if merged and start - merged[-1][1] <= merge_gap:
            merged[-1] = (merged[-1][0], end)
        else:
            merged.append((start, end))

    zones: list[dict[str, Any]] = []
    for start, end in merged:
        if end - start < min_len:
            continue
        window = envelope[start:end]
        zones.append({
            "onset_sec": round(start / sfreq, 4),
            "duration_sec": round((end - start) / sfreq, 4),
            "amplitude_uv": round(float(np.percentile(window, 95)) * 1e6, 2),
            "_samples": (start, end),
        })
    return zones


def zone_channels(
    before: NDArray, after: NDArray, start: int, end: int, ch_names: list[str],
) -> list[str]:
    """Каналы с заметным вкладом в зону: RMS diff выше фона по каналам зоны.

    Фон — медиана + 2·MAD по каналам (та же конвенция robust, что у зон);
    пустого списка не бывает: зона без единого канала бессмысленна, поэтому
    при равных фонах берётся канал с максимальным вкладом.
    """
    diff = np.asarray(before, dtype=np.float64)[:, start:end] - np.asarray(
        after, dtype=np.float64,
    )[:, start:end]
    rms = np.sqrt(np.mean(diff * diff, axis=1))
    med, scale = robust_stats(rms)
    threshold = med + 2.0 * scale if scale > 0 else np.inf
    hot = np.flatnonzero(rms > threshold)
    if hot.size == 0:
        hot = np.array([int(np.argmax(rms))])
    return [ch_names[int(index)] for index in hot if 0 <= int(index) < len(ch_names)]


def clean_loss(
    before: NDArray,
    after: NDArray,
    sfreq: float,
    settings: Settings,
    *,
    notch_hz: float | None,
    notch_harmonics: int,
    removed_variance_percent: float | None = None,
    removed_variance_source: str = "diff",
) -> dict[str, Any]:
    """Метрики потерь чистки для текущей конфигурации (L1/L3/L4/L5).

    ``before``/``after`` — уже с учётом отмен зон. ``removed_variance_percent``
    считает вызывающий (только у ICA он «компонентный»); по умолчанию — доля
    дисперсии diff, а источник в ответе подписан честно.
    """
    from scipy.signal import csd, welch

    # Локальный импорт: mains тянет prepared_signal → artifact_cleaner — цикл
    from app.services.mains import line_noise_levels_db

    before = np.asarray(before, dtype=np.float64)
    after = np.asarray(after, dtype=np.float64)

    # L1 — остаток наводки: тот же расчёт, что в /recordings/{id}/mains (DRY)
    line_noise: list[dict[str, Any]] = []
    if notch_hz:
        freqs = [notch_hz, *harmonic_frequencies(notch_hz, notch_harmonics, sfreq)]
        levels_before = line_noise_levels_db(before, sfreq, freqs)
        levels_after = line_noise_levels_db(after, sfreq, freqs)
        line_noise = [
            {"freq_hz": float(freq), "before_db": float(b), "after_db": float(a)}
            for freq, b, a in zip(freqs, levels_before, levels_after, strict=True)
        ]

    # L3/L4 — один спектральный проход на обе метрики
    nperseg = int(min(2048, before.shape[-1]))
    freqs_psd, psd_before = welch(before, fs=sfreq, nperseg=nperseg, axis=-1)
    _, psd_after = welch(after, fs=sfreq, nperseg=nperseg, axis=-1)
    _, cross = csd(before, after, fs=sfreq, nperseg=nperseg, axis=-1)
    # Среднее PSD по каналам (как в mains): одна кривая на запись
    p_before = psd_before.mean(axis=0)
    p_after = psd_after.mean(axis=0)
    c_xy = cross.mean(axis=0)
    coherence = np.abs(c_xy) ** 2 / np.maximum(p_before * p_after, _SPECTRAL_FLOOR)

    bands: list[dict[str, Any]] = []
    for name, (fmin, fmax) in settings.freq_bands.items():
        band_mask = (freqs_psd >= float(fmin)) & (freqs_psd <= float(fmax))
        if not band_mask.any():
            bands.append({"name": name, "delta_db": None, "correlation": None})
            continue
        band_freqs = freqs_psd[band_mask]
        integral_before = float(np.trapezoid(p_before[band_mask], band_freqs))
        integral_after = float(np.trapezoid(p_after[band_mask], band_freqs))
        if integral_before <= _SPECTRAL_FLOOR or integral_after <= _SPECTRAL_FLOOR:
            delta_db = None  # обе нули — «дельта неизвестна», а не −200 дБ
        else:
            # L3 — Δ-спектр: сколько мощности срезала чистка (дБ, >0 — срезала)
            delta_db = round(10.0 * float(np.log10(integral_before / integral_after)), 2)
        # L4 — сохранённая дисперсия: коherентность до/после в полосе, 0..1
        correlation = round(float(np.clip(coherence[band_mask].mean(), 0.0, 1.0)), 3)
        bands.append({"name": name, "delta_db": delta_db, "correlation": correlation})

    # L5 — удалённая дисперсия: компонентная оценка приходит от вызывающего
    if removed_variance_percent is None:
        var_before = float(np.var(before))
        var_diff = float(np.var(before - after))
        removed = (
            round(100.0 * var_diff / var_before, 2) if var_before > _SPECTRAL_FLOOR else 0.0
        )
    else:
        removed = float(removed_variance_percent)

    return {
        "line_noise": line_noise,
        "bands": bands,
        "removed_variance_percent": float(np.clip(removed, 0.0, 100.0)),
        "removed_variance_source": removed_variance_source,
    }
