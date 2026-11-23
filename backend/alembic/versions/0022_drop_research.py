"""Удаление режима «Исследование»: таблицы досье, раундов, триажа и штурмов.

Revision ID: 0022
Revises: 0021
Create Date: 2026-11-23

Режим отменён владельцем 23.11.2026: остаются «Чат экспертов» и «Знания».
Данные не переносятся — таблицы удаляются вместе со строками.
"""
import sqlalchemy as sa

from alembic import op

revision: str = "0022"
down_revision: str | None = "0021"
branch_labels: str | list[str] | None = None
depends_on: str | list[str] | None = None

_TABLES = (
    "consilium_entries",
    "consilium_requests",
    "consilium_evidence",
    "consilium_snapshots",
    "consilium_answers",
    "consilium_rounds",
    "consilium_triage",
    "consilium_jev_marks",
    "consilium_brainstorm_ideas",
    "consilium_brainstorms",
    "consilium_decisions",
    "consilium_executions",
    "consilium_proposals",
    "consilium_chat_messages",
    "consilium_chats",
    "consilium_cases",
)


def upgrade() -> None:
    """Удаляет таблицы исследования (идемпотентно: отсутствующие пропускаются)."""
    existing = set(sa.inspect(op.get_bind()).get_table_names())
    for table in _TABLES:
        if table in existing:
            op.drop_table(table)


def downgrade() -> None:
    """Возврат невозможен: схема исследования удалена вместе с данными.

    Пустой downgrade честнее выдуманного восстановления — откат к 0021 требует
    копии БД, снятой до миграции.
    """
