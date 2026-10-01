"""Очистка сигнала MNE-only: гармоники notch, bad-каналы, ICA-apply, SSP (этап 4).

Базовое удаление артефактов MNE + вторая разметка ICLabel (asrpy — вне скоупа,
autoreject — отклонён спайком 01.10.2026). Золотой порядок (PDF «Артефакты ЭЭГ»):

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

**Вторая разметка ICLabel** (вердикт владельца 01.10.2026: «внедрять как вторую
разметку»): после корреляционного пути компоненты дополнительно размечает ML-модель
ICLabel (``iclabel_second_opinion`` — метки + вероятности + рекомендация удалить
eye/heart), результат уходит в отчёт чистки. **Advisory**: ``ica.apply`` решает по
нашему пути (адресность, пороги, отчёт), ICLabel — второе мнение для пользователя;
считается на average-referenced копии (модель обучена на референсированных данных,
пачка B грузит ICA до референса) и **до** ``ica.apply`` — после удалённых
источников нет. Сбой модели — предупреждение в отчёте, чистка не страдает.

Шаг живёт в кэше подготовленного сигнала (``prepared_signal``, ключ A4/N5
включает ``CleanSpec``): стадии `artifacts`/`epochs` с теми же параметрами
получают уже очищенный сигнал. Отчёт «до/после» — одно число амплитуды
(p95 |x| по монтажу, мкВ) плюс что именно сделано: UI показывает его в
результате стадии `filter`.
"""
import logging
import warnings
from dataclasses import dataclass, field
from typing import Any, TypedDict

import mne
import numpy as np
from numpy.typing import NDArray

from app.core.config import Settings
from app.services.cardio import ecg_proxy
from app.services.clean_metrics import clean_loss, detect_clean_zones, zone_channels
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

# Вторая разметка ICA — ICLabel (вердикт 01.10.2026): классы модели, означающие
# артефакт (кандидаты на удаление); остальные классы (brain/muscle/line noise/
# channel noise/other) — не рекомендация снимать компонент.
_ICLABEL_ARTIFACT_LABELS: tuple[str, ...] = ("eye blink", "heart beat")

# Порог вероятности метки, с которого рекомендация ICLabel считается серьёзной
_ICLABEL_PROBA_THRESHOLD = 0.5


class _IclabelOpinion(TypedDict):
    """Результат ``iclabel_second_opinion``: метки, вероятности, рекомендация."""

    labels: list[str]
    probabilities: list[float]
    recommended: list[int]


@dataclass(frozen=True)
class CleanSpec:
    """Параметры очистки: часть ключа кэша подготовленного сигнала (N5).

    ``bad_channels`` — кортеж (хешируем), ``method`` — из ``CLEAN_METHODS``,
    ``ica_n_components=0`` означает «auto» (MNE выберет сам).

    ``exclude_zone_ids`` — отменённые зоны вклада чистки (шаг 2 плана): id
    серверные (``clean-1``, …), входят в ключ кэша — сигнал с отменами это
    **другой** сигнал, и слои ``cleaned``/``diff`` обязаны честно различаться.
    Семантика: чистка применяется как раньше, затем в исключённых зонах
    сэмплы восстанавливаются из сырого сигнала («чистка здесь не применена» —
    включая bad-каналы). Не undo-стек: единственный механизм — повторный
    запуск стадии с новым набором id.
    """

    notch_harmonics: int = 0
    bad_channels: tuple[str, ...] = ()
    interpolate_bads: bool = False
    method: str = "none"
    ica_n_components: int = 0
    exclude_zone_ids: tuple[str, ...] = ()

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
        if self.exclude_zone_ids:
            parts.append(f"отмены={','.join(self.exclude_zone_ids)}")
        return ", ".join(parts) or "без очистки"


@dataclass
class CleanReport:
    """Отчёт очистки «что сделано и до/после» (амплитуда + зоны + метрики)."""

    method: str = "none"
    notch_harmonics: int = 0
    interpolated_channels: list[str] = field(default_factory=list)
    n_components_removed: int = 0
    removed_components: list[int] = field(default_factory=list)
    n_projectors: int = 0
    amplitude_p95_uv_before: float | None = None
    amplitude_p95_uv_after: float | None = None
    warnings: list[str] = field(default_factory=list)
    # Зоны вклада чистки (шаг 2): dict'ы CleanZoneOut, id — clean-1…
    zones: list[dict[str, Any]] = field(default_factory=list)
    # Метрики потерь L1/L3/L4/L5 для текущей конфигурации (с отменами)
    loss: dict[str, Any] | None = None
    # Внутренности L5: оценка компонент ICA (не отдаётся наружу отдельно —
    # входит в loss.removed_variance_percent с подписью источника)
    removed_variance_percent: float | None = None
    removed_variance_source: str = "diff"
    # Вторая разметка ICA (ICLabel, вердикт 01.10.2026): advisory — на
    # решение ``ica.apply`` не влияет. ``None`` — не считалась (сбоя модели
    # в warnings)
    iclabel_labels: list[str] | None = None
    iclabel_probabilities: list[float] | None = None
    # Компоненты, которые ICLabel рекомендует удалить (eye/heart, proba ≥ 0.5)
    iclabel_recommended: list[int] = field(default_factory=list)

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
            "zones": [{k: v for k, v in zone.items() if not k.startswith("_")} for zone in self.zones],
            "loss": self.loss,
            "iclabel_labels": list(self.iclabel_labels) if self.iclabel_labels is not None else None,
            "iclabel_probabilities": (
                list(self.iclabel_probabilities)
                if self.iclabel_probabilities is not None
                else None
            ),
            "iclabel_recommended": list(self.iclabel_recommended),
        }


def amplitude_p95_uv(data: NDArray) -> float | None:
    """95-й перцентиль |x| по монтажу, мкВ — одно число «насколько буйный сигнал»."""
    finite = np.abs(data[np.isfinite(data)])
    if finite.size == 0:
        return None
    return round(float(np.percentile(finite, 95)) * 1e6, 2)


def apply_cleaning(
    raw: mne.io.BaseRaw,
    spec: CleanSpec,
    settings: Settings,
    notch_hz: float | None = None,
) -> CleanReport:
    """Применяет очистку к raw **на месте** (копией владеет `prepared_signal`) и возвращает отчёт.

    Порядок шагов зафиксирован в докстринге модуля (PDF: интерполяция
    bad-каналов — до ICA/SSP). Дальше — шаги среза 2 плана:

    1. копия сигнала «до» (нужна и зонам, и метрикам);
    2. чистка как раньше;
    3. **зоны вклада** считаются от полного вклада (до отмен) — id стабильны
       между пересчётами;
    4. в исключённых зонах (``spec.exclude_zone_ids``) сэмплы **восстанавливаются
       из сырого сигнала** — «чистка здесь не применена», включая bad-каналы;
    5. **метрики потерь** L1/L3/L4/L5 считаются для текущей конфигурации
       (после отмен): отменил зону — числа изменились.
    """
    report = CleanReport(method=spec.method)
    before = raw.get_data().copy()
    report.amplitude_p95_uv_before = amplitude_p95_uv(before)

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

    sfreq = float(raw.info["sfreq"]) or 1.0
    ch_names = list(raw.ch_names)
    # Шаг 2: зоны вклада — от **полного** вклада чистки (до отмен), чтобы id
    # clean-N не переставлялись при добавлении/снятии отмен.
    clean_after = raw.get_data()
    excluded = set(spec.exclude_zone_ids)
    known_ids: set[str] = set()
    report.zones = []
    for index, zone in enumerate(detect_clean_zones(before, clean_after, sfreq, settings), 1):
        start, end = zone.pop("_samples")
        zone_id = f"clean-{index}"
        known_ids.add(zone_id)
        report.zones.append({
            "id": zone_id,
            "onset_sec": zone["onset_sec"],
            "duration_sec": zone["duration_sec"],
            "channels": zone_channels(before, clean_after, start, end, ch_names),
            "amplitude_uv": zone["amplitude_uv"],
            "excluded": zone_id in excluded,
            "_samples": (start, end),
        })
    unknown = sorted(excluded - known_ids)
    if unknown:
        report.warnings.append(
            f"Отменённые зоны не найдены в этом пересчёте: {', '.join(unknown)} — "
            "снимите отмену или пересчитайте стадию заново"
        )
    for zone in report.zones:
        if not zone["excluded"]:
            continue
        start, end = zone["_samples"]
        # «Чистка здесь не применена» — включая bad-каналы: в зону возвращается
        # ровно тот сигнал, что был до чистки (семантика зафиксирована в
        # docs/rules/artifacts.md, шаг 2 плана).
        raw[:, start:end] = before[:, start:end]

    after = raw.get_data()
    report.amplitude_p95_uv_after = amplitude_p95_uv(after)
    # Шаг 2: метрики потерь для текущей конфигурации (с отменами)
    report.loss = clean_loss(
        before, after, sfreq, settings,
        notch_hz=notch_hz,
        notch_harmonics=spec.notch_harmonics,
        removed_variance_percent=report.removed_variance_percent,
        removed_variance_source=(
            "ica_components"
            if report.removed_variance_percent is not None
            else report.removed_variance_source
        ),
    )
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


def iclabel_second_opinion(
    raw: mne.io.BaseRaw, ica: mne.preprocessing.ICA,
) -> _IclabelOpinion:
    """Вторая разметка компонентов ICA — ICLabel (`mne-icalabel`), advisory.

    Возвращает ``{"labels", "probabilities", "recommended"}``: метку модели и
    её вероятность для каждого компонента плюс индексы, которые модель
    рекомендует удалить (классы eye/heart с ``proba >= 0.5``).

    Модель обучена на **average-referenced** данных 1–100 Гц, а в пайплайне ICA
    фитится и применяется до референса (пачка B) — разметка считается на копии raw
    с average reference и фильтром 1–100 Гц (спайк 01.10.2026: без референса метки
    расходятся, heart → brain). Рекомендация **не** участвует в ``ica.apply``: вторая
    разметка — второе мнение для пользователя (`docs/rules/artifacts.md`), а не
    замена корреляционного пути ``find_eog_component_inds``/QRS-прокси. Известное
    расхождение: ``fit_ica`` — fastica, а ICLabel обучен на extended infomax
    (предупреждение модели фильтруется, факт — в правиле).

    Вызывается до ``ica.apply`` (после удалённых источников модель считает
    вырожденные признаки). Любая ошибка (нет ``mne-icalabel``/``onnxruntime``,
    отказ модели) — кинет исключение: вызывающий превращает его в
    предупреждение отчёта, чистка не страдает.
    """
    from mne_icalabel import label_components

    labeled = raw.copy()
    # Прямо `set_eeg_reference` (та же строка, что в `apply_reference`): импорт
    # `edf_loader` сюда замкнул бы цикл (edf_loader → artifact_detector → этот
    # модуль)
    labeled.set_eeg_reference("average", projection=False)
    # Модель обучена на данных 1–100 Гц (mne-icalabel предупреждает без фильтра):
    # копию фильтруем под спецификацию — сигнал чистки не трогаем
    nyquist = float(raw.info["sfreq"]) / 2.0
    if nyquist > 1.0:
        labeled.filter(1.0, min(100.0, nyquist), verbose=False)
    with warnings.catch_warnings():
        # Документированное расхождение advisory-пути: fit_ica — fastica, а ICLabel
        # обучен на extended infomax (смена алгоритма чистки — отдельное решение
        # владельца; факт зафиксирован в docs/rules/artifacts.md)
        warnings.filterwarnings("ignore", message="The provided ICA instance")
        result = label_components(labeled, ica, method="iclabel")
    labels = [str(name) for name in result["labels"]]
    probabilities = [float(value) for value in result["y_pred_proba"]]
    recommended = [
        index
        for index, (name, proba) in enumerate(zip(labels, probabilities, strict=True))
        if name in _ICLABEL_ARTIFACT_LABELS and proba >= _ICLABEL_PROBA_THRESHOLD
    ]
    return _IclabelOpinion(
        labels=labels, probabilities=probabilities, recommended=recommended,
    )


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
        # Вторая разметка ICLabel (вердикт 01.10.2026): считается до ica.apply
        # (удалённых источников ещё нет) и не влияет на exclude — advisory
        try:
            opinion = iclabel_second_opinion(raw, ica)
            report.iclabel_labels = opinion["labels"]
            report.iclabel_probabilities = opinion["probabilities"]
            report.iclabel_recommended = opinion["recommended"]
        except Exception as exc:
            report.warnings.append(f"ICLabel (вторая разметка) не посчитался: {exc}")
        if exclude:
            ica.exclude = exclude
            # L5 (шаг 2): доля дисперсии удалённых компонент — считается на
            # источниках **до** apply (после apply удалённых источников нет);
            # если компоненты не удалены — метрика остаётся «diff» (см. шапку
            # clean_metrics: источник подписывается честно).
            try:
                sources_var = np.var(ica.get_sources(raw).get_data(), axis=1)
                total = float(sources_var.sum())
                if total > 0.0:
                    report.removed_variance_percent = (
                        100.0 * float(sources_var[exclude].sum()) / total
                    )
                    report.removed_variance_source = "ica_components"
            except Exception as exc:  # L5 вторична к самой очистке
                logger.debug("L5 (компоненты ICA) не посчиталась: %s", exc)
                # источник L5 останется «diff» — не повод ронять очистку
            ica.apply(raw, verbose=False)
        report.n_components_removed = len(exclude)
        report.removed_components = exclude
    except Exception as exc:
        report.warnings.append(f"ICA-очистка не применилась: {exc}")


def _ica_ecg_inds(ica: mne.preprocessing.ICA, raw: mne.io.BaseRaw) -> list[int]:
    """Компоненты ICA, коррелирующие с QRS-прокси (T7/T8), — ЭКГ-наводка.

    Прокси берётся из единого кардио-детектора (`services/cardio.py`) — того же,
    что строит зоны `ecg` и ряд ЧСС.
    """
    proxy = ecg_proxy(raw.get_data(), list(raw.ch_names), float(raw.info["sfreq"]))
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