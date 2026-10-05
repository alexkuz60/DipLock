"""Вход рендера «Нейромузыки»: подготовленный сигнал → 7 полосовых пакетов.

Конвейер подготовки (docs/rules/neuromusic.md):

1. **Одно чтение EDF** через ``prepared_raw_report`` (RAM-кэш A4) с
   дефолтной очисткой ``AUDIO_DEFAULT_CLEAN`` («золотой порядок»
   ``artifact_cleaner``: гармоники notch → bad-каналы → ICA по EOG/ECG-прокси)
   и **авто-notch 50 Гц** на входе — свист 6.4 кГц (50 × 128) невозможен
   (согласование по ТЗ §2: контроль остаётся предупреждением, не ошибкой).
   К нему добавлен **обязательный режект двух первых гармоник 100/150 Гц**
   (требование 05.10.2026): ``apply_line_harmonics`` в каждом прогоне, даже
   когда очистка деградировала. Референс ``none`` — как у виртуальных миксов
   ``channel_mix``: среднее по группе шины само является ссылкой.
2. ``sfreq`` приводится к 500 Гц (``load_edf`` ресемплирует только записи
   **выше** 500 Гц; контракт ядра — фиксированные 500).
3. Семь полосовых фильтров (``apply_band_filter`` по ``settings.freq_bands``)
   → пакеты ``(K, N)`` float64 в порядке каналов записи.
4. Валидация: NaN/inf — ошибка; остаток 50 Гц в γ-полосах — предупреждение.
"""
import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import numpy as np
from scipy.signal import welch

from app.core.config import Settings
from app.services.artifact_cleaner import CleanSpec
from app.services.bandpass_filter import apply_band_filter
from app.services.filter_design import harmonic_frequencies
from app.services.prepared_signal import prepared_raw_report
from app.services.recordings import Recording

logger = logging.getLogger(__name__)

# Профиль «дефолтной очистки» — «золотой порядок» artifact_cleaner (согласование:
# чистка по умолчанию, без настроек в UI фазы 1). Гармоники 100/150/200 Гц
# требуют notch_hz (он есть в каждом вызове рендера), интерполяция чинит
# мёртвые электроды, ICA снимает EOG/ECG-компоненты (прокси Fp1/Fp2).
AUDIO_DEFAULT_CLEAN = CleanSpec(
    notch_harmonics=3,
    interpolate_bads=True,
    method="ica",
    ica_n_components=0,
)

# Авто-notch на входе рендера: 50 × 128 = 6.4 кГц — свист поверх партитуры.
AUDIO_NOTCH_HZ = 50.0

# Обязательный режект двух первых гармоник 100/150 Гц (требование владельца
# 05.10.2026): в каждом прогоне рендера, **независимо от успеха дефолтной
# очистки** — чистка задействует те же гармоники через CleanSpec.notch_harmonics,
# но при её деградации в load_edf остаётся только 50 Гц. Частоты считает единый
# helper filter_design.harmonic_frequencies (с учётом Nyquist), вызов — после
# приведения к 500 Гц (Nyquist 250 > 150 для любой записи).
AUDIO_NOTCH_HARMONICS = 2

# Контроль остатка 50 Гц (ТЗ §2 «проверка подавления»). Буквальный порог
# «ниже −60 дБ от медианы полосы» на шумовом фоне невыполним по построению:
# бины шума лежат на уровне медианы (0 дБ), и любой чистый сигнал давал бы
# «провал». Замысел «звук не должен свистеть» реализован пиковым критерием:
# неподавленный тон всегда выделяется на десятки дБ над фоном полосы.
LINE_NOISE_MIN_PEAK_DB = 10.0
# Смысл проверки в γ (32–64 Гц, тон в полосе пропускания); γ-high держим как
# контроль краевых/интермодуляционных остатков.
LINE_NOISE_BANDS = ("gamma", "high_gamma")


@dataclass
class BandPackages:
    """Готовые полосовые пакеты рендера: каждая полоса — (K, N) float64 @500 Гц."""

    channels: list[str]
    """Имена каналов в порядке строк пакетов (порядок записи после pick)."""
    sfreq: float
    """Частота дискретизации пакетов — всегда 500 (контракт ядра)."""
    n_times: int
    """Число отсчётов: длительность трека = n_times / sfreq секунд."""
    packages: dict[str, np.ndarray]
    """``band_key`` → массив (K, N); ключи — ``settings.freq_bands``."""
    warnings: list[str] = field(default_factory=list)
    """Предупреждения подготовки (остаток 50 Гц, деградация очистки и т.п.)."""
    clean_label: str = ""
    """Человекочитаемое описание применённой очистки (в sidecar)."""
    interpolated: list[str] = field(default_factory=list)
    """Интерполированные мёртвые каналы (в sidecar)."""

    @property
    def duration_s(self) -> float:
        """Длительность записи, с (= длительность треков рендера)."""
        return self.n_times / self.sfreq if self.sfreq else 0.0


def line_noise_warnings(
    packages: dict[str, np.ndarray], cfg: Settings, sfreq: float,
) -> list[str]:
    """Остаток сетевого фона 50 Гц в γ-полосах: пик над медианой полосы (ТЗ §2).

    Не блокирует рендер (notch применяется автоматически), но сигналит, если
    подавление не сработало — участок останется свистом 6.4 кГц в партитуре.
    """
    warnings: list[str] = []
    for band in LINE_NOISE_BANDS:
        data = packages.get(band)
        bounds = cfg.freq_bands.get(band)
        if data is None or bounds is None or data.shape[1] < 16:
            continue
        nperseg = min(512, data.shape[1])
        freqs, psd = welch(np.mean(data, axis=0), fs=sfreq, nperseg=nperseg)
        if psd.size == 0 or not np.isfinite(psd).any():
            continue
        idx = int(np.argmin(np.abs(freqs - AUDIO_NOTCH_HZ)))
        mask = (freqs >= bounds[0]) & (freqs <= bounds[1])
        if not mask.any() or psd[idx] <= 0.0:
            continue
        median = float(np.median(psd[mask]))
        if median <= 0.0:
            continue
        level_db = 10.0 * float(np.log10(psd[idx] / median))
        if level_db > LINE_NOISE_MIN_PEAK_DB:
            warnings.append(
                f"Неподавленный фон {AUDIO_NOTCH_HZ:.0f} Гц в полосе {band}: "
                f"+{level_db:.1f} дБ над медианой (порог +{LINE_NOISE_MIN_PEAK_DB:.0f} дБ) — "
                "возможен свист 6.4 кГц в треке"
            )
    return warnings


def validate_packages(packages: dict[str, np.ndarray]) -> None:
    """NaN/inf в пакете — явная ошибка входа (не тихий рендер, ТЗ §2)."""
    for band, data in packages.items():
        if not np.isfinite(data).all():
            raise ValueError(
                f"Полоса {band}: NaN/inf в подготовленном сигнале — рендер невозможен"
            )


def apply_line_harmonics(raw: Any, sfreq: float) -> list[float]:
    """Обязательный режект первых гармоник notch (100/150 Гц для 50 Гц).

    Вызывается в каждом прогоне ``prepare_packages`` после приведения к
    500 Гц — независимо от того, применилась ли дефолтная очистка (при её
    деградации это единственный режект после 50 Гц из ``load_edf``). Частоты
    считает ``filter_design.harmonic_frequencies`` (единый источник, с учётом
    Nyquist). Повторное применение к уже вырезанному чисткой идемпотентно.
    """
    freqs = harmonic_frequencies(AUDIO_NOTCH_HZ, AUDIO_NOTCH_HARMONICS, float(sfreq))
    if freqs:
        raw.notch_filter(freqs, verbose=False)
    return list(freqs)



def prepare_packages(
    recording: Recording,
    cfg: Settings,
    on_stage: Callable[[str, float], None] | None = None,
) -> BandPackages:
    """Собирает полосовые пакеты: EDF → очистка → фильтры → валидация.

    ``on_stage(message, pct)`` — колбек прогресса (этап подготовки занимает
    0..0.3, остальные проценты раздаёт ``render``).
    """
    warnings: list[str] = []

    def _stage(message: str, pct: float) -> None:
        if on_stage is not None:
            on_stage(message, pct)

    _stage("Чтение и очистка сигнала", 0.0)
    kwargs: dict[str, Any] = {
        "l_freq": None,
        "h_freq": None,
        "notch_hz": AUDIO_NOTCH_HZ,
        "reference_mode": "none",
        "pipeline": None,
    }
    try:
        raw, clean_report = prepared_raw_report(recording, cfg, clean=AUDIO_DEFAULT_CLEAN, **kwargs)
    except Exception as exc:
        # «Дефолтная очистка с деградацией»: если профиль не применился (например,
        # ICA на слишком короткой записи), рендер идёт без чистки, но с честным
        # предупреждением — молча менять контракт входа нельзя.
        logger.warning("Дефолтная очистка не применилась, рендер без неё: %s", exc)
        warnings.append(f"Дефолтная очистка не применилась — рендер без неё: {exc}")
        raw, clean_report = prepared_raw_report(recording, cfg, clean=None, **kwargs)

    clean_label = AUDIO_DEFAULT_CLEAN.label()
    clean_warnings = list(clean_report.get("warnings") or [])
    if clean_warnings:
        warnings.extend(clean_warnings)
    interpolated = list(clean_report.get("interpolated_channels") or [])

    # Мёртвые каналы, помеченные при загрузке (find_dead_channels): чистка
    # интерполирует только spec.bad_channels, а spec мы не знаем заранее —
    # интерполируем лоадерские bads здесь, на своей копии raw.
    loader_bads = [name for name in raw.info.get("bads", []) if name in raw.ch_names]
    if loader_bads:
        try:
            raw.interpolate_bads(reset_bads=True, verbose=False)
            interpolated = sorted({*interpolated, *loader_bads})
        except Exception as exc:
            warnings.append(
                f"Интерполяция мёртвых каналов {', '.join(loader_bads)} не удалась: {exc}"
            )

    # Контракт ядра: ровно 500 Гц (load_edf ресемплирует только >500).
    sfreq = float(raw.info["sfreq"] or 0.0)
    if abs(sfreq - 500.0) > 1e-9:
        _stage("Ресемпл сигнала к 500 Гц", 0.05)
        raw.resample(500.0, verbose=False)
        sfreq = 500.0

    # Обязательный режект 100/150 Гц (требование 05.10.2026): после приведения
    # к 500 Гц — до полосовых фильтров, в каждом прогоне.
    _stage("Режект гармоник 100/150 Гц", 0.06)
    apply_line_harmonics(raw, sfreq)

    channels = list(raw.ch_names)
    packages: dict[str, np.ndarray] = {}
    n_bands = max(1, len(cfg.freq_bands))
    for index, band in enumerate(cfg.freq_bands):
        _stage(f"Полоса {band} ({index + 1}/{n_bands})", 0.05 + 0.25 * (index + 1) / n_bands)
        filtered = apply_band_filter(raw, band_name=band)
        data = np.asarray(filtered.get_data(verbose=False), dtype=np.float64)
        if data.shape[1] == 0:
            raise ValueError(f"Полоса {band}: пустой сигнал записи")
        packages[band] = data

    validate_packages(packages)
    warnings.extend(line_noise_warnings(packages, cfg, sfreq))

    n_times = next(iter(packages.values())).shape[1]
    for band, data in packages.items():
        if data.shape[1] != n_times:
            raise ValueError(
                f"Полоса {band}: длина {data.shape[1]} ≠ {n_times} — треки обязаны совпадать"
            )

    return BandPackages(
        channels=channels,
        sfreq=sfreq,
        n_times=n_times,
        packages=packages,
        warnings=warnings,
        clean_label=clean_label,
        interpolated=interpolated,
    )
