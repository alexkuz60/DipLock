"""Строки БД библиотеки знаний: папки, документы, фрагменты, теги, граф, вложения.

Все обращения к таблицам знаний идут через этот модуль (правило
``docs/rules/data-and-caches.md``): роуты и сервисы не пишут ORM-строки сами.
"""
from __future__ import annotations

import html
import os
import re
import uuid
from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import delete, func, select

from app.core.config import settings
from app.models import db
from app.schemas.knowledge import (
    AgentAttachmentCreate,
    AgentAttachmentOut,
    KnowledgeAnnotationCreate,
    KnowledgeAnnotationOut,
    KnowledgeChunkOut,
    KnowledgeDocumentDetail,
    KnowledgeDocumentOut,
    KnowledgeDocumentsPage,
    KnowledgeFolderCreate,
    KnowledgeFolderOut,
    KnowledgeFoldersOut,
    KnowledgeGraphNode,
    KnowledgeGraphOut,
    KnowledgeLinkCreate,
    KnowledgeLinkOut,
    KnowledgeSearchHitOut,
    KnowledgeSearchOut,
    KnowledgeTagOut,
    KnowledgeTagsOut,
)
from app.services.cache_store import cache_read
from app.services.knowledge import index as knowledge_index
from app.services.knowledge.chunking import Chunk
from app.services.knowledge.extract import ExtractResult


class KnowledgeError(Exception):
    """Ошибка библиотеки с текстом для UI (404/400), без путей сервера."""

    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.status = status


def utcnow() -> datetime:
    """Текущее время UTC без микросекунд — как в остальных таблицах."""
    return datetime.now(UTC).replace(tzinfo=None, microsecond=0)


def _set(row: Any, **fields: Any) -> None:
    """Мутация ORM-строки: setattr с переменными — mypy и ruff без замечаний."""
    for name, value in fields.items():
        setattr(row, name, value)


def _folder_out(row: db.KnowledgeFolder, documents: int) -> KnowledgeFolderOut:
    """Папка с числом документов."""
    return KnowledgeFolderOut.model_validate({
        "id": row.id, "name": row.name, "parent_id": row.parent_id,
        "documents": documents, "created_at": row.created_at,
    })


def _document_out(
    row: db.KnowledgeDocument,
    tags: Sequence[str],
    chunks: int,
) -> KnowledgeDocumentOut:
    """Документ с тегами и числом фрагментов."""
    return KnowledgeDocumentOut.model_validate({
        "id": row.id, "folder_id": row.folder_id, "title": row.title,
        "filename": row.filename, "kind": row.kind, "source_url": row.source_url,
        "size_bytes": row.size_bytes, "pages": row.pages, "text_chars": row.text_chars,
        "status": row.status, "error": row.error, "tags": list(tags),
        "chunks": chunks, "created_at": row.created_at, "indexed_at": row.indexed_at,
    })


def _chunk_out(row: db.KnowledgeChunk) -> KnowledgeChunkOut:
    """Фрагмент документа."""
    return KnowledgeChunkOut.model_validate({
        "id": row.id, "ordinal": row.ordinal, "heading": row.heading,
        "page_from": row.page_from, "page_to": row.page_to, "text": row.text,
        "tokens": row.tokens,
    })


def _annotation_out(row: db.KnowledgeAnnotation) -> KnowledgeAnnotationOut:
    """Аннотация раздела."""
    return KnowledgeAnnotationOut.model_validate({
        "id": row.id, "document_id": row.document_id, "chunk_id": row.chunk_id,
        "heading": row.heading, "note": row.note, "created_at": row.created_at,
    })


def _link_out(row: db.KnowledgeLink) -> KnowledgeLinkOut:
    """Ребро графа."""
    return KnowledgeLinkOut.model_validate({
        "id": row.id, "from_kind": row.from_kind, "from_id": row.from_id,
        "to_kind": row.to_kind, "to_id": row.to_id, "relation": row.relation,
        "confirmed": row.confirmed, "created_at": row.created_at,
    })


def _attachment_out(row: db.AgentThreadAttachment) -> AgentAttachmentOut:
    """Вложение нити."""
    return AgentAttachmentOut.model_validate({
        "id": row.id, "thread_id": row.thread_id, "kind": row.kind,
        "ref_id": row.ref_id, "label": row.label, "created_at": row.created_at,
    })


async def create_folder(payload: KnowledgeFolderCreate) -> KnowledgeFolderOut:
    """Новая папка; родитель проверяется на существование."""
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        if payload.parent_id is not None:
            parent = await session.get(db.KnowledgeFolder, payload.parent_id)
            if parent is None:
                raise KnowledgeError("Родительская папка не найдена", status=404)
        row = db.KnowledgeFolder(
            id=str(uuid.uuid4()), name=payload.name, parent_id=payload.parent_id,
            created_at=utcnow(),
        )
        session.add(row)
        await session.commit()
        return _folder_out(row, 0)


async def list_folders() -> KnowledgeFoldersOut:
    """Все папки с числом документов, по имени."""
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        counts: dict[str, int] = dict(
            (
                await session.execute(
                    select(db.KnowledgeDocument.folder_id, func.count())
                    .group_by(db.KnowledgeDocument.folder_id),
                )
            ).all(),
        )
        rows = (
            await session.execute(
                select(db.KnowledgeFolder).order_by(db.KnowledgeFolder.name),
            )
        ).scalars().all()
        return KnowledgeFoldersOut(
            items=[_folder_out(row, int(counts.get(str(row.id), 0))) for row in rows],
        )


async def delete_folder(folder_id: str) -> None:
    """Удаляет папку; документы внутри удаляются каскадом (файлы — сервис)."""
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        row = await session.get(db.KnowledgeFolder, folder_id)
        if row is None:
            raise KnowledgeError("Папка не найдена", status=404)
        await session.execute(
            delete(db.KnowledgeFolder).where(db.KnowledgeFolder.id == folder_id),
        )
        await session.commit()


async def find_document_by_sha(sha256: str) -> KnowledgeDocumentOut | None:
    """Документ с тем же содержимым — дедуп повторной загрузки."""
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        row = (
            await session.execute(
                select(db.KnowledgeDocument)
                .where(db.KnowledgeDocument.sha256 == sha256)
                .order_by(db.KnowledgeDocument.created_at)
                .limit(1),
            )
        ).scalars().first()
        if row is None:
            return None
        tags = await _tags_of(session, str(row.id))
        chunks = await _chunk_count(session, str(row.id))
        return _document_out(row, tags, chunks)


async def _tags_of(session: Any, document_id: str) -> list[str]:
    """Имена тегов документа по алфавиту."""
    rows = (
        await session.execute(
            select(db.KnowledgeTag.name)
            .join(db.KnowledgeDocTag, db.KnowledgeDocTag.tag_id == db.KnowledgeTag.id)
            .where(db.KnowledgeDocTag.document_id == document_id)
            .order_by(db.KnowledgeTag.name),
        )
    ).scalars().all()
    return list(rows)


async def _chunk_count(session: Any, document_id: str) -> int:
    """Число фрагментов документа."""
    return int(
        (
            await session.execute(
                select(func.count())
                .select_from(db.KnowledgeChunk)
                .where(db.KnowledgeChunk.document_id == document_id),
            )
        ).scalar_one(),
    )


async def create_document(
    *,
    document_id: str,
    folder_id: str | None,
    title: str,
    filename: str,
    kind: str,
    source_url: str | None,
    sha256: str,
    size_bytes: int,
    extracted: ExtractResult,
    chunks: list[Chunk],
    embeddings: list[list[float]] | None,
    meta: dict[str, Any] | None = None,
) -> KnowledgeDocumentOut:
    """Пишет документ, фрагменты и статус разбора одной транзакцией."""
    await db.init_db()
    status = "ok" if chunks else "empty"
    error = "; ".join(extracted.warnings) if extracted.warnings else None
    async with db.AsyncSessionLocal() as session:
        if folder_id is not None:
            folder = await session.get(db.KnowledgeFolder, folder_id)
            if folder is None:
                raise KnowledgeError("Папка не найдена", status=404)
        row = db.KnowledgeDocument(
            id=document_id, folder_id=folder_id, title=title, filename=filename,
            kind=kind, source_url=source_url, sha256=sha256, size_bytes=size_bytes,
            pages=extracted.pages, text_chars=extracted.text_chars, status=status,
            error=error, meta=dict(meta or {}), created_at=utcnow(),
            indexed_at=utcnow() if chunks else None,
        )
        session.add(row)
        for position, chunk in enumerate(chunks):
            vector = embeddings[position] if embeddings and position < len(embeddings) else None
            session.add(
                db.KnowledgeChunk(
                    id=str(uuid.uuid4()), document_id=document_id,
                    ordinal=chunk.ordinal, heading=chunk.heading,
                    page_from=chunk.page_from, page_to=chunk.page_to,
                    text=chunk.text, tokens=len(chunk.text.split()),
                    embedding=vector,
                ),
            )
        await session.commit()
        return _document_out(row, [], len(chunks))


async def list_documents(
    *,
    folder_id: str | None = None,
    limit: int = 100,
    offset: int = 0,
) -> KnowledgeDocumentsPage:
    """Документы библиотеки, новые сверху; ``folder_id`` — фильтр папки."""
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        query = select(db.KnowledgeDocument)
        counter = select(func.count()).select_from(db.KnowledgeDocument)
        if folder_id is not None:
            query = query.where(db.KnowledgeDocument.folder_id == folder_id)
            counter = counter.where(db.KnowledgeDocument.folder_id == folder_id)
        total = int((await session.execute(counter)).scalar_one())
        rows = (
            await session.execute(
                query.order_by(
                    db.KnowledgeDocument.created_at.desc(), db.KnowledgeDocument.id,
                ).limit(limit).offset(offset),
            )
        ).scalars().all()
        items = []
        for row in rows:
            items.append(
                _document_out(
                    row,
                    await _tags_of(session, row.id),
                    await _chunk_count(session, row.id),
                ),
            )
        return KnowledgeDocumentsPage(items=items, total=total)


async def get_document(document_id: str) -> KnowledgeDocumentDetail:
    """Документ с оглавлением (фрагментами) и аннотациями."""
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        row = await session.get(db.KnowledgeDocument, document_id)
        if row is None:
            raise KnowledgeError("Документ не найден", status=404)
        chunks = (
            await session.execute(
                select(db.KnowledgeChunk)
                .where(db.KnowledgeChunk.document_id == document_id)
                .order_by(db.KnowledgeChunk.ordinal),
            )
        ).scalars().all()
        annotations = (
            await session.execute(
                select(db.KnowledgeAnnotation)
                .where(db.KnowledgeAnnotation.document_id == document_id)
                .order_by(db.KnowledgeAnnotation.created_at),
            )
        ).scalars().all()
        return KnowledgeDocumentDetail(
            document=_document_out(row, await _tags_of(session, document_id), len(chunks)),
            chunks=[_chunk_out(chunk) for chunk in chunks],
            annotations=[_annotation_out(item) for item in annotations],
        )


async def delete_document(document_id: str) -> None:
    """Удаляет документ, фрагменты, теги-связи и аннотации (файлы — сервис)."""
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        row = await session.get(db.KnowledgeDocument, document_id)
        if row is None:
            raise KnowledgeError("Документ не найден", status=404)
        await session.execute(
            delete(db.KnowledgeAnnotation).where(
                db.KnowledgeAnnotation.document_id == document_id,
            ),
        )
        await session.execute(
            delete(db.KnowledgeDocTag).where(db.KnowledgeDocTag.document_id == document_id),
        )
        await session.execute(
            delete(db.KnowledgeChunk).where(db.KnowledgeChunk.document_id == document_id),
        )
        await session.execute(
            delete(db.KnowledgeLink).where(
                db.KnowledgeLink.from_kind == "document",
                db.KnowledgeLink.from_id == document_id,
            ),
        )
        await session.execute(
            delete(db.KnowledgeLink).where(
                db.KnowledgeLink.to_kind == "document",
                db.KnowledgeLink.to_id == document_id,
            ),
        )
        await session.execute(
            delete(db.KnowledgeDocument).where(db.KnowledgeDocument.id == document_id),
        )
        await session.commit()


async def add_annotation(
    document_id: str,
    payload: KnowledgeAnnotationCreate,
) -> KnowledgeAnnotationOut:
    """Аннотация к документу или фрагменту; документ обязан существовать."""
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        if await session.get(db.KnowledgeDocument, document_id) is None:
            raise KnowledgeError("Документ не найден", status=404)
        row = db.KnowledgeAnnotation(
            id=str(uuid.uuid4()), document_id=document_id, chunk_id=payload.chunk_id,
            heading=payload.heading, note=payload.note, created_at=utcnow(),
        )
        session.add(row)
        await session.commit()
        return _annotation_out(row)


async def delete_annotation(annotation_id: str) -> None:
    """Удаляет аннотацию."""
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        row = await session.get(db.KnowledgeAnnotation, annotation_id)
        if row is None:
            raise KnowledgeError("Аннотация не найдена", status=404)
        await session.execute(
            delete(db.KnowledgeAnnotation).where(db.KnowledgeAnnotation.id == annotation_id),
        )
        await session.commit()


async def list_tags() -> KnowledgeTagsOut:
    """Все теги с числом документов."""
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        rows = (
            await session.execute(
                select(db.KnowledgeTag, func.count(db.KnowledgeDocTag.document_id))
                .outerjoin(db.KnowledgeDocTag, db.KnowledgeDocTag.tag_id == db.KnowledgeTag.id)
                .group_by(db.KnowledgeTag.id)
                .order_by(db.KnowledgeTag.name),
            )
        ).all()
        return KnowledgeTagsOut(
            items=[
                KnowledgeTagOut.model_validate({
                    "id": tag.id, "name": tag.name, "documents": int(count),
                })
                for tag, count in rows
            ],
        )


async def create_tag(name: str) -> KnowledgeTagOut:
    """Создаёт тег; повтор имени (без учёта регистра) возвращает существующий."""
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        row = (
            await session.execute(
                select(db.KnowledgeTag).where(func.lower(db.KnowledgeTag.name) == name.lower()),
            )
        ).scalars().first()
        if row is None:
            row = db.KnowledgeTag(id=str(uuid.uuid4()), name=name, created_at=utcnow())
            session.add(row)
            await session.commit()
        count = int(
            (
                await session.execute(
                    select(func.count())
                    .select_from(db.KnowledgeDocTag)
                    .where(db.KnowledgeDocTag.tag_id == row.id),
                )
            ).scalar_one(),
        )
        return KnowledgeTagOut.model_validate({
            "id": row.id, "name": row.name, "documents": count,
        })


async def set_document_tags(document_id: str, names: list[str]) -> list[str]:
    """Заменяет набор тегов документа; новые имена создаются на месте."""
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        if await session.get(db.KnowledgeDocument, document_id) is None:
            raise KnowledgeError("Документ не найден", status=404)
        await session.execute(
            delete(db.KnowledgeDocTag).where(db.KnowledgeDocTag.document_id == document_id),
        )
        seen: set[str] = set()
        for raw in names:
            name = raw.strip()
            if not name or name.lower() in seen:
                continue
            seen.add(name.lower())
            tag = (
                await session.execute(
                    select(db.KnowledgeTag).where(db.KnowledgeTag.name == name),
                )
            ).scalars().first()
            if tag is None:
                tag = db.KnowledgeTag(id=str(uuid.uuid4()), name=name, created_at=utcnow())
                session.add(tag)
                await session.flush()
            session.add(db.KnowledgeDocTag(document_id=document_id, tag_id=tag.id))
        await session.commit()
        return await _tags_of(session, document_id)


async def create_link(payload: KnowledgeLinkCreate) -> KnowledgeLinkOut:
    """Ребро графа; дубль (те же узлы и отношение) возвращается существующим."""
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        existing = (
            await session.execute(
                select(db.KnowledgeLink).where(
                    db.KnowledgeLink.from_kind == payload.from_kind,
                    db.KnowledgeLink.from_id == payload.from_id,
                    db.KnowledgeLink.to_kind == payload.to_kind,
                    db.KnowledgeLink.to_id == payload.to_id,
                    db.KnowledgeLink.relation == payload.relation,
                ),
            )
        ).scalars().first()
        if existing is not None:
            return _link_out(existing)
        row = db.KnowledgeLink(
            id=str(uuid.uuid4()), from_kind=payload.from_kind, from_id=payload.from_id,
            to_kind=payload.to_kind, to_id=payload.to_id, relation=payload.relation,
            confirmed=payload.confirmed, created_at=utcnow(),
        )
        session.add(row)
        await session.commit()
        return _link_out(row)


async def delete_link(link_id: str) -> None:
    """Удаляет ребро графа."""
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        row = await session.get(db.KnowledgeLink, link_id)
        if row is None:
            raise KnowledgeError("Связь не найдена", status=404)
        await session.execute(
            delete(db.KnowledgeLink).where(db.KnowledgeLink.id == link_id),
        )
        await session.commit()


async def graph() -> KnowledgeGraphOut:
    """Граф знаний: узлы документов и тегов, только подтверждённые рёбра."""
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        documents: Sequence[Any] = (
            await session.execute(
                select(db.KnowledgeDocument.id, db.KnowledgeDocument.title),
            )
        ).all()
        tags: Sequence[Any] = (
            await session.execute(
                select(db.KnowledgeTag.id, db.KnowledgeTag.name, func.count(db.KnowledgeDocTag.document_id))
                .outerjoin(db.KnowledgeDocTag, db.KnowledgeDocTag.tag_id == db.KnowledgeTag.id)
                .group_by(db.KnowledgeTag.id),
            )
        ).all()
        edges = (
            await session.execute(
                select(db.KnowledgeLink)
                .where(db.KnowledgeLink.confirmed.is_(True))
                .order_by(db.KnowledgeLink.created_at),
            )
        ).scalars().all()
        nodes = [
            KnowledgeGraphNode(kind="document", id=doc_id, label=title)
            for doc_id, title in documents
        ]
        nodes.extend(
            KnowledgeGraphNode(kind="tag", id=tag_id, label=name, documents=int(count))
            for tag_id, name, count in tags
        )
        return KnowledgeGraphOut(nodes=nodes, edges=[_link_out(edge) for edge in edges])


async def search(query: str, *, limit: int) -> KnowledgeSearchOut:
    """Поиск по фрагментам: TF-IDF всегда, эмбеддинги — когда провайдер доступен."""
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        rows: Sequence[Any] = (
            await session.execute(
                select(
                    db.KnowledgeChunk.id,
                    db.KnowledgeChunk.document_id,
                    db.KnowledgeChunk.ordinal,
                    db.KnowledgeChunk.heading,
                    db.KnowledgeChunk.page_from,
                    db.KnowledgeChunk.text,
                    db.KnowledgeChunk.embedding,
                    db.KnowledgeDocument.title,
                ).join(
                    db.KnowledgeDocument,
                    db.KnowledgeDocument.id == db.KnowledgeChunk.document_id,
                ),
            )
        ).all()
    titles = {row[1]: row[7] for row in rows}
    payload = [row[:7] for row in rows]
    query_vector = None
    if payload:
        vectors = await knowledge_index.embed_texts([query])
        query_vector = vectors[0] if vectors else None
    hits, mode = knowledge_index.rank(
        query, payload, query_vector=query_vector, limit=limit,
    )
    return KnowledgeSearchOut(
        query=query,
        mode="hybrid" if mode == "hybrid" else "tfidf",
        hits=[
            KnowledgeSearchHitOut(
                chunk_id=hit.chunk_id,
                document_id=hit.document_id,
                document_title=titles.get(hit.document_id, ""),
                ordinal=hit.ordinal,
                heading=hit.heading,
                page_from=hit.page_from,
                text=hit.text,
                score=hit.score,
            )
            for hit in hits
        ],
    )


async def add_attachment(thread_id: str, payload: AgentAttachmentCreate) -> AgentAttachmentOut:
    """Прикрепляет вложение к нити; дубль возвращается существующим."""
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        if await session.get(db.AgentThread, thread_id) is None:
            raise KnowledgeError("Нить не найдена", status=404)
        existing = (
            await session.execute(
                select(db.AgentThreadAttachment).where(
                    db.AgentThreadAttachment.thread_id == thread_id,
                    db.AgentThreadAttachment.kind == payload.kind,
                    db.AgentThreadAttachment.ref_id == payload.ref_id,
                ),
            )
        ).scalars().first()
        if existing is not None:
            return _attachment_out(existing)
        row = db.AgentThreadAttachment(
            id=str(uuid.uuid4()), thread_id=thread_id, kind=payload.kind,
            ref_id=payload.ref_id, label=payload.label, created_at=utcnow(),
        )
        session.add(row)
        await session.commit()
        return _attachment_out(row)


async def list_attachments(thread_id: str) -> list[AgentAttachmentOut]:
    """Вложения нити, новые сверху."""
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        rows = (
            await session.execute(
                select(db.AgentThreadAttachment)
                .where(db.AgentThreadAttachment.thread_id == thread_id)
                .order_by(db.AgentThreadAttachment.created_at.desc()),
            )
        ).scalars().all()
        return [_attachment_out(row) for row in rows]


async def delete_attachment(attachment_id: str) -> None:
    """Снимает вложение с нити."""
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        row = await session.get(db.AgentThreadAttachment, attachment_id)
        if row is None:
            raise KnowledgeError("Вложение не найдено", status=404)
        await session.execute(
            delete(db.AgentThreadAttachment).where(
                db.AgentThreadAttachment.id == attachment_id,
            ),
        )
        await session.commit()


_TAG_RE = re.compile(r"<[^>]+>")


async def _report_excerpt(recording_id: str, limit_chars: int) -> str:
    """Начало текста последнего HTML-отчёта записи (теги сняты, пробелы сжаты)."""
    async with db.AsyncSessionLocal() as session:
        relative = (
            await session.execute(
                select(db.ReportRun.html_path)
                .where(db.ReportRun.recording_id == recording_id)
                .order_by(db.ReportRun.created_at.desc())
                .limit(1),
            )
        ).scalar_one_or_none()
    if not relative:
        return ""
    data = cache_read(os.path.join(settings.cache_dir, relative))
    if data is None:
        return ""
    text = html.unescape(_TAG_RE.sub(" ", data.decode("utf-8", "replace")))
    return " ".join(text.split())[:limit_chars]


async def _analysis_excerpt(analysis_id: str, limit_chars: int) -> str:
    """Сводка прогона анализа: паспорт, полосы, предупреждения."""
    from app.services import results_store

    try:
        detail = await results_store.get_analysis_detail(int(analysis_id))
    except ValueError:
        return ""
    if not detail:
        return ""
    lines = [
        f"запись {detail.get('recording_id')}, файл {detail.get('filename')}",
        f"эпоха {detail.get('epoch_length_ms')} мс, сетка {detail.get('grid_mm')} мм, "
        f"эпох использовано {detail.get('n_epochs_used')} из {detail.get('n_epochs_total')}",
    ]
    for band in detail.get("bands") or []:
        lines.append(
            f"полоса {band.get('band_key')} ({band.get('band_hz_lo')}–"
            f"{band.get('band_hz_hi')} Гц): состояние {band.get('state')}, "
            f"точек {band.get('n_points')}, КД пройдено {band.get('n_kd_passed')}, "
            f"ошибок {band.get('n_errors')}",
        )
    warnings = detail.get("warnings") or []
    if warnings:
        lines.append("предупреждения: " + "; ".join(str(item) for item in warnings))
    return "\n".join(lines)[:limit_chars]


async def attachment_context(thread_id: str, *, limit_chars: int = 4000) -> str:
    """Текст вложений для промпта: фрагменты документов и сводки отчётов.

    Отчёт ЭЭГ в промпт целиком не влезает — берётся начало текста отчёта,
    усечённое до ``limit_chars``; анализ — сводка полос из ``results_store``;
    документ — первые фрагменты по порядку.
    """
    items = await list_attachments(thread_id)
    if not items:
        return ""
    blocks: list[str] = []
    async with db.AsyncSessionLocal() as session:
        for item in items:
            if item.kind == "document":
                chunks: Sequence[str] = (
                    await session.execute(
                        select(db.KnowledgeChunk.text)
                        .where(db.KnowledgeChunk.document_id == item.ref_id)
                        .order_by(db.KnowledgeChunk.ordinal)
                        .limit(4),
                    )
                ).scalars().all()
                body = "\n\n".join(chunks)[:limit_chars]
                if body:
                    blocks.append(f"[Документ «{item.label}»]\n{body}")
            elif item.kind == "web":
                blocks.append(f"[Веб-ссылка «{item.label}»] {item.ref_id}")
            elif item.kind == "report":
                body = await _report_excerpt(item.ref_id, limit_chars)
                head = f"[Отчёт ЭЭГ «{item.label}»] id={item.ref_id}"
                blocks.append(f"{head}\n{body}" if body else head)
            elif item.kind == "analysis":
                body = await _analysis_excerpt(item.ref_id, limit_chars)
                head = f"[Анализ ЭЭГ «{item.label}»] id={item.ref_id}"
                blocks.append(f"{head}\n{body}" if body else head)
            else:
                blocks.append(f"[Вложение «{item.label}»] {item.ref_id}")
    return "\n\n".join(blocks)
