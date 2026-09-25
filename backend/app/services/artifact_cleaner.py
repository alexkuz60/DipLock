"""Очистка сигнала MNE-only: гармоники notch, bad-каналы, ICA-apply, SSP (этап 4).

Базовое удаление артефактов без новых зависимостей (asrpy/autoreject/
mne-icalabel — вне скоупа, N12/N13). Золотой порядок (PDF «Артефакты ЭЭГ»):

1. гармоники сетевого фильтра (notch 50/60 → 100/150/200 Гц);
2. пометка bad-каналов (список пользователя);
3. **интерполяция bad-каналов — до ICA/SSP** (PDF: «используйте интерполяцию
   после поиска плохих каналов и до ICA/SSP»);
4. ICA с ``ica.apply`` (удаление EOG/ECG-компонент) ли SSP (EOG-проекторы).

EOG-компоненты ищутся по EOG-каналам записи, а если их нет (`load_edf` оставляет
только каналы 10-20 — N8) — по фронтальному прокси Fp1/Fp2
(``find_eog_component_inds``). Фитинг идёт на high-pass-копии 1 Гц, ``ica.apply``
— на исходном сигнале (``fit_ica``). Теми же хелперами пользуется детекция
артефактов (ветка ``run_ica`` стадии ``artifacts``).

Шаг живёт в кэше подготовленного сигнала (``prepared_signal``, ключ A4/N5
включает ``CleanSpec``): стадии `artifacts`/`epochs` с теми же параметрами
получают уже очищенный сигнал. Отчёт «до/после» — одно число амплитуды
(p95 |x| по монтажу, мкВ) плюс что именно сделано: UI показывает его в
результате стадии `filter`.
"""
import logging
from dataclasses import dataclass, field
from typing import Any

import mne
import numpy as np
from numpy.typing import NDArray

from app.core.config import Settings
from app.services.filter_design import band_filter_kwargs, harmonic_frequencies

logger = logging.getLogger(__name__)

# Допустимые методы артефактуальной очистки (`CleanSpec.method`)
CLEAN_METHODS: tuple[str, ...] = ("none", "ica", "ssp")

# Порог корреляции источника ICA с прокси ЭКГ, с которой компонента считается
# артефактной (для EOG MNE сам считает порог `find_bads_eog`)
_ECG_CORR_THRESHOLD = 0.35

# Фронтальный прокси EOG для `find_bads_eog`, когда в записи нет EOG-каналов
# (N8): глазодвигательный потенциал лучше всего выражен на Fp1/Fp2/FPz — тот же
# приём, что у детектора `ocular` (artifact_detector._FRONTAL).
FRONTAL_PROXY: tuple[str, ...] = ("FP1", "FP2", "FPZ")

# Порог корреляции источника ICA с фронтальным прокси для прокси-фолбэка
# `find_bads_eog`. Дефолтный z-score MNE (3.0) при малом числе компонент
# не срабатывает даже на корреляции −0.999 (z ≈ 2.1 на 6 компонентах — замер
# 24.09.2026), поэтому прокси-путь идёт явной корреляцией; для нативных
# EOG-каналов порог MNE остаётся дефолтным.
_PROXY_CORR_THRESHOLD = 0.5


@dataclass(frozen=True)
class CleanSpec:
    """Параметры очистки: часть ключа кэша подготовленного сигнала (N5).

    ``bad_channels`` — кортеж (хешируем), ``method`` — из ``CLEAN_METHODS``,
    ``ica_n_components=0`` означает «auto» (MNE выберет сам).
    """

    notch_harmonics: int = 0
    bad_channels: tuple[str, ...] = ()
    interpolate_bads: bool = False
    method: str = "none"
    ica_n_components: int = 0

    def label(self) -> str:
        """Человекочитаемое описание для журнала/логов."""
        parts: list[str] = []
        if self.notch_harmonics:
            parts.append(f"гармоник notch={self.notch_harmonics}")
        if self.bad_channels:
            parts.append(f"bad={','.join(self.bad_channels)}")
        if self.interpolate_bads:
            parts.append("интерполяция bad")
        if self.method != "none":
            parts.append(f"очистка={self.method}")
        return ", ".join(parts) or "без очистки"


@dataclass
class CleanReport:
    """Отчёт очистки «что сделано и до/после» (одно число амплитуды, L5-lite)."""

    method: str = "none"
    notch_harmonics: int = 0
    interpolated_channels: list[str] = field(default_factory=list)
    n_components_removed: int = 0
    removed_components: list[int] = field(default_factory=list)
    n_projectors: int = 0
    amplitude_p95_uv_before: float | None = None
    amplitude_p95_uv_after: float | None = None
    warnings: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        """Словарь для результата стадии (его валидирует `CleanReportOut`)."""
        return {
            "method": self.method,
            "notch_harmonics": self.notch_harmonics,
            "interpolated_channels": list(self.interpolated_channels),
            "n_components_removed": self.n_components_removed,
            "removed_components": list(self.removed_components),
            "n_projectors": self.n_projectors,
            "amplitude_p95_uv_before": self.amplitude_p95_uv_before,
            "amplitude_p95_uv_after": self.amplitude_p95_uv_after,
            "warnings": list(self.warnings),
        }


def amplitude_p95_uv(data: NDArray) -> float | None:
    """95-й перцентиль |x| по монтажу, мкВ — одно число «насколько буйный сигнал»."""
    finite = np.abs(data[np.isfinite(data)])
    if finite.size == 0:
        return None
    return round(float(np.percentile(finite, 95)) * 1e6, 2)


def _ecg_proxy(data: NDArray, names: list[str], sfreq: float) -> NDArray | None:
    """Прокси ЭКГ из височных отведений (QRS 5–20 Гц, огибающая)."""
    from scipy.signal import butter, filtfilt

    idx = [i for i, ch in enumerate(names) if ch.upper() in ("T7", "T8", "T3", "T4")]
    if not idx or sfreq <= 50.0:
        return None
    x = np.nan_to_num(data[idx]).mean(axis=0)
    nyq = sfreq / 2.0
    b, a = butter(2, [5.0 / nyq, 20.0 / nyq], btype="band")
    return np.abs(filtfilt(b, a, x))


def apply_cleaning(
    raw: mne.io.BaseRaw,
    spec: CleanSpec,
    settings: Settings,
    notch_hz: float | None = None,
) -> CleanReport:
    """Применяет очистку к raw **на месте** (копией владеет `prepared_signal`) и возвращает отчёт.

    ``settings`` резервируется под порогами будущих шагов (AGENTS.md: пороги —
    из конфига); сейчас очистка параметризуется только ``CleanSpec``. Порядок
    шагов зафиксирован в докстринге модуля (PDF: интерполяция bad-каналов — до
    ICA/SSP).
    """
    del settings  # пороги шагов появятся здесь же (DRY с core/config.py)
    report = CleanReport(method=spec.method)
    report.amplitude_p95_uv_before = amplitude_p95_uv(raw.get_data())

    # 1. Гармоники сетевого фильтра (50 → 100/150/200 Гц, N13)
    if spec.notch_harmonics > 0 and notch_hz:
        freqs = harmonic_frequencies(
            notch_hz, spec.notch_harmonics, float(raw.info["sfreq"]),
        )
        if freqs:
            try:
                raw.notch_filter(freqs, verbose=False)
                report.notch_harmonics = len(freqs)
            except Exception as exc:
                report.warnings.append(f"Гармоники notch не применились: {exc}")

    # 2–3. Bad-каналы: пометка и интерполяция (до ICA/SSP — по PDF)
    known = set(raw.ch_names)
    missing = [ch for ch in spec.bad_channels if ch not in known]
    if missing:
        report.warnings.append(f"Каналов нет в монтаже: {', '.join(missing)}")
    bads = [ch for ch in spec.bad_channels if ch in known]
    if bads:
        # Объединение, а не перетирание: bads из загрузки (мёртвые электроды
        # до референса, `edf_loader`) не должны теряться при пометке формы —
        # интерполяция чинит оба списка.
        raw.info["bads"] = sorted(set(bads) | set(raw.info["bads"]))
    if spec.interpolate_bads and bads:
        try:
            raw.interpolate_bads(reset_bads=True, verbose=False)
            report.interpolated_channels = list(bads)
        except Exception as exc:
            report.warnings.append(f"Интерполяция bad-каналов не удалась: {exc}")

    # 4. Артефактуальная подчистка: ICA (ica.apply) либо SSP (проекторы EOG)
    if spec.method == "ica":
        _clean_ica(raw, spec, report)
    elif spec.method == "ssp":
        _clean_ssp(raw, report)

    report.amplitude_p95_uv_after = amplitude_p95_uv(raw.get_data())
    return report


def fit_ica(raw: mne.io.BaseRaw, n_components: int) -> mne.preprocessing.ICA:
    """Фитинг ICA (fastica) на high-pass-копии — качество разложения (N8).

    MNE требует для ICA high-pass ~1 Гц (иначе дрейф маскирует разложение), но
    фильтровать исходный сигнал нельзя — он идёт во вьюер и расчёты. Поэтому
    фит идёт на копии ``raw.copy().filter(1.0, None)``, а ``ica.apply`` вызывает
    на исходном raw (стандартный рецепт MNE: fit — filtered, apply — original).
    """
    fit_raw = (
        raw
        if raw.info["highpass"] >= 1.0
        else raw.copy().filter(
            1.0, None, verbose=False,
            **band_filter_kwargs(1.0, None, float(raw.info["sfreq"])),
        )
    )
    ica = mne.preprocessing.ICA(n_components=n_components, rng=42, max_iter="auto")
    ica.fit(fit_raw, verbose=False)
    return ica


def find_eog_component_inds(
    ica: mne.preprocessing.ICA, raw: mne.io.BaseRaw,
) -> tuple[list[int], str]:
    """Индексы EOG-компонент ICA и источник признака (``"eog"``/``"proxy"``).

    Нативный путь — EOG-каналы записи; их нет (N8: ``load_edf`` оставляет только
    каналы 10-20) — берётся фронтальный прокси ``FRONTAL_PROXY``. Ни того, ни
    другого — ``RuntimeError`` с понятным текстом: вызывающий код переводит его
    в предупреждение, а не в падение задачи.
    """
    try:
        inds, _ = ica.find_bads_eog(raw, verbose=False)
        return list(inds), "eog"
    except RuntimeError:
        proxy = [ch for ch in raw.ch_names if ch.upper() in FRONTAL_PROXY]
        if not proxy:
            raise RuntimeError(
                "нет EOG-каналов и фронтальных прокси (Fp1/Fp2) — EOG-компоненты не ищутся"
            ) from None
        inds, _ = ica.find_bads_eog(
            raw, ch_name=proxy,
            measure="correlation", threshold=_PROXY_CORR_THRESHOLD,
            verbose=False,
        )
        return list(inds), "proxy"


def _clean_ica(raw: mne.io.BaseRaw, spec: CleanSpec, report: CleanReport) -> None:
    """ICA + ``ica.apply``: удаляет EOG- и ЭКГ-подобные компоненты (MNE-only).

    EOG-компоненты ищутся по EOG-каналам либо фронтальному прокси Fp1/Fp2
    (``find_eog_component_inds``). Отчёт обязан содержать число и индексы
    удалённых компонент — это единственная видимая пользователю «цена» ICA-очистки
    (задача 2026-09: «реализовать ica.apply с отчётом»).
    """
    n_components = spec.ica_n_components or min(15, len(raw.ch_names) - 1)
    try:
        ica = fit_ica(raw, n_components)
        try:
            eog_inds, _ = find_eog_component_inds(ica, raw)
        except Exception as exc:
            report.warnings.append(f"EOG-компоненты не найдены: {exc}")
            eog_inds = []
        exclude = sorted({*eog_inds, *_ica_ecg_inds(ica, raw)})
        if exclude:
            ica.exclude = exclude
            ica.apply(raw, verbose=False)
        report.n_components_removed = len(exclude)
        report.removed_components = exclude
    except Exception as exc:
        report.warnings.append(f"ICA-очистка не применилась: {exc}")


def _ica_ecg_inds(ica: mne.preprocessing.ICA, raw: mne.io.BaseRaw) -> list[int]:
    """Компоненты ICA, коррелирующие с QRS-прокси (T7/T8), — ЭКГ-наводка."""
    proxy = _ecg_proxy(raw.get_data(), list(raw.ch_names), float(raw.info["sfreq"]))
    if proxy is None:
        return []
    sources = ica.get_sources(raw).get_data()
    inds: list[int] = []
    for i in range(sources.shape[0]):
        src = sources[i]
        if float(np.std(src)) == 0.0:
            continue
        corr = float(np.corrcoef(src, proxy)[0, 1])
        if np.isfinite(corr) and abs(corr) >= _ECG_CORR_THRESHOLD:
            inds.append(i)
    return inds


def _clean_ssp(raw: mne.io.BaseRaw, report: CleanReport) -> None:
    """SSP: EOG-проекторы MNE (``compute_proj_eog``). Экспериментально — UI предупреждает.

    SSP агрессивнее ICA и необратим (проектор режет подпространство целиком),
    поэтому в интерфейсе метод помечен предупреждением: по умолчанию стоит
    ``none``, а не ``ssp``.
    """
    try:
        result = mne.preprocessing.compute_proj_eog(
            raw, n_grad=0, n_mag=0, n_eeg=2, average=True, no_proj=True, verbose=False,
        )
    except Exception as exc:
        report.warnings.append(f"SSP-проекторы не построились: {exc}")
        return
    projs = list(result[0]) if isinstance(result, tuple) else list(result)
    if not projs:
        report.warnings.append("SSP: EOG-события не найдены — проекторы не построены")
        return
    raw.add_proj(projs, verbose=False)
    raw.apply_proj(verbose=False)
    report.n_projectors = len(projs)