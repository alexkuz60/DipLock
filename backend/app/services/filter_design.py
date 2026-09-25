"""Дизайн полосового фильтра: метод FIR/IIR, переходные полосы, буфер края, АЧХ (2.5).

Единая точка правды для всех мест, где сигнал фильтруется по полосе
(``edf_loader.load_edf``, ``bandpass_filter.apply_band_filter``) и для нарезки
эпох, которая отбрасывает края записи. Находки N11–N14 (``audit_strategy.md`` §5):

* **N11** — ``fir_design="firwin"`` не передаётся нигде (дефолт MNE ≥ 1.7),
  а переходные полосы заданы **явным числом** по формуле MNE ``"auto"``
  (``transition_bandwidths``); дрейф-тест ``tests/test_filter_design.py``
  сверяет тапы с ``create_filter(..., auto)`` — смена дефолтов MNE не пройдёт
  молча.
* **Узкая полоса → IIR** (kimi3): ``resolve_filter_method`` выбирает IIR
  Butterworth (дефолт MNE: ``order=4``, ``sos``, zero-phase filtfilt), когда
  ширина полосы ≤ ``Settings.filter_iir_max_width_hz``. У 7.83 ± 0.25 Гц
  FIR-ядро (переходная полоса ≥ 2 Гц, ядро 1.65 с) полосу честно не выделяет
  — IIR делает это коротким ядром без ложного обещания точности.
* **N12** — ``edge_buffer_sec`` = половина длины FIR-ядра: столько сигнала у
  каждого края записи занимает переходный процесс zero-phase фильтра.
  ``segment_epochs`` помечает эти интервалы аннотацией ``BAD_edge`` — эпохи
  у краёв отбрасываются честно (причина видна в покрытии и в штриховке UI).
* **N13** — ``harmonic_frequencies`` — гармоники сети для notch (та же логика
  в очистке ``artifact_cleaner``); ``filter_response`` включает в АЧХ и
  основную частоту, и гармоники.
* **АЧХ** — ``filter_response`` гоняет единичный импульс через **тот же**
  конвейер (``raw.filter`` + ``raw.notch_filter``), поэтому кривая показывает
  ровно то, что получает расчёт: 0 дБ в полосе пропускания, провалы notch.

Фильтрация — по-прежнему по continuous raw до нарезки (правило
``docs/rules/safety.md``): метод и переходные полосы применяются одинаково во
всех вызывающих, поэтому ключ кэша подготовленного сигнала (полоса + notch +
референс) остаётся достаточным — метод детерминированно выводится из полосы.
"""
import math
from dataclasses import dataclass
from functools import lru_cache
from typing import Any

import mne
import numpy as np

from app.core.config import Settings, settings


def resolve_filter_method(
    l_freq: float | None,
    h_freq: float | None,
    cfg: Settings | None = None,
) -> str:
    """Метод полосового фильтра: ``none`` | ``fir`` | ``iir``.

    IIR (Butterworth zero-phase, дефолт MNE) берётся для узких полос:
    ширина ``h - l`` ≤ ``Settings.filter_iir_max_width_hz`` (по умолчанию
    1 Гц — покрывает «одиночную частоту» 7.83 ± 0.25 Гц). Односторонняя
    полоса (только high-pass или только low-pass) — всегда FIR: ширины у неё
    нет, а «узкая односторонняя» в формах не представлена.
    """
    if l_freq is None and h_freq is None:
        return "none"
    if l_freq is None or h_freq is None:
        return "fir"
    width = h_freq - l_freq
    limit = (cfg or settings).filter_iir_max_width_hz
    return "iir" if 0 < width <= limit else "fir"


def transition_bandwidths(
    l_freq: float | None,
    h_freq: float | None,
    sfreq: float,
) -> tuple[float | None, float | None]:
    """Явные переходные полосы (Гц) — та же формула, что у MNE ``"auto"``.

    MNE 1.13 (``mne/filter.py``, ``_triage_filter_params``)::

        l_trans = min(max(0.25 * l_freq, 2.0), l_freq)
        h_trans = min(max(0.25 * h_freq, 2.0), sfreq / 2 - h_freq)

    Копия формулы — осознанная цена N11 («переходные полосы явными»):
    числа фиксируются в вызове, а дрейф-тест гарантирует совпадение с MNE
    на текущей версии (см. докстринг модуля). Отрицательный ``h_trans``
    (частота выше Nyquist) не зажимается: MNE и с ``"auto"``, и с явным
    числом поднимает понятную ошибку.
    """
    l_trans = None
    if l_freq is not None:
        l_trans = float(min(max(0.25 * l_freq, 2.0), l_freq))
    h_trans = None
    if h_freq is not None:
        h_trans = float(min(max(0.25 * h_freq, 2.0), sfreq / 2.0 - h_freq))
    return l_trans, h_trans


@dataclass(frozen=True)
class FilterDesign:
    """Сводка дизайна фильтра: метод, переходные полосы, ядро и буфер края.

    ``filter_length_sec`` — длина FIR-ядра в секундах (``None`` для IIR и
    «без фильтра»); ``edge_buffer_sec`` — буфер краёв записи: половина ядра
    (zero-phase фильтр искажает край на половину длины), ``0`` для IIR — у
    короткого IIR-ядра переходный процесс пренебрежимо мал.
    """

    method: str  # none | fir | iir
    l_trans_bandwidth: float | None = None
    h_trans_bandwidth: float | None = None
    filter_length_sec: float | None = None
    edge_buffer_sec: float = 0.0


@lru_cache(maxsize=64)
def _fir_length_sec(
    l_freq: float | None,
    h_freq: float | None,
    sfreq: float,
    l_trans: float | None,
    h_trans: float | None,
) -> float:
    """Длина FIR-ядра (с) через ``mne.filter.create_filter``; кэш по параметрам."""
    kwargs: dict[str, Any] = {}
    if l_trans is not None:
        kwargs["l_trans_bandwidth"] = l_trans
    if h_trans is not None:
        kwargs["h_trans_bandwidth"] = h_trans
    taps = mne.filter.create_filter(None, sfreq, l_freq, h_freq, verbose=False, **kwargs)
    return len(taps) / float(sfreq)


def design_filter(
    l_freq: float | None,
    h_freq: float | None,
    sfreq: float,
    cfg: Settings | None = None,
) -> FilterDesign:
    """Дизайн полосового фильтра для границ полосы и частоты дискретизации."""
    method = resolve_filter_method(l_freq, h_freq, cfg)
    if method == "none":
        return FilterDesign(method="none")
    if method == "iir":
        return FilterDesign(method="iir")
    l_trans, h_trans = transition_bandwidths(l_freq, h_freq, sfreq)
    length = _fir_length_sec(l_freq, h_freq, float(sfreq), l_trans, h_trans)
    return FilterDesign(
        method="fir",
        l_trans_bandwidth=l_trans,
        h_trans_bandwidth=h_trans,
        filter_length_sec=length,
        edge_buffer_sec=length / 2.0,
    )


def band_filter_kwargs(
    l_freq: float | None,
    h_freq: float | None,
    sfreq: float,
    cfg: Settings | None = None,
) -> dict[str, Any]:
    """Единые аргументы ``raw.filter(...)`` для полосы (метод + переходные полосы).

    Для FIR — явные ``l_trans_bandwidth``/``h_trans_bandwidth`` (N11) без
    ``fir_design`` (дефолт MNE); для IIR — только ``method="iir"`` (переходные
    полосы в IIR-ветке MNE игнорирует). ``verbose`` добавляет вызывающий.
    """
    design = design_filter(l_freq, h_freq, sfreq, cfg)
    if design.method == "none":
        return {}
    if design.method == "iir":
        return {"method": "iir"}
    kwargs: dict[str, Any] = {}
    if design.l_trans_bandwidth is not None:
        kwargs["l_trans_bandwidth"] = design.l_trans_bandwidth
    if design.h_trans_bandwidth is not None:
        kwargs["h_trans_bandwidth"] = design.h_trans_bandwidth
    return kwargs


def harmonic_frequencies(
    notch_hz: float | None,
    count: int,
    sfreq: float,
) -> list[float]:
    """Гармоники сети выше основной частоты: 50 → ``[100, 150, 200, 240]``.

    Число гармоник — ``count`` (0…4, форма ``notch_harmonics``); частоты выше
    Nyquist − 1 Гц отбрасываются (на границе МНЧ notch нестабилен).
    """
    if not notch_hz or count <= 0:
        return []
    nyquist = float(sfreq) / 2.0
    return [notch_hz * k for k in range(2, 2 + count) if notch_hz * k < nyquist - 1.0]


def notch_frequencies(notch_hz: float | None, harmonics: int, sfreq: float) -> list[float]:
    """Все частоты notch: основная + гармоники (АЧХ и проверки)."""
    if not notch_hz:
        return []
    return [notch_hz, *harmonic_frequencies(notch_hz, harmonics, sfreq)]


@dataclass(frozen=True)
class FilterResponse:
    """АЧХ применяемого фильтра: сетка частот, усиление в дБ и метаданные."""

    freqs_hz: np.ndarray
    gain_db: np.ndarray
    design: FilterDesign
    notch_freqs: tuple[float, ...]
    band_hz: tuple[float, float] | None


def filter_response(
    l_freq: float | None = None,
    h_freq: float | None = None,
    notch_hz: float | None = None,
    notch_harmonics: int = 0,
    sfreq: float = 500.0,
    cfg: Settings | None = None,
) -> FilterResponse:
    """АЧХ полосового фильтра и notch: единичный импульс через живой конвейер.

    Считает ``|FFT(y)|`` на единичном импульсе после ``raw.filter`` +
    ``raw.notch_filter`` — ровно тех вызовов, что делает подготовка сигнала,
    поэтому кривая — фактический отклик, а не «приблизительно по формулам»
    (фильтр линейный: отклика на импульс достаточно). Вызывать в потоке
    (CPU-bound, ~10–50 мс).

    Целевая сетка: 0.05 Гц до 20 Гц (узкие полосы и обрез видны детально),
    0.5 Гц выше; интерполяция по спектру с шагом ≤ 0.01 Гц даёт погрешность,
    ничтожную относительно читаемости графика.
    """
    sfreq = float(sfreq)
    design = design_filter(l_freq, h_freq, sfreq, cfg)
    # Шаг FFT ≤ 0.01 Гц: узкая полоса 0.5 Гц должна попадать в десятки бинов.
    n_fft = 1 << max(10, math.ceil(math.log2(max(sfreq / 0.01, 1024))))

    impulse = np.zeros((1, n_fft))
    impulse[0, n_fft // 4] = 1.0  # не у края: паддинг filtfilt не мешает
    raw = mne.io.RawArray(impulse, mne.create_info(["ACHX"], sfreq, "eeg"), verbose=False)
    kwargs = band_filter_kwargs(l_freq, h_freq, sfreq, cfg)
    if kwargs:
        raw.filter(l_freq, h_freq, verbose=False, **kwargs)
    freqs = notch_frequencies(notch_hz, notch_harmonics, sfreq)
    if freqs:
        raw.notch_filter(freqs, verbose=False)

    spectrum = np.abs(np.fft.rfft(raw.get_data()[0]))
    fft_freqs = np.fft.rfftfreq(n_fft, 1.0 / sfreq)
    gain_db_full = 20.0 * np.log10(np.maximum(spectrum, 1e-12))

    nyquist = sfreq / 2.0
    target = np.unique(
        np.concatenate([
            np.arange(0.0, min(20.0, nyquist), 0.05),
            np.arange(20.0, nyquist, 0.5),
            [nyquist],
        ])
    )
    target = target[target <= nyquist + 1e-9]
    gain_db = np.interp(target, fft_freqs, gain_db_full)
    return FilterResponse(
        freqs_hz=np.round(target, 3),
        gain_db=np.round(gain_db, 2),
        design=design,
        notch_freqs=tuple(freqs),
        band_hz=(float(l_freq), float(h_freq))
        if l_freq is not None and h_freq is not None
        else None,
    )
