"""HTTP-контракт основания Консилиума: работа выполняется сервисом хранения."""

from collections.abc import AsyncIterator, Callable, Coroutine
from contextlib import asynccontextmanager
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from sqlalchemy.exc import IntegrityError, SQLAlchemyError

from app.schemas.consilium import (
    ConsiliumCaseCreate,
    ConsiliumCaseOut,
    ConsiliumCasesPage,
    ConsiliumCaseUpdate,
    ConsiliumContextCreate,
    ConsiliumContextOut,
    ConsiliumContextPage,
    ConsiliumContextUpdate,
    ConsiliumDeletionPreview,
    ConsiliumEvidence,
    ConsiliumEvidenceCreate,
    ConsiliumEvidenceDeletion,
    ConsiliumEvidencePage,
    ConsiliumMessageCreate,
    ConsiliumMessageOut,
    ConsiliumMessagesPage,
    ConsiliumMessageUpdate,
    ConsiliumRecording,
    ConsiliumSnapshot,
    ConsiliumSnapshotCreate,
    ConsiliumSnapshotsPage,
    ConsiliumSourcesPage,
)
from app.services import recording_store
from app.services.consilium import dossier, sources, store


class PrivateRoute(APIRoute):
    """Ошибка формы не эхо-передаёт чувствительный текст и не кэшируется."""

    def get_route_handler(self) -> Callable[[Request], Coroutine[Any, Any, Response]]:
        """Сохраняет обычный контракт ошибок loc/msg/type без input и ctx."""
        original = super().get_route_handler()

        async def handle(request: Request) -> Response:
            try:
                return await original(request)
            except RequestValidationError as exc:
                return JSONResponse(
                    status_code=422,
                    content={"detail": [
                        {key: error[key] for key in ("loc", "msg", "type")}
                        for error in exc.errors()
                    ]},
                    headers={"Cache-Control": "private, no-store"},
                )

        return handle


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