"""Обязательное транзакционное хранение исследований и ручной истории (Т1.2)."""

import hashlib
import json
import uuid
from datetime import datetime
from typing import Literal, cast

from sqlalchemy import delete, func, select, update
from sqlalchemy.engine import CursorResult, Result
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import db
from app.schemas.consilium import (
    ConsiliumCaseCreate,
    ConsiliumCaseOut,
    ConsiliumCasesPage,
    ConsiliumCaseUpdate,
    ConsiliumContextCreate,
    ConsiliumContextOut,
    ConsiliumContextPage,
    ConsiliumContextUpdate,
    ConsiliumContract,
    ConsiliumDeletionPreview,
    ConsiliumEvidenceCreate,
    ConsiliumMessageCreate,
    ConsiliumMessageOut,
    ConsiliumMessagesPage,
    ConsiliumMessageUpdate,
    ConsiliumSnapshotCreate,
)

type WriteRequest = (
    ConsiliumCaseCreate | ConsiliumCaseUpdate | ConsiliumContextCreate
    | ConsiliumContextUpdate | ConsiliumMessageCreate | ConsiliumMessageUpdate
    | ConsiliumEvidenceCreate | ConsiliumSnapshotCreate
)


class ConsiliumError(ValueError):
    """Ожидаемый отказ без чувствительного содержания в сообщении."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


def fingerprint(payload: ConsiliumContract) -> str:
    """Отпечаток запроса: стабильный JSON, не repr и не текущее окружение."""
    text = json.dumps(payload.model_dump(mode="json"), sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(text.encode()).hexdigest()


def case_out(row: db.ConsiliumCase) -> ConsiliumCaseOut:
    """Типизированный паспорт текущего состояния дела."""
    return ConsiliumCaseOut.model_validate({
        "id": row.id, "title": row.title, "question": row.question, "direction": row.direction,
        "status": row.status, "version": row.version, "subject_codes": row.subject_codes,
        "recording_ids": row.recording_ids, "created_at": row.created_at,
        "updated_at": row.updated_at,
    })


async def require_case(session: AsyncSession, case_id: str) -> db.ConsiliumCase:
    """Чужое/удалённое дело — 404, не пустая история."""
    row = await session.get(db.ConsiliumCase, case_id)
    if row is None:
        raise ConsiliumError(404, "Исследование не найдено")
    return row


async def _receipt(
    session: AsyncSession, scope: str, payload: WriteRequest,
) -> db.ConsiliumRequest | None:
    """Повтор проверяется раньше текущей версии; другой текст с тем же ключом — 409."""
    row = await session.scalar(select(db.ConsiliumRequest).where(
        db.ConsiliumRequest.scope == scope,
        db.ConsiliumRequest.request_id == payload.request_id,
    ))
    if row is not None and row.fingerprint != fingerprint(payload):
        raise ConsiliumError(409, "Ключ запроса уже использован для другого действия")
    return row


def _save_receipt(
    session: AsyncSession, case_id: str, scope: str,
    payload: WriteRequest, response: ConsiliumContract,
) -> None:
    """Квитанция и результат сохраняются одним коммитом."""
    session.add(db.ConsiliumRequest(
        id=str(uuid.uuid4()), case_id=case_id, scope=scope,
        request_id=payload.request_id, fingerprint=fingerprint(payload),
        response=response.model_dump(mode="json"),
    ))


async def _validate_links(session: AsyncSession, recording_ids: list[str]) -> None:
    """Новые связи требуют существующей строки записи, не обращаются к EDF/MNE."""
    if not recording_ids:
        return
    found: set[str] = set((await session.scalars(select(db.RecordingRecord.recording_id).where(
        db.RecordingRecord.recording_id.in_(recording_ids),
    ))).all())
    if set(recording_ids) != found:
        raise ConsiliumError(404, "Одна из выбранных записей не найдена")


async def _bump(
    session: AsyncSession, row: db.ConsiliumCase, expected: int, *, require_open: bool = True,
) -> None:
    """Compare-and-swap версии предотвращает молчаливое затирание изменений."""
    if require_open and row.status != "open":
        raise ConsiliumError(409, "Исследование архивировано — сначала откройте его")
    result = await session.execute(update(db.ConsiliumCase).where(
        db.ConsiliumCase.id == row.id, db.ConsiliumCase.version == expected,
    ).values(version=expected + 1, updated_at=datetime.utcnow()))
    if cast(CursorResult, result).rowcount != 1:
        raise ConsiliumError(409, "Исследование изменилось — обновите данные")


async def create_case(payload: ConsiliumCaseCreate) -> ConsiliumCaseOut:
    """Создаёт дело и квитанцию; ошибка commit не превращается в успех."""
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        repeat = await _receipt(session, "create", payload)
        if repeat is not None:
            return ConsiliumCaseOut.model_validate(repeat.response)
        await _validate_links(session, payload.recording_ids)
        now = datetime.utcnow()
        row = db.ConsiliumCase(
            id=str(uuid.uuid4()), **payload.model_dump(exclude={"request_id"}),
            status="open", version=1, created_at=now, updated_at=now,
        )
        session.add(row)
        await session.flush()
        response = case_out(row)
        _save_receipt(session, str(row.id), "create", payload, response)
        await session.commit()
        return response


async def get_case(case_id: str) -> ConsiliumCaseOut:
    """Читает паспорт без необходимости исходного EDF."""
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        return case_out(await require_case(session, case_id))


async def list_cases(limit: int, offset: int) -> ConsiliumCasesPage:
    """Страница дел с честным total, включая архив."""
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        total = int(await session.scalar(select(func.count()).select_from(db.ConsiliumCase)) or 0)
        rows = (await session.scalars(select(db.ConsiliumCase).order_by(
            db.ConsiliumCase.updated_at.desc(), db.ConsiliumCase.id,
        ).limit(limit).offset(offset))).all()
        return ConsiliumCasesPage(total=total, items=[case_out(row) for row in rows])


async def update_case(case_id: str, payload: ConsiliumCaseUpdate) -> ConsiliumCaseOut:
    """Сохраняет паспорт с optimistic version; архив можно явно открыть."""
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        row = await require_case(session, case_id)
        scope = f"case:{case_id}"
        repeat = await _receipt(session, scope, payload)
        if repeat is not None:
            return ConsiliumCaseOut.model_validate(repeat.response)
        # Исчезнувшие старые ссылки допустимы; проверяем только новые.
        await _validate_links(session, list(set(payload.recording_ids) - set(row.recording_ids)))
        await _bump(session, row, payload.expected_version, require_open=False)
        for key, value in payload.model_dump(exclude={"request_id", "expected_version"}).items():
            setattr(row, key, value)
        await session.flush()
        response = case_out(row)
        _save_receipt(session, case_id, scope, payload, response)
        await session.commit()
        return response


def _entry_out(row: db.ConsiliumEntry) -> ConsiliumContextOut | ConsiliumMessageOut:
    """Из JSON полезной нагрузки восстанавливает строгую ревизию."""
    model = ConsiliumContextOut if row.kind == "context" else ConsiliumMessageOut
    return model.model_validate({
        "id": row.entry_id, "case_id": row.case_id, "revision": row.revision,
        "created_at": row.created_at, **row.payload,
    })


async def write_entry(
    case_id: str,
    kind: Literal["context", "message"],
    payload: ConsiliumContextCreate | ConsiliumContextUpdate
    | ConsiliumMessageCreate | ConsiliumMessageUpdate,
    entry_id: str | None = None,
) -> ConsiliumContextOut | ConsiliumMessageOut:
    """Добавляет или исправляет ручную запись; ревизии никогда не перезаписываются."""
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        case = await require_case(session, case_id)
        scope = f"{case_id}:{kind}:{entry_id or 'create'}"
        repeat = await _receipt(session, scope, payload)
        if repeat is not None:
            model = ConsiliumContextOut if kind == "context" else ConsiliumMessageOut
            return model.model_validate(repeat.response)
        revision = 1
        if entry_id is not None:
            previous = await session.scalar(select(db.ConsiliumEntry).where(
                db.ConsiliumEntry.case_id == case_id, db.ConsiliumEntry.kind == kind,
                db.ConsiliumEntry.entry_id == entry_id,
            ).order_by(db.ConsiliumEntry.revision.desc()).limit(1))
            if previous is None:
                raise ConsiliumError(404, "Запись истории не найдена в этом исследовании")
            if previous.revision != getattr(payload, "expected_revision", None):
                raise ConsiliumError(409, "Реплика изменилась — обновите данные")
            revision = int(previous.revision) + 1
        if isinstance(payload, ConsiliumContextCreate):
            if payload.recording_id is not None and payload.recording_id not in case.recording_ids:
                raise ConsiliumError(400, "Контекст ссылается на запись вне исследования")
            if payload.subject_code is not None and payload.subject_code not in case.subject_codes:
                raise ConsiliumError(400, "Код добровольца не входит в исследование")
        await _bump(session, case, payload.expected_version)
        row = db.ConsiliumEntry(
            id=str(uuid.uuid4()), case_id=case_id, kind=kind,
            entry_id=entry_id or str(uuid.uuid4()), revision=revision,
            payload=payload.model_dump(mode="json", exclude={
                "request_id", "expected_version", "expected_revision",
            }), created_at=datetime.utcnow(),
        )
        session.add(row)
        response = _entry_out(row)
        _save_receipt(session, case_id, scope, payload, response)
        await session.commit()
        return response


async def list_entries(
    case_id: str, kind: Literal["context", "message"], limit: int, offset: int,
) -> ConsiliumContextPage | ConsiliumMessagesPage:
    """Возвращает историю со всеми ревизиями, 404 на неизвестное дело."""
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        await require_case(session, case_id)
        conditions = [db.ConsiliumEntry.case_id == case_id, db.ConsiliumEntry.kind == kind]
        total = int(await session.scalar(select(func.count()).select_from(
            db.ConsiliumEntry,
        ).where(*conditions)) or 0)
        rows = (await session.scalars(select(db.ConsiliumEntry).where(*conditions).order_by(
            db.ConsiliumEntry.created_at, db.ConsiliumEntry.id,
        ).limit(limit).offset(offset))).all()
        if kind == "context":
            return ConsiliumContextPage(total=total, items=[
                ConsiliumContextOut.model_validate(_entry_out(row)) for row in rows
            ])
        return ConsiliumMessagesPage(total=total, items=[
            ConsiliumMessageOut.model_validate(_entry_out(row)) for row in rows
        ])


async def deletion_preview(case_id: str) -> ConsiliumDeletionPreview:
    """Показывает объём удаления, не удаляет источники ЭЭГ."""
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        row = await require_case(session, case_id)
        counts: Result[tuple[str, int]] = await session.execute(select(
            db.ConsiliumEntry.kind, func.count().label("count"),
        ).where(
            db.ConsiliumEntry.case_id == case_id,
        ).group_by(db.ConsiliumEntry.kind))
        by_kind = {str(row["kind"]): int(row["count"]) for row in counts.mappings()}
        return ConsiliumDeletionPreview.model_validate({
            "case_id": case_id, "version": row.version,
            "context_revisions": by_kind.get("context", 0),
            "message_revisions": by_kind.get("message", 0),
            "evidence_items": int(await session.scalar(select(func.count()).select_from(
                db.ConsiliumEvidenceRecord,
            ).where(db.ConsiliumEvidenceRecord.case_id == case_id)) or 0),
            "snapshots": int(await session.scalar(select(func.count()).select_from(
                db.ConsiliumSnapshotRecord,
            ).where(db.ConsiliumSnapshotRecord.case_id == case_id)) or 0),
            "recording_ids": row.recording_ids,
            "warnings": ["ЭЭГ-записи не удаляются. Все ревизии ручной истории будут удалены."],
        })


async def delete_case(case_id: str, expected_version: int) -> None:
    """Удаляет чувствительное дело целиком явными DELETE даже при выключенных FK."""
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        row = await require_case(session, case_id)
        await _bump(session, row, expected_version, require_open=False)
        for model in (
            db.ConsiliumRequest, db.ConsiliumEntry,
            db.ConsiliumSnapshotRecord, db.ConsiliumEvidenceRecord,
        ):
            await session.execute(delete(model).where(model.case_id == case_id))
        await session.execute(delete(db.ConsiliumCase).where(db.ConsiliumCase.id == case_id))
        await session.commit()