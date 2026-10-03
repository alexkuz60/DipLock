"""Дифференциальный анализ двух записей (B9, задача «Сравнение»).

Зачем отдельный сервис
----------------------
Одна пара записей одного испытуемого (например, покой с закрытыми глазами vs
умственная деятельность) обрабатывается **одними и теми же параметрами** спектра —
иначе дельты не определены. Отсюда инварианты:

* пара читается тем же путём, что и спектр (``_prepare_epochs`` →
  ``_compute_psd``: монтаж 10-20, референс, фильтр до нарезки, кэш подготовленного
  сигнала A4) — сравнение не изобретает свою обработку;
* частотная сетка и набор каналов у обеих сторон **одни**: sfreq обязан совпасть
  (шлюз 400), а каналы сужаются до пересечения (разошедшиеся — в предупреждениях
  и в «совпадении параметров» B9);
* дельты всегда **B − A**: знак числа = направление изменения.

Что считается
-------------
* **PSD-кривые и дельты по полосам** (δ…γ из ``freq_bands``): мощность, относительная
  доля, медиана по эпохам, дельта мкВ² и дБ;
* **95% bootstrap-ИИ дельты дБ** — по эпоховым мощностям (ресэмплинг внутри каждой
  стороны, ``compare_n_bootstraps``); 0 внутри интервала = различие не подтверждено;
* **Welch t-тест** по эпоховым мощностям: уровень полосы (p, поправка FDR по полосам)
  и по каналам внутри полосы (``fdr_significant_channels``);
* **кластерный пермутационный тест MNE** (``mne.stats.permutation_cluster_test``)
  по мощности «канал × частота» в дБ: соседство скальпа — ``find_ch_adjacency``
  (Delaunay по позициям монтажа), частоты — решётка; на выходе кластеры с p и
  знаком дельты. Уровни — ``compare_n_permutations``/``compare_alpha``;
* **карты разности B−A** по полосам: дивергентная палитра со шкалой ``(-m, m)``
  (`topomap_png`), кэш на диске ``cache/compare/{id_A}/{signature}/{band}.png``,
  отдача — ETag-эндпоинтом; подпись зависит от параметров и **обеих** записей;
* индексы (IAF, θ/β, (θ+α)/β) и 1/f-разложение (specparam) каждой стороны + дельты.

Каветы (поле ``notes`` контракта) — не украшение: кластерный тест не локализует
эффект внутри кластера (Sassenhagen & Draschkow, 2019), а эпохи внутри записи
автокоррелированы, поэтому эффективная выборка меньше числа эпох.
"""
import hashlib
import os
import time
import warnings as py_warnings
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlencode

import numpy as np

from app.core.config import Settings
from app.services import journal
from app.services.cache_store import cache_clear, cache_path, cache_write
from app.services.recordings import Recording
from app.services.spectral import (
    SpectrumParams,
    _band_powers,
    _channel_band_power,
    _compute_psd,
    _fit_specparam,
    _individual_alpha_hz,
    _integrate_band,
    _prepare_epochs,
    channel_positions,
    spectrum_signature,
    topomap_png,
)

# Версия карт разности: смена отрисовки отправляет старые PNG в невалидность
# (урок A7 — как ``v3-topomap-mne`` у карт мощности).
COMPARE_TOPOMAP_VERSION = "v1-compare-delta"

# Обязательные каветы интерпретации — их показывает UI под результатом.
COMPARE_NOTES: tuple[str, ...] = (
    "Кластерный тест указывает на связку «частота × канал», но не доказывает "
    "значимость каждой её точки отдельно (Sassenhagen & Draschkow, 2019).",
    "Эпохи внутри записи автокоррелированы: эффективная выборка меньше числа "
    "эпох, поэтому p-значения могут быть оптимистичными.",
    "Дельты считаются по общим каналам пары и при одинаковой обработке "
    "(см. «совпадение параметров»); направление дельт — B − A.",
)

# Пол мощности для логарифмов: ниже — околонулевой шум, дБ отсекается (не −3000).
_PSD_FLOOR_UV2 = 1e-12


class CompareError(ValueError):
    """Ошибка параметров/данных пары — превращается в понятный текст задачи."""


@dataclass
class CompareParams:
    """Параметры сравнения: общие параметры спектра + ярлыки условий."""

    spectrum: SpectrumParams
    label_a: str = "Покой"
    label_b: str = "Деятельность"


@dataclass
class PairPsd:
    """PSD-кубы обеих сторон на общей сетке — вход всех расчётов пары."""

    freqs: np.ndarray                     # (n_freq,) Гц
    psd_a: np.ndarray                     # (n_ep_a, n_ch, n_freq) мкВ²/Гц
    psd_b: np.ndarray
    channels: list[str]                   # общий набор (порядок записей A)
    channels_only_a: list[str]
    channels_only_b: list[str]
    sfreq: float
    n_epochs_a: int
    n_epochs_b: int
    warnings: list[str] = field(default_factory=list)


@dataclass
class SideSummary:
    """Агрегаты одной стороны: то же наполнение, что у спектра, плюс ряды эпох."""

    channel_powers: dict[str, dict[str, float]]   # band → channel → мкВ²
    band_power: dict[str, float | None]           # band → средняя по каналам, мкВ²
    epoch_series: dict[str, np.ndarray]           # band → (n_ep,) мкВ² (среднее по каналам)
    epoch_channels: dict[str, np.ndarray]         # band → (n_ep, n_ch) мкВ² (для FDR)
    curve: np.ndarray                             # (n_freq,) средний PSD, мкВ²/Гц
    total_power: float
    iaf_hz: float | None
    theta_beta: float | None
    theta_alpha_beta: float | None
    specparam: dict[str, Any]
    specparam_warnings: list[str]


def _pair_channels(recording_a: Recording, recording_b: Recording) -> list[str]:
    """Общий набор каналов пары из метаданных: порядок A ∩ B.

    Один и тот же хелпер и в ``run_compare``, и в ленивом пересчёте топокарты:
    подпись ключа кэша обязана совпадать независимо от того, каким путём она
    посчитана (метаданные против ``epochs.ch_names`` — тот же компромисс, что у
    ``cached_topomap`` спектра).
    """
    channels_a = list(recording_a.meta.get("channels") or [])
    channels_b = set(recording_b.meta.get("channels") or [])
    return [name for name in channels_a if name in channels_b]


def compare_signature(
    params: CompareParams, cfg: Settings, channels: list[str],
    recording_a: Recording, recording_b: Recording,
) -> str:
    """Отпечаток пары и параметров: ключ кэша карт разности и версия ETag.

    Подпись спектра (``spectrum_signature``) покрывает параметры и каналы, сюда
    добавляются **обе** записи: карта разности живёт рядом с записью A
    (``cache/compare/{id_A}/…``), а смена записи B меняет подпись — старые
    картинки не отдаются «не своего» сравнения. Ярлыки условий в подпись не
    входят: они меняют только подписи, не числа.
    """
    base = spectrum_signature(params.spectrum, cfg, channels)
    digest = hashlib.sha256()
    digest.update("|".join((
        base,
        f"a={recording_a.recording_id}",
        f"b={recording_b.recording_id}",
        COMPARE_TOPOMAP_VERSION,
    )).encode("utf-8"))
    return digest.hexdigest()[:16]


def _pair_psd(
    recording_a: Recording, recording_b: Recording, cfg: Settings, params: CompareParams,
) -> PairPsd:
    """Читает обе записи и считает PSD-кубы на общей сетке.

    Сетки обязаны совпасть (одинаковый sfreq и параметры — шлюз 400 уже прошли
    здесь, повторная проверка — защита сервиса от прямых вызовов); каналы
    сужаются до пересечения: сравнение по «разным» каналам дало бы дельты
    неопределённого смысла.
    """
    raw_a, epochs_a = _prepare_epochs(recording_a, cfg, params.spectrum)
    raw_b, epochs_b = _prepare_epochs(recording_b, cfg, params.spectrum)
    sfreq_a = float(raw_a.info["sfreq"])
    sfreq_b = float(raw_b.info["sfreq"])
    if not np.isclose(sfreq_a, sfreq_b):
        raise CompareError(
            f"Частоты дискретизации различаются ({sfreq_a:g} vs {sfreq_b:g} Гц) — "
            "сравнение не определено"
        )

    channels_a = list(epochs_a.ch_names)
    channels_b = list(epochs_b.ch_names)
    common = [name for name in channels_a if name in set(channels_b)]
    only_a = [name for name in channels_a if name not in set(channels_b)]
    only_b = [name for name in channels_b if name not in set(channels_a)]
    if not common:
        raise CompareError("Записи не имеют ни одного общего канала — сравнивать нечего")

    report_warnings: list[str] = []
    if only_a or only_b:
        report_warnings.append(
            "Каналы вне пересечения исключены из сравнения: "
            + "; ".join(
                part for part in (
                    f"A: {', '.join(only_a)}" if only_a else "",
                    f"B: {', '.join(only_b)}" if only_b else "",
                ) if part
            )
        )

    freqs_a, psd_a, _, _ = _compute_psd(epochs_a, cfg, params.spectrum)
    freqs_b, psd_b, _, _ = _compute_psd(epochs_b, cfg, params.spectrum)
    if freqs_a.shape != freqs_b.shape or not np.allclose(freqs_a, freqs_b):
        raise CompareError(
            "Частотные сетки PSD разошлись (разные параметры или sfreq) — дельты не определены"
        )

    def _slice(psd: np.ndarray, channels: list[str]) -> np.ndarray:
        idx = [channels.index(name) for name in common]
        return psd[:, idx, :]

    return PairPsd(
        freqs=freqs_a,
        psd_a=_slice(psd_a, channels_a),
        psd_b=_slice(psd_b, channels_b),
        channels=common,
        channels_only_a=only_a,
        channels_only_b=only_b,
        sfreq=sfreq_a,
        n_epochs_a=int(psd_a.shape[0]),
        n_epochs_b=int(psd_b.shape[0]),
        warnings=report_warnings,
    )


def _side_summary(pair: PairPsd, cube: np.ndarray, cfg: Settings) -> SideSummary:
    """Агрегаты одной стороны из PSD-куба (та же арифметика, что у спектра)."""
    psd_mean = np.mean(cube, axis=0)               # (n_ch, n_freq) — PSD по эпохам
    curve = np.mean(psd_mean, axis=0)              # (n_freq,) средний по каналам
    band_power = _band_powers(freqs=pair.freqs, psd_mean=psd_mean, bands=cfg.freq_bands)
    total_power = float(np.trapezoid(curve, x=pair.freqs)) if pair.freqs.size >= 2 else 0.0

    channel_powers: dict[str, dict[str, float]] = {}
    epoch_series: dict[str, np.ndarray] = {}
    epoch_channels: dict[str, np.ndarray] = {}
    df = float(pair.freqs[1] - pair.freqs[0]) if pair.freqs.size > 1 else 1.0
    for name, (fmin, fmax) in cfg.freq_bands.items():
        channel_powers[name] = _channel_band_power(
            pair.freqs, psd_mean, pair.channels, fmin, fmax,
        )
        mask = (pair.freqs >= fmin) & (pair.freqs <= fmax)
        if not np.any(mask):
            epoch_series[name] = np.empty(0)
            epoch_channels[name] = np.empty((cube.shape[0], 0))
            continue
        per_channel = _integrate_band(pair.freqs[mask], cube[:, :, mask], df)  # (n_ep, n_ch)
        epoch_channels[name] = per_channel
        epoch_series[name] = np.mean(per_channel, axis=-1)

    alpha_range = cfg.freq_bands.get("alpha")
    theta_p, alpha_p, beta_p = band_power.get("theta"), band_power.get("alpha"), band_power.get("beta")
    fit, fit_warnings = _fit_specparam(pair.freqs, curve)
    return SideSummary(
        channel_powers=channel_powers,
        band_power=band_power,
        epoch_series=epoch_series,
        epoch_channels=epoch_channels,
        curve=curve,
        total_power=total_power,
        iaf_hz=(
            _individual_alpha_hz(pair.freqs, curve, alpha_range)
            if alpha_range is not None else None
        ),
        theta_beta=(theta_p / beta_p if theta_p is not None and beta_p else None),
        theta_alpha_beta=(
            (theta_p + alpha_p) / beta_p
            if theta_p is not None and alpha_p is not None and beta_p else None
        ),
        specparam=fit,
        specparam_warnings=fit_warnings,
    )


def _delta_db(power_a: float | None, power_b: float | None) -> float | None:
    """10·log10(B/A) с полом: нулевые мощности дают честный None, не −∞."""
    if power_a is None or power_b is None:
        return None
    if power_a <= 0 or power_b <= 0:
        return None
    return float(10.0 * np.log10(power_b / power_a))


def _welch_p(series_a: np.ndarray, series_b: np.ndarray) -> float:
    """Welch t-тест (без предположения равенства дисперсий) → p, всегда конечное.

    Нулевые дисперсии у обеих сторон (константы) дают nan от scipy: одинаковые
    константы — «различий нет» (p=1), разные — «различие абсолютно» (p=0).
    """
    from scipy import stats

    if series_a.size < 2 or series_b.size < 2:
        return float("nan")
    with np.errstate(invalid="ignore", divide="ignore"):
        result = stats.ttest_ind(series_a, series_b, equal_var=False)
    pvalue = float(result.pvalue)
    if np.isfinite(pvalue):
        return pvalue
    return 1.0 if np.isclose(np.mean(series_a), np.mean(series_b)) else 0.0


def _bootstrap_ci_db(
    series_a: np.ndarray, series_b: np.ndarray, n_bootstraps: int, rng: np.random.Generator,
) -> list[float] | None:
    """95% bootstrap-ИИ дельты дБ: ресэмплинг эпох **внутри** каждой стороны.

    Две записи — независимые выборки (эпохи не парные), поэтому интервал
    строится по разности средних мощностей двух независимых ресэмплингов, а не
    по «эпоха к эпохе». ``None`` — меньше двух эпох: интервал не определён.
    """
    if series_a.size < 2 or series_b.size < 2:
        return None
    idx_a = rng.integers(0, series_a.size, size=(n_bootstraps, series_a.size))
    idx_b = rng.integers(0, series_b.size, size=(n_bootstraps, series_b.size))
    # Пол — machine tiny, а не абсолютный: логарифм определён для любого
    # положительного числа, фиксированный 1e-12 «съедал» бы дельты
    # маломощностных сигналов (обе стороны → пол → дельта ровно 0).
    tiny = float(np.finfo(np.float64).tiny)
    mean_a = np.maximum(series_a[idx_a].mean(axis=1), tiny)
    mean_b = np.maximum(series_b[idx_b].mean(axis=1), tiny)
    deltas = 10.0 * np.log10(mean_b / mean_a)
    low, high = np.percentile(deltas, (2.5, 97.5))
    return [float(low), float(high)]


def _robust_effect(series_a: np.ndarray, series_b: np.ndarray) -> float | None:
    """Робастный размер эффекта: медианная разность / pooled MAD (устойчив к выбросам)."""
    from app.utils.robust import robust_stats

    if series_a.size < 2 or series_b.size < 2:
        return None
    med_a, scale_a = robust_stats(series_a)
    med_b, scale_b = robust_stats(series_b)
    pooled = float(np.sqrt(0.5 * (scale_a**2 + scale_b**2)))
    if pooled <= 0:
        return None
    return float((med_b - med_a) / pooled)


def _band_rows(
    pair: PairPsd, sum_a: SideSummary, sum_b: SideSummary, cfg: Settings,
    signature: str,
) -> list[dict[str, Any]]:
    """Строки дельт по полосам: p (Welch), q (FDR по полосам) и каналы внутри полосы.

    На полосу: Welch t-тест по канало-средним эпоховым мощностям (p); **второй**
    проход — по каждому каналу отдельно с FDR внутри полосы
    (``fdr_significant_channels`` — по ним UI показывает карту разности).
    ``q_value`` — FDR-поправка p по всем полосам результата (один проход).
    """
    from mne.stats import fdr_correction

    raw_p: list[float] = []
    rows: list[dict[str, Any]] = []
    rng = np.random.default_rng(int(signature[:8], 16))
    for name, (fmin, fmax) in cfg.freq_bands.items():
        power_a = sum_a.band_power.get(name)
        power_b = sum_b.band_power.get(name)
        series_a = sum_a.epoch_series.get(name, np.empty(0))
        series_b = sum_b.epoch_series.get(name, np.empty(0))

        p_value = _welch_p(series_a, series_b)
        raw_p.append(p_value if np.isfinite(p_value) else 1.0)

        # Канальный FDR внутри полосы — только при живых рядах обеих сторон.
        significant_channels: list[str] = []
        ch_a = sum_a.epoch_channels.get(name)
        ch_b = sum_b.epoch_channels.get(name)
        if (
            ch_a is not None and ch_b is not None
            and ch_a.shape[1] > 0 and ch_a.shape[0] >= 2 and ch_b.shape[0] >= 2
        ):
            ch_p = np.array([_welch_p(ch_a[:, i], ch_b[:, i]) for i in range(ch_a.shape[1])])
            ch_p = np.where(np.isfinite(ch_p), ch_p, 1.0)
            reject, _ = fdr_correction(ch_p, alpha=cfg.compare_alpha)
            significant_channels = [
                channel for channel, keep in zip(pair.channels, reject, strict=True) if keep
            ]

        median_a = float(np.median(series_a)) if series_a.size else None
        median_b = float(np.median(series_b)) if series_b.size else None
        rows.append({
            "name": name,
            "fmin": float(fmin),
            "fmax": float(fmax),
            "power_a_uv2": power_a,
            "power_b_uv2": power_b,
            "delta_uv2": (
                float(power_b - power_a)
                if power_a is not None and power_b is not None else None
            ),
            "delta_db": _delta_db(power_a, power_b),
            "relative_power_a": (
                power_a / sum_a.total_power
                if power_a is not None and sum_a.total_power > 0 else None
            ),
            "relative_power_b": (
                power_b / sum_b.total_power
                if power_b is not None and sum_b.total_power > 0 else None
            ),
            "median_a_uv2": median_a,
            "median_b_uv2": median_b,
            "ci95_delta_db": _bootstrap_ci_db(series_a, series_b, cfg.compare_n_bootstraps, rng),
            "effect": _robust_effect(series_a, series_b),
            "p_value": p_value if np.isfinite(p_value) else None,
            "q_value": None,  # заполняется после FDR по полосам
            "fdr_significant_channels": significant_channels,
            "topomap_delta_url": None,  # заполняется при построении карт
        })

    # FDR по полосам: один проход на весь список, q рядом со своим p.
    _, q_values = fdr_correction(np.asarray(raw_p), alpha=cfg.compare_alpha)
    for row, q in zip(rows, q_values, strict=True):
        row["q_value"] = float(q)
    return rows


def _empty_stats(cfg: Settings, reason: str | None = None) -> tuple[dict[str, Any], list[str]]:
    """Пустая статистика + предупреждение-причина (тест не проводился)."""
    stats: dict[str, Any] = {
        "method": "permutation_cluster_test",
        "n_permutations": cfg.compare_n_permutations,
        "alpha": cfg.compare_alpha,
        "n_clusters": 0,
        "n_significant": 0,
        "clusters": [],
    }
    return stats, [reason] if reason else []


def _cluster_stats(
    pair: PairPsd, cfg: Settings, signature: str,
) -> tuple[dict[str, Any], list[str]]:
    """Кластерный пермутационный тест MNE: мощность «канал × частота» в дБ.

    Данные ``(n_ep, n_ch, n_freq)`` → транспонируются в ``(n_ep, n_freq, n_ch)``
    и сплющиваются: последняя ось данных — каналы, соседство —
    ``combine_adjacency(n_freqs, ch_adj)``, где ``ch_adj`` строится MNE по
    позициям монтажа (Delaunay по координатам электродов). Статистика F
    считается на децибелах — масштаб низких частот не «съедает» высокие.

    Случаи пропуска (не ошибка): меньше двух эпох у одной из сторон, меньше
    трёх каналов с позицией — в ``warnings``, статистика пустая.
    """
    from mne import create_info
    from mne.channels import find_ch_adjacency, make_dig_montage
    from mne.stats import combine_adjacency, permutation_cluster_test

    n_a, n_b = pair.n_epochs_a, pair.n_epochs_b
    if n_a < 2 or n_b < 2:
        return _empty_stats(
            cfg, f"Кластерный тест пропущен: мало эпох (A={n_a}, B={n_b}; нужно ≥ 2 у каждой)",
        )
    positions = channel_positions(pair.channels)
    stat_channels = [name for name in pair.channels if name in positions]
    if len(stat_channels) < 3:
        return _empty_stats(
            cfg,
            "Кластерный тест пропущен: меньше трёх каналов с позицией в монтаже",
        )

    # Матрица adjacency со своим порядком каналов — приводим данные к нему.
    info = create_info(stat_channels, pair.sfreq, "eeg")
    with py_warnings.catch_warnings():
        # Насион не участвует в Delaunay-соседстве: трансформация координат
        # для adjacency не нужна, предупреждение только шумит журнал задачи.
        py_warnings.filterwarnings("ignore", message="Fiducial point nasion not found")
        info.set_montage(make_dig_montage({name: positions[name] for name in stat_channels}))
    ch_adj, adj_names = find_ch_adjacency(info, "eeg")
    names = [str(name) for name in adj_names]
    if names != stat_channels:
        stat_channels = names  # порядок MNE — источник истины для столбцов
    idx = [pair.channels.index(name) for name in stat_channels]

    floor = _PSD_FLOOR_UV2
    db_a = 10.0 * np.log10(np.maximum(pair.psd_a[:, idx, :], floor))  # (n_ep, n_ch, n_freq)
    db_b = 10.0 * np.log10(np.maximum(pair.psd_b[:, idx, :], floor))
    n_freqs = pair.freqs.size
    # (n_ep, n_freq, n_ch) → решётка «частота × канал» в строках.
    flat_a = db_a.transpose(0, 2, 1).reshape(n_a, n_freqs * len(stat_channels))
    flat_b = db_b.transpose(0, 2, 1).reshape(n_b, n_freqs * len(stat_channels))
    # Направление дельты: среднее по эпохам в дБ, разность сторон (B − A).
    delta_matrix = db_b.mean(axis=0) - db_a.mean(axis=0)  # (n_ch, n_freq)

    adjacency = combine_adjacency(n_freqs, ch_adj)
    rng = np.random.default_rng(int(signature[8:16], 16))
    with py_warnings.catch_warnings():
        # F-тест односторонний: MNE ругается на tail=0 при каждом вызове.
        py_warnings.filterwarnings("ignore", message="Ignoring argument.*tail")
        _, clusters, p_values, _ = permutation_cluster_test(
            [flat_a, flat_b],
            n_permutations=cfg.compare_n_permutations,
            adjacency=adjacency,
            out_type="mask",
            rng=rng,
        )
    if len(clusters) == 0:
        return _empty_stats(cfg)

    # Маска (n_freq*n_ch,) → (n_freq, n_ch): частоты — строки, каналы — столбцы.
    delta_grid = delta_matrix.T  # (n_freq, n_ch)
    entries: list[dict[str, Any]] = []
    for mask, p_value in zip(clusters, p_values, strict=True):
        grid = np.asarray(mask, dtype=bool).reshape(n_freqs, len(stat_channels))
        freq_hits = np.where(grid.any(axis=1))[0]
        ch_hits = np.where(grid.any(axis=0))[0]
        if freq_hits.size == 0 or ch_hits.size == 0:
            continue
        mean_delta = float(delta_grid[grid].mean())
        entries.append({
            "p_value": float(p_value),
            "significant": bool(p_value < cfg.compare_alpha),
            "channels": [stat_channels[i] for i in ch_hits],
            "freq_min_hz": float(pair.freqs[freq_hits[0]]),
            "freq_max_hz": float(pair.freqs[freq_hits[-1]]),
            "n_points": int(grid.sum()),
            "mean_delta_db": mean_delta,
            "direction": "B>A" if mean_delta >= 0 else "A>B",
        })

    entries.sort(key=lambda item: item["p_value"])
    n_significant = sum(1 for item in entries if item["significant"])
    shown = [item for item in entries if item["significant"]]
    if not shown and entries:
        # Различий нет — показываем самый вероятный кластер с честным флагом.
        shown = [entries[0]]
    return {
        "method": "permutation_cluster_test",
        "n_permutations": cfg.compare_n_permutations,
        "alpha": cfg.compare_alpha,
        "n_clusters": len(entries),
        "n_significant": n_significant,
        "clusters": shown[:100],
    }, []


def clear_compare_cache(cfg: Settings, recording_id: str | None = None) -> None:
    """Удаляет дисковый кэш карт разности: один участник пары или весь.

    Путь вложен по **первой** записи (``compare/{id_A}/…``), поэтому удаление A
    сносит её подкаталог целиком; для B — второй уровень. Пустой ``recording_id``
    чистит весь кэш (тесты).
    """
    if recording_id is None:
        cache_clear(cfg.cache_dir, "compare")
        return
    cache_clear(cfg.cache_dir, "compare", recording_id)
    root = cache_path(cfg.cache_dir, "compare")
    if not os.path.isdir(root):
        return
    for name in os.listdir(root):  # второй уровень: B-участник внутри каталога A
        if os.path.isdir(os.path.join(root, name)):
            cache_clear(cfg.cache_dir, "compare", name, recording_id)


def compare_topomap_path(
    cfg: Settings, recording_id_a: str, signature: str, band: str,
) -> str:
    """Путь карты разности в дисковом кэше."""
    return cache_path(cfg.cache_dir, "compare", recording_id_a, signature, f"{band}.png")


def compare_topomap_url(cfg: Settings, band: str, recording_a: Recording,
                        recording_b: Recording, params: CompareParams) -> str:
    """URL карты разности: параметры — в query (нужны для ленивого пересчёта).

    Пустые значения («без фильтра», «без notch») в query не попадают: FastAPI
    разобрал бы ``band_min=`` как ошибку валидации. Версия ``v`` добавляется
    клиентом (``&v=``), как у карт спектра.
    """
    spec = params.spectrum
    pairs = {
        "recording_id_a": recording_a.recording_id,
        "recording_id_b": recording_b.recording_id,
        "band_min": spec.filter_band[0] if spec.filter_band else "",
        "band_max": spec.filter_band[1] if spec.filter_band else "",
        "notch_hz": spec.notch_hz if spec.notch_hz is not None else "",
        "epoch_length_ms": spec.epoch_length_ms,
        "psd_method": spec.psd_method,
        "reference": spec.reference,
        "reference_channels": ",".join(spec.reference_channels or []),
    }
    query = urlencode({key: value for key, value in pairs.items() if value != ""})
    return f"{cfg.api_prefix}/compare/topomap/{band}.png?{query}"


def _delta_topomap_png(
    pair: PairPsd, sum_a: SideSummary, sum_b: SideSummary,
    cfg: Settings, band: str,
) -> bytes | None:
    """PNG карты разности одной полосы: дельты дБ по каналам, шкала (−m, m).

    ``None`` — дельт меньше трёх (топокарта из двух точек не рисуется).
    """
    values: dict[str, float] = {}
    for channel in pair.channels:
        power_a = sum_a.channel_powers.get(band, {}).get(channel)
        power_b = sum_b.channel_powers.get(band, {}).get(channel)
        delta = _delta_db(power_a, power_b)
        if delta is not None:
            values[channel] = delta
    if len(values) < 3:
        return None
    positions = channel_positions(list(values))
    if len(positions) < 3:
        return None
    m = max(abs(value) for value in values.values()) or 1.0
    return topomap_png(
        positions, values, cmap="RdBu_r", vlim=(-float(m), float(m)),
    )


def run_compare(
    recording_a: Recording,
    recording_b: Recording,
    cfg: Settings,
    params: CompareParams,
    progress: Any = None,
) -> dict[str, Any]:
    """Дифференциальный анализ пары записей → dict под ``CompareResult``.

    Этапы: чтение обеих записей → PSD-кубы → агрегаты сторон → дельты по
    полосам (Welch/FDR/бутстрап) → кластерный тест MNE → карты разности в кэш.
    Прогресс сообщается теми же ключами этапов, что и у спектра (UI-подписи из
    ``STAGE_TITLES``).
    """
    report = progress or (lambda *args, **kwargs: None)
    started = time.perf_counter()

    report("load_edf", 0.1, message="Чтение пары записей и PSD обеих сторон")
    pair = _pair_psd(recording_a, recording_b, cfg, params)
    channels = pair.channels

    report("spectrum", 0.35, message="Агрегаты сторон и дельты по полосам")
    sum_a = _side_summary(pair, pair.psd_a, cfg)
    sum_b = _side_summary(pair, pair.psd_b, cfg)
    # Подпись — от метаданных (см. _pair_channels): совпадает с ленивым
    # пересчётом топокарты, поэтому URL из результата всегда попадает в кэш.
    signature = compare_signature(
        params, cfg, _pair_channels(recording_a, recording_b), recording_a, recording_b,
    )
    band_rows = _band_rows(pair, sum_a, sum_b, cfg, signature)

    report("stats", 0.6, message="Кластерный тест MNE (пермутации)")
    stats, stats_warnings = _cluster_stats(pair, cfg, signature)

    # Карты разности: рисуем один раз при задаче, кладём в кэш под signature.
    report("topomaps", 0.8, message="Карты разности B−A")
    for row in band_rows:
        png = _delta_topomap_png(pair, sum_a, sum_b, cfg, row["name"])
        if png is None:
            continue
        path = compare_topomap_path(cfg, recording_a.recording_id, signature, row["name"])
        if cache_write(path, png, label="Кэш карт разности"):
            row["topomap_delta_url"] = compare_topomap_url(
                cfg, row["name"], recording_a, recording_b, params,
            )

    warnings_out = [*pair.warnings, *stats_warnings]
    if sum_a.specparam_warnings:
        warnings_out.extend(f"A: {item}" for item in sum_a.specparam_warnings)
    if sum_b.specparam_warnings:
        warnings_out.extend(f"B: {item}" for item in sum_b.specparam_warnings)

    def _delta_or_none(left: float | None, right: float | None) -> float | None:
        if left is None or right is None:
            return None
        return float(right - left)

    spec_a, spec_b = sum_a.specparam, sum_b.specparam
    result: dict[str, Any] = {
        "signature": signature,
        "side_a": {
            "recording_id": recording_a.recording_id,
            "filename": recording_a.filename,
            "label": params.label_a,
            "n_epochs": pair.n_epochs_a,
            "n_channels": len(channels),
        },
        "side_b": {
            "recording_id": recording_b.recording_id,
            "filename": recording_b.filename,
            "label": params.label_b,
            "n_epochs": pair.n_epochs_b,
            "n_channels": len(channels),
        },
        "match": {
            "sfreq": pair.sfreq,
            "filter_band_hz": (
                list(params.spectrum.filter_band) if params.spectrum.filter_band else None
            ),
            "notch_hz": params.spectrum.notch_hz,
            "epoch_length_ms": params.spectrum.epoch_length_ms,
            "psd_method": params.spectrum.psd_method,
            "reference": params.spectrum.reference,
            "channels": channels,
            "channels_only_a": pair.channels_only_a,
            "channels_only_b": pair.channels_only_b,
        },
        "freqs": [float(value) for value in pair.freqs],
        "psd_mean_a_uv2": [float(value) for value in sum_a.curve],
        "psd_mean_b_uv2": [float(value) for value in sum_b.curve],
        "psd_delta_db": [
            float(10.0 * np.log10(max(b, _PSD_FLOOR_UV2) / max(a, _PSD_FLOOR_UV2)))
            for a, b in zip(sum_a.curve, sum_b.curve, strict=True)
        ],
        "bands": band_rows,
        "indices": {
            "iaf_a_hz": sum_a.iaf_hz,
            "iaf_b_hz": sum_b.iaf_hz,
            "delta_iaf_hz": _delta_or_none(sum_a.iaf_hz, sum_b.iaf_hz),
            "theta_beta_a": sum_a.theta_beta,
            "theta_beta_b": sum_b.theta_beta,
            "delta_theta_beta": _delta_or_none(sum_a.theta_beta, sum_b.theta_beta),
            "theta_alpha_beta_a": sum_a.theta_alpha_beta,
            "theta_alpha_beta_b": sum_b.theta_alpha_beta,
            "delta_theta_alpha_beta": _delta_or_none(
                sum_a.theta_alpha_beta, sum_b.theta_alpha_beta
            ),
        },
        "specparam": {
            "exponent_a": spec_a.get("aperiodic_exponent"),
            "exponent_b": spec_b.get("aperiodic_exponent"),
            "delta_exponent": _delta_or_none(
                spec_a.get("aperiodic_exponent"), spec_b.get("aperiodic_exponent")
            ),
            "offset_a": spec_a.get("aperiodic_offset"),
            "offset_b": spec_b.get("aperiodic_offset"),
            "delta_offset": _delta_or_none(
                spec_a.get("aperiodic_offset"), spec_b.get("aperiodic_offset")
            ),
            "fit_r_squared_a": spec_a.get("fit_r_squared"),
            "fit_r_squared_b": spec_b.get("fit_r_squared"),
            "peaks_a": list(spec_a.get("peaks") or []),
            "peaks_b": list(spec_b.get("peaks") or []),
        },
        "stats": stats,
        "topomap_version": signature,
        "notes": list(COMPARE_NOTES),
        "warnings": warnings_out,
        "duration_sec_calc": round(time.perf_counter() - started, 3),
    }
    report(
        "done", 1.0,
        message=(
            f"Сравнение готово: {len(channels)} каналов, "
            f"значимых кластеров {stats['n_significant']}/{stats['n_clusters']}"
        ),
        epochs_done=pair.n_epochs_a + pair.n_epochs_b,
        epochs_total=pair.n_epochs_a + pair.n_epochs_b,
    )
    return result


def cached_compare_topomap(
    recording_a: Recording,
    recording_b: Recording,
    cfg: Settings,
    params: CompareParams,
    band: str,
) -> tuple[bytes, str]:
    """PNG карты разности + ETag; при промахе кэша картинка строится заново.

    Ленивый пересчёт — тот же принцип, что у ``cached_topomap`` спектра:
    после перезапуска сервера ссылка из уже показанного результата не должна
    отвечать 404. Подпись берётся из каналов, доступных в реестре (метаданные
    обеих записей), поэтому ключ кэша не зависит от чтения EDF.
    """
    if band not in cfg.freq_bands:
        raise CompareError(f"Неизвестный диапазон: {band!r}")
    channels = _pair_channels(recording_a, recording_b)
    signature = compare_signature(params, cfg, channels, recording_a, recording_b)
    path = compare_topomap_path(cfg, recording_a.recording_id, signature, band)
    started = time.perf_counter()
    try:
        with open(path, "rb") as fh:
            data = fh.read()
        cache_hit = True
    except OSError:
        data = b""
        cache_hit = False
    if not cache_hit:
        # Промах: полный расчёт пары (кэш prepared_raw делает повтор дешёвым).
        pair = _pair_psd(recording_a, recording_b, cfg, params)
        sum_a = _side_summary(pair, pair.psd_a, cfg)
        sum_b = _side_summary(pair, pair.psd_b, cfg)
        png = _delta_topomap_png(pair, sum_a, sum_b, cfg, band)
        if png is None:
            raise CompareError(
                f"Карта разности {band} не построена: меньше трёх каналов с дельтами"
            )
        cache_write(path, png, label="Кэш карт разности")
        data = png
    journal.record(
        "compare", "topomap_read",
        ms=(time.perf_counter() - started) * 1000.0,
        params_key=signature, bytes_out=len(data), cache_hit=cache_hit,
        note=f"band={band}",
    )
    return data, f"{signature}-{band}"








