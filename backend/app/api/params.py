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
from app.services.artifact_cleaner import CLEAN_METHODS, CleanSpec
from app.services.dipole_scanner import DipoleRefineParams, DipoleScanParams
from app.services.evoked import EvokedParams
from app.services.preprocess import PreprocessParams
from app.services.recording_signals import (
    SIGNAL_LAYER_LITERALS,
    SIGNAL_LAYERS,
    SignalsLayerQuery,
)
from app.services.report import ReportParams, report_band_catalog
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


def signals_layer_query(
    *,
    layer: str,
    band_min: float | None,
    band_max: float | None,
    notch_hz: float | None,
    reference_channels: str | None,
    band_key: str | None = None,
    notch_harmonics: int = 0,
    bad_channels: str | None = None,
    interpolate_bads: bool = False,
    clean_method: str = "none",
    ica_n_components: int = 0,
    exclude_zone_ids: str | None = None,
) -> SignalsLayerQuery:
    """Слой видимости вьюера и база подготовленных слоёв из query (шаг 2 плана).

    Проверки — те же, что у стадии «Фильтр и референс» (полоса парой, опции
    очистки): слой — видимость, но «после очистки» обязан строиться по честным
    параметрам, иначе показанная обработка разошлась бы с расчётом. Отменённые
    зоны (``exclude_zone_ids`` через запятую) — часть опций очистки: слои
    ``cleaned``/``diff`` обязаны совпадать со стадией, иначе вьюер показал бы
    другой сигнал, чем расчёт.

    Слой ``band`` (Фаза B) адресуется ``band_key`` — ключом из
    ``freq_bands``/``functional_bands``, а не границами: это адрес персиста.
    Числовая полоса и опции очистки с ним несовместны (ключ персиста их не
    содержит) — сервер отвечает 400, а не молча игнорирует.
    """
    layer_value = SIGNAL_LAYER_LITERALS.get(layer)
    if layer_value is None:
        raise HTTPException(
            status_code=400,
            detail=f"layer должен быть одним из {list(SIGNAL_LAYERS)} (получено: {layer!r})",
        )
    band = parse_filter_band(band_min, band_max)
    excluded = parse_zone_ids(exclude_zone_ids)
    if layer_value == "band":
        _require_band_key_layer(band_key, band, notch_harmonics, bad_channels,
                                interpolate_bads, clean_method, ica_n_components, excluded)
        return SignalsLayerQuery(
            layer="band",
            band_key=band_key,
            notch_hz=notch_hz,
            reference_channels=tuple(parse_reference_channels(reference_channels) or ()),
        )
    if band_key:
        raise HTTPException(
            status_code=400,
            detail="band_key передаётся только для слоя band (для cleaned/diff используйте band_min/band_max)",
        )
    _require_clean_options(clean_method, notch_harmonics, ica_n_components)
    bads = tuple(name.strip() for name in (bad_channels or "").split(",") if name.strip())
    return SignalsLayerQuery(
        layer=layer_value,
        band=band,
        notch_hz=notch_hz,
        reference_channels=tuple(parse_reference_channels(reference_channels) or ()),
        clean=CleanSpec(
            notch_harmonics=notch_harmonics,
            bad_channels=bads,
            interpolate_bads=interpolate_bads,
            method=clean_method,
            ica_n_components=ica_n_components,
            exclude_zone_ids=excluded,
        ),
    )


def parse_zone_ids(raw: str | None) -> tuple[str, ...]:
    """Идентификаторы отменённых зон (``clean-1,clean-2`` → кортеж id).

    Серверные id стабильны между пересчётами, поэтому форма не валидирует их
    против списка зон: неизвестный id — не отмена, а warning в отчёте стадии
    (правило: сервер не решает за клиента, что для него «существующая зона»).
    """
    return tuple(part.strip() for part in (raw or "").split(",") if part.strip())


def _require_band_key_layer(
    band_key: str | None,
    band: tuple[float, float] | None,
    notch_harmonics: int,
    bad_channels: str | None,
    interpolate_bads: bool,
    clean_method: str,
    ica_n_components: int,
    exclude_zone_ids: tuple[str, ...] = (),
) -> None:
    """Проверки слоя ``band``: обязателен известный ``band_key``, без числовых
    границ и опций очистки (они не входят в ключ персиста, п.16)."""
    known = (*settings.freq_bands.keys(), *settings.functional_bands.keys())
    if not band_key:
        raise HTTPException(
            status_code=400,
            detail=f"Слой band требует band_key — один из {list(known)}",
        )
    if band_key not in known:
        raise HTTPException(
            status_code=400,
            detail=f"band_key должен быть одним из {list(known)} (получено: {band_key!r})",
        )
    if band is not None:
        raise HTTPException(
            status_code=400,
            detail="Слой band адресуется band_key — band_min/band_max с ним несовместны",
        )
    if (
        clean_method != "none"
        or notch_harmonics
        or (bad_channels or "").strip()
        or interpolate_bads
        or ica_n_components
        or exclude_zone_ids
    ):
        raise HTTPException(
            status_code=400,
            detail="Слой band собирается без очистки (ключ персиста её не содержит): "
                   "clean_method=none, без bad-каналов, гармоников и ICA",
        )


def validate_analysis_request(
    epoch_length_ms: float, freq_band: str, single_freq: float | None,
) -> None:
    """Проверка параметров файлового анализа (``/analyze`` и ``/jobs``).

    Именованные полосы — базовые ``freq_bands`` и функциональные
    ``functional_bands`` (фаза A): оба словаря резолвит ``band_bounds``,
    поэтому форма может предложить и те, и другие.
    """
    require_epoch_length(epoch_length_ms)
    known_bands = (*settings.freq_bands.keys(), *settings.functional_bands.keys())
    if freq_band not in ("all", "custom", *known_bands):
        raise HTTPException(
            status_code=400,
            detail=f"freq_band должен быть 'all'/'custom' или {list(known_bands)}",
        )
    if single_freq is not None and freq_band != "all":
        raise HTTPException(status_code=400, detail="single_freq ставится вместе с freq_band='all'")


def _require_clean_options(clean_method: str, notch_harmonics: int, ica_n_components: int) -> None:
    """Опции очистки из формы: неизвестный метод или диапазон — 400 (правило 8).

    Общая проверка для стадии предподготовки и слоёв видимости вьюера: слой —
    видимость, но его параметры те же, что у стадии «Фильтр и референс», и
    молчаливое «none» вместо опечатки показало бы другую обработку.
    """
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
    exclude_zone_ids: str | None = None,
    epoch_mode: str = "fixed",
    event_id: str | None = None,
    epoch_pre_ms: float = 200.0,
    epoch_post_ms: float = 800.0,
) -> PreprocessParams:
    """Параметры стадии предподготовки; длина эпохи важна только стадии ``epochs``.

    Опции очистки (гармоники notch, bad-каналы, ICA/SSP, отменённые зоны
    ``exclude_zone_ids`` через запятую) валидируются здесь же: неизвестный
    метод — 400 с текстом для UI, а не молчаливое «none» (правило 8,
    `docs/rules/api-jobs.md`). Неизвестные id зон сервер не отвергает: они
    обязаны стабильно проезжать между пересчётами — честный warning об этом
    отдаёт отчёт стадии. Событийный режим нарезки (``epoch_mode='events'``,
    N2/2.7) требует описание события и корректное окно до/после.
    """
    if stage == "epochs":
        if epoch_mode not in ("fixed", "events"):
            raise HTTPException(
                status_code=400,
                detail=f"epoch_mode должен быть fixed или events (получено: {epoch_mode!r})",
            )
        if epoch_mode == "fixed":
            require_epoch_length(epoch_length_ms)
        else:
            if not (event_id or "").strip():
                raise HTTPException(
                    status_code=400,
                    detail=(
                        "Событийный режим требует event_id: выберите событие записи "
                        "в блоке «Эпохи» панели"
                    ),
                )
            if epoch_pre_ms < 0 or epoch_pre_ms > 10000:
                raise HTTPException(
                    status_code=400,
                    detail=f"epoch_pre_ms — окно до события от 0 до 10000 мс (получено: {epoch_pre_ms})",
                )
            if epoch_post_ms < 100 or epoch_post_ms > 10000:
                raise HTTPException(
                    status_code=400,
                    detail=f"epoch_post_ms — окно после события от 100 до 10000 мс (получено: {epoch_post_ms})",
                )
            if epoch_pre_ms + epoch_post_ms > 10000:
                raise HTTPException(
                    status_code=400,
                    detail="Окно эпохи (до + после) не должно быть длиннее 10000 мс",
                )
    _require_clean_options(clean_method, notch_harmonics, ica_n_components)

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
        exclude_zone_ids=list(parse_zone_ids(exclude_zone_ids)),
        z_threshold=z_threshold,
        pp_threshold_uv=pp_threshold_uv,
        flat_line_uv=flat_line_uv,
        flat_line_ms=flat_line_ms,
        run_ica=run_ica,
        epoch_length_ms=epoch_length_ms,
        epoch_mode=epoch_mode,
        event_id=(event_id or "").strip() or None,
        epoch_pre_ms=epoch_pre_ms,
        epoch_post_ms=epoch_post_ms,
    )


def evoked_params(
    *,
    event_id: str | None,
    epoch_pre_ms: float,
    epoch_post_ms: float,
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
    baseline_start_ms: float | None = None,
    baseline_end_ms: float | None = None,
    notch_harmonics: int = 0,
    bad_channels: str | None = None,
    interpolate_bads: bool = False,
    clean_method: str = "none",
    ica_n_components: int = 0,
) -> EvokedParams:
    """Параметры задачи ERP: окно события + baseline + подготовка сигнала.

    Окно и описание события валидируются той же формой, что и стадия «Нарезка
    эпох» (`preprocess_params` — DRY: 400-тексты не дублируются). Baseline —
    пара значений в мс от события; окно обязано лежать внутри эпохи.
    """
    prep = preprocess_params(
        stage="epochs",
        band_min=band_min, band_max=band_max, notch_hz=notch_hz,
        reference=reference, reference_channels=reference_channels,
        z_threshold=z_threshold, pp_threshold_uv=pp_threshold_uv,
        flat_line_uv=flat_line_uv, flat_line_ms=flat_line_ms,
        run_ica=run_ica,
        # В режиме events длина не из списка не проверяется — значение не используется
        epoch_length_ms=epoch_post_ms,
        notch_harmonics=notch_harmonics, bad_channels=bad_channels,
        interpolate_bads=interpolate_bads, clean_method=clean_method,
        ica_n_components=ica_n_components,
        epoch_mode="events", event_id=event_id,
        epoch_pre_ms=epoch_pre_ms, epoch_post_ms=epoch_post_ms,
    )
    if (baseline_start_ms is None) != (baseline_end_ms is None):
        raise HTTPException(
            status_code=400,
            detail="Baseline задаётся парой значений (start и end) либо не задаётся вовсе",
        )
    if (
        baseline_start_ms is not None and baseline_end_ms is not None
        and not (-epoch_pre_ms <= baseline_start_ms < baseline_end_ms <= epoch_post_ms)
    ):
        raise HTTPException(
            status_code=400,
            detail=(
                f"Окно baseline [{baseline_start_ms}; {baseline_end_ms}] мс должно лежать "
                f"внутри эпохи [−{epoch_pre_ms}; {epoch_post_ms}] мс (start < end)"
            ),
        )
    return EvokedParams(
        preprocess=prep,
        baseline_start_ms=baseline_start_ms,
        baseline_end_ms=baseline_end_ms,
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


def report_band_keys(raw: str | None) -> list[str]:
    """Ключи полос пакета из формы: пусто — все полосы, опечатка — 400.

    Список — через запятую («δ,θ,α»); порядок и дубли сохраняются как есть
    (сервис дедуплицирует, порядок читается в отчёте сверху вниз).
    """
    if not raw or not raw.strip():
        return []
    catalog = report_band_catalog(settings)
    keys = [key.strip() for key in raw.split(",") if key.strip()]
    unknown = [key for key in keys if key not in catalog]
    if unknown:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Неизвестные полосы: {', '.join(unknown)}. "
                f"Доступны: {', '.join(catalog)}"
            ),
        )
    return keys


def report_params(
    *,
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
    exclude_zone_ids: str | None = None,
    grid_mm: float = 7.0,
    bands: str | None = None,
) -> ReportParams:
    """Параметры автоотчёта: часть 1 — те же параметры стадий EDF, часть 2 — пакет.

    Разбор и проверки — общие с ``preprocess_params`` (пара границ, чистка,
    длина эпохи из настроек): отчёт не изобретает своих правил. Нарезка —
    только ``fixed``: событийный режим (ERP) в сквозной отчёт не входит и
    поля формы ``epoch_mode``/``event_id`` здесь не читаются.
    """
    base = preprocess_params(
        stage="epochs",
        band_min=band_min, band_max=band_max,
        notch_hz=notch_hz, reference=reference, reference_channels=reference_channels,
        z_threshold=z_threshold, pp_threshold_uv=pp_threshold_uv,
        flat_line_uv=flat_line_uv, flat_line_ms=flat_line_ms,
        run_ica=run_ica,
        epoch_length_ms=epoch_length_ms,
        notch_harmonics=notch_harmonics, bad_channels=bad_channels,
        interpolate_bads=interpolate_bads,
        clean_method=clean_method, ica_n_components=ica_n_components,
        exclude_zone_ids=exclude_zone_ids,
        epoch_mode="fixed",
    )
    return ReportParams(
        preprocess=base, grid_mm=grid_mm, band_keys=report_band_keys(bands),
    )
