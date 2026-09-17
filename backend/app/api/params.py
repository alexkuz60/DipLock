"""Формы запросов → параметры сервисов (A1, этап 3).

Роут описывает форму (``Form(...)``/``Query(...)``), а разбор значений и
проверки живут здесь: «полоса задаётся парой», «длина эпохи — из настроек»,
«референс — список каналов через запятую». До этого модуля те же пять проверок
повторялись в каждом эндпоинте, и правка правила требовала обойти все роуты.

Ошибки — ``HTTPException(400)`` с текстом для UI (правило 8 в
``docs/rules/api-jobs.md``): молча зажимать значения нельзя, пользователь
должен видеть, что именно не так.
"""
from typing import Any, List, Mapping, Optional, Tuple

from fastapi import HTTPException

from app.core.config import settings
from app.services.dipole_scanner import DipoleScanParams
from app.services.preprocess import PreprocessParams
from app.services.spectrogram import SpectrogramParams
from app.services.spectrogram import validate_params as _validate_spectrogram_params
from app.services.spectral import SpectrumParams


def parse_filter_band(
    band_min: Optional[float], band_max: Optional[float],
) -> Optional[Tuple[float, float]]:
    """Полоса фильтра из формы: пара значений либо «без фильтра».

    Односторонняя полоса — ошибка: молча догадываться о второй границе нельзя,
    фильтр меняет и спектр, и локализацию.
    """
    if band_min is None and band_max is None:
        return None
    if band_min is None or band_max is None:
        raise HTTPException(
            status_code=400,
            detail="Полоса задаётся парой band_min и band_max либо не задаётся вовсе",
        )
    if band_min >= band_max:
        raise HTTPException(status_code=400, detail="band_min должен быть меньше band_max")
    return (band_min, band_max)


def parse_reference_channels(raw: Optional[str]) -> Optional[List[str]]:
    """Разбирает список каналов референса из формы (``F3,F4`` → ``['F3','F4']``)."""
    if not raw:
        return None
    names = [name.strip() for name in raw.split(",") if name.strip()]
    return names or None


def require_epoch_length(epoch_length_ms: float) -> None:
    """Проверка длины эпохи: только значения из `epoch_lengths_ms` (DRY с панелью)."""
    if epoch_length_ms not in settings.epoch_lengths_ms:
        raise HTTPException(
            status_code=400,
            detail=f"epoch_length_ms должен быть одним из {settings.epoch_lengths_ms}",
        )


def validate_analysis_request(
    epoch_length_ms: float, freq_band: str, single_freq: Optional[float],
) -> None:
    """Проверка параметров файлового анализа (``/analyze`` и ``/jobs``)."""
    require_epoch_length(epoch_length_ms)
    if freq_band not in ("all", "custom", *settings.freq_bands.keys()):
        raise HTTPException(
            status_code=400,
            detail=f"freq_band должен быть 'all'/'custom' или {list(settings.freq_bands.keys())}",
        )
    if single_freq is not None and freq_band != "all":
        raise HTTPException(status_code=400, detail="single_freq ставится вместе с freq_band='all'")


def preprocess_params(
    *,
    stage: str,
    band_min: Optional[float],
    band_max: Optional[float],
    notch_hz: Optional[float],
    reference: str,
    reference_channels: Optional[str],
    z_threshold: float,
    pp_threshold_uv: float,
    flat_line_uv: float,
    flat_line_ms: float,
    run_ica: bool,
    epoch_length_ms: float,
    reject_threshold_uv: float,
) -> PreprocessParams:
    """Параметры стадии предподготовки; длина эпохи важна только стадии ``epochs``."""
    if stage == "epochs":
        require_epoch_length(epoch_length_ms)

    return PreprocessParams(
        stage=stage,
        filter_band=parse_filter_band(band_min, band_max),
        notch_hz=notch_hz,
        reference=reference,
        reference_channels=parse_reference_channels(reference_channels),
        z_threshold=z_threshold,
        pp_threshold_uv=pp_threshold_uv,
        flat_line_uv=flat_line_uv,
        flat_line_ms=flat_line_ms,
        run_ica=run_ica,
        epoch_length_ms=epoch_length_ms,
        reject_threshold_uv=reject_threshold_uv,
    )


def spectrum_params(
    *,
    band_min: Optional[float],
    band_max: Optional[float],
    notch_hz: Optional[float],
    reference: str,
    reference_channels: Optional[str],
    epoch_length_ms: float,
    reject_threshold_uv: float,
) -> SpectrumParams:
    """Параметры расчёта спектра по диапазонам (Welch PSD)."""
    require_epoch_length(epoch_length_ms)

    return SpectrumParams(
        filter_band=parse_filter_band(band_min, band_max),
        notch_hz=notch_hz,
        epoch_length_ms=epoch_length_ms,
        reference=reference,
        reference_channels=parse_reference_channels(reference_channels),
        reject_threshold_uv=reject_threshold_uv,
    )


def spectrogram_params(
    *,
    channel: str,
    band_min: Optional[float],
    band_max: Optional[float],
    notch_hz: Optional[float],
    reference: str,
    reference_channels: Optional[str],
    window_ms: float,
    overlap_pct: float,
    fmax_hz: float,
) -> SpectrogramParams:
    """Параметры спектрограммы канала; проверка окна/перекрытия — в сервисе."""
    params = SpectrogramParams(
        channel=channel,
        filter_band=parse_filter_band(band_min, band_max),
        notch_hz=notch_hz,
        reference=reference,
        reference_channels=parse_reference_channels(reference_channels),
        window_ms=window_ms,
        overlap_pct=overlap_pct,
        fmax_hz=fmax_hz,
    )
    try:
        _validate_spectrogram_params(params, settings)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return params


def stored_spectrogram_params(result: Mapping[str, Any]) -> SpectrogramParams:
    """Параметры сетки спектрограммы из **результата задачи** (``grid.bin``).

    Значения берутся у того расчёта, который показан на экране: сетка — это его
    данные, а не «текущие настройки панели». Референс в результат задачи не
    пишется, поэтому подставляется значение по умолчанию — известное расхождение
    при ``reference != "average"`` (находка A11 в ``audit-2026-09.md``).
    """
    band = result.get("filter_band_hz")
    return SpectrogramParams(
        channel=str(result["channel"]),
        filter_band=(band[0], band[1]) if band and len(band) == 2 else None,
        notch_hz=result.get("notch_hz"),
        window_ms=float(result["window_ms"]),
        overlap_pct=float(result["overlap_pct"]),
        fmax_hz=float(result["fmax_hz"]),
    )


def dipole_scan_params(
    *,
    band_min: Optional[float],
    band_max: Optional[float],
    notch_hz: Optional[float],
    reference: str,
    reference_channels: Optional[str],
    epoch_length_ms: float,
    reject_threshold_uv: float,
    grid_mm: float,
) -> DipoleScanParams:
    """Параметры быстрого расчёта диполей (перебор сетки узлов)."""
    require_epoch_length(epoch_length_ms)

    return DipoleScanParams(
        filter_band=parse_filter_band(band_min, band_max),
        notch_hz=notch_hz,
        epoch_length_ms=epoch_length_ms,
        reject_threshold_uv=reject_threshold_uv,
        reference=reference,
        reference_channels=parse_reference_channels(reference_channels),
        grid_mm=grid_mm,
    )
