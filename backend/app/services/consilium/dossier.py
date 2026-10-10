"""Обязательное сохранение материалов и публикация неизменяемого досье."""

import asyncio
import hashlib
import uuid
from datetime import datetime

from sqlalchemy import delete, func, select
from sqlalchemy.sql.elements import ColumnElement

from app.core.config import settings
from app.models import db
from app.schemas.consilium import (
    ConsiliumContextOut,
    ConsiliumEvidence,
    ConsiliumEvidenceCreate,
    ConsiliumEvidenceDeletion,
    ConsiliumEvidencePage,
    ConsiliumSnapshot,
    ConsiliumSnapshotCreate,
    ConsiliumSnapshotsPage,
)
from app.services.consilium import sources, store


async def add_evidence(case_id: str, payload: ConsiliumEvidenceCreate) -> ConsiliumEvidence:
    """Принимает копию результата, а не клиентские числа; повтор не читает источник заново."""
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        case = await store.require_case(session, case_id)
        scope = f"{case_id}:evidence"
        repeat = await store._receipt(session, scope, payload)
        if repeat is not None:
            return ConsiliumEvidence.model_validate(repeat.response)
        if case.version != payload.expected_version or case.status != "open":
            raise store.ConsiliumError(409, "Исследование изменилось или архивировано — обновите данные")
        try:
            material = await sources.capture(payload.source_kind, payload.source_id, list(case.recording_ids))
        except store.ConsiliumError:
            raise
        except (ValueError, TypeError):
            raise store.ConsiliumError(413, "Источник нельзя зафиксировать целиком — проверьте размер и формат") from None
        await store._bump(session, case, payload.expected_version)
        material = material.model_copy(update={"id": str(uuid.uuid4()), "case_id": case_id})
        content = material.model_dump(mode="json")
        if len(await asyncio.to_thread(sources.canonical_bytes, content)) > settings.consilium_material_max_bytes:
            raise store.ConsiliumError(413, "Материал превышает лимит; сохранение отменено без обрезки")
        session.add(db.ConsiliumEvidenceRecord(
            id=material.id, case_id=case_id, payload=content, created_at=material.captured_at,
        ))
        store._save_receipt(session, case_id, scope, payload, material)
        await session.commit()
        return material


async def list_evidence(case_id: str, limit: int, offset: int) -> ConsiliumEvidencePage:
    """Читает принятые копии независимо от наличия исходной задачи."""
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        await store.require_case(session, case_id)
        condition: ColumnElement[bool] = db.ConsiliumEvidenceRecord.case_id == case_id
        total = int(await session.scalar(select(func.count()).select_from(
            db.ConsiliumEvidenceRecord,
        ).where(condition)) or 0)
        rows = (await session.scalars(select(db.ConsiliumEvidenceRecord).where(condition).order_by(
            db.ConsiliumEvidenceRecord.created_at, db.ConsiliumEvidenceRecord.id,
        ).limit(limit).offset(offset))).all()
        return ConsiliumEvidencePage(total=total, items=[
            ConsiliumEvidence.model_validate(row.payload) for row in rows
        ])


async def create_snapshot(case_id: str, payload: ConsiliumSnapshotCreate) -> ConsiliumSnapshot:
    """Публикует выбранные версии в одной транзакции с проверкой версии дела."""
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        case = await store.require_case(session, case_id)
        scope = f"{case_id}:snapshot"
        repeat = await store._receipt(session, scope, payload)
        if repeat is not None:
            return ConsiliumSnapshot.model_validate(repeat.response)
        await store._bump(session, case, payload.expected_version)
        rows = (await session.scalars(select(db.ConsiliumEvidenceRecord).where(
            db.ConsiliumEvidenceRecord.case_id == case_id,
            db.ConsiliumEvidenceRecord.id.in_(payload.evidence_ids),
        ))).all()
        materials = {str(row.id): ConsiliumEvidence.model_validate(row.payload) for row in rows}
        if set(materials) != set(payload.evidence_ids):
            raise store.ConsiliumError(404, "Один из материалов не найден в этом исследовании")
        for material in materials.values():
            sources.check_members(material.recording_ids, list(case.recording_ids))
        contexts = (await session.scalars(select(db.ConsiliumEntry).where(
            db.ConsiliumEntry.case_id == case_id, db.ConsiliumEntry.kind == "context",
            db.ConsiliumEntry.entry_id.in_(payload.context_ids),
        ).order_by(db.ConsiliumEntry.revision))).all()
        latest = {str(row.entry_id): ConsiliumContextOut.model_validate(store._entry_out(row))
                  for row in contexts}
        if set(latest) != set(payload.context_ids):
            raise store.ConsiliumError(404, "Одна из контекстных записей не найдена в этом исследовании")
        warnings = list(dict.fromkeys(
            warning for material in materials.values() for warning in material.warnings
        ))
        if any(material.signal_state is None for material in materials.values()):
            warnings.append("Совместимость подготовки источников не установлена; снимок не делает их сопоставимыми")
        if any(not item.verified for item in latest.values()):
            warnings.append("Выбранный ручной контекст содержит непроверенные записи")
        snapshot = ConsiliumSnapshot(
            id=str(uuid.uuid4()), case_id=case_id, case_version=payload.expected_version,
            created_at=datetime.utcnow(), question=str(case.question), title=str(case.title),
            subject_codes=list(case.subject_codes), recording_ids=list(case.recording_ids),
            evidence=[materials[key] for key in payload.evidence_ids],
            context=[latest[key] for key in payload.context_ids], warnings=warnings, sha256="0" * 64,
        )
        content = snapshot.model_dump(mode="json", exclude={"sha256"})
        packed = await asyncio.to_thread(sources.canonical_bytes, content)
        if len(packed) > settings.consilium_snapshot_max_bytes:
            raise store.ConsiliumError(413, "Досье превышает лимит; выберите меньше материалов")
        snapshot = snapshot.model_copy(update={"sha256": hashlib.sha256(packed).hexdigest()})
        session.add(db.ConsiliumSnapshotRecord(
            id=snapshot.id, case_id=case_id, payload=snapshot.model_dump(mode="json"),
            created_at=snapshot.created_at,
        ))
        store._save_receipt(session, case_id, scope, payload, snapshot)
        await session.commit()
        return snapshot


async def get_snapshot(case_id: str, snapshot_id: str) -> ConsiliumSnapshot:
    """Снимок читается без обращения к текущим источникам/контексту."""
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        await store.require_case(session, case_id)
        row = await session.get(db.ConsiliumSnapshotRecord, snapshot_id)
        if row is None or row.case_id != case_id:
            raise store.ConsiliumError(404, "Снимок не найден в этом исследовании")
        return ConsiliumSnapshot.model_validate(row.payload)


async def list_snapshots(case_id: str, limit: int, offset: int) -> ConsiliumSnapshotsPage:
    """Страница опубликованных снимков со стабильной сортировкой."""
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        await store.require_case(session, case_id)
        condition: ColumnElement[bool] = db.ConsiliumSnapshotRecord.case_id == case_id
        total = int(await session.scalar(select(func.count()).select_from(
            db.ConsiliumSnapshotRecord,
        ).where(condition)) or 0)
        rows = (await session.scalars(select(db.ConsiliumSnapshotRecord).where(condition).order_by(
            db.ConsiliumSnapshotRecord.created_at.desc(), db.ConsiliumSnapshotRecord.id,
        ).limit(limit).offset(offset))).all()
        return ConsiliumSnapshotsPage(total=total, items=[
            ConsiliumSnapshot.model_validate(row.payload) for row in rows
        ])


async def evidence_deletion_preview(case_id: str, evidence_id: str) -> ConsiliumEvidenceDeletion:
    """Предпросмотр зависимых копий; не удаляет исходный расчёт."""
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        case = await store.require_case(session, case_id)
        item = await session.get(db.ConsiliumEvidenceRecord, evidence_id)
        if item is None or item.case_id != case_id:
            raise store.ConsiliumError(404, "Материал не найден в этом исследовании")
        rows = (await session.scalars(select(db.ConsiliumSnapshotRecord).where(
            db.ConsiliumSnapshotRecord.case_id == case_id,
        ))).all()
        dependent = [str(row.id) for row in rows if any(
            evidence.id == evidence_id
            for evidence in ConsiliumSnapshot.model_validate(row.payload).evidence
        )]
        return ConsiliumEvidenceDeletion(
            case_id=case_id, evidence_id=evidence_id, version=int(case.version),
            snapshot_ids=dependent,
            warnings=["Удаляется материал, содержащие его снимки и квитанции дела. Исходные расчёты сохраняются."],
        )


async def delete_evidence(case_id: str, evidence_id: str, expected_version: int) -> None:
    """Удаляет все зависимые копии и квитанции, чтобы повтор не восстановил данные."""
    preview = await evidence_deletion_preview(case_id, evidence_id)
    async with db.AsyncSessionLocal() as session:
        case = await store.require_case(session, case_id)
        if preview.version != expected_version:
            raise store.ConsiliumError(409, "Состав исследования изменился — повторите предпросмотр")
        await store._bump(session, case, expected_version, require_open=False)
        await session.execute(delete(db.ConsiliumSnapshotRecord).where(
            db.ConsiliumSnapshotRecord.case_id == case_id,
            db.ConsiliumSnapshotRecord.id.in_(preview.snapshot_ids),
        ))
        await session.execute(delete(db.ConsiliumRequest).where(db.ConsiliumRequest.case_id == case_id))
        await session.execute(delete(db.ConsiliumEvidenceRecord).where(
            db.ConsiliumEvidenceRecord.id == evidence_id, db.ConsiliumEvidenceRecord.case_id == case_id,
        ))
        await session.commit()
