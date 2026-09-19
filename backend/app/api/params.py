"""Формы запросов → параметры сервисов (A1, этап 3).

Роут описывает форму (``Form(...)``/``Query(...)``), а разбор значений и
проверки живут здесь: «полоса задаётся парой», «длина эпохи — из настроек»,
«референс — список каналов через запятую». До этого модуля те же пять проверок
повторялись в каждом эндпоинте, и правка правила требовала обойти все роуты.

Ошибки — ``HTTPException(400)`` с текстом для UI (правило 8 в
``docs/rules/api-jobs.md``): молча зажимать значения нельзя, пользователь
должен видеть, что именно не так.
"""
from collections.abc import Mapping
from typing import Any

from fastapi import HTTPException

from app.core.config import settings
from app.schemas.analysis import PreprocessStage
from app.services.dipole_scanner import DipoleRefineParams, DipoleScanParams
from app.services.preprocess import PreprocessParams
from app.services.spectral import SpectrumParams
from app.services.spectrogram import SpectrogramParams
from app.services.spectrogram import validate_params as _validate_spectrogram_params


def parse_filter_band(
    band_min: float | None, band_max: float | None,
) -> tuple[float, float] | None:
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


def parse_reference_channels(raw: str | None) -> list[str] | None:
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
    epoch_length_ms: float, freq_band: str, single_freq: float | None,
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
    stage: PreprocessStage,
    band_min: float | None,
    band_max: float | None,
    notch_hz: float | None,
    reference: str,
    reference_channels: str | None,
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
    band_min: float | None,
    band_max: float | None,
    notch_hz: float | None,
    reference: str,
    reference_channels: str | None,
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
    band_min: float | None,
    band_max: float | None,
    notch_hz: float | None,
    reference: str,
    reference_channels: str | None,
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
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return params


def stored_spectrogram_params(result: Mapping[str, Any]) -> SpectrogramParams:
    """Параметры сетки спектрограммы из **результата задачи** (``grid.bin``).

    Значения берутся у того расчёта, который показан на экране: сетка — это его
    данные, а не «текущие настройки панели». Референс тоже пишется в результат
    (``reference``/``reference_channels``, A11): подставлять «average» на слово
    нельзя — иначе ленивый пересчёт посчитал бы сетку другой ссылкой, а ETag
    (отпечаток параметров) остался бы прежним. Fallback — для результатов,
    записанных до правки (`results_dir/jobs/*.json`).
    """
    band = result.get("filter_band_hz")
    reference_channels = result.get("reference_channels") or None
    return SpectrogramParams(
        channel=str(result["channel"]),
        filter_band=(band[0], band[1]) if band and len(band) == 2 else None,
        notch_hz=result.get("notch_hz"),
        reference=str(result.get("reference") or "average"),
        reference_channels=list(reference_channels) if reference_channels else None,
        window_ms=float(result["window_ms"]),
        overlap_pct=float(result["overlap_pct"]),
        fmax_hz=float(result["fmax_hz"]),
    )


def dipole_scan_params(
    *,
    band_min: float | None,
    band_max: float | None,
    notch_hz: float | None,
    reference: str,
    reference_channels: str | None,
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


def dipole_refine_params(
    *,
    epoch_index: int,
    band_min: float | None,
    band_max: float | None,
    notch_hz: float | None,
    reference: str,
    reference_channels: str | None,
    epoch_length_ms: float,
    reject_threshold_uv: float,
    grid_mm: float,
) -> DipoleRefineParams:
    """Параметры точного уточнения: сканирование (нарезка результата) + эпоха."""
    scan = dipole_scan_params(
        band_min=band_min, band_max=band_max,
        notch_hz=notch_hz,
        reference=reference, reference_channels=reference_channels,
        epoch_length_ms=epoch_length_ms, reject_threshold_uv=reject_threshold_uv,
        grid_mm=grid_mm,
    )
    if epoch_index < 0:
        raise HTTPException(status_code=400, detail="Номер эпохи неотрицателен (с 0)")
    return DipoleRefineParams(scan=scan, epoch_index=epoch_index)
