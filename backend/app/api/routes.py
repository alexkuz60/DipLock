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
import shutil
import sys
from typing import Any

from fastapi import (
    APIRouter,
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
    dipole_refine_params,
    dipole_scan_params,
    preprocess_params,
    spectrogram_params,
    spectrum_params,
    stored_spectrogram_params,
    validate_analysis_request,
)
from app.api.recording_jobs import (
    job_by_id,
    job_status,
    recording_job_result,
    require_recording,
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
    ChannelMixOut,
    ContourSliceOut,
    ContoursOut,
    ContoursRef,
    DipoleRefineResult,
    DipoleScanResult,
    JobCreated,
    JobStatus,
    MetaResponse,
    MriSliceRef,
    MriSlicesOut,
    PreprocessResult,
    PreprocessStage,
    RecordingMeta,
    RecordingSignalsHeader,
    SpectrogramGridHeader,
    SpectrogramResult,
    SpectrumResult,
    SurfaceOut,
)
from app.schemas.journal import JournalEntry, JournalOut
from app.services import analysis_pipeline, journal
from app.services.atlas_contours import (
    contours_meta,
    slice_contours,
)
from app.services.atlas_contours import (
    contours_ref as contour_ref,
)
from app.services.channel_mix import mixes_for
from app.services.job_manager import job_manager, noop_progress
from app.services.mri_slices import (
    mri_meta,
)
from app.services.mri_slices import (
    slice_png as mri_slice_png,
)
from app.services.mri_slices import (
    slice_ref as mri_slice_ref,
)
from app.services.recording_signals import (
    SignalBuildError,
    build_signal_blob,
)
from app.services.recordings import Recording, recording_registry
from app.services.spectral import cached_topomap
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
    """
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
    return _meta_out(recording, recording.deduplicated)


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
    if_none_match: str | None = Header(default=None, alias="If-None-Match"),
) -> Response:
    """Огибающая сигналов для вьюера треков (срез 2.5, docs/ui.md §8).

    Ответ — бинарный контейнер float32 (см. ``RecordingSignalsHeader``):
    ``DPS1`` | ``uint32 LE len(header)`` | JSON-заголовок | payload каналов.
    Минимумы/максимумы считаются по временным корзинам, поэтому пики артефактов
    не теряются при прореживании. Уровень отдаётся с ``ETag``: повторный запрос
    с тем же ``If-None-Match`` получает 304, а сам уровень кэшируется на диске.
    """
    recording = require_recording(recording_id)
    try:
        data, version = await asyncio.to_thread(build_signal_blob, recording, level, settings)
    except SignalBuildError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return asset_response(
        data, version,
        if_none_match=if_none_match,
        media_type="application/octet-stream",
        # Запись живёт по TTL реестра, поэтому кэшируем приватно и недолго
        cache_control=CACHE_PRIVATE_HOUR,
        headers={"X-Signal-Level": str(level)},
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
    reject_threshold_uv: float = Form(150.0),
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
        epoch_length_ms=epoch_length_ms, reject_threshold_uv=reject_threshold_uv,
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
    "/recordings/{recording_id}/spectrum", status_code=202, response_model=JobCreated,
    summary="Запустить расчёт спектра по диапазонам (Welch PSD)",
)
async def create_spectrum_job(
    recording_id: str,
    band_min: float | None = Form(None, description="Нижняя граница полосы, Гц; без пары — без фильтра"),
    band_max: float | None = Form(None, description="Верхняя граница полосы, Гц"),
    notch_hz: float | None = Form(None, description="Сетевой фильтр 50/60 Гц (None — выключен)"),
    reference: str = Form("average", description="average | custom"),
    reference_channels: str | None = Form(None, description="Каналы референса через запятую"),
    epoch_length_ms: float = Form(2000.0, description="Длина эпохи для PSD"),
    reject_threshold_uv: float = Form(150.0, description="Порог reject: эпохи выше — не в спектр"),
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
        epoch_length_ms=epoch_length_ms, reject_threshold_uv=reject_threshold_uv,
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
    reject_threshold_uv: float = Query(150.0, description="Порог reject"),
    if_none_match: str | None = Header(default=None, alias="If-None-Match"),
) -> Response:
    """PNG топокарты ритма в раскладке скальпа; вне круга голова прозрачна.

    Параметры фильтра и эпохи входят в ETag: картинка соответствует **своему**
    расчёту, и смена фильтра не отдаёт старую. Кэш — дисковый, поэтому повторный
    запрос не пересчитывает PSD, а промах кэша пересчитывает (как пирамида
    сигналов, 2.5). Неизвестный диапазон — 400, чужая запись — 404.
    """
    recording = require_recording(recording_id)
    # Референс в query топокарты не передаётся (контракт URL среза 3.4): берём
    # значение по умолчанию, как раньше; полоса, notch и эпоха — из параметров.
    params = spectrum_params(
        band_min=band_min, band_max=band_max,
        notch_hz=notch_hz,
        reference="average", reference_channels=None,
        epoch_length_ms=epoch_length_ms, reject_threshold_uv=reject_threshold_uv,
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
    reject_threshold_uv: float = Form(150.0, description="Порог reject эпох"),
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
        epoch_length_ms=epoch_length_ms, reject_threshold_uv=reject_threshold_uv,
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
    reject_threshold_uv: float = Form(150.0, description="Порог reject эпох"),
    grid_mm: float = Form(7.0, ge=2.0, le=20.0, description="Шаг сетки быстрого расчёта, мм"),
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
        epoch_length_ms=epoch_length_ms, reject_threshold_uv=reject_threshold_uv,
        grid_mm=grid_mm,
    )
    return submit_recording_job(
        "dipole_refine", recording, params, meta={"epoch_index": epoch_index},
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


@router.get("/meta", response_model=MetaResponse, summary="Версии, окружение и параметры")
async def get_meta() -> MetaResponse:
    """Всё, что нужно разделу «Состояние сервера» и provenance результата (F16)."""
    from sqlalchemy.engine import make_url

    versions = _library_versions()
    prefix = settings.api_prefix
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
        upload_dir=settings.upload_dir,
        results_dir=settings.results_dir,
        cache_dir=settings.cache_dir,
        # Только драйвер БД: DSN с паролем наружу не отдаём
        database_backend=make_url(settings.database_url).drivername,
        surface_version=asset_version(settings),
        surface_url=f"{prefix}/surface",
        standard_channels=list(settings.standard_channels),
        epoch_lengths_ms=list(settings.epoch_lengths_ms),
        freq_bands={
            name: [float(fmin), float(fmax)]
            for name, (fmin, fmax) in settings.freq_bands.items()
        },
        signal_levels=[int(level) for level in settings.signal_levels],
        signal_base_points=settings.signal_base_points,
        artifact_thresholds=ArtifactThresholds(
            z_score_threshold=settings.z_score_threshold,
            peak_to_peak_threshold_uv=settings.peak_to_peak_threshold_uv,
            flat_line_threshold_uv=settings.flat_line_threshold_uv,
            flat_line_min_duration_ms=settings.flat_line_min_duration_ms,
            reject_threshold_uv=settings.reject_threshold_uv,
        ),
        dipole_fit_decim=settings.dipole_fit_decim,
        dipole_fit_max_epochs=settings.dipole_fit_max_epochs,
        dipole_fit_n_jobs=settings.dipole_fit_n_jobs,
        dipole_fit_sec_per_point=settings.dipole_fit_sec_per_point,
        # Точный фитинг — «медленный профиль»: дефолты означают часы счёта,
        # поэтому UI обязан предупреждать до запуска, а не после (F19).
        dipole_fit_experimental=True,
        max_concurrent_jobs=job_manager.max_concurrent,
        cors_origins=[o.strip() for o in settings.cors_origins.split(",") if o.strip()],
        mri_slices=_mri_ref(),
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

