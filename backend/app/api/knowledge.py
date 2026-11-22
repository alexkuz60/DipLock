"""HTTP-контракт библиотеки знаний Консилиума: источники, поиск, граф, вложения.

Тяжёлый разбор файлов (PDF/DOCX/XLSX) идёт в потоке через ``asyncio.to_thread``:
в ``async def`` MNE-подобные CPU-операции недопустимы (правило AGENTS.md).
"""
from __future__ import annotations

import asyncio
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import APIRouter, File, Form, HTTPException, Response, UploadFile
from sqlalchemy.exc import SQLAlchemyError

from app.api.private import PrivateRoute
from app.core.config import settings
from app.schemas.knowledge import (
    AgentAttachmentCreate,
    AgentAttachmentOut,
    AgentAttachmentsOut,
    KnowledgeAnnotationCreate,
    KnowledgeAnnotationOut,
    KnowledgeDocTagsUpdate,
    KnowledgeDocumentDetail,
    KnowledgeDocumentOut,
    KnowledgeDocumentsPage,
    KnowledgeFolderCreate,
    KnowledgeFolderOut,
    KnowledgeFoldersOut,
    KnowledgeGraphOut,
    KnowledgeLinkCreate,
    KnowledgeLinkOut,
    KnowledgeSearchOut,
    KnowledgeTagCreate,
    KnowledgeTagOut,
    KnowledgeTagsOut,
    KnowledgeWebAdd,
)
from app.services.knowledge import chunking, extract, index, storage, store
from app.services.knowledge.store import KnowledgeError

router = APIRouter(prefix="/knowledge", tags=["Консилиум-знания"], route_class=PrivateRoute)


@asynccontextmanager
async def guarded(response: Response) -> AsyncIterator[None]:
    """Приватные ответы и безопасные ошибки библиотеки."""
    response.headers["Cache-Control"] = "private, no-store"
    try:
        yield
    except KnowledgeError as exc:
        raise HTTPException(exc.status, str(exc), headers={"Cache-Control": "no-store"}) from None
    except storage.KnowledgeLimitError as exc:
        raise HTTPException(413, str(exc), headers={"Cache-Control": "no-store"}) from None
    except SQLAlchemyError:
        raise HTTPException(503, "Не удалось сохранить или прочитать библиотеку", headers={
            "Cache-Control": "no-store",
        }) from None


@router.get("/folders", response_model=KnowledgeFoldersOut)
async def list_folders(response: Response) -> KnowledgeFoldersOut:
    """Папки библиотеки с числом документов."""
    async with guarded(response):
        return await store.list_folders()


@router.post("/folders", status_code=201, response_model=KnowledgeFolderOut)
async def create_folder(payload: KnowledgeFolderCreate, response: Response) -> KnowledgeFolderOut:
    """Новая папка (вложенность через ``parent_id``)."""
    async with guarded(response):
        return await store.create_folder(payload)


@router.delete("/folders/{folder_id}", status_code=204)
async def delete_folder(folder_id: str, response: Response) -> Response:
    """Удаляет папку; документы внутри удаляются каскадом."""
    async with guarded(response):
        await store.delete_folder(folder_id)
        return Response(status_code=204, headers={"Cache-Control": "no-store"})


@router.get("/documents", response_model=KnowledgeDocumentsPage)
async def list_documents(
    response: Response,
    folder_id: str | None = None,
    limit: int = 100,
    offset: int = 0,
) -> KnowledgeDocumentsPage:
    """Документы библиотеки, новые сверху."""
    async with guarded(response):
        return await store.list_documents(
            folder_id=folder_id, limit=max(1, min(limit, 500)), offset=max(0, offset),
        )


@router.post("/documents", status_code=201, response_model=KnowledgeDocumentOut)
async def upload_document(
    response: Response,
    file: UploadFile = File(...),
    folder_id: str | None = Form(default=None),
    title: str | None = Form(default=None),
) -> KnowledgeDocumentOut:
    """Загрузка файла: дедуп по sha256, разбор в потоке, индексация фрагментов."""
    async with guarded(response):
        data = await file.read()
        if not data:
            raise HTTPException(400, "Файл пуст", headers={"Cache-Control": "no-store"})
        storage.check_limits(len(data))
        sha256 = storage.sha256_of(data)
        existing = await store.find_document_by_sha(sha256)
        if existing is not None:
            return existing
        filename = file.filename or "document"
        kind = extract.detect_kind(filename)
        document_id = str(uuid.uuid4())
        stored = await asyncio.to_thread(storage.save_bytes, document_id, filename, data)
        extracted = await asyncio.to_thread(extract.extract, stored.path, kind)
        chunks = chunking.chunk_sections(
            extracted.sections,
            size=settings.knowledge_chunk_chars,
            overlap=settings.knowledge_chunk_overlap,
        )
        vectors = await index.embed_texts([chunk.text for chunk in chunks]) if chunks else None
        return await store.create_document(
            document_id=document_id,
            folder_id=folder_id or None,
            title=(title or filename).strip() or filename,
            filename=filename,
            kind=kind,
            source_url=None,
            sha256=sha256,
            size_bytes=stored.size_bytes,
            extracted=extracted,
            chunks=chunks,
            embeddings=vectors,
            meta={"warnings": extracted.warnings},
        )


@router.post("/documents/web", status_code=201, response_model=KnowledgeDocumentOut)
async def add_web_document(payload: KnowledgeWebAdd, response: Response) -> KnowledgeDocumentOut:
    """Сохраняет веб-страницу в библиотеку по ссылке (текст, без картинок)."""
    async with guarded(response):
        extracted, page_title = await asyncio.to_thread(extract.extract_web, payload.url)
        chunks = chunking.chunk_sections(
            extracted.sections,
            size=settings.knowledge_chunk_chars,
            overlap=settings.knowledge_chunk_overlap,
        )
        vectors = await index.embed_texts([chunk.text for chunk in chunks]) if chunks else None
        return await store.create_document(
            document_id=str(uuid.uuid4()),
            folder_id=payload.folder_id,
            title=(payload.title or page_title or payload.url).strip()[:300],
            filename=payload.url.rsplit("/", 1)[-1] or "web",
            kind="web",
            source_url=payload.url,
            sha256=storage.sha256_of(payload.url.encode()),
            size_bytes=0,
            extracted=extracted,
            chunks=chunks,
            embeddings=vectors,
            meta={"warnings": extracted.warnings},
        )


@router.get("/documents/{document_id}", response_model=KnowledgeDocumentDetail)
async def get_document(document_id: str, response: Response) -> KnowledgeDocumentDetail:
    """Документ с оглавлением по разделам и аннотациями."""
    async with guarded(response):
        return await store.get_document(document_id)


@router.delete("/documents/{document_id}", status_code=204)
async def delete_document(document_id: str, response: Response) -> Response:
    """Удаляет документ и его файлы с диска."""
    async with guarded(response):
        await store.delete_document(document_id)
        await asyncio.to_thread(storage.delete_document_files, document_id)
        return Response(status_code=204, headers={"Cache-Control": "no-store"})


@router.post(
    "/documents/{document_id}/annotations",
    status_code=201,
    response_model=KnowledgeAnnotationOut,
)
async def add_annotation(
    document_id: str,
    payload: KnowledgeAnnotationCreate,
    response: Response,
) -> KnowledgeAnnotationOut:
    """Аннотация раздела или фрагмента документа."""
    async with guarded(response):
        return await store.add_annotation(document_id, payload)


@router.delete("/annotations/{annotation_id}", status_code=204)
async def delete_annotation(annotation_id: str, response: Response) -> Response:
    """Удаляет аннотацию."""
    async with guarded(response):
        await store.delete_annotation(annotation_id)
        return Response(status_code=204, headers={"Cache-Control": "no-store"})


@router.put("/documents/{document_id}/tags", response_model=list[str])
async def set_document_tags(
    document_id: str,
    payload: KnowledgeDocTagsUpdate,
    response: Response,
) -> list[str]:
    """Заменяет набор тегов документа (новые имена создаются)."""
    async with guarded(response):
        return await store.set_document_tags(document_id, payload.tags)


@router.get("/tags", response_model=KnowledgeTagsOut)
async def list_tags(response: Response) -> KnowledgeTagsOut:
    """Все теги библиотеки с числом документов."""
    async with guarded(response):
        return await store.list_tags()


@router.post("/tags", status_code=201, response_model=KnowledgeTagOut)
async def create_tag(payload: KnowledgeTagCreate, response: Response) -> KnowledgeTagOut:
    """Создаёт тег (повтор имени возвращает существующий)."""
    async with guarded(response):
        return await store.create_tag(payload.name)


@router.get("/search", response_model=KnowledgeSearchOut)
async def search(
    response: Response,
    q: str,
    limit: int | None = None,
) -> KnowledgeSearchOut:
    """Поиск по фрагментам: TF-IDF и эмбеддинги, режим — в ответе."""
    async with guarded(response):
        query = q.strip()
        if not query:
            raise HTTPException(400, "Пустой поисковый запрос", headers={
                "Cache-Control": "no-store",
            })
        return await store.search(
            query, limit=limit or settings.knowledge_search_limit,
        )


@router.get("/graph", response_model=KnowledgeGraphOut)
async def graph(response: Response) -> KnowledgeGraphOut:
    """Граф знаний: узлы и подтверждённые рёбра."""
    async with guarded(response):
        return await store.graph()


@router.post("/links", status_code=201, response_model=KnowledgeLinkOut)
async def create_link(payload: KnowledgeLinkCreate, response: Response) -> KnowledgeLinkOut:
    """Ребро графа знаний."""
    async with guarded(response):
        return await store.create_link(payload)


@router.delete("/links/{link_id}", status_code=204)
async def delete_link(link_id: str, response: Response) -> Response:
    """Удаляет ребро графа."""
    async with guarded(response):
        await store.delete_link(link_id)
        return Response(status_code=204, headers={"Cache-Control": "no-store"})


@router.get("/threads/{thread_id}/attachments", response_model=AgentAttachmentsOut)
async def list_attachments(thread_id: str, response: Response) -> AgentAttachmentsOut:
    """Вложения нити чата."""
    async with guarded(response):
        return AgentAttachmentsOut(items=await store.list_attachments(thread_id))


@router.post(
    "/threads/{thread_id}/attachments",
    status_code=201,
    response_model=AgentAttachmentOut,
)
async def add_attachment(
    thread_id: str,
    payload: AgentAttachmentCreate,
    response: Response,
) -> AgentAttachmentOut:
    """Прикрепляет документ, ссылку или отчёт ЭЭГ к нити."""
    async with guarded(response):
        return await store.add_attachment(thread_id, payload)


@router.delete("/attachments/{attachment_id}", status_code=204)
async def delete_attachment(attachment_id: str, response: Response) -> Response:
    """Снимает вложение с нити."""
    async with guarded(response):
        await store.delete_attachment(attachment_id)
        return Response(status_code=204, headers={"Cache-Control": "no-store"})
