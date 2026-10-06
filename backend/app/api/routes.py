"""REST API эндпоинты DipLock.

Роут описывает только форму запроса и контракт ответа; работа живёт в модулях
слоя (A1, этап 3):

* ``app/api/uploads.py`` — приём EDF: санитизация имени, размер, sha256 (F10);
* ``app/api/params.py`` — формы → параметры сервисов (400 с текстом для UI);
* ``app/api/recording_jobs.py`` — задачи записи: запуск, статус, результат;
* ``app/api/assets.py`` — отдача кэшируемых ассетов с ETag/304 (A2, этап 3);
* ``app/services/*`` — расчёты («один шаг пайплайна = один модуль»).

Контракт ответов описан Pydantic-моделями в ``app/schemas`` (F4): из OpenAPI
генерируются TypeScript-типы frontend. Тяжёлые статические ассеты (меш
fsaverage, атлас Brodmann) отдаются отдельными кэшируемыми эндпоинтами (F6),
долгий анализ — фоновыми задачами с прогрессом по этапам (F7).
"""
import asyncio
import json
import logging
import math
import shutil
import sys
from typing import Any

from fastapi import (
    APIRouter,
    BackgroundTasks,
    File,
    Form,
    Header,
    HTTPException,
    Query,
    Response,
    UploadFile,
)

from app.api.assets import (
    CACHE_PRIVATE_DAY,
    CACHE_PRIVATE_HOUR,
    CACHE_PUBLIC_WEEK,
    asset_response,
)
from app.api.params import (
    bundle_params,
    compare_params,
    dipole_refine_params,
    dipole_scan_params,
    eloreta_params,
    evoked_params,
    parse_filter_band,
    preprocess_params,
    report_params,
    signals_layer_query,
    spectrogram_params,
    spectrum_params,
    stored_spectrogram_params,
    validate_analysis_request,
)
from app.api.recording_jobs import (
    compare_job_result,
    job_by_id,
    job_status,
    recording_job_result,
    require_recording,
    submit_compare_job,
    submit_recording_job,
)
from app.api.uploads import safe_edf_name, save_upload
from app.core.config import settings
from app.schemas.analysis import (
    AnalyzeResponse,
    ArtifactThresholds,
    BrodmannAreaOut,
    BrodmannIndexOut,
    BrodmannLabelsOut,
    BundleResult,
    ChannelMixOut,
    ContourSliceOut,
    ContoursOut,
    ContoursRef,
    DipoleOut,
    DipoleRefineResult,
    DipoleScanResult,
    EloretaResult,
    EpochOut,
    EvokedResult,
    FilterResponseOut,
    JobCreated,
    JobStatus,
    MainsOut,
    MetaResponse,
    MriSliceRef,
    MriSlicesOut,
    MriVolumeRef,
    PreprocessResult,
    PreprocessStage,
    RecordingMeta,
    RecordingSignalsHeader,
    ReportHtmlOut,
    ReportResult,
    RunManifestOut,
    SessionDetailOut,
    SessionsPageOut,
    SessionSummaryOut,
    SpectrogramGridHeader,
    SpectrogramResult,
    SpectrumResult,
    SurfaceOut,
)
from app.schemas.audio import AudioRenderRequest, AudioRenderStart, AudioRenderStatus
from app.schemas.compare import CompareResult
from app.schemas.group import (
    GroupAggregateIn,
    GroupAggregateOut,
    GroupAnalysesPage,
    GroupAnalysisCreateIn,
    GroupAnalysisDetailOut,
    GroupAnalysisSummaryOut,
)
from app.schemas.journal import JournalEntry, JournalOut
from app.schemas.resource import GpuStatusOut, LocalResourceOut, LocalResourceUpdate
from app.schemas.server import ServerRestartOut
from app.services import (
    analysis_pipeline,
    fsaverage_assets,
    gpu,
    journal,
    recording_store,
    results_store,
    server_control,
)
from app.services.atlas_contours import (
    contours_meta,
    slice_contours,
)
from app.services.atlas_contours import (
    contours_ref as contour_ref,
)
from app.services.audio_render import render as neuro_render
from app.services.audio_render.core import PITCH_STEPS_CHOICES
from app.services.audio_render.loudness import (
    LOUDNESS_PHON_MAX,
    LOUDNESS_PHON_MIN,
)
from app.services.audio_render.mix import (
    BOOST_MAX_DB,
    BOOST_MIN_DB,
    GAIN_MAX_DB,
    GAIN_MIN_DB,
)
from app.services.channel_mix import mixes_for
from app.services.compare import cached_compare_topomap
from app.services.filter_design import filter_response
from app.services.group_analysis import (
    GroupError,
    aggregate_group,
    get_group_analysis,
    list_group_analyses,
    save_group_analysis,
)
from app.services.group_reports import ensure_compare_report, ensure_group_report
from app.services.job_manager import job_manager, noop_progress
from app.services.mains import mains_component
from app.services.mri_slices import (
    mri_meta,
)
from app.services.mri_slices import (
    slice_png as mri_slice_png,
)
from app.services.mri_slices import (
    slice_ref as mri_slice_ref,
)
from app.services.mri_volumes import volume_bytes, volumes_ref
from app.services.recording_signals import (
    SignalBuildError,
    build_signal_blob,
)
from app.services.recordings import Recording, ensure_record_events, recording_registry
from app.services.report import read_report_html
from app.services.run_manifest import build_manifest
from app.services.session_bundle import dipoles_csv, read_bundle_zip
from app.services.spectral import cached_topomap, head_map_positions
from app.services.spectrogram import (
    cached_grid as cached_spectrogram_grid,
)
from app.services.spectrogram import (
    grid_url as spectrogram_grid_url,
)
from app.services.surface_cache import (
    asset_version,
    brodmann_area_names,
    get_brodmann_area,
    get_brodmann_bytes,
    get_surface_bytes,
)
from app.utils.versions import code_freshness as _code_freshness
from app.utils.versions import library_versions as _library_versions

logger = logging.getLogger(__name__)

router = APIRouter()


def _meta_out(recording: Recording, deduplicated: bool = False) -> RecordingMeta:
    """Паспорт записи для ответа.

    Флаг ``deduplicated`` — факт ответа на загрузку («файл уже хранился, копия не
    создана»), а не свойство файла: в сайдкар записи он не пишется, и обычная
    выдача паспорта (`GET /recordings/{id}`) его не выставляет.

    ``mixes`` — виртуальные каналы раздела «ЭЭГ»: состав считается по каналам
    записи в `services/channel_mix.py`, чтобы правила монтажа 10-20 жили в одном
    месте, а UI только показывал готовый список.

    ``ensure_record_events`` дополняет события старых сайдкаров (N2/2.7):
    паспорт, записанный до шага, ключа ``events`` не имеет.
    """
    ensure_record_events(recording, settings)
    return RecordingMeta(
        **recording.meta,
        # dict из чистого сервиса → элемент контракта: валидацию типа делает Pydantic
        mixes=[ChannelMixOut(**option) for option in mixes_for(recording.meta.get("channels") or [])],
        deduplicated=deduplicated,
    )



def _mri_ref() -> MriSliceRef:
    """Ссылка на срезы МРТ: версия по отпечатку тома, без его сборки (O(1))."""
    return MriSliceRef(**mri_slice_ref(settings))


def _contours_ref() -> ContoursRef:
    """Ссылка на контуры атласа: версия по отпечатку файлов, без сборки (O(1))."""
    return ContoursRef(**contour_ref(settings))


def _mri_volumes_ref() -> MriVolumeRef:
    """Ссылка на тома Niivue: отпечаток файлов и affine T1, без чтения байтов."""
    return MriVolumeRef(**volumes_ref(settings))


@router.post("/analyze", response_model=AnalyzeResponse, summary="Синхронный анализ EDF")
async def analyze_eeg(
    file: UploadFile = File(...),
    epoch_length_ms: float = Form(2000.0),
    freq_band: str = Form("all"),
    custom_min_freq: float | None = Form(None),
    custom_max_freq: float | None = Form(None),
    single_freq: float | None = Form(None),
    run_ica: bool = Form(True),
    z_threshold: float = Form(5.0),
    pp_threshold_uv: float = Form(100.0),
) -> dict[str, Any]:
    """Полный пайплайн одним запросом: EDF → артефакты → эпохи → фильтр → диполи.

    Удобно для curl/скриптов. Для UI используйте ``POST /jobs``: там есть
    прогресс по этапам, ограничение параллелизма, и результат не теряется при
    обрыве соединения. Тяжёлый меш fsaverage в ответ НЕ входит — только ссылка
    на кэшируемый ассет (``surface.url``).
    """
    validate_analysis_request(epoch_length_ms, freq_band, single_freq)
    safe_name = safe_edf_name(file.filename)
    tmp_path, upload_dir, _digest = await save_upload(file, safe_name)

    try:
        result = await asyncio.to_thread(
            analysis_pipeline.run_analysis, noop_progress, tmp_path, safe_name,
            epoch_length_ms, freq_band,
            custom_min_freq, custom_max_freq, single_freq,
            run_ica, z_threshold, pp_threshold_uv,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        logger.exception("Анализ завершился ошибкой")
        raise HTTPException(status_code=500, detail=f"Ошибка анализа: {e}") from e
    finally:
        # Загрузка удаляется и после успеха (F10): файл уже прочитан
        shutil.rmtree(upload_dir, ignore_errors=True)

    # Сохранить в БД (не падаем при сбое БД)
    try:
        await analysis_pipeline.save_analysis_to_db(result)
    except Exception:
        logger.exception("Не удалось сохранить результат в БД")

    return result


@router.post(
    "/recordings", status_code=201, response_model=RecordingMeta,
    summary="Загрузить EDF для просмотра (без обработки)",
)
async def create_recording(
    # ``response`` нужен, чтобы вернуть 200 при дедупликации (201 — по умолчанию).
    # Default — формальность для FastAPI-сигнатуры: обработчик всегда получает
    # инжектированный объект, а аннотация ``Response`` (без ``| None``) — единственная
    # форма, которую FastAPI распознаёт как специальный параметр.
    file: UploadFile = File(...), response: Response = Response(),
) -> RecordingMeta:
    """Сохраняет EDF и возвращает паспорт записи (каналы, sfreq, длительность).

    Артефакты/эпохи/диполи здесь не считаются: обработка стартует отдельной
    задачей по кнопке «Пересчитать предподготовку» (docs/ui.md). Файл остаётся
    в ``data/edf/<recording_id>/`` — его читают эндпоинты просмотра; устаревшие
    записи реестр удаляет по TTL и лимиту истории.

    Копии не плодятся: если файл с таким же содержимым (sha256) уже хранится, в
    том числе после рестарта процесса (отпечаток лежит в сайдкаре каталога),
    возвращается **существующая** запись с ``deduplicated=true`` (200), а только
    что записанная копия удаляется. Новая запись — 201.
    """
    safe_name = safe_edf_name(file.filename)
    tmp_path, upload_dir, digest = await save_upload(file, safe_name, with_digest=True)
    try:
        recording = await asyncio.to_thread(
            recording_registry.register, tmp_path, upload_dir, safe_name, settings, digest,
        )
    except ValueError as e:
        shutil.rmtree(upload_dir, ignore_errors=True)
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        shutil.rmtree(upload_dir, ignore_errors=True)
        logger.exception("Не удалось прочитать EDF %s", safe_name)
        raise HTTPException(status_code=400, detail=f"Не удалось прочитать EDF: {e}") from e

    if recording.deduplicated:
        # Такой файл уже хранится: только что записанная копия не нужна
        shutil.rmtree(upload_dir, ignore_errors=True)
        if response is not None:
            response.status_code = 200
        logger.info(
            "Загрузка %s: открыта существующая запись %s", safe_name, recording.recording_id,
        )

    # Строка записи в БД (4.4, шаг ①): сначала сироты — строка умершей записи
    # с тем же sha256 (каталог уже удалён) упёрлась бы в unique-индекс дедупа,
    # — затем upsert регистрации/дедупа (accessed_at — метрика TTL).
    # Best-effort: просмотр важнее БД (как у save_analysis_to_db).
    try:
        await recording_store.drop_orphan_rows()
        await recording_store.upsert_recording(recording)
    except Exception:
        logger.exception(
            "Не удалось обновить строку записи %s в БД", recording.recording_id,
        )
    return _meta_out(recording, recording.deduplicated)


@router.delete(
    "/recordings/{recording_id}", status_code=204,
    summary="Удалить запись и её результаты",
)
async def delete_recording(recording_id: str) -> Response:
    """Удаляет запись целиком (4.4): файл, кэши и строки БД каскадом (§8.4.3).

    TTL выключен по умолчанию («записи — не 24 ч») — это явное удаление
    вместе со всеми результатами: строками ``sessions``/``analyses``/``report_*``.
    404 — запись неизвестна или уже удалена; 204 — удалена.
    """
    require_recording(recording_id)
    await asyncio.to_thread(recording_registry.delete, recording_id)
    try:
        await recording_store.drop_recording_rows(recording_id)
    except Exception:
        # Файл уже удалён: строки уберёт обход сирот при следующем старте.
        logger.exception("Строки записи %s в БД не удалены", recording_id)
    return Response(status_code=204)


# ---------- read-API сессий (4.7): чтение строк результатов -----------------


@router.get(
    "/sessions", response_model=SessionsPageOut,
    summary="Список сессий (read-API 4.7)",
)
async def list_sessions(
    recording_id: str | None = Query(
        default=None, description="Только сессии этой записи (каскад TTL)",
    ),
    kind: str | None = Query(
        default=None,
        description="Источник строки: legacy | preprocess | dipoles | dipole_refine | spectrogram",
    ),
    limit: int = Query(default=50, ge=1, le=500, description="Размер страницы"),
    offset: int = Query(default=0, ge=0, description="Смещение (новые сверху)"),
) -> SessionsPageOut:
    """Страница сессий с агрегатами детей (эпохи/диполи) — вход Фазы 5.

    ``total`` считается до ``limit/offset``; работа — в
    ``results_store.list_sessions`` (тот же модуль, что пишет строки).
    """
    total, items = await results_store.list_sessions(
        recording_id=recording_id, kind=kind, limit=limit, offset=offset,
    )
    return SessionsPageOut(
        total=total, limit=limit, offset=offset,
        items=[SessionSummaryOut(**item) for item in items],
    )


@router.get(
    "/sessions/{session_id}", response_model=SessionDetailOut,
    summary="Паспорт сессии",
)
async def get_session(session_id: str) -> SessionDetailOut:
    """Сессия с числом эпох/диполей и ключами мощностей; 404 — не найдена."""
    detail = await results_store.get_session_detail(session_id)
    if detail is None:
        raise HTTPException(status_code=404, detail=f"Сессия {session_id} не найдена")
    return SessionDetailOut(**detail)


@router.get(
    "/sessions/{session_id}/epochs", response_model=list[EpochOut],
    summary="Эпохи сессии",
)
async def get_session_epochs(
    session_id: str,
    limit: int = Query(default=500, ge=1, le=5000, description="Размер страницы"),
    offset: int = Query(default=0, ge=0, description="Смещение (по epoch_index)"),
) -> list[EpochOut]:
    """Сетка эпох с мощностями полос (честные None — «не измерено»); 404 — нет сессии."""
    rows = await results_store.list_session_epochs(
        session_id, limit=limit, offset=offset,
    )
    if rows is None:
        raise HTTPException(status_code=404, detail=f"Сессия {session_id} не найдена")
    return [EpochOut(**row) for row in rows]


@router.get(
    "/sessions/{session_id}/dipoles", response_model=list[DipoleOut],
    summary="Диполи сессии",
)
async def get_session_dipoles(
    session_id: str,
    freq_band: str | None = Query(
        default=None, description="Фильтр по полосе прогона («lo-hi» Гц)",
    ),
    limit: int = Query(default=500, ge=1, le=5000, description="Размер страницы"),
    offset: int = Query(default=0, ge=0, description="Смещение (по эпохам)"),
) -> list[DipoleOut]:
    """Строки диполей для агрегатов Фазы 5 (ROI/полоса); 404 — нет сессии."""
    rows = await results_store.list_session_dipoles(
        session_id, freq_band=freq_band, limit=limit, offset=offset,
    )
    if rows is None:
        raise HTTPException(status_code=404, detail=f"Сессия {session_id} не найдена")
    return [DipoleOut(**row) for row in rows]


@router.get(
    "/recordings/{recording_id}", response_model=RecordingMeta,
    summary="Паспорт записи",
)
async def get_recording(recording_id: str) -> RecordingMeta:
    """Метаданные загруженной записи. 404 — неизвестна, устарела (TTL) или удалена."""
    return _meta_out(require_recording(recording_id))


@router.get(
    "/recordings/{recording_id}/signals",
    response_class=Response,
    responses={200: {"model": RecordingSignalsHeader, "content": {"application/octet-stream": {}}}},
    summary="Сигналы записи: float32-огибающая уровня зума (ETag)",
)
async def get_recording_signals(
    recording_id: str,
    level: int = Query(default=1, ge=1, description="Уровень пирамиды (множитель зума ×1…×16)"),
    layer: str = Query(
        default="raw",
        description="Слой видимости: raw (сырая пирамида) | cleaned (сигнал расчётов) | diff (вклад очистки)",
    ),
    # Параметры подготовленной базы слоёв cleaned/diff — та же форма, что у
    # стадии «Фильтр и референс» (шаг 2 плана «слои видимости»)
    band_min: float | None = Query(None, description="Нижняя граница полосы, Гц"),
    band_max: float | None = Query(None, description="Верхняя граница полосы, Гц"),
    band_key: str | None = Query(
        None,
        description="Ключ полосы для слоя band (фаза B): один из freq_bands/functional_bands",
    ),
    notch_hz: float | None = Query(None, description="Сетевой фильтр 50/60 Гц (None — выключен)"),
    reference_channels: str | None = Query(None, description="Каналы референса через запятую (без них — average)"),
    notch_harmonics: int = Query(0, description="Гармоники notch (100/150/200/240 Гц), 0–4"),
    bad_channels: str | None = Query(None, description="Плохие каналы через запятую («C3, T7»)"),
    interpolate_bads: bool = Query(False, description="Интерполировать bad-каналы (до ICA/SSP)"),
    clean_method: str = Query("none", description="Очистка: none | ica | ssp"),
    ica_n_components: int = Query(0, description="Число компонент ICA (0 — auto, MNE выберет)"),
    exclude_zone_ids: str | None = Query(
        None,
        description="Отменённые зоны вклада чистки через запятую (clean-1, clean-2…)",
    ),
    if_none_match: str | None = Header(default=None, alias="If-None-Match"),
) -> Response:
    """Огибающая сигналов для вьюера треков (срез 2.5, docs/ui.md §8).

    Ответ — бинарный контейнер float32 (см. ``RecordingSignalsHeader``):
    ``DPS1`` | ``uint32 LE len(header)`` | JSON-заголовок | payload каналов.
    Минимумы/максимумы считаются по временным корзинам, поэтому пики артефактов
    не теряются при прореживании. Уровень отдаётся с ``ETag``: повторный запрос
    с тем же ``If-None-Match`` получает 304, а сам уровень кэшируется на диске.

    ``layer`` — слой видимости (шаг 2 плана): ``raw`` — прежняя сырая пирамида
    (N14), ``cleaned``/``diff`` — подготовленный сигнал по параметрам формы
    «Фильтр и референс» и вклад очистки, ``band`` — персист подготовленного
    массива по именованной полосе ``band_key`` (Фаза B: полоса/очистка в query
    с ним несовместны — 400). Слой — видимость: правка параметра не
    запускает расчёт и не трогает стадии, но ETag включает параметры — смена
    полосы/очистки отдаёт другой уровень, а не молчаливую подмену.
    """
    recording = require_recording(recording_id)
    query = signals_layer_query(
        layer=layer,
        band_min=band_min,
        band_max=band_max,
        band_key=band_key,
        notch_hz=notch_hz,
        reference_channels=reference_channels,
        notch_harmonics=notch_harmonics,
        bad_channels=bad_channels,
        interpolate_bads=interpolate_bads,
        clean_method=clean_method,
        ica_n_components=ica_n_components,
        exclude_zone_ids=exclude_zone_ids,
    )
    try:
        data, version = await asyncio.to_thread(build_signal_blob, recording, level, settings, query)
    except SignalBuildError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return asset_response(
        data, version,
        if_none_match=if_none_match,
        media_type="application/octet-stream",
        # Запись живёт по TTL реестра, поэтому кэшируем приватно и недолго
        cache_control=CACHE_PRIVATE_HOUR,
        headers={"X-Signal-Level": str(level), "X-Signal-Layer": query.layer},
    )


@router.post(
    "/recordings/{recording_id}/preprocess", status_code=202, response_model=JobCreated,
    summary="Запустить стадию предподготовки (filter / artifacts / epochs)",
)
async def create_preprocess_job(
    recording_id: str,
    stage: PreprocessStage = Form(..., description="Стадия: filter | artifacts | epochs"),
    band_min: float | None = Form(None, description="Нижняя граница полосы, Гц; без пары — без фильтра"),
    band_max: float | None = Form(None, description="Верхняя граница полосы, Гц"),
    notch_hz: float | None = Form(None, description="Сетевой фильтр 50/60 Гц (None — выключен)"),
    reference: str = Form("average", description="average | custom"),
    reference_channels: str | None = Form(None, description="Каналы референса через запятую"),
    z_threshold: float = Form(5.0),
    pp_threshold_uv: float = Form(100.0),
    flat_line_uv: float = Form(5.0),
    flat_line_ms: float = Form(200.0),
    run_ica: bool = Form(False, description="ICA-ветка детекции (тяжёлая — по умолчанию выключена)"),
    epoch_length_ms: float = Form(2000.0),
    epoch_mode: str = Form("fixed", description="Режим нарезки: fixed | events (по событиям, N2)"),
    event_id: str | None = Form(None, description="Описание события нарезки (режим events)"),
    epoch_pre_ms: float = Form(200.0, description="Окно до события, мс (режим events)"),
    epoch_post_ms: float = Form(800.0, description="Окно после события, мс (режим events)"),
    notch_harmonics: int = Form(0, description="Гармоники notch (100/150/200 Гц), 0–4"),
    bad_channels: str | None = Form(None, description="Плохие каналы через запятую"),
    interpolate_bads: bool = Form(False, description="Интерполировать bad-каналы (до ICA/SSP)"),
    clean_method: str = Form("none", description="Очистка артефактов: none | ica | ssp"),
    ica_n_components: int = Form(0, description="Компонент ICA (0 — auto)"),
    exclude_zone_ids: str | None = Form(
        None,
        description="Отменённые зоны вклада чистки через запятую (clean-1, clean-2…)",
    ),
) -> JobCreated:
    """Предподготовка записи **по кнопке**: одна стадия = одна задача.

    Правка параметров в UI ничего не запускает (docs/ui.md) — расчёт стартует
    только этим запросом. Стадии раздельные: пересчёт фильтра не обесценивает
    найденные артефакты, а результат каждой стадии клиент подтверждает снимком
    параметров (`stageApplied` в сторе раздела).

    Задача возвращается сразу (202 + ``job_id``): прогресс — в ``GET /jobs/{id}``,
    результат — в ``GET /recordings/{id}/preprocess/{job_id}``.
    """
    recording = require_recording(recording_id)
    params = preprocess_params(
        stage=stage,
        band_min=band_min, band_max=band_max,
        notch_hz=notch_hz,
        reference=reference, reference_channels=reference_channels,
        z_threshold=z_threshold, pp_threshold_uv=pp_threshold_uv,
        flat_line_uv=flat_line_uv, flat_line_ms=flat_line_ms,
        run_ica=run_ica,
        epoch_length_ms=epoch_length_ms,
        epoch_mode=epoch_mode,
        event_id=event_id,
        epoch_pre_ms=epoch_pre_ms,
        epoch_post_ms=epoch_post_ms,
        notch_harmonics=notch_harmonics, bad_channels=bad_channels,
        interpolate_bads=interpolate_bads,
        clean_method=clean_method, ica_n_components=ica_n_components,
        exclude_zone_ids=exclude_zone_ids,
    )
    return submit_recording_job("preprocess", recording, params, meta={"stage": stage})


@router.get(
    "/recordings/{recording_id}/preprocess/{job_id}", response_model=PreprocessResult,
    summary="Результат стадии предподготовки",
)
async def get_preprocess_result(recording_id: str, job_id: str) -> PreprocessResult:
    """Результат стадии. 409 — задача идёт или упала; 404 — чужой/неизвестный job."""
    job = recording_job_result(recording_id, job_id, "preprocess")
    return PreprocessResult(**job.result)


@router.post(
    "/recordings/{recording_id}/evoked", status_code=202, response_model=JobCreated,
    summary="Запустить ERP-усреднение по событиям (стимул → эпоха → усреднение)",
)
async def create_evoked_job(
    recording_id: str,
    event_id: str = Form(..., description="Описание события из паспорта записи"),
    epoch_pre_ms: float = Form(200.0, description="Окно до события, мс"),
    epoch_post_ms: float = Form(800.0, description="Окно после события, мс"),
    baseline_start_ms: float | None = Form(
        None, description="Baseline: начало, мс от события (пара с end; пусто — без коррекции)"
    ),
    baseline_end_ms: float | None = Form(None, description="Baseline: конец, мс от события"),
    band_min: float | None = Form(None, description="Нижняя граница полосы, Гц; без пары — без фильтра"),
    band_max: float | None = Form(None, description="Верхняя граница полосы, Гц"),
    notch_hz: float | None = Form(None, description="Сетевой фильтр 50/60 Гц (None — выключен)"),
    reference: str = Form("average", description="average | custom"),
    reference_channels: str | None = Form(None, description="Каналы референса через запятую"),
    z_threshold: float = Form(5.0),
    pp_threshold_uv: float = Form(100.0),
    flat_line_uv: float = Form(5.0),
    flat_line_ms: float = Form(200.0),
    run_ica: bool = Form(False, description="ICA-ветка детекции (тяжёлая — по умолчанию выключена)"),
    notch_harmonics: int = Form(0, description="Гармоники notch (100/150/200 Гц), 0–4"),
    bad_channels: str | None = Form(None, description="Плохие каналы через запятую"),
    interpolate_bads: bool = Form(False, description="Интерполировать bad-каналы (до ICA/SSP)"),
    clean_method: str = Form("none", description="Очистка артефактов: none | ica | ssp"),
    ica_n_components: int = Form(0, description="Компонент ICA (0 — auto)"),
) -> JobCreated:
    """ERP-усреднение по событиям записи **по кнопке** (шаг 2.7).

    Форма повторяет форму стадии «Нарезка эпох» (те же пороги отбраковки —
    числа согласованы со штриховкой вьюера) плюс окно события и baseline.
    Задача возвращается сразу (202 + ``job_id``): прогресс — в ``GET /jobs/{id}``,
    результат — в ``GET /recordings/{id}/evoked/{job_id}``.
    """
    recording = require_recording(recording_id)
    params = evoked_params(
        event_id=event_id,
        epoch_pre_ms=epoch_pre_ms, epoch_post_ms=epoch_post_ms,
        baseline_start_ms=baseline_start_ms, baseline_end_ms=baseline_end_ms,
        band_min=band_min, band_max=band_max,
        notch_hz=notch_hz,
        reference=reference, reference_channels=reference_channels,
        z_threshold=z_threshold, pp_threshold_uv=pp_threshold_uv,
        flat_line_uv=flat_line_uv, flat_line_ms=flat_line_ms,
        run_ica=run_ica,
        notch_harmonics=notch_harmonics, bad_channels=bad_channels,
        interpolate_bads=interpolate_bads,
        clean_method=clean_method, ica_n_components=ica_n_components,
    )
    return submit_recording_job("evoked", recording, params, meta={"event_id": event_id})


@router.get(
    "/recordings/{recording_id}/evoked/{job_id}", response_model=EvokedResult,
    summary="Результат ERP-усреднения по событиям",
)
async def get_evoked_result(recording_id: str, job_id: str) -> EvokedResult:
    """Результат задачи ERP. 409 — задача идёт или упала; 404 — чужой/неизвестный job."""
    job = recording_job_result(recording_id, job_id, "evoked")
    return EvokedResult(**job.result)


@router.post(
    "/recordings/{recording_id}/spectrum", status_code=202, response_model=JobCreated,
    summary="Запустить расчёт спектра по диапазонам (Welch или multitaper PSD)",
)
async def create_spectrum_job(
    recording_id: str,
    band_min: float | None = Form(None, description="Нижняя граница полосы, Гц; без пары — без фильтра"),
    band_max: float | None = Form(None, description="Верхняя граница полосы, Гц"),
    notch_hz: float | None = Form(None, description="Сетевой фильтр 50/60 Гц (None — выключен)"),
    reference: str = Form("average", description="average | custom"),
    reference_channels: str | None = Form(None, description="Каналы референса через запятую"),
    epoch_length_ms: float = Form(2000.0, description="Длина эпохи для PSD"),
    psd_method: str = Form("welch", description="Метод PSD: welch | multitaper (N17)"),
) -> JobCreated:
    """Спектр записи по ритмам δ…γ — фоновой задачей (202 + ``job_id``).

    Ответ задачи (``GET /recordings/{id}/spectrum/{job_id}``) содержит числа PSD
    и ссылки на топокарты диапазонов; картинки отдаёт отдельный кэшируемый
    эндпоинт ``/spectrum/topomap/{band}.png`` с ETag/304. Расчёт стартует только
    этим запросом (правило «обработка — по кнопке», docs/ui.md).
    """
    recording = require_recording(recording_id)
    params = spectrum_params(
        band_min=band_min, band_max=band_max,
        notch_hz=notch_hz,
        reference=reference, reference_channels=reference_channels,
        epoch_length_ms=epoch_length_ms,
        psd_method=psd_method,
    )
    return submit_recording_job(
        "spectrum", recording, params, meta={"epoch_length_ms": epoch_length_ms},
    )


@router.get(
    "/recordings/{recording_id}/spectrum/{job_id}", response_model=SpectrumResult,
    summary="Результат расчёта спектра",
)
async def get_spectrum_result(recording_id: str, job_id: str) -> SpectrumResult:
    """Числа PSD по диапазонам и ссылки на топокарты. 409 — задача идёт/упала."""
    job = recording_job_result(recording_id, job_id, "spectrum")
    return SpectrumResult(**job.result)


@router.get(
    "/recordings/{recording_id}/spectrum/topomap/{band}.png",
    response_class=Response,
    responses={200: {"content": {"image/png": {}}}},
    summary="Топокарта диапазона (PNG, ETag)",
)
async def get_spectrum_topomap(
    recording_id: str,
    band: str,
    band_min: float | None = Query(None, description="Полоса фильтра, нижняя граница, Гц"),
    band_max: float | None = Query(None, description="Полоса фильтра, верхняя граница, Гц"),
    notch_hz: float | None = Query(None, description="Сетевой фильтр, Гц"),
    epoch_length_ms: float = Query(2000.0, description="Длина эпохи для PSD"),
    psd_method: str = Query("welch", description="Метод PSD: welch | multitaper (входит в ETag)"),
    if_none_match: str | None = Header(default=None, alias="If-None-Match"),
) -> Response:
    """PNG топокарты ритма в раскладке скальпа; вне круга голова прозрачна.

    Параметры фильтра, эпохи и метода PSD входят в ETag: картинка соответствует
    **своему** расчёту, и смена фильтра или метода не отдаёт старую. Кэш —
    дисковый, поэтому повторный запрос не пересчитывает PSD, а промах кэша
    пересчитывает (как пирамида сигналов, 2.5). Неизвестный диапазон — 400,
    чужая запись — 404.
    """
    recording = require_recording(recording_id)
    # Референс в query топокарты не передаётся (контракт URL среза 3.4): берём
    # значение по умолчанию, как раньше; полоса, notch, эпоха и метод — из параметров.
    params = spectrum_params(
        band_min=band_min, band_max=band_max,
        notch_hz=notch_hz,
        reference="average", reference_channels=None,
        epoch_length_ms=epoch_length_ms,
        psd_method=psd_method,
    )
    try:
        data, version = await asyncio.to_thread(
            cached_topomap, recording, settings, params, band,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return asset_response(
        data, version,
        if_none_match=if_none_match,
        media_type="image/png",
        cache_control=CACHE_PRIVATE_DAY,
        headers={"X-Spectrum-Band": band},
    )


@router.post(
    "/compare", status_code=202, response_model=JobCreated,
    summary="Дифференциальный анализ двух записей (покой vs деятельность)",
)
async def create_compare_job(
    recording_id_a: str = Form(..., description="Запись A — первая сторона пары (например, покой)"),
    recording_id_b: str = Form(..., description="Запись B — вторая сторона (например, деятельность)"),
    label_a: str = Form("Покой", description="Ярлык условия A (до 64 символов)"),
    label_b: str = Form("Деятельность", description="Ярлык условия B"),
    band_min: float | None = Form(None, description="Нижняя граница полосы, Гц; без пары — без фильтра"),
    band_max: float | None = Form(None, description="Верхняя граница полосы, Гц"),
    notch_hz: float | None = Form(None, description="Сетевой фильтр 50/60 Гц (None — выключен)"),
    reference: str = Form("average", description="average | custom"),
    reference_channels: str | None = Form(None, description="Каналы референса через запятую"),
    epoch_length_ms: float = Form(2000.0, description="Длина эпохи для PSD"),
    psd_method: str = Form("welch", description="Метод PSD: welch | multitaper (N17)"),
    tfr_event: str | None = Form(
        None,
        description="Описание события для TFR/ERDS-карт; пусто — без событийной ветки",
    ),
    tfr_tmin_ms: float = Form(-500.0, description="Начало окна TFR относительно события, мс"),
    tfr_tmax_ms: float = Form(1500.0, description="Конец окна TFR, мс"),
    tfr_baseline_start_ms: float = Form(-500.0, description="Baseline TFR: начало, мс"),
    tfr_baseline_end_ms: float = Form(-100.0, description="Baseline TFR: конец, мс до события"),
) -> JobCreated:
    """Две записи → общая обработка → дельты по полосам, статистика, карты разности.

    Шлюз параметров пары (400 до старта задачи): записи разные, одинаковая
    частота дискретизации и хотя бы один общий канал — без этого дельты не
    определены (B9 «совпадение параметров»). Обе стороны обрабатываются
    **одними и теми же** параметрами: это и есть гарантия сравнимости.
    Дельты всегда B − A.
    """
    recording_a = require_recording(recording_id_a)
    recording_b = require_recording(recording_id_b)
    if recording_a.recording_id == recording_b.recording_id:
        raise HTTPException(
            status_code=400,
            detail="Сравнивать нужно две разные записи (A и B совпадают)",
        )
    sfreq_a = float(recording_a.meta.get("sfreq") or 0.0)
    sfreq_b = float(recording_b.meta.get("sfreq") or 0.0)
    if sfreq_a <= 0 or sfreq_b <= 0 or not math.isclose(sfreq_a, sfreq_b, rel_tol=1e-9):
        raise HTTPException(
            status_code=400,
            detail=(
                f"Частоты дискретизации различаются ({sfreq_a:g} vs {sfreq_b:g} Гц) — "
                "сравнение не определено"
            ),
        )
    channels_a = set(recording_a.meta.get("channels") or [])
    channels_b = set(recording_b.meta.get("channels") or [])
    if not (channels_a & channels_b):
        raise HTTPException(
            status_code=400, detail="Записи не имеют ни одного общего канала — сравнивать нечего",
        )
    params = compare_params(
        label_a=label_a, label_b=label_b,
        band_min=band_min, band_max=band_max,
        notch_hz=notch_hz, reference=reference, reference_channels=reference_channels,
        epoch_length_ms=epoch_length_ms, psd_method=psd_method,
        tfr_event=tfr_event, tfr_tmin_ms=tfr_tmin_ms, tfr_tmax_ms=tfr_tmax_ms,
        tfr_baseline_start_ms=tfr_baseline_start_ms,
        tfr_baseline_end_ms=tfr_baseline_end_ms,
    )
    # Событийная ветка: шлюз «событие есть в обеих записях» до старта задачи —
    # иначе 404 на середине дороги, когда PSD уже посчитан.
    if params.tfr is not None:
        for side, recording in (("A", recording_a), ("B", recording_b)):
            counts = recording.meta.get("event_counts") or {}
            if not counts:
                ensure_record_events(recording, settings)
                counts = recording.meta.get("event_counts") or {}
            if params.tfr.event_id not in counts:
                available = ", ".join(f"«{key}»" for key in sorted(counts)) or "нет"
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"Событие «{params.tfr.event_id}» не найдено в записи {side}: "
                        f"доступные события — {available}"
                    ),
                )
    return submit_compare_job(recording_a, recording_b, params)


@router.get(
    "/compare/{job_id}", response_model=CompareResult,
    summary="Результат дифференциального анализа двух записей",
)
async def get_compare_result(job_id: str) -> CompareResult:
    """Дельты, статистика и ссылки на карты разности. 409 — задача идёт/упала."""
    job = compare_job_result(job_id)
    return CompareResult(**job.result)


@router.get(
    "/compare/{job_id}/report", response_model=ReportHtmlOut,
    summary="Отчёт по результату сравнения (Тип 1) — раздел «Итоги»",
)
async def get_compare_report(job_id: str) -> ReportHtmlOut:
    """Сборка/чтение HTML-отчёта по готовому результату ``kind=compare``.

    Ленивая сборка — тот же приём, что промах кэша карт разности: первый
    запрос строит самодостаточный ``mne.Report`` в дисковый кэш, повторные
    читают его. 404/409 — как у ``GET /compare/{job_id}`` (чужой вид задачи
    или «ещё не завершена»).
    """
    job = compare_job_result(job_id)
    doc = await asyncio.to_thread(
        ensure_compare_report, settings, job_id, dict(job.result),
    )
    prefix = settings.api_prefix
    return ReportHtmlOut(
        title=doc.title,
        html_sig=doc.sig,
        report_version=doc.version,
        html_url=f"{prefix}/compare/{job_id}/report/html",
        warnings=doc.warnings,
    )


@router.get(
    "/compare/{job_id}/report/html",
    response_class=Response,
    responses={200: {"content": {"text/html": {}}}},
    summary="HTML отчёта по сравнению: самодостаточный MNE.Report (ETag)",
)
async def get_compare_report_html(
    job_id: str,
    if_none_match: str | None = Header(default=None, alias="If-None-Match"),
) -> Response:
    """HTML отчёта Типа 1: та же сборка, что и метаданные, и ETag/304.

    Документ самодостаточный (карты разности встроены base64 при наличии в
    кэше), поэтому открывается в новой вкладке и печатается без запросов.
    """
    job = compare_job_result(job_id)
    doc = await asyncio.to_thread(
        ensure_compare_report, settings, job_id, dict(job.result),
    )
    return asset_response(
        doc.data,
        doc.version,
        if_none_match=if_none_match,
        media_type="text/html",
        cache_control=CACHE_PRIVATE_DAY,
    )


@router.get(
    "/compare/topomap/{band}.png",
    response_class=Response,
    responses={200: { "content": {"image/png": {}} }},
    summary="Карта разности B−A по полосе (PNG, ETag)",
)
async def get_compare_topomap(
    band: str,
    recording_id_a: str = Query(..., description="Запись A"),
    recording_id_b: str = Query(..., description="Запись B"),
    band_min: float | None = Query(None, description="Полоса фильтра, нижняя граница, Гц"),
    band_max: float | None = Query(None, description="Полоса фильтра, верхняя граница, Гц"),
    notch_hz: float | None = Query(None, description="Сетевой фильтр, Гц"),
    epoch_length_ms: float = Query(2000.0, description="Длина эпохи для PSD"),
    psd_method: str = Query("welch", description="Метод PSD: welch | multitaper (входит в ETag)"),
    reference: str = Query("average", description="Референс (входит в ETag)"),
    reference_channels: str | None = Query(None, description="Каналы референса через запятую"),
    if_none_match: str | None = Header(default=None, alias="If-None-Match"),
) -> Response:
    """Дельты дБ по каналам полосы: дивергентная палитра, шкала (−m, m).

    Подпись ETag включает параметры и **обе** записи; промах кэша пересчитывает
    пару (кэш prepared_raw делает повтор дешёвым), как у топокарт спектра.
    """
    recording_a = require_recording(recording_id_a)
    recording_b = require_recording(recording_id_b)
    params = compare_params(
        label_a="", label_b="",
        band_min=band_min, band_max=band_max,
        notch_hz=notch_hz, reference=reference, reference_channels=reference_channels,
        epoch_length_ms=epoch_length_ms, psd_method=psd_method,
    )
    try:
        data, version = await asyncio.to_thread(
            cached_compare_topomap, recording_a, recording_b, settings, params, band,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return asset_response(
        data, version,
        if_none_match=if_none_match,
        media_type="image/png",
        cache_control=CACHE_PRIVATE_DAY,
        headers={"X-Compare-Band": band},
    )


@router.post(
    "/recordings/{recording_id}/dipoles", status_code=202, response_model=JobCreated,
    summary="Быстрый расчёт диполей (перебор сетки, одна точка на эпоху)",
)
async def create_dipole_scan_job(
    recording_id: str,
    band_min: float | None = Form(None, description="Нижняя граница полосы, Гц"),
    band_max: float | None = Form(None, description="Верхняя граница полосы, Гц"),
    notch_hz: float | None = Form(None, description="Сетевой фильтр 50/60 Гц"),
    reference: str = Form("average", description="average | custom"),
    reference_channels: str | None = Form(None, description="Каналы референса через запятую"),
    epoch_length_ms: float = Form(1000.0, description="Длина эпохи для расчёта"),
    grid_mm: float = Form(7.0, ge=2.0, le=20.0, description="Шаг объёмной сетки поиска, мм"),
) -> JobCreated:
    """Быстрый режим («fast»): одна точка на эпоху в пике GFP на сетке узлов.

    Точный фитинг (`mne.fit_dipole` на BEM) — отдельный профиль; здесь результат
    помечен ``method='fast_grid'``, и UI показывает эту метку, а не выдаёт быстрый
    расчёт за точный (`docs/ui.md` §12).
    """
    recording = require_recording(recording_id)
    params = dipole_scan_params(
        band_min=band_min, band_max=band_max,
        notch_hz=notch_hz,
        reference=reference, reference_channels=reference_channels,
        epoch_length_ms=epoch_length_ms,
        grid_mm=grid_mm,
    )
    return submit_recording_job(
        "dipoles", recording, params, meta={"epoch_length_ms": epoch_length_ms},
    )


@router.get(
    "/recordings/{recording_id}/dipoles/{job_id}", response_model=DipoleScanResult,
    summary="Результат быстрого расчёта диполей",
)
async def get_dipole_scan_result(recording_id: str, job_id: str) -> DipoleScanResult:
    """Точки диполей (MNI, момент, амплитуда, GOF). 409 — задача идёт или упала."""
    job = recording_job_result(recording_id, job_id, "dipoles")
    return DipoleScanResult(**job.result)


@router.post(
    "/recordings/{recording_id}/dipole_refine", status_code=202, response_model=JobCreated,
    summary="Точное уточнение одной эпохи (BEM fit_dipole в окне пика GFP)",
)
async def create_dipole_refine_job(
    recording_id: str,
    epoch_index: int = Form(..., ge=0, description="Номер эпохи нарезки быстрого расчёта (с 0)"),
    band_min: float | None = Form(None, description="Нижняя граница полосы, Гц"),
    band_max: float | None = Form(None, description="Верхняя граница полосы, Гц"),
    notch_hz: float | None = Form(None, description="Сетевой фильтр 50/60 Гц"),
    reference: str = Form("average", description="average | custom"),
    reference_channels: str | None = Form(None, description="Каналы референса через запятую"),
    epoch_length_ms: float = Form(1000.0, description="Длина эпохи — как в быстром расчёте"),
    grid_mm: float = Form(7.0, ge=2.0, le=20.0, description="Шаг сетки быстрого расчёта, мм"),
    halfwin_ms: float | None = Form(
        None,
        description=(
            "Половина окна свободного фитинга вокруг пика GFP, мс (0 — только пик; "
            "пусто — дефолт сервера)"
        ),
    ),
) -> JobCreated:
    """Кнопка «Уточнить для эпохи…» (F19): `mne.fit_dipole` на BEM fsaverage.

    Параметры нарезки обязаны повторять быстрый расчёт (UI шлёт поля результата,
    а не текущую форму): ``epoch_index`` привязан к той нарезке. В ответе —
    «было/стало»: узел сетки (и его GOF на BEM) и уточнённая точка.
    """
    recording = require_recording(recording_id)
    params = dipole_refine_params(
        epoch_index=epoch_index,
        band_min=band_min, band_max=band_max,
        notch_hz=notch_hz,
        reference=reference, reference_channels=reference_channels,
        epoch_length_ms=epoch_length_ms,
        grid_mm=grid_mm,
        halfwin_ms=halfwin_ms,
    )
    return submit_recording_job(
        "dipole_refine", recording, params,
        meta={"epoch_index": epoch_index, "halfwin_ms": params.halfwin_ms},
    )


@router.get(
    "/recordings/{recording_id}/dipole_refine/{job_id}", response_model=DipoleRefineResult,
    summary="Результат точного уточнения эпохи",
)
async def get_dipole_refine_result(recording_id: str, job_id: str) -> DipoleRefineResult:
    """«Было/стало»: узел сетки и уточнённая BEM-точка. 409 — задача идёт/упала."""
    job = recording_job_result(recording_id, job_id, "dipole_refine")
    return DipoleRefineResult(**job.result)


@router.post(
    "/recordings/{recording_id}/eloreta", status_code=202, response_model=JobCreated,
    summary="eLORETA: пик и ROI-доли распределения одной эпохи (остаток B9)",
)
async def create_eloreta_job(
    recording_id: str,
    epoch_index: int = Form(..., ge=0, description="Номер эпохи нарезки быстрого расчёта (с 0)"),
    band_min: float | None = Form(None, description="Нижняя граница полосы, Гц"),
    band_max: float | None = Form(None, description="Верхняя граница полосы, Гц"),
    notch_hz: float | None = Form(None, description="Сетевой фильтр 50/60 Гц"),
    reference: str = Form("average", description="average | custom"),
    reference_channels: str | None = Form(None, description="Каналы референса через запятую"),
    epoch_length_ms: float = Form(1000.0, description="Длина эпохи — как в быстром расчёте"),
    grid_mm: float = Form(7.0, ge=2.0, le=20.0, description="Шаг сетки быстрого расчёта, мм"),
    halfwin_ms: float | None = Form(
        None,
        description=(
            "Половина окна вокруг пика GFP, мс (0 — отсчёт пика; "
            "пусто — дефолт сервера)"
        ),
    ),
) -> JobCreated:
    """Пик/ROI eLORETA на одной эпохе (dipoles.md п.5: **не полные карты**).

    Форма — та же, что у «Уточнить»: нарезка обязана повторять быстрый расчёт
    (``epoch_index`` привязан к ней). Результат: пик распределения (координата +
    анатомия из общего источника) и доли энергии по структурам — объём честно
    ограничен, полные карты не отдаются.
    """
    recording = require_recording(recording_id)
    params = eloreta_params(
        epoch_index=epoch_index,
        band_min=band_min, band_max=band_max,
        notch_hz=notch_hz, reference=reference, reference_channels=reference_channels,
        epoch_length_ms=epoch_length_ms,
        grid_mm=grid_mm,
        halfwin_ms=halfwin_ms,
    )
    return submit_recording_job(
        "eloreta", recording, params,
        meta={"epoch_index": epoch_index, "halfwin_ms": params.halfwin_ms},
    )


@router.get(
    "/recordings/{recording_id}/eloreta/{job_id}", response_model=EloretaResult,
    summary="Результат eLORETA: пик и ROI-доли эпохи",
)
async def get_eloreta_result(recording_id: str, job_id: str) -> EloretaResult:
    """Пик + ROI одной эпохи. 409 — задача идёт/упала."""
    job = recording_job_result(recording_id, job_id, "eloreta")
    return EloretaResult(**job.result)


@router.post(
    "/recordings/{recording_id}/report", status_code=202, response_model=JobCreated,
    summary="Собрать сквозной автоотчёт (MNE.Report + пакет диполей по полосам)",
)
async def create_report_job(
    recording_id: str,
    band_min: float | None = Form(None, description="Нижняя граница полосы, Гц; без пары — без фильтра"),
    band_max: float | None = Form(None, description="Верхняя граница полосы, Гц"),
    notch_hz: float | None = Form(None, description="Сетевой фильтр 50/60 Гц (None — выключен)"),
    reference: str = Form("average", description="average | custom"),
    reference_channels: str | None = Form(None, description="Каналы референса через запятую"),
    z_threshold: float = Form(5.0),
    pp_threshold_uv: float = Form(100.0),
    flat_line_uv: float = Form(5.0),
    flat_line_ms: float = Form(200.0),
    run_ica: bool = Form(False, description="ICA-ветка детекции (тяжёлая — по умолчанию выключена)"),
    epoch_length_ms: float = Form(1000.0, description="Длина эпохи (часть 1 и пакет)"),
    notch_harmonics: int = Form(0, description="Гармоники notch (100/150/200 Гц), 0–4"),
    bad_channels: str | None = Form(None, description="Плохие каналы через запятую"),
    interpolate_bads: bool = Form(False, description="Интерполировать bad-каналы (до ICA/SSP)"),
    clean_method: str = Form("none", description="Очистка артефактов: none | ica | ssp"),
    ica_n_components: int = Form(0, description="Компонент ICA (0 — auto)"),
    exclude_zone_ids: str | None = Form(
        None, description="Отменённые зоны вклада чистки через запятую (clean-1, clean-2…)",
    ),
    grid_mm: float = Form(7.0, ge=2.0, le=20.0, description="Шаг объёмной сетки поиска, мм"),
    bands: str | None = Form(
        None,
        description="Ключи полос пакета через запятую (δ,θ,…); пусто — все полосы /meta",
    ),
    epoch_mode: str = Form(
        "fixed",
        description="Нарезка части 1: fixed | events (событийная — часть 2 пакета не меняет)",
    ),
    event_id: str | None = Form(None, description="Описание события (режим events)"),
    epoch_pre_ms: float = Form(200.0, description="Окно до события, мс (режим events)"),
    epoch_post_ms: float = Form(800.0, description="Окно после события, мс (режим events)"),
) -> JobCreated:
    """Автоотчёт раздела «Итоги» — одна задача в три ступени.

    Ступени: три стадии препроцессинга (часть 1 — **те же** параметры и числа,
    что раздел EDF: форма здесь повторяет форму стадий; нарезка fixed/events —
    какой бы ни была нарезка EDF, отчёт её пересказывает) → пакетный быстрый
    расчёт диполей по полосам (часть 2, агрегаты структур/BA; пакет **всегда**
    на fixed-нарезке — событийные диполи отдельная задача, events.md п.8) →
    сборка самодостаточного ``mne.Report`` в дисковый кэш. Результат задачи —
    агрегаты и ссылка ``html_url``; сам HTML — отдельный ассет с ETag ниже.
    """
    recording = require_recording(recording_id)
    params = report_params(
        band_min=band_min, band_max=band_max,
        notch_hz=notch_hz, reference=reference, reference_channels=reference_channels,
        z_threshold=z_threshold, pp_threshold_uv=pp_threshold_uv,
        flat_line_uv=flat_line_uv, flat_line_ms=flat_line_ms,
        run_ica=run_ica, epoch_length_ms=epoch_length_ms,
        notch_harmonics=notch_harmonics, bad_channels=bad_channels,
        interpolate_bads=interpolate_bads,
        clean_method=clean_method, ica_n_components=ica_n_components,
        exclude_zone_ids=exclude_zone_ids,
        grid_mm=grid_mm, bands=bands,
        epoch_mode=epoch_mode, event_id=event_id,
        epoch_pre_ms=epoch_pre_ms, epoch_post_ms=epoch_post_ms,
    )
    # Шлюз «событие есть в записи» — до старта задачи (как у сравнения):
    # иначе на середине дороги, когда стадии уже посчитаны.
    if params.preprocess.epoch_mode == "events":
        counts = recording.meta.get("event_counts") or {}
        if not counts:
            ensure_record_events(recording, settings)
            counts = recording.meta.get("event_counts") or {}
        if (params.preprocess.event_id or "") not in counts:
            available = ", ".join(f"«{key}»" for key in sorted(counts)) or "нет"
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Событие «{params.preprocess.event_id}» не найдено в записи "
                    f"{recording.filename}: доступные события — {available}"
                ),
            )
    return submit_recording_job(
        "report", recording, params, meta={"bands": params.band_keys},
    )


@router.get(
    "/recordings/{recording_id}/report/{job_id}", response_model=ReportResult,
    summary="Результат автоотчёта (агрегаты полос и ссылка на HTML)",
)
async def get_report_result(recording_id: str, job_id: str) -> ReportResult:
    """Сводка отчёта: QC, эпохи, агрегаты по полосам. 409 — задача идёт/упала.

    ``html_url`` собирается здесь, а не в воркере: воркер не знает ``job_id``
    (задача создаётся после него), а ссылка адресуется именно задаче.
    """
    job = recording_job_result(recording_id, job_id, "report")
    result = dict(job.result)
    result["html_url"] = (
        f"{settings.api_prefix}/recordings/{recording_id}/report/{job_id}/html"
    )
    return ReportResult(**result)


@router.get(
    "/recordings/{recording_id}/report/{job_id}/html",
    response_class=Response,
    responses={200: {"content": {"text/html": {}}}},
    summary="HTML автоотчёта: самодостаточный MNE.Report (ETag)",
)
async def get_report_html(
    recording_id: str,
    job_id: str,
    if_none_match: str | None = Header(default=None, alias="If-None-Match"),
) -> Response:
    """HTML отчёта из дискового кэша с ETag/304 (единая отдача — ``assets.py``).

    Печать попадает в результат задачи (``html_sig``): ассет соответствует
    ровно тому расчёту, который показан на экране. Кэш очищается вместе с
    записью — тогда ответ 404 с просьбой собрать отчёт заново.
    """
    job = recording_job_result(recording_id, job_id, "report")
    signature = str((job.result or {}).get("html_sig") or "")
    cached = await asyncio.to_thread(read_report_html, settings, recording_id, signature)
    if cached is None:
        raise HTTPException(
            status_code=404,
            detail="HTML автоотчёта очищен — соберите отчёт заново",
        )
    data, version = cached
    return asset_response(
        data,
        version,
        if_none_match=if_none_match,
        media_type="text/html",
        cache_control=CACHE_PRIVATE_DAY,
    )


@router.post(
    "/recordings/{recording_id}/spectrogram", status_code=202, response_model=JobCreated,
    summary="Запустить расчёт спектрограммы канала (STFT)",
)
async def create_spectrogram_job(
    recording_id: str,
    channel: str = Form("", description="Канал, по которому считается спектрограмма"),
    band_min: float | None = Form(None, description="Нижняя граница полосы, Гц; без пары — без фильтра"),
    band_max: float | None = Form(None, description="Верхняя граница полосы, Гц"),
    notch_hz: float | None = Form(None, description="Сетевой фильтр 50/60 Гц (None — выключен)"),
    reference: str = Form("average", description="average | custom"),
    reference_channels: str | None = Form(None, description="Каналы референса через запятую"),
    window_ms: float = Form(500.0, description="Длина окна STFT, мс"),
    overlap_pct: float = Form(75.0, description="Перекрытие окон, %"),
    fmax_hz: float = Form(40.0, description="Верхняя частота сетки, Гц"),
) -> JobCreated:
    """Спектрограмма выбранного канала — фоновой задачей (202 + ``job_id``).

    Ответ задачи (``GET /recordings/{id}/spectrogram/{job_id}``) отдаёт
    **метаданные** сетки и ссылку на числа; сами числа приходят бинарным
    контейнером (``…/grid.bin``, ``SpectrogramGridHeader``): строк на частоты ×
    столбцов на времена слишком много для JSON-ответа. Палитра, окно дБ и
    сглаживание — параметры просмотра UI, они сетку не пересчитывают.
    """
    recording = require_recording(recording_id)
    params = spectrogram_params(
        channel=channel,
        band_min=band_min, band_max=band_max,
        notch_hz=notch_hz,
        reference=reference, reference_channels=reference_channels,
        window_ms=window_ms, overlap_pct=overlap_pct, fmax_hz=fmax_hz,
    )
    return submit_recording_job("spectrogram", recording, params, meta={"channel": channel})


@router.get(
    "/recordings/{recording_id}/spectrogram/{job_id}", response_model=SpectrogramResult,
    summary="Результат расчёта спектрограммы (метаданные сетки)",
)
async def get_spectrogram_result(recording_id: str, job_id: str) -> SpectrogramResult:
    """Метаданные сетки + ссылка на числа. 409 — задача идёт или упала.

    ``grid_url`` собирается здесь, а не в воркере: воркер не знает ``job_id``
    (задача создаётся после него), а ссылка адресуется именно задаче.
    """
    job = recording_job_result(recording_id, job_id, "spectrogram")
    result = dict(job.result)
    result["grid_url"] = spectrogram_grid_url(settings, recording_id, job_id)
    return SpectrogramResult(**result)


@router.get(
    "/recordings/{recording_id}/spectrogram/{job_id}/grid.bin",
    response_class=Response,
    responses={200: {"model": SpectrogramGridHeader, "content": {"application/octet-stream": {}}}},
    summary="Сетка спектрограммы: float32 дБ (ETag)",
)
async def get_spectrogram_grid(
    recording_id: str,
    job_id: str,
    if_none_match: str | None = Header(default=None, alias="If-None-Match"),
) -> Response:
    """Сетка уровней (дБ) как бинарный контейнер ``DPS2`` с ETag/304.

    Параметры расчёта берутся из **результата задачи**, а не из query: сетка
    соответствует именно тому расчёту, который показан на экране. При промахе
    дискового кэша сетка пересчитывается (как топокарты, 3.4).
    """
    job = recording_job_result(recording_id, job_id, "spectrogram")
    recording = require_recording(recording_id)
    result = job.result
    params = stored_spectrogram_params(result)
    try:
        data, version = await asyncio.to_thread(
            cached_spectrogram_grid, recording, settings, params,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return asset_response(
        data, f"{version}-{params.channel}",
        if_none_match=if_none_match,
        media_type="application/octet-stream",
        cache_control=CACHE_PRIVATE_DAY,
        headers={
            "X-Spectrogram-Channel": params.channel,
            "X-Spectrogram-Version": version,
        },
    )


@router.post(
    "/recordings/{recording_id}/bundle", status_code=202, response_model=JobCreated,
    summary="Собрать пакет сессии (zip: EDF + параметры + результаты или BIDS)",
)
async def create_bundle_job(
    recording_id: str,
    format: str = Form(
        "session",
        description="Формат пакета: session (EDF + манифест + паспорт + задачи) | bids",
    ),
) -> JobCreated:
    """Пакет сессии (N40/4.6) — фоновой задачей `kind=bundle` (202 + `job_id`).

    Zip собирается потоково в дисковый кэш по входному отпечатку: те же
    входы → кэш-попадание без пересборки. Результат — список файлов и
    `zip_url`; сам ассет отдаётся ниже с ETag/304. Формат `bids` даёт
    минимальную BIDS-структуру (dataset_description, participants, сайдкар,
    события), `session` — полный набор «EDF + параметры + результаты».
    """
    recording = require_recording(recording_id)
    params = bundle_params(format=format)
    return submit_recording_job("bundle", recording, params)


@router.get(
    "/recordings/{recording_id}/bundle/{job_id}", response_model=BundleResult,
    summary="Результат задачи пакета",
)
async def get_bundle_result(recording_id: str, job_id: str) -> BundleResult:
    """Список файлов пакета и ссылка на zip. 409 — задача идёт/упала.

    ``zip_url`` собирается здесь, а не в воркере: воркер не знает ``job_id``
    (задача создаётся после него), а адрес адресуется именно задаче — как у
    ``html_url`` автоотчёта.
    """
    job = recording_job_result(recording_id, job_id, "bundle")
    result = dict(job.result)
    result["zip_url"] = (
        f"{settings.api_prefix}/recordings/{recording_id}/bundle/{job_id}/zip"
    )
    return BundleResult(**result)


@router.get(
    "/recordings/{recording_id}/bundle/{job_id}/zip",
    response_class=Response,
    responses={200: {"content": {"application/zip": {}}}},
    summary="Zip пакета сессии из дискового кэша (ETag)",
)
async def get_bundle_zip(
    recording_id: str,
    job_id: str,
    if_none_match: str | None = Header(default=None, alias="If-None-Match"),
) -> Response:
    """Zip пакета с ETag/304 (единая отдача — ``assets.py``).

    ETag — входной отпечаток сборки (``sig`` из результата): он меняется при
    любом изменении входов (EDF, паспорт, задачи, версии), поэтому браузер не
    отдаёт устаревший архив. Кэш очищен вместе с записью — 404 с просьбой
    собрать пакет заново (как у HTML автоотчёта).
    """
    job = recording_job_result(recording_id, job_id, "bundle")
    signature = str((job.result or {}).get("sig") or "")
    cached = await asyncio.to_thread(read_bundle_zip, settings, recording_id, signature)
    if cached is None:
        raise HTTPException(
            status_code=404,
            detail="Пакет сессии очищен — соберите пакет заново",
        )
    data, version = cached
    return asset_response(
        data,
        version,
        if_none_match=if_none_match,
        media_type="application/zip",
        cache_control=CACHE_PRIVATE_HOUR,
        headers={
            "Content-Disposition": (
                f'attachment; filename="bundle-{recording_id[:8]}.zip"'
            ),
        },
    )


@router.get(
    "/recordings/{recording_id}/dipoles.csv",
    response_class=Response,
    responses={200: {"content": {"text/csv": {}}}},
    summary="Экспорт таблицы диполей записи в CSV (RFC 4180)",
)
async def export_dipoles_csv(recording_id: str) -> Response:
    """CSV всех диполей записи (все сессии, все полосы) — выгрузка готовых строк.

    Не задача: чтение ``read-API сессий`` и сериализация — секунды, а
    «задача = job» относится к расчёту (правило 2). Пустой результат —
    честный CSV с одной шапкой («данных нет», а не ошибка). Кавычки/CRLF —
    RFC 4180 (``services/session_bundle.py::dipoles_csv``).
    """
    recording = require_recording(recording_id)
    _, sessions = await results_store.list_sessions(
        recording_id=recording.recording_id, limit=1000, offset=0,
    )
    rows: list[dict[str, Any]] = []
    for session in sessions:
        session_rows = await results_store.list_session_dipoles(
            str(session["id"]), limit=100_000, offset=0,
        )
        rows.extend(session_rows or [])
    text = dipoles_csv(rows)
    return Response(
        content=text,
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": (
                f'attachment; filename="dipoles-{recording_id[:8]}.csv"'
            ),
        },
    )


@router.get(
    "/jobs/{job_id}/manifest", response_model=RunManifestOut,
    summary="Run manifest задачи (версии + параметры + отпечатки ассетов)",
)
async def get_job_manifest(job_id: str) -> RunManifestOut:
    """На чём, чем и на каких данных посчитана задача (N40/4.6).

    Манифест строится на лету из ``meta`` задачи (``params_sig`` и
    ``recording_id`` — то, что уже есть у любой задачи) плюс текущие версии
    среды и отпечатки ассетов — для задачи этого процесса/хоста они
    соответствуют её окружению. В отличие от результата, манифест честен
    и для идущей, и для упавшей задачи («с чем запускали»). 404 — неизвестна.
    """
    job = job_manager.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail=f"Задача {job_id} не найдена")
    return RunManifestOut(**build_manifest(settings, job.to_record()))


@router.post(
    "/jobs", status_code=202, response_model=JobCreated,
    summary="Запустить анализ фоновой задачей (с прогрессом)",
)
async def create_analysis_job(
    file: UploadFile = File(...),
    epoch_length_ms: float = Form(2000.0),
    freq_band: str = Form("all"),
    custom_min_freq: float | None = Form(None),
    custom_max_freq: float | None = Form(None),
    single_freq: float | None = Form(None),
    run_ica: bool = Form(True),
    z_threshold: float = Form(5.0),
    pp_threshold_uv: float = Form(100.0),
) -> JobCreated:
    """Основной вход для UI: 202 + ``job_id``, далее поллинг ``GET /jobs/{id}``.

    Параметры те же, что у ``POST /analyze``. Число одновременно выполняемых
    задач ограничено ``MAX_CONCURRENT_JOBS`` (остальные ждут в очереди).
    """
    validate_analysis_request(epoch_length_ms, freq_band, single_freq)
    safe_name = safe_edf_name(file.filename)
    tmp_path, upload_dir, _digest = await save_upload(file, safe_name)

    job = analysis_pipeline.submit_uploaded_analysis(
        filepath=tmp_path, filename=safe_name, upload_dir=upload_dir,
        epoch_length_ms=epoch_length_ms, freq_band=freq_band,
        custom_min_freq=custom_min_freq, custom_max_freq=custom_max_freq,
        single_freq=single_freq,
        run_ica=run_ica, z_threshold=z_threshold, pp_threshold_uv=pp_threshold_uv,
    )
    prefix = settings.api_prefix
    return JobCreated(
        job_id=job.job_id,
        status=job.status,
        poll_url=f"{prefix}/jobs/{job.job_id}",
        result_url=f"{prefix}/jobs/{job.job_id}/result",
    )


@router.get("/jobs", response_model=list[JobStatus], summary="История задач")
async def list_jobs(limit: int = Query(20, ge=1, le=200)) -> list[JobStatus]:
    """Последние задачи (новые — в конце списка)."""
    return [job_status(job) for job in job_manager.list_jobs(limit)]


@router.get("/jobs/{job_id}", response_model=JobStatus, summary="Состояние задачи")
async def get_job(job_id: str) -> JobStatus:
    """Этап, прогресс (0..1) и ошибка задачи — для прогресс-бара UI."""
    job = job_manager.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail=f"Задача {job_id} не найдена")
    return job_status(job)


@router.delete("/jobs/{job_id}", response_model=JobStatus, summary="Отменить задачу")
async def cancel_job(job_id: str) -> JobStatus:
    """Кооперативная отмена (3.2): воркер останавливается на ближайшем тике прогресса.

    Воркер-поток не прерывается силой — он сам узнаёт об отмене и задача
    становится ``cancelled`` (результат отменённой не публикуется). 404 —
    задачи нет; 409 — уже завершена (успех/ошибка), отменять нечего; уже
    отменённая — 200 с её статусом: повторный DELETE идемпотентен.
    """
    job = job_manager.cancel(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail=f"Задача {job_id} не найдена")
    if job.status in ("succeeded", "failed"):
        raise HTTPException(
            status_code=409,
            detail=f"Задача уже завершена (статус «{job.status}») — отменять нечего",
        )
    return job_status(job)


@router.get(
    "/jobs/{job_id}/result", response_model=AnalyzeResponse,
    summary="Результат завершённой задачи",
)
async def get_job_result(job_id: str) -> dict[str, Any]:
    """Результат анализа. 409 — задача ещё идёт или завершилась ошибкой."""
    return job_by_id(job_id).result


@router.get(
    "/surface",
    response_class=Response,
    responses={200: {"model": SurfaceOut, "content": {"application/json": {}}}},
    summary="Меш fsaverage (кэш + ETag)",
)
async def get_surface(
    if_none_match: str | None = Header(default=None, alias="If-None-Match"),
) -> Response:
    """Децимированный меш lh/rh без тяжёлых BA-индексов.

    Ответ — готовые байты из кэша (без сериализации на каждый запрос); схема
    ``SurfaceOut`` описана в OpenAPI. Повторный запрос с тем же ``If-None-Match``
    получает 304.
    """
    try:
        data, version = get_surface_bytes(settings)
    except (FileNotFoundError, OSError) as exc:
        raise HTTPException(status_code=503, detail=f"Данные fsaverage недоступны: {exc}") from exc
    return asset_response(data, version, if_none_match=if_none_match)


@router.get(
    "/surface/brodmann",
    response_class=Response,
    responses={200: {"model": BrodmannIndexOut, "content": {"application/json": {}}}},
    summary="Индексы вершин всех полей Бродмана (тяжёлый ассет)",
)
async def get_brodmann_all(
    if_none_match: str | None = Header(default=None, alias="If-None-Match"),
) -> Response:
    """Все метки PALS_B12_Brodmann (≈2 МБ).

    Для одной области используйте ``/surface/brodmann/{area_name}`` — там ответ
    в десятки раз меньше.
    """
    try:
        data, version = get_brodmann_bytes(settings)
    except (FileNotFoundError, OSError) as exc:
        raise HTTPException(status_code=503, detail=f"Данные fsaverage недоступны: {exc}") from exc
    return asset_response(
        data, version, if_none_match=if_none_match, cache_control=CACHE_PUBLIC_WEEK,
    )


@router.get(
    "/surface/brodmann/{area_name}", response_model=BrodmannAreaOut,
    summary="Индексы вершин одного поля Бродмана",
)
async def get_brodmann_one(area_name: str) -> dict[str, Any]:
    """Лёгкий ответ по конкретной области (например ``BA17-lh``)."""
    try:
        area = get_brodmann_area(settings, area_name)
    except (FileNotFoundError, OSError) as exc:
        raise HTTPException(status_code=503, detail=f"Данные fsaverage недоступны: {exc}") from exc
    if area is None:
        raise HTTPException(status_code=404, detail=f"Поле Бродмана {area_name} не найдено")
    return area


@router.get(
    "/surface/mri", response_model=MriSlicesOut,
    summary="Метаданные срезов МРТ (T1, MNI-сетка)",
)
async def get_mri_slices() -> dict[str, Any]:
    """Границы, шаг сетки, плоскости и окно яркости срезов.

    Первое обращение собирает том на MNI-сетке из ``T1.mgz`` + ``brainmask.mgz``
    (≈0.7 с) и кладёт его в ``cache_dir/mri``; дальше ответ мгновенный. Сами срезы
    отдаются картинками (``/surface/mri/slice/...``), а не в этом ответе.
    """
    try:
        return mri_meta(settings)
    except (FileNotFoundError, OSError) as exc:
        raise HTTPException(status_code=503, detail=f"Данные fsaverage недоступны: {exc}") from exc


@router.get(
    "/surface/mri/slice/{plane}/{mm}.png",
    response_class=Response,
    responses={200: {"content": {"image/png": {}}}},
    summary="Срез МРТ картинкой (PNG, ETag)",
)
async def get_mri_slice(
    plane: str,
    mm: float,
    if_none_match: str | None = Header(default=None, alias="If-None-Match"),
) -> Response:
    """PNG среза (серый + альфа) в раскладке проекций UI.

    Значение среза квантуется сеткой тома (1 мм), фактическое значение возвращается
    заголовком ``X-Mri-Slice-Mm`` — расхождение с дробным срезом UI видно сразу.
    Неизвестная плоскость — 404, недоступный том — 503, повторный запрос с тем же
    ``If-None-Match`` — 304.
    """
    try:
        data, version, actual_mm = mri_slice_png(settings, plane, mm)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except (FileNotFoundError, OSError) as exc:
        raise HTTPException(status_code=503, detail=f"Данные fsaverage недоступны: {exc}") from exc

    return asset_response(
        data, f"{version}-{plane}-{actual_mm:g}",
        if_none_match=if_none_match,
        media_type="image/png",
        cache_control=CACHE_PUBLIC_WEEK,
        headers={"X-Mri-Slice-Mm": f"{actual_mm:g}"},
    )


@router.get(
    "/surface/mri/volume/{name}",
    response_class=Response,
    summary="Том fsaverage как есть (3D-вид Niivue, ETag)",
)
async def get_mri_volume(
    name: str,
    if_none_match: str | None = Header(default=None, alias="If-None-Match"),
) -> Response:
    """Файл тома/поверхности FreeSurfer без перекодирования (3.5, N33).

    Имя берётся только из белого словаря (``services/mri_volumes.py``): чужое
    имя — 404 **до** чтения файловой системы (path traversal невозможен),
    отсутствующий файл — 503, повторный запрос с тем же ``If-None-Match`` — 304.
    ETag — отпечаток файлов томов (kind ``volumes`` в ``asset_versions``).
    """
    try:
        data, version = volume_bytes(settings, name)
    except KeyError as exc:
        raise HTTPException(
            status_code=404,
            detail=f"Неизвестный том {name!r}: белый список имён — в /meta (mri_volumes.names)",
        ) from exc
    except (FileNotFoundError, OSError) as exc:
        raise HTTPException(status_code=503, detail=f"Данные fsaverage недоступны: {exc}") from exc
    return asset_response(
        data, version, if_none_match=if_none_match,
        # Один тип на белый список: mgz — сжатый MGH, surf — бинарь FreeSurfer;
        # Niivue определяет формат по магическим байтам, а не по Content-Type.
        media_type="application/octet-stream",
        cache_control=CACHE_PUBLIC_WEEK,
    )


@router.get(
    "/surface/contours", response_model=ContoursOut,
    summary="Метаданные контуров атласа (структуры и поля Бродмана)",
)
async def get_contours() -> dict[str, Any]:
    """Шаг сетки, допуски упрощения, число меток и метод BA-разметки.

    Первое обращение собирает объёмы меток из ``aparc+aseg.mgz`` и ленты коры
    ``lh/rh.ribbon.mgz`` (≈1 с) и кладёт их в ``cache_dir/contours``; дальше ответ
    мгновенный. Сами контуры отдаются по срезу (``/surface/contours/{plane}/{mm}``).
    """
    try:
        return contours_meta(settings)
    except (FileNotFoundError, OSError) as exc:
        raise HTTPException(status_code=503, detail=f"Данные fsaverage недоступны: {exc}") from exc


@router.get(
    "/surface/contours/{plane}/{mm}", response_model=ContourSliceOut,
    summary="Контуры среза: анатомические структуры и поля Бродмана (ETag)",
)
async def get_contour_slice(
    plane: str,
    mm: float,
    if_none_match: str | None = Header(default=None, alias="If-None-Match"),
) -> Response:
    """Полигоны меток среза в миллиметрах MNI по осям плоскости.

    Срез квантуется сеткой атласа (1 мм), фактическое значение возвращается полем
    ``mm`` ответа и заголовком ``X-Contour-Mm``. Неизвестная плоскость или срез вне
    сетки — 404, недоступный атлас — 503, повторный запрос с тем же ``If-None-Match``
    — 304. Поля Бродмана размечены **производно** (``method`` в ответе): метки PALS
    живут на поверхности коры, в объём они переносятся по ближайшей вершине.
    """
    try:
        payload = slice_contours(settings, plane, mm)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except (FileNotFoundError, OSError) as exc:
        raise HTTPException(status_code=503, detail=f"Данные fsaverage недоступны: {exc}") from exc

    data = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    actual_mm = float(payload["mm"])
    return asset_response(
        data, f"{payload['version']}-{plane}-{actual_mm:g}",
        if_none_match=if_none_match,
        cache_control=CACHE_PUBLIC_WEEK,
        headers={"X-Contour-Mm": f"{actual_mm:g}"},
    )


@router.get(
    "/brodmann-labels", response_model=BrodmannLabelsOut,
    summary="Имена доступных полей Бродмана",
)
async def get_brodmann_labels() -> dict[str, Any]:
    """Список меток из кэша атласа (без чтения файлов MNE на каждый запрос)."""
    try:
        names = brodmann_area_names(settings)
    except (FileNotFoundError, OSError) as exc:
        raise HTTPException(status_code=503, detail=f"Данные fsaverage недоступны: {exc}") from exc
    return {"brodmann_areas": names, "count": len(names), "version": asset_version(settings)}


@router.get(
    "/brain-surface", deprecated=True, response_class=Response,
    responses={200: {"model": SurfaceOut, "content": {"application/json": {}}}},
    summary="Устаревший алиас /surface",
)
async def get_brain_surface_legacy(
    include_ba: bool = Query(False, description="Добавить ba_labels (тяжело, ≈2 МБ)"),
) -> Response:
    """Совместимость со старым контрактом: меш + (опционально) BA-индексы."""
    try:
        data, version = get_surface_bytes(settings)
        if include_ba:
            ba_bytes, _ = get_brodmann_bytes(settings)
            areas = json.loads(ba_bytes).get("areas", {})
            mesh = json.loads(data)
            mesh["ba_labels"] = {
                name: {key: value for key, value in area.items() if key != "name"}
                for name, area in areas.items()
            }
            data = json.dumps(mesh, separators=(",", ":")).encode("utf-8")
    except (FileNotFoundError, OSError) as exc:
        raise HTTPException(status_code=503, detail=f"Данные fsaverage недоступны: {exc}") from exc
    return asset_response(data, version)


@router.get(
    "/filter-response",
    response_model=FilterResponseOut,
    summary="АЧХ применяемого фильтра (полоса + notch с гармониками)",
)
async def get_filter_response(
    band_min: float | None = Query(None, description="Нижняя граница полосы, Гц"),
    band_max: float | None = Query(None, description="Верхняя граница полосы, Гц"),
    notch_hz: float | None = Query(None, description="Частота notch, Гц (50/60)"),
    notch_harmonics: int = Query(
        0, description="Гармоники notch (100/150/200/240 Гц), 0–4",
    ),
    sfreq: float = Query(500.0, description="Частота дискретизации, Гц"),
) -> FilterResponseOut:
    """АЧХ фильтра, который применяет предподготовка: лёгкий синхронный расчёт.

    Не задача (job): ~10–50 мс без ETag — параметры уже в query. Кривая считается
    тем же конвейером, что и сигнал (``services/filter_design.py``): единичный
    импульс проходит ``raw.filter`` + ``raw.notch_filter`` (с гармониками — N13),
    поэтому совпадает с фактической обработкой: 0 дБ в полосе пропускания, провалы
    notch. UI показывает график в блоке «Фильтр и референс», свёрнутым по
    умолчанию — правка параметров без кнопок не делает запросов (правило UI).
    """
    band = parse_filter_band(band_min, band_max)
    if not 0 <= notch_harmonics <= 4:
        raise HTTPException(
            status_code=400, detail="notch_harmonics — целое 0…4 (гармоники 50/60 Гц)",
        )
    if band is None and not notch_hz:
        raise HTTPException(
            status_code=400,
            detail="Задайте полосу (band_min/band_max) и/или notch_hz — иначе АЧХ нечего показывать",
        )
    if not 50.0 <= sfreq <= 2000.0:
        raise HTTPException(status_code=400, detail="sfreq — от 50 до 2000 Гц")
    if notch_hz is not None and not 0.0 < notch_hz < sfreq / 2.0:
        raise HTTPException(
            status_code=400, detail="notch_hz должен быть в пределах (0, Nyquist)",
        )
    response = await asyncio.to_thread(
        filter_response,
        l_freq=band[0] if band else None,
        h_freq=band[1] if band else None,
        notch_hz=notch_hz,
        notch_harmonics=notch_harmonics,
        sfreq=sfreq,
    )
    design = response.design
    return FilterResponseOut(
        freqs_hz=[float(value) for value in response.freqs_hz],
        gain_db=[float(value) for value in response.gain_db],
        method=design.method,
        band_hz=list(response.band_hz) if response.band_hz else None,
        l_trans_bandwidth_hz=design.l_trans_bandwidth,
        h_trans_bandwidth_hz=design.h_trans_bandwidth,
        filter_length_sec=design.filter_length_sec,
        edge_buffer_sec=design.edge_buffer_sec,
        notch_freqs=[float(value) for value in response.notch_freqs],
        sfreq=sfreq,
    )


@router.get(
    "/recordings/{recording_id}/mains",
    response_model=MainsOut,
    summary="Сигнал сетевого фона: уровни линий (L1) и вырезанная notch-компонентная",
)
async def get_recording_mains(
    recording_id: str,
    notch_hz: float | None = Query(None, description="Частота notch, Гц (50/60)"),
    notch_harmonics: int = Query(
        0, description="Гармоники notch (100/150/200/240 Гц), 0–4",
    ),
    start_sec: float = Query(0.0, ge=0.0, description="Начало окна трассы, с"),
    duration_sec: float = Query(5.0, description="Длина окна трассы, с (до 60)"),
) -> MainsOut:
    """Сигнал сетевого фона записи: лёгкий синтхронный расчёт (Части 1 §7, L1).

    Не задача (job) и без ETag: ``prepared_raw`` кэширует чтение EDF (A4),
    ``notch_filter`` на копии — секунды. Возвращает уровни линий сети над
    фоном PSD (``level_db``) и вырезанную компоненту ``x − notch(x)`` за окно
    (``trace_uv``, среднее по каналам, до полосового фильтра). UI — блок
    «Сетевой фон» в панели «Фильтр и референс», свёрнут по умолчанию:
    запрос шлёт только явное раскрытие (правило «считает только кнопка»).
    """
    recording = require_recording(recording_id)
    if notch_hz is None:
        raise HTTPException(
            status_code=400, detail="Задайте notch_hz — без notch нечего вырезать",
        )
    if not 0 < notch_hz < 2000:
        raise HTTPException(status_code=400, detail="notch_hz — от 0 до 2000 Гц")
    if not 0 <= notch_harmonics <= 4:
        raise HTTPException(
            status_code=400, detail="notch_harmonics — целое 0…4 (гармоники 50/60 Гц)",
        )
    if duration_sec <= 0 or duration_sec > 60:
        raise HTTPException(status_code=400, detail="duration_sec — от 0.1 до 60 с")
    try:
        result = await asyncio.to_thread(
            mains_component,
            recording, settings,
            notch_hz, notch_harmonics,
            start_sec=start_sec, duration_sec=duration_sec,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return MainsOut(
        freqs_hz=result.freqs_hz,
        level_db=result.level_db,
        trace_times_sec=result.trace_times_sec,
        trace_uv=result.trace_uv,
        removed_rms_uv=result.removed_rms_uv,
        channel=result.channel,
        start_sec=result.start_sec,
        duration_sec=result.duration_sec,
        notch_hz=result.notch_hz,
        notch_harmonics=result.notch_harmonics,
        sfreq=result.sfreq,
    )


@router.get("/meta", response_model=MetaResponse, summary="Версии, окружение и параметры")
async def get_meta() -> MetaResponse:
    """Всё, что нужно разделу «Состояние сервера» и provenance результата (F16)."""
    from sqlalchemy.engine import make_url

    versions = _library_versions()
    prefix = settings.api_prefix
    # Источники BEM/transform (задача FreeSurfer): только os.path-проверки,
    # расчёт в /meta не запускается; сбой не должен ронять метаданные.
    try:
        bem_src: str | None = fsaverage_assets.bem_source(settings)
        trans_src: str | None = fsaverage_assets.trans_source(settings)
    except Exception:
        bem_src = trans_src = None
    return MetaResponse(
        app=settings.app_name,
        app_version=settings.app_version,
        api_prefix=prefix,
        python_version=sys.version.split()[0],
        platform=sys.platform,
        mne_version=versions["mne"] or "unknown",
        numpy_version=versions["numpy"] or "unknown",
        scipy_version=versions["scipy"] or "unknown",
        sqlalchemy_version=versions["sqlalchemy"] or "unknown",
        trimesh_version=versions["trimesh"],
        subjects_dir=settings.subjects_dir,
        fsaverage_trans=settings.fsaverage_trans,
        bem_source=bem_src,
        trans_source=trans_src,
        upload_dir=settings.upload_dir,
        results_dir=settings.results_dir,
        cache_dir=settings.cache_dir,
        # Только драйвер БД: DSN с паролем наружу не отдаём
        database_backend=make_url(settings.database_url).drivername,
        surface_version=asset_version(settings),
        surface_url=f"{prefix}/surface",
        standard_channels=list(settings.standard_channels),
        # Карта-силуэт головы в панели «Каналы»: нормированные координаты монтажа
        channel_positions=head_map_positions(settings.standard_channels),
        epoch_lengths_ms=list(settings.epoch_lengths_ms),
        freq_bands={
            name: [float(fmin), float(fmax)]
            for name, (fmin, fmax) in settings.freq_bands.items()
        },
        functional_bands={
            name: [float(fmin), float(fmax)]
            for name, (fmin, fmax) in settings.functional_bands.items()
        },
        signal_levels=[int(level) for level in settings.signal_levels],
        signal_base_points=settings.signal_base_points,
        artifact_thresholds=ArtifactThresholds(
            z_score_threshold=settings.z_score_threshold,
            zscore_window_sec=settings.zscore_window_sec,
            peak_to_peak_threshold_uv=settings.peak_to_peak_threshold_uv,
            flat_line_threshold_uv=settings.flat_line_threshold_uv,
            flat_line_min_duration_ms=settings.flat_line_min_duration_ms,
            muscle_min_duration_ms=settings.muscle_min_duration_ms,
            break_min_duration_ms=settings.break_min_duration_ms,
            line_noise_ratio=settings.line_noise_ratio,
            clipping_share=settings.clipping_share,
            pop_step_uv=settings.pop_step_uv,
            bad_channel_z=settings.bad_channel_z,
        ),
        dipole_fit_decim=settings.dipole_fit_decim,
        dipole_fit_max_epochs=settings.dipole_fit_max_epochs,
        dipole_fit_n_jobs=settings.dipole_fit_n_jobs,
        dipole_fit_sec_per_point=settings.dipole_fit_sec_per_point,
        # Точный фитинг — «медленный профиль»: дефолты означают часы счёта,
        # поэтому UI обязан предупреждать до запуска, а не после (F19).
        dipole_fit_experimental=True,
        # Уточнение эпохи: окно по умолчанию (0 — только пик), предел из формы и
        # оценки времени — UI показывает «сколько ждать» до запуска (1.5).
        dipole_refine_halfwin_ms=settings.dipole_refine_halfwin_ms,
        dipole_refine_halfwin_max_ms=settings.dipole_refine_halfwin_max_ms,
        dipole_refine_sec_fixed=settings.dipole_refine_sec_fixed,
        dipole_refine_sec_per_sample=settings.dipole_refine_sec_per_sample,
        dipole_refine_n_jobs=settings.dipole_refine_n_jobs,
        max_concurrent_jobs=job_manager.max_concurrent,
        cors_origins=[o.strip() for o in settings.cors_origins.split(",") if o.strip()],
        mri_slices=_mri_ref(),
        mri_volumes=_mri_volumes_ref(),
        contours=_contours_ref(),
    )


@router.get("/journal", response_model=JournalOut, summary="Журнал шагов: пошаговые замеры")
async def journal_tail(
    limit: int = Query(200, ge=1, le=2000, description="Сколько последних строк вернуть"),
    pipeline: str | None = Query(
        None, description="Фильтр по пайплайну: spectrum, dipoles, signals, asset-surface, …"
    ),
) -> JournalOut:
    """Хвост журнала шагов (`docs/data_map.md` §9).

    Замеры пишутся в продакшен-пути (один ``perf_counter`` и одна строка на шаг),
    а этот роут их отдаёт: цифры для документации и для ответа «почему 8 секунд»
    берутся отсюда, а не из «кажется, стало быстрее». Файла может не быть
    (журнал выключен или ещё не писался) — это пустой список, а не 404.
    """
    return JournalOut(
        enabled=bool(settings.journal_enabled),
        journal_path=journal.journal_path(),
        entries=[
            JournalEntry(**entry) for entry in journal.read_journal(limit=limit, pipeline=pipeline)
        ],
    )


@router.post(
    "/server/restart",
    status_code=202,
    response_model=ServerRestartOut,
    summary="Перезапуск бэкенда из UI",
)
async def restart_server(background_tasks: BackgroundTasks) -> ServerRestartOut:
    """Планирует замену процесса сервера свежим запуском (``os.execv``).

    409 — перезапуск невозможен: dev-режим ``--reload``, сервер запущен не
    лаунчером (PID-файл не наш) или идут задачи (``queued``/``running``) —
    exec оборвал бы расчёт; текст причины — для UI. При успехе ответ уходит
    **до** перезапуска (пауза ``restart_after_sec`` внутри фоновой задачи),
    поэтому клиент гарантированно получает 202 и текущий
    ``server_started_at`` для контроля (см. ``services/server_control.py``).
    """
    allowed, reason = server_control.can_restart()
    if not allowed:
        raise HTTPException(status_code=409, detail=reason)
    busy = server_control.active_jobs()
    if busy:
        kinds = ", ".join(f"{job.kind} ({job.job_id[:8]})" for job in busy)
        raise HTTPException(
            status_code=409,
            detail=(
                f"Идут задачи: {kinds} — дождитесь их завершения или отмените, "
                "потом перезапустите"
            ),
        )
    background_tasks.add_task(server_control.restart_soon)
    # code_freshness возвращает dict[str, str | bool], поле — str: делим явно
    started_at = _code_freshness()["server_started_at"]
    return ServerRestartOut(
        restarting=True,
        restart_after_sec=server_control.RESTART_DELAY_SEC,
        server_started_at=str(started_at),
    )


def _gpu_state() -> tuple[gpu.GpuInfo, bool]:
    """Срез «локального ресурса»: детекция GPU и тумблер (для ``async def`` в потоке)."""
    return gpu.detect_gpu(), gpu.get_use_cuda()


def _local_resource_out(info: gpu.GpuInfo, use_cuda: bool) -> LocalResourceOut:
    """Собрать контракт из данных сервиса (домен → Pydantic, F4)."""
    return LocalResourceOut(
        gpu=GpuStatusOut(
            present=info.present,
            name=info.name,
            cupy=info.cupy,
            usable=info.usable,
            mem_total_mb=info.mem_total_mb,
            mem_free_mb=info.mem_free_mb,
            reason=info.reason,
        ),
        use_cuda=use_cuda,
    )


@router.get(
    "/resource",
    response_model=LocalResourceOut,
    summary="Локальный ресурс: GPU и ускорение MNE",
)
async def get_resource() -> LocalResourceOut:
    """Автоопределение GPU этого сервера + состояние тумблера «Использовать GPU».

    ``nvidia-smi`` и проба CuPy блокирующие — в потоке (правило Async);
    ответ — для панели «Локальный ресурс» раздела «Настройки».
    """
    info, use_cuda = await asyncio.to_thread(_gpu_state)
    return _local_resource_out(info, use_cuda)


@router.put(
    "/resource",
    response_model=LocalResourceOut,
    summary="Тумблер «Использовать GPU»",
)
async def put_resource(payload: LocalResourceUpdate) -> LocalResourceOut:
    """Переключить ускорение MNE на GPU: пишется в MNE-конфиг сервера.

    409 — включить нечего: CUDA недоступна (текст причины — для UI);
    выключение всегда возможно. Ответ — новое состояние тумблера.
    """
    try:
        await asyncio.to_thread(gpu.set_use_cuda, payload.use_cuda)
    except gpu.GpuUnavailableError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    info, use_cuda = await asyncio.to_thread(_gpu_state)
    return _local_resource_out(info, use_cuda)


# ---------------------------------------------------------------------------
# Групповой анализ (остаток 4.7, Фаза 5): агрегаты «BA × сессии»

@router.post(
    "/group/aggregate",
    response_model=GroupAggregateOut,
    summary="Групповой агрегат выборки «BA × сессии»",
)
async def group_aggregate(payload: GroupAggregateIn) -> GroupAggregateOut:
    """Агрегаты дипольных точек выбранной полосы по списку записей (§3.5).

    Вход — записи-участники (кандидаты ``GET /sessions``) и групповые фильтры
    «диапазон / длина эпохи / GOF / BA-ROI / дата». Расчёт — выборки и
    арифметика по ``dipole_points`` последнего прогона каждой записи (без
    MNE), поэтому синхронно, без задачи. ``GroupError`` → 400 с текстом для UI.
    """
    try:
        result = await aggregate_group(payload, settings)
    except GroupError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return GroupAggregateOut(**result)


@router.post(
    "/group/analyses", status_code=201, response_model=GroupAnalysisSummaryOut,
    summary="Сохранить прогон группового анализа (история, не UPSERT)",
)
async def create_group_analysis(payload: GroupAnalysisCreateIn) -> GroupAnalysisSummaryOut:
    """Снимок определения (фильтры + состав) в БД — числа не замораживаются.

    Читается ``GET /group/analyses/{id}`` пересчётом по живой БД: история
    хранит «что считалось», а не устаревающие цифры (§8.4.2 — история, не
    UPSERT: повтор оставляет новую строку).
    """
    try:
        summary = await save_group_analysis(
            payload, settings, payload.name,
        )
    except GroupError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return GroupAnalysisSummaryOut(**summary)


@router.get(
    "/group/analyses", response_model=GroupAnalysesPage,
    summary="История прогонов группового анализа",
)
async def list_group_analyses_route(
    limit: int = Query(50, ge=1, le=200, description="Размер страницы"),
    offset: int = Query(0, ge=0, description="Смещение"),
) -> GroupAnalysesPage:
    """Страница прогонов: новые сверху, честный ``total``, живые участники."""
    page = await list_group_analyses(limit=limit, offset=offset)
    return GroupAnalysesPage(
        total=int(page["total"]),
        items=[GroupAnalysisSummaryOut(**item) for item in page["items"]],
    )


@router.get(
    "/group/analyses/{run_id}", response_model=GroupAnalysisDetailOut,
    summary="Прогон группового анализа: паспорт + свежий агрегат",
)
async def get_group_analysis_route(run_id: int) -> GroupAnalysisDetailOut:
    """Паспорт прогона и пересчёт его определения по живой БД; 404 — нет."""
    detail = await get_group_analysis(run_id, settings)
    if detail is None:
        raise HTTPException(status_code=404, detail=f"Прогон {run_id} не найден")
    return GroupAnalysisDetailOut(
        run=GroupAnalysisSummaryOut(**detail["run"]),
        aggregate=GroupAggregateOut(**detail["aggregate"]),
    )


@router.get(
    "/group/analyses/{run_id}/report", response_model=ReportHtmlOut,
    summary="Отчёт по прогону группового анализа (Тип 2) — раздел «Итоги»",
)
async def get_group_analysis_report_route(run_id: int) -> ReportHtmlOut:
    """Сборка/чтение HTML-отчёта по прогону: паспорт + свежий пересчёт.

    Числа в документе — те же, что в ``GET /group/analyses/{run_id}`` (свежий
    пересчёт по живой БД): сменились данные — отпечаток другой и документ
    собирается заново (история хранит определение, §8.4.2). 404 — нет.
    """
    detail = await get_group_analysis(run_id, settings)
    if detail is None:
        raise HTTPException(status_code=404, detail=f"Прогон {run_id} не найден")
    doc = await asyncio.to_thread(ensure_group_report, settings, run_id, detail)
    prefix = settings.api_prefix
    return ReportHtmlOut(
        title=doc.title,
        html_sig=doc.sig,
        report_version=doc.version,
        html_url=f"{prefix}/group/analyses/{run_id}/report/html",
        warnings=doc.warnings,
    )


@router.get(
    "/group/analyses/{run_id}/report/html",
    response_class=Response,
    responses={200: {"content": {"text/html": {}}}},
    summary="HTML отчёта по прогону группы: самодостаточный MNE.Report (ETag)",
)
async def get_group_analysis_report_html_route(
    run_id: int,
    if_none_match: str | None = Header(default=None, alias="If-None-Match"),
) -> Response:
    """HTML отчёта Типа 2 из дискового кэша с ETag/304 (``assets.py``)."""
    detail = await get_group_analysis(run_id, settings)
    if detail is None:
        raise HTTPException(status_code=404, detail=f"Прогон {run_id} не найден")
    doc = await asyncio.to_thread(ensure_group_report, settings, run_id, detail)
    return asset_response(
        doc.data,
        doc.version,
        if_none_match=if_none_match,
        media_type="text/html",
        cache_control=CACHE_PRIVATE_DAY,
    )


# --- «Нейромузыка» (эксперимент, docs/rules/neuromusic.md) --------------------
# Рендер без job-системы (ТЗ фазы 1): in-memory статус, один активный рендер.
# Роуты только форма/контракт; цикл — services/audio_render/render.py.


def _audio_artifacts(render_id: str) -> neuro_render.RenderArtifacts:
    """Готовые артефакты рендера; 404 — нет/TTL, 409 — идёт или упал."""
    try:
        state = neuro_render.state_of(render_id)
    except neuro_render.RenderNotFound as exc:
        raise HTTPException(
            status_code=404,
            detail=f"Рендер {render_id} не найден (хранился {neuro_render.RENDER_TTL_SEC // 60} мин)",
        ) from exc
    if state.status == "running":
        raise HTTPException(
            status_code=409, detail=f"Рендер ещё идёт: {state.stage} ({state.pct:.0%})",
        )
    if state.status == "failed" or state.artifacts is None:
        raise HTTPException(status_code=409, detail=f"Рендер не удался: {state.error}")
    return state.artifacts


@router.post(
    "/audio/render",
    status_code=202,
    response_model=AudioRenderStart,
    summary="Запустить рендер партитуры ЭЭГ → стерео (эксперимент «Нейромузыка»)",
)
async def start_audio_render(payload: AudioRenderRequest) -> AudioRenderStart:
    """Старт рендера: 7 треков + мастер, транспонирование 5/6/7 октав
    (``octave_shift``, дефолт 7 → ×128), в памяти процесса.

    Проценты и шаг — ``GET /audio/render/{id}/status``; WAV и sidecar —
    отдельными GET. Гейны/boost/loudness_phon/octave_shift валидируются
    здесь (400 с текстом для UI).
    """
    recording = require_recording(payload.recording_id)
    unknown = sorted(set(payload.gains_db) - set(settings.freq_bands))
    if unknown:
        raise HTTPException(
            status_code=400, detail=f"Неизвестные полосы гейнов: {', '.join(unknown)}",
        )
    for band, value in sorted(payload.gains_db.items()):
        if not GAIN_MIN_DB <= float(value) <= GAIN_MAX_DB:
            raise HTTPException(
                status_code=400,
                detail=f"Гейн {band}: {value} вне диапазона {GAIN_MIN_DB:g}…{GAIN_MAX_DB:g} дБ",
            )
    boost = float(payload.boost_db)
    if not BOOST_MIN_DB <= boost <= BOOST_MAX_DB:
        raise HTTPException(
            status_code=400,
            detail=(
                f"boost_db: {boost} вне диапазона "
                f"{BOOST_MIN_DB:g}…{BOOST_MAX_DB:g} дБ "
                f"(базовое усиление полосовых стерео-треков)"
            ),
        )
    loudness_phon = payload.loudness_phon
    if loudness_phon is not None and not LOUDNESS_PHON_MIN <= float(loudness_phon) <= LOUDNESS_PHON_MAX:
        raise HTTPException(
            status_code=400,
            detail=(
                f"loudness_phon: {loudness_phon} вне диапазона "
                f"{LOUDNESS_PHON_MIN:g}…{LOUDNESS_PHON_MAX:g} фон "
                f"(опорный уровень компенсации ISO 226; null — выключить)"
            ),
        )
    octave_shift = int(payload.octave_shift)
    if octave_shift not in PITCH_STEPS_CHOICES:
        choices = "/".join(str(value) for value in PITCH_STEPS_CHOICES)
        raise HTTPException(
            status_code=400,
            detail=(
                f"octave_shift: {payload.octave_shift} — число октав транспонирования, "
                f"допустимо {choices} (×32/×64/×128)"
            ),
        )
    try:
        render_id = neuro_render.start_render(
            recording, settings, payload.gains_db, boost, loudness_phon,
            payload.loudness_autobase, octave_shift,
        )
    except neuro_render.RenderBusy as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return AudioRenderStart(render_id=render_id)


@router.get(
    "/audio/render/{render_id}/status",
    response_model=AudioRenderStatus,
    summary="Статус рендера: шаг пайплайна и проценты (поллинг UI)",
)
async def audio_render_status(render_id: str) -> AudioRenderStatus:
    """Прогресс-бар «Нейромузыки»: stage + pct 0..1, список готовых треков."""
    try:
        state = neuro_render.state_of(render_id)
    except neuro_render.RenderNotFound as exc:
        raise HTTPException(status_code=404, detail=f"Рендер {render_id} не найден") from exc
    return AudioRenderStatus(
        render_id=state.render_id,
        status=state.status,
        stage=state.stage,
        pct=state.pct,
        message=state.message,
        error=state.error,
        tracks=sorted(state.artifacts.tracks_wav) if state.artifacts else [],
    )


@router.get(
    "/audio/render/{render_id}/master.wav",
    response_class=Response,
    responses={200: {"content": {"audio/wav": {}}}},
    summary="WAV мастера партитуры (48 кГц, PCM_24, стерео)",
)
async def audio_render_master(render_id: str) -> Response:
    """Мастер-трек из памяти рендера (плеер и «Скачать WAV»)."""
    artifacts = _audio_artifacts(render_id)
    # Без Content-Disposition: файл должен проигрываться в <audio src=...>,
    # а скачивание UI инициирует атрибутом download (same-origin).
    return Response(content=artifacts.master_wav, media_type="audio/wav")


@router.get(
    "/audio/render/{render_id}/track/{band}.wav",
    response_class=Response,
    responses={200: {"content": {"audio/wav": {}}}},
    summary="WAV отдельного трека партитуры (инструмент одной полосы)",
)
async def audio_render_track(render_id: str, band: str) -> Response:
    """Соль-прослушивание: каждый трек полосы отдельным файлом (концепция M6)."""
    artifacts = _audio_artifacts(render_id)
    data = artifacts.tracks_wav.get(band)
    if data is None:
        raise HTTPException(
            status_code=404,
            detail=f"Трек {band} не найден; доступны: {', '.join(artifacts.bands)}",
        )
    return Response(content=data, media_type="audio/wav")


@router.get(
    "/audio/render/{render_id}/sidecar.json",
    response_class=Response,
    responses={200: {"content": {"application/json": {}}}},
    summary="Sidecar-«партитура» рендера (веса, гейны, checksum, extensions)",
)
async def audio_render_sidecar(render_id: str) -> Response:
    """JSON-партитура эксперимента (ТЗ §6): что и из чего было сварено."""
    artifacts = _audio_artifacts(render_id)
    return Response(content=artifacts.sidecar, media_type="application/json")

