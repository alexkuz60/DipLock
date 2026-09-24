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
from app.services.artifact_cleaner import CLEAN_METHODS
from app.services.dipole_scanner import DipoleRefineParams, DipoleScanParams
from app.services.preprocess import PreprocessParams
from app.services.spectral import SPECTRUM_PSD_METHODS, SpectrumParams
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
    notch_harmonics: int = 0,
    bad_channels: str | None = None,
    interpolate_bads: bool = False,
    clean_method: str = "none",
    ica_n_components: int = 0,
) -> PreprocessParams:
    """Параметры стадии предподготовки; длина эпохи важна только стадии ``epochs``.

    Опции очистки (гармоники notch, bad-каналы, ICA/SSP) валидируются здесь же:
    неизвестный метод — 400 с текстом для UI, а не молчаливое «none» (правило 8,
    `docs/rules/api-jobs.md`).
    """
    if stage == "epochs":
        require_epoch_length(epoch_length_ms)
    if clean_method not in CLEAN_METHODS:
        raise HTTPException(
            status_code=400,
            detail=f"clean_method должен быть одним из {list(CLEAN_METHODS)}",
        )
    if not 0 <= notch_harmonics <= 4:
        raise HTTPException(
            status_code=400,
            detail="notch_harmonics — целое 0…4 (гармоники 50/60 Гц: 100/150/200/240 Гц)",
        )
    if ica_n_components < 0:
        raise HTTPException(
            status_code=400, detail="ica_n_components неотрицателен (0 — auto, MNE выберет)",
        )

    return PreprocessParams(
        stage=stage,
        filter_band=parse_filter_band(band_min, band_max),
        notch_hz=notch_hz,
        reference=reference,
        reference_channels=parse_reference_channels(reference_channels),
        notch_harmonics=notch_harmonics,
        bad_channels=parse_reference_channels(bad_channels),
        interpolate_bads=interpolate_bads,
        clean_method=clean_method,
        ica_n_components=ica_n_components,
        z_threshold=z_threshold,
        pp_threshold_uv=pp_threshold_uv,
        flat_line_uv=flat_line_uv,
        flat_line_ms=flat_line_ms,
        run_ica=run_ica,
        epoch_length_ms=epoch_length_ms,
    )


def spectrum_params(
    *,
    band_min: float | None,
    band_max: float | None,
    notch_hz: float | None,
    reference: str,
    reference_channels: str | None,
    epoch_length_ms: float,
    psd_method: str = "welch",
) -> SpectrumParams:
    """Параметры расчёта спектра по диапазонам (Welch или multitaper PSD)."""
    require_epoch_length(epoch_length_ms)
    if psd_method not in SPECTRUM_PSD_METHODS:
        raise HTTPException(
            status_code=400,
            detail=f"psd_method должен быть одним из {list(SPECTRUM_PSD_METHODS)}",
        )

    return SpectrumParams(
        filter_band=parse_filter_band(band_min, band_max),
        notch_hz=notch_hz,
        epoch_length_ms=epoch_length_ms,
        reference=reference,
        reference_channels=parse_reference_channels(reference_channels),
        psd_method=psd_method,
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
    grid_mm: float,
) -> DipoleScanParams:
    """Параметры быстрого расчёта диполей (перебор сетки узлов)."""
    require_epoch_length(epoch_length_ms)

    return DipoleScanParams(
        filter_band=parse_filter_band(band_min, band_max),
        notch_hz=notch_hz,
        epoch_length_ms=epoch_length_ms,
        reference=reference,
        reference_channels=parse_reference_channels(reference_channels),
        grid_mm=grid_mm,
    )


def require_halfwin_ms(halfwin_ms: float | None) -> float:
    """Половина окна уточнения (мс): 0…``dipole_refine_halfwin_max_ms``.

    ``None`` — дефолт конфига (0 = фитится только пик GFP). Верхняя граница —
    не формальность: каждый лишний отсчёт окна стоит ≈7 с (замер 20.09.2026),
    поэтому «широкое окно» пользователь выбирает явно, а не получает молча.
    """
    value = settings.dipole_refine_halfwin_ms if halfwin_ms is None else float(halfwin_ms)
    limit = settings.dipole_refine_halfwin_max_ms
    if value < 0 or value > limit:
        raise HTTPException(
            status_code=400,
            detail=(
                f"halfwin_ms должен быть в диапазоне 0…{limit:g} мс "
                f"(0 — фитится только пик GFP); получено {value:g}"
            ),
        )
    return value


def dipole_refine_params(
    *,
    epoch_index: int,
    band_min: float | None,
    band_max: float | None,
    notch_hz: float | None,
    reference: str,
    reference_channels: str | None,
    epoch_length_ms: float,
    grid_mm: float,
    halfwin_ms: float | None = None,
) -> DipoleRefineParams:
    """Параметры точного уточнения: сканирование (нарезка результата) + эпоха.

    ``halfwin_ms`` — половина окна свободного фитинга вокруг пика GFP; ``None``
    означает дефолт конфига (0 — один отсчёт), а не «окно пошире».
    """
    scan = dipole_scan_params(
        band_min=band_min, band_max=band_max,
        notch_hz=notch_hz,
        reference=reference, reference_channels=reference_channels,
        epoch_length_ms=epoch_length_ms,
        grid_mm=grid_mm,
    )
    if epoch_index < 0:
        raise HTTPException(status_code=400, detail="Номер эпохи неотрицателен (с 0)")
    return DipoleRefineParams(
        scan=scan,
        epoch_index=epoch_index,
        halfwin_ms=require_halfwin_ms(halfwin_ms),
    )
