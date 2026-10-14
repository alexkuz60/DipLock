"""HTTP-контракт основания Консилиума: работа выполняется сервисом хранения."""

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import APIRouter, HTTPException, Query, Response
from fastapi.responses import StreamingResponse
from sqlalchemy.exc import IntegrityError, SQLAlchemyError

from app.api.private import PrivateRoute
from app.schemas.consilium import (
    ConsiliumAnswerRetry,
    ConsiliumBrainstormCreate,
    ConsiliumBrainstormOut,
    ConsiliumBrainstormsPage,
    ConsiliumCaseCreate,
    ConsiliumCaseOut,
    ConsiliumCasesPage,
    ConsiliumCaseUpdate,
    ConsiliumContextCreate,
    ConsiliumContextOut,
    ConsiliumContextPage,
    ConsiliumContextUpdate,
    ConsiliumDecisionCreate,
    ConsiliumDecisionOut,
    ConsiliumDeletionPreview,
    ConsiliumEvidence,
    ConsiliumEvidenceCreate,
    ConsiliumEvidenceDeletion,
    ConsiliumEvidencePage,
    ConsiliumExecutionCreate,
    ConsiliumExecutionOut,
    ConsiliumJevMarkAnswerCreate,
    ConsiliumJevMarkOut,
    ConsiliumJevMarkRoundPlanCreate,
    ConsiliumJevMarksPage,
    ConsiliumMessageCreate,
    ConsiliumMessageOut,
    ConsiliumMessagesPage,
    ConsiliumMessageUpdate,
    ConsiliumProposalCreate,
    ConsiliumProposalOut,
    ConsiliumProposalsPage,
    ConsiliumProposalUpdate,
    ConsiliumRecording,
    ConsiliumRoundAction,
    ConsiliumRoundCreate,
    ConsiliumRoundOut,
    ConsiliumRoundsPage,
    ConsiliumSnapshot,
    ConsiliumSnapshotCreate,
    ConsiliumSnapshotsPage,
    ConsiliumSourcesPage,
    ConsiliumStreamEvent,
    ConsiliumTriageCreate,
    ConsiliumTriageOut,
    ConsiliumTriagePage,
)
from app.services import recording_store
from app.services.consilium import (
    brainstorm,
    dossier,
    jev_marks,
    library,
    rounds,
    rounds_store,
    sources,
    store,
    streams,
    triage,
)

router = APIRouter(prefix="/consilium", tags=["Консилиум"], route_class=PrivateRoute)


@asynccontextmanager
async def guarded(response: Response) -> AsyncIterator[None]:
    """Приватные ответы и безопасные ошибки: SQL не раскрывает текст добровольца."""
    response.headers["Cache-Control"] = "private, no-store"
    try:
        yield
    except store.ConsiliumError as exc:
        raise HTTPException(exc.status, str(exc), headers={"Cache-Control": "no-store"}) from None
    except IntegrityError:
        raise HTTPException(409, "Конфликт сохранения — обновите данные", headers={
            "Cache-Control": "no-store",
        }) from None
    except SQLAlchemyError:
        raise HTTPException(503, "Не удалось сохранить или прочитать исследование", headers={
            "Cache-Control": "no-store",
        }) from None


@router.post("/cases", status_code=201, response_model=ConsiliumCaseOut)
async def create_case(payload: ConsiliumCaseCreate, response: Response) -> ConsiliumCaseOut:
    """Создать исследование без запуска анализа или ИИ."""
    async with guarded(response):
        return await store.create_case(payload)


@router.get("/cases", response_model=ConsiliumCasesPage)
async def list_cases(
    response: Response, limit: int = Query(50, ge=1, le=100), offset: int = Query(0, ge=0),
) -> ConsiliumCasesPage:
    """Список открытых и архивных исследований."""
    async with guarded(response):
        return await store.list_cases(limit, offset)


@router.get("/cases/{case_id}", response_model=ConsiliumCaseOut)
async def get_case(case_id: str, response: Response) -> ConsiliumCaseOut:
    """Паспорт; 404 на неизвестное исследование."""
    async with guarded(response):
        return await store.get_case(case_id)


@router.patch("/cases/{case_id}", response_model=ConsiliumCaseOut)
async def update_case(
    case_id: str, payload: ConsiliumCaseUpdate, response: Response,
) -> ConsiliumCaseOut:
    """Изменить паспорт или архивировать с проверкой версии."""
    async with guarded(response):
        return await store.update_case(case_id, payload)


@router.get("/cases/{case_id}/context", response_model=ConsiliumContextPage)
async def list_context(
    case_id: str, response: Response,
    limit: int = Query(50, ge=1, le=100), offset: int = Query(0, ge=0),
) -> ConsiliumContextPage:
    """Контекст со всеми ревизиями, не только текущий текст."""
    async with guarded(response):
        result = await store.list_entries(case_id, "context", limit, offset)
        return ConsiliumContextPage.model_validate(result)


@router.post("/cases/{case_id}/context", status_code=201, response_model=ConsiliumContextOut)
async def create_context(
    case_id: str, payload: ConsiliumContextCreate, response: Response,
) -> ConsiliumContextOut:
    """Сохранить рассказ, условия или наблюдение отдельно от измерений."""
    async with guarded(response):
        return ConsiliumContextOut.model_validate(await store.write_entry(case_id, "context", payload))


@router.patch("/cases/{case_id}/context/{entry_id}", response_model=ConsiliumContextOut)
async def update_context(
    case_id: str, entry_id: str, payload: ConsiliumContextUpdate, response: Response,
) -> ConsiliumContextOut:
    """Исправить контекст новой ревизией."""
    async with guarded(response):
        return ConsiliumContextOut.model_validate(await store.write_entry(
            case_id, "context", payload, entry_id,
        ))


@router.get("/cases/{case_id}/messages", response_model=ConsiliumMessagesPage)
async def list_messages(
    case_id: str, response: Response,
    limit: int = Query(50, ge=1, le=100), offset: int = Query(0, ge=0),
) -> ConsiliumMessagesPage:
    """Ручная история; модельных ответов в этом срезе нет."""
    async with guarded(response):
        result = await store.list_entries(case_id, "message", limit, offset)
        return ConsiliumMessagesPage.model_validate(result)


@router.post("/cases/{case_id}/messages", status_code=201, response_model=ConsiliumMessageOut)
async def create_message(
    case_id: str, payload: ConsiliumMessageCreate, response: Response,
) -> ConsiliumMessageOut:
    """Добавить реплику исследователя, не запуская ИИ."""
    async with guarded(response):
        return ConsiliumMessageOut.model_validate(await store.write_entry(case_id, "message", payload))


@router.patch("/cases/{case_id}/messages/{entry_id}", response_model=ConsiliumMessageOut)
async def update_message(
    case_id: str, entry_id: str, payload: ConsiliumMessageUpdate, response: Response,
) -> ConsiliumMessageOut:
    """Исправить ручную реплику с сохранением исходной версии."""
    async with guarded(response):
        return ConsiliumMessageOut.model_validate(await store.write_entry(
            case_id, "message", payload, entry_id,
        ))


@router.get("/cases/{case_id}/deletion-preview", response_model=ConsiliumDeletionPreview)
async def deletion_preview(case_id: str, response: Response) -> ConsiliumDeletionPreview:
    """Посмотреть последствия удаления без изменения данных."""
    async with guarded(response):
        return await store.deletion_preview(case_id)


@router.delete("/cases/{case_id}", status_code=204)
async def delete_case(
    case_id: str, response: Response, expected_version: int = Query(..., ge=1),
) -> None:
    """Удалить дело и ревизии после подтверждения версии предварительного просмотра."""
    async with guarded(response):
        await store.delete_case(case_id, expected_version)


@router.get("/recordings", response_model=list[ConsiliumRecording])
async def list_recordings(response: Response) -> list[ConsiliumRecording]:
    """Список зарегистрированных записей, без чтения EDF и запуска анализа."""
    async with guarded(response):
        return [ConsiliumRecording.model_validate(item)
                for item in await recording_store.list_research_recordings()]


@router.get("/cases/{case_id}/sources", response_model=ConsiliumSourcesPage)
async def list_sources(
    case_id: str, response: Response,
    limit: int = Query(50, ge=1, le=100), offset: int = Query(0, ge=0),
) -> ConsiliumSourcesPage:
    """Каталог конкретных прогонов только связанных записей."""
    async with guarded(response):
        return await sources.list_sources(case_id, limit, offset)


@router.post("/cases/{case_id}/evidence", status_code=201, response_model=ConsiliumEvidence)
async def add_evidence(
    case_id: str, payload: ConsiliumEvidenceCreate, response: Response,
) -> ConsiliumEvidence:
    """Фиксирует серверную копию выбранного источника."""
    async with guarded(response):
        return await dossier.add_evidence(case_id, payload)


@router.get("/cases/{case_id}/evidence", response_model=ConsiliumEvidencePage)
async def list_evidence(
    case_id: str, response: Response,
    limit: int = Query(50, ge=1, le=100), offset: int = Query(0, ge=0),
) -> ConsiliumEvidencePage:
    """Принятые материалы, не свежий пересчёт источников."""
    async with guarded(response):
        return await dossier.list_evidence(case_id, limit, offset)


@router.post("/cases/{case_id}/snapshots", status_code=201, response_model=ConsiliumSnapshot)
async def create_snapshot(
    case_id: str, payload: ConsiliumSnapshotCreate, response: Response,
) -> ConsiliumSnapshot:
    """Публикует досье из выбранных копий и текущих ревизий контекста."""
    async with guarded(response):
        return await dossier.create_snapshot(case_id, payload)


@router.get("/cases/{case_id}/snapshots", response_model=ConsiliumSnapshotsPage)
async def list_snapshots(
    case_id: str, response: Response,
    limit: int = Query(20, ge=1, le=100), offset: int = Query(0, ge=0),
) -> ConsiliumSnapshotsPage:
    """История опубликованных снимков."""
    async with guarded(response):
        return await dossier.list_snapshots(case_id, limit, offset)


@router.get("/cases/{case_id}/snapshots/{snapshot_id}", response_model=ConsiliumSnapshot)
async def get_snapshot(case_id: str, snapshot_id: str, response: Response) -> ConsiliumSnapshot:
    """Точная версия снимка без чтения живой аналитической БД."""
    async with guarded(response):
        return await dossier.get_snapshot(case_id, snapshot_id)


@router.get("/cases/{case_id}/evidence/{evidence_id}/deletion-preview", response_model=ConsiliumEvidenceDeletion)
async def evidence_deletion_preview(
    case_id: str, evidence_id: str, response: Response,
) -> ConsiliumEvidenceDeletion:
    """Зависимые снимки перед удалением копии материала."""
    async with guarded(response):
        return await dossier.evidence_deletion_preview(case_id, evidence_id)


@router.delete("/cases/{case_id}/evidence/{evidence_id}", status_code=204)
async def delete_evidence(
    case_id: str, evidence_id: str, response: Response,
    expected_version: int = Query(..., ge=1),
) -> None:
    """Удаляет копию, зависимые снимки и квитанции, не исходный расчёт."""
    async with guarded(response):
        await dossier.delete_evidence(case_id, evidence_id, expected_version)


# --- Раунды советников (Т3): запуск — явная кнопка, состояние — в строке раунда ---


@router.post("/cases/{case_id}/rounds", status_code=202, response_model=ConsiliumRoundOut)
async def start_round(
    case_id: str, payload: ConsiliumRoundCreate, response: Response,
) -> ConsiliumRoundOut:
    """Запускает раунд советников; ответы приходят задачей в строку раунда."""
    async with guarded(response):
        return await rounds.start_round(case_id, payload)


@router.get("/cases/{case_id}/rounds", response_model=ConsiliumRoundsPage)
async def list_rounds(
    case_id: str, response: Response,
    limit: int = Query(20, ge=1, le=100), offset: int = Query(0, ge=0),
) -> ConsiliumRoundsPage:
    """Раунды исследования с append-only историей ответов."""
    async with guarded(response):
        return await rounds_store.list_rounds(case_id, limit, offset)


@router.get("/cases/{case_id}/rounds/{round_id}", response_model=ConsiliumRoundOut)
async def get_round(case_id: str, round_id: str, response: Response) -> ConsiliumRoundOut:
    """Раунд со всеми попытками; прерванная операция видна в статусе строки."""
    async with guarded(response):
        return await rounds_store.get_round(case_id, round_id)


_SSE_PING_S = 15.0


def _sse_frame(event: ConsiliumStreamEvent) -> str:
    """Один фрейм SSE: тип события и JSON-данные (без обрезки дельт)."""
    return f"event: {event.type}\ndata: {event.model_dump_json()}\n\n"


async def _stream_frames(progress: streams.RoundProgress | None) -> AsyncIterator[str]:
    """Кадры SSE из журнала потока (механизм 0011); позднему подписчику — round_done."""
    if progress is None:
        # Запуск завершён (или бэкенд перезапущен) — только round_done
        yield _sse_frame(ConsiliumStreamEvent(type="round_done"))
        return
    sent = 0
    while True:
        progress.changed.clear()
        while sent < len(progress.log):
            yield _sse_frame(progress.log[sent])
            sent += 1
        if progress.finished:
            if progress.error:
                yield _sse_frame(ConsiliumStreamEvent(type="error", error=progress.error))
            yield _sse_frame(
                ConsiliumStreamEvent(type="round_done", error=progress.error),
            )
            return
        try:
            await asyncio.wait_for(progress.changed.wait(), timeout=_SSE_PING_S)
        except TimeoutError:
            yield _sse_frame(ConsiliumStreamEvent(type="ping"))


@router.get(
    "/cases/{case_id}/rounds/{round_id}/stream",
    responses={
        200: {
            "model": ConsiliumStreamEvent,
            "description": (
                "SSE-поток событий раунда: фреймы `event:` + JSON "
                "`ConsiliumStreamEvent` (role_started/delta/role_done/error/ping); "
                "после `round_done` поздних дельт нет"
            ),
            "content": {
                "text/event-stream": {
                    "schema": {"$ref": "#/components/schemas/ConsiliumStreamEvent"},
                },
            },
        },
    },
)
async def stream_round(
    case_id: str, round_id: str, response: Response,
) -> StreamingResponse:
    """Стрим событий раунда: частичные тексты ролей по мере генерации (срез 0011).

    Живой поток — только удобство: фолбэк клиента остаётся прежним (поллинг
    `GET /rounds/{id}`), готовые ответы приходят из БД. Тексты в файл задачи не
    попадают (§8), частичный текст живёт в RAM процесса.
    """
    async with guarded(response):
        # Принадлежность раунда делу: чужой/отсутствующий — честный 404
        await rounds_store.get_round(case_id, round_id)

    return StreamingResponse(
        _stream_frames(streams.get_round(round_id)),
        media_type="text/event-stream",
        headers={"Cache-Control": "private, no-store", "X-Accel-Buffering": "no"},
    )


@router.post(
    "/cases/{case_id}/rounds/{round_id}/summary",
    status_code=202, response_model=ConsiliumRoundOut,
)
async def run_summary(
    case_id: str, round_id: str, payload: ConsiliumRoundAction, response: Response,
) -> ConsiliumRoundOut:
    """Составляет итог по завершённому раунду, сохраняя разногласия (§6)."""
    async with guarded(response):
        return await rounds.run_summary(case_id, round_id, payload)


@router.post(
    "/cases/{case_id}/rounds/{round_id}/retry",
    status_code=202, response_model=ConsiliumRoundOut,
)
async def retry_answer(
    case_id: str, round_id: str, payload: ConsiliumAnswerRetry, response: Response,
) -> ConsiliumRoundOut:
    """Повтор одного неудавшегося ответа советника; история попыток остаётся."""
    async with guarded(response):
        return await rounds.retry_role(case_id, round_id, payload)


# --- Триаж готовности досье (Jev): быстрый типизированный ответ до раунда ---


@router.post("/cases/{case_id}/triage", status_code=201, response_model=ConsiliumTriageOut)
async def run_triage(
    case_id: str, payload: ConsiliumTriageCreate, response: Response,
) -> ConsiliumTriageOut:
    """Запускает триаж досье решающим классификатором; только явной кнопкой."""
    async with guarded(response):
        return await triage.run_triage(case_id, payload)


@router.get("/cases/{case_id}/triage", response_model=ConsiliumTriagePage)
async def list_triage(
    case_id: str, response: Response,
    limit: int = Query(20, ge=1, le=100), offset: int = Query(0, ge=0),
) -> ConsiliumTriagePage:
    """История попыток триажа: append-only, новые сверху."""
    async with guarded(response):
        return await triage.list_triage(case_id, limit, offset)


@router.get("/cases/{case_id}/triage/{triage_id}", response_model=ConsiliumTriageOut)
async def get_triage(
    case_id: str, triage_id: str, response: Response,
) -> ConsiliumTriageOut:
    """Точная строка триажа с типизированными решениями классификатора."""
    async with guarded(response):
        return await triage.get_triage(case_id, triage_id)


# --- Разметка Jev (§5.3): advisory-метки, только явной кнопкой ---


@router.post(
    "/cases/{case_id}/jev-marks/round-plan",
    status_code=201, response_model=ConsiliumJevMarkOut,
)
async def run_round_plan(
    case_id: str, payload: ConsiliumJevMarkRoundPlanCreate, response: Response,
) -> ConsiliumJevMarkOut:
    """«Быстрый раунд»: подбор ролей и глубины обсуждения по снимку досье."""
    async with guarded(response):
        return await jev_marks.run_round_plan(case_id, payload)


@router.post(
    "/cases/{case_id}/jev-marks/proposal",
    status_code=201, response_model=ConsiliumJevMarkOut,
)
async def run_proposal_mark(
    case_id: str, payload: ConsiliumJevMarkAnswerCreate, response: Response,
) -> ConsiliumJevMarkOut:
    """Карточка предложения из текста ответа советника (вид шага §7 и поля)."""
    async with guarded(response):
        return await jev_marks.run_proposal_mark(case_id, payload)


@router.post(
    "/cases/{case_id}/jev-marks/source-marks",
    status_code=201, response_model=ConsiliumJevMarkOut,
)
async def run_source_marks(
    case_id: str, payload: ConsiliumJevMarkAnswerCreate, response: Response,
) -> ConsiliumJevMarkOut:
    """Разметка источников утверждений текста ответа (три источника не смешиваются)."""
    async with guarded(response):
        return await jev_marks.run_source_marks(case_id, payload)


@router.get("/cases/{case_id}/jev-marks", response_model=ConsiliumJevMarksPage)
async def list_jev_marks(
    case_id: str, response: Response,
    kind: str | None = Query(None, pattern=r"^(round_plan|proposal|source_marks)$"),
    subject_id: str | None = Query(None, max_length=128),
    limit: int = Query(20, ge=1, le=100), offset: int = Query(0, ge=0),
) -> ConsiliumJevMarksPage:
    """История попыток разметки (append-only, новые сверху) с фильтрами."""
    async with guarded(response):
        return await jev_marks.list_marks(case_id, kind, subject_id, limit, offset)


@router.get("/cases/{case_id}/jev-marks/{mark_id}", response_model=ConsiliumJevMarkOut)
async def get_jev_mark(
    case_id: str, mark_id: str, response: Response,
) -> ConsiliumJevMarkOut:
    """Точная строка разметки с типизированными метками и предупреждениями."""
    async with guarded(response):
        return await jev_marks.get_mark(case_id, mark_id)


# --- Мозговой штурм (срез 0012): идеи и резюме по снимку досье ---


@router.post(
    "/cases/{case_id}/brainstorms", status_code=202, response_model=ConsiliumBrainstormOut,
)
async def run_brainstorm(
    case_id: str, payload: ConsiliumBrainstormCreate, response: Response,
) -> ConsiliumBrainstormOut:
    """Запускает мозговой штурм по снимку досье; только явной кнопкой."""
    async with guarded(response):
        return await brainstorm.run(case_id, payload)


@router.get("/cases/{case_id}/brainstorms", response_model=ConsiliumBrainstormsPage)
async def list_brainstorms(
    case_id: str, response: Response,
    limit: int = Query(20, ge=1, le=100), offset: int = Query(0, ge=0),
) -> ConsiliumBrainstormsPage:
    """История запусков штурма: append-only, новые сверху."""
    async with guarded(response):
        return await brainstorm.list_brainstorms(case_id, limit, offset)


@router.get(
    "/cases/{case_id}/brainstorms/{brainstorm_id}", response_model=ConsiliumBrainstormOut,
)
async def get_brainstorm(
    case_id: str, brainstorm_id: str, response: Response,
) -> ConsiliumBrainstormOut:
    """Точный запуск штурма: резюме, идеи и сырой текст ответа модели."""
    async with guarded(response):
        return await brainstorm.get_brainstorm(case_id, brainstorm_id)


@router.get(
    "/cases/{case_id}/brainstorms/{brainstorm_id}/stream",
    responses={
        200: {
            "model": ConsiliumStreamEvent,
            "description": (
                "SSE-поток событий штурма: фреймы `event:` + JSON "
                "`ConsiliumStreamEvent` (роль `brainstorm`: role_started/delta/"
                "role_done/error/ping); после `round_done` поздних дельт нет"
            ),
            "content": {
                "text/event-stream": {
                    "schema": {"$ref": "#/components/schemas/ConsiliumStreamEvent"},
                },
            },
        },
    },
)
async def stream_brainstorm(
    case_id: str, brainstorm_id: str, response: Response,
) -> StreamingResponse:
    """Стрим событий штурма: растущий текст по мере генерации (механизм 0011).

    Живой поток — только удобство: фолбэк клиента остаётся прежним (поллинг
    `GET /brainstorms/{id}`), готовый результат приходит из БД. Тексты в файл
    задачи не попадают (§8), частичный текст живёт в RAM процесса.
    """
    async with guarded(response):
        # Принадлежность запуска делу: чужой/отсутствующий — честный 404
        await brainstorm.get_brainstorm(case_id, brainstorm_id)
    return StreamingResponse(
        _stream_frames(streams.get_round(brainstorm_id)),
        media_type="text/event-stream",
        headers={"Cache-Control": "private, no-store", "X-Accel-Buffering": "no"},
    )


# --- Библиотека исследования (Т5, срез 0013): предложения и решения ---


@router.post("/cases/{case_id}/proposals", status_code=201, response_model=ConsiliumProposalOut)
async def create_proposal(
    case_id: str, payload: ConsiliumProposalCreate, response: Response,
) -> ConsiliumProposalOut:
    """Новое предложение: вручную или из идеи штурма/ответа советника."""
    async with guarded(response):
        return await library.create(case_id, payload)


@router.get("/cases/{case_id}/proposals", response_model=ConsiliumProposalsPage)
async def list_proposals(
    case_id: str, response: Response,
    limit: int = Query(20, ge=1, le=100), offset: int = Query(0, ge=0),
) -> ConsiliumProposalsPage:
    """Библиотека исследования: карточки предложений с решениями и исполнениями."""
    async with guarded(response):
        return await library.list_proposals(case_id, limit, offset)


@router.get("/cases/{case_id}/proposals/{proposal_id}", response_model=ConsiliumProposalOut)
async def get_proposal(
    case_id: str, proposal_id: str, response: Response,
) -> ConsiliumProposalOut:
    """Точная карточка предложения с append-only историей решений."""
    async with guarded(response):
        return await library.get_proposal(case_id, proposal_id)


@router.patch("/cases/{case_id}/proposals/{proposal_id}", response_model=ConsiliumProposalOut)
async def update_proposal(
    case_id: str, proposal_id: str, payload: ConsiliumProposalUpdate, response: Response,
) -> ConsiliumProposalOut:
    """Правка карточки: новая версия, решения прежних версий остаются."""
    async with guarded(response):
        return await library.update(case_id, proposal_id, payload)


@router.post(
    "/cases/{case_id}/proposals/{proposal_id}/decisions",
    status_code=201, response_model=ConsiliumDecisionOut,
)
async def add_decision(
    case_id: str, proposal_id: str, payload: ConsiliumDecisionCreate, response: Response,
) -> ConsiliumDecisionOut:
    """Решение человека (принято/отклонено) с комментарием; append-only."""
    async with guarded(response):
        return await library.add_decision(case_id, proposal_id, payload)


@router.post(
    "/cases/{case_id}/proposals/{proposal_id}/executions",
    status_code=201, response_model=ConsiliumExecutionOut,
)
async def add_execution(
    case_id: str, proposal_id: str, payload: ConsiliumExecutionCreate, response: Response,
) -> ConsiliumExecutionOut:
    """Ручное исполнение предложения и результат; каждое — новой строкой."""
    async with guarded(response):
        return await library.add_execution(case_id, proposal_id, payload)