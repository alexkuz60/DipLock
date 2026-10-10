"""Основание Консилиума: дело, ручные ревизии, квитанции запросов.

Revision ID: 0006
Revises: 0005
Create Date: 2026-10-10 19:48:42.225464

"""
import sqlalchemy as sa

from alembic import op

revision: str = "0006"
down_revision: str | None = "0005"
branch_labels: str | list[str] | None = None
depends_on: str | list[str] | None = None


def upgrade() -> None:
    """Создаёт хранилище, замороженное после автогенерации на изолированной БД."""
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table("consilium_cases"):
        op.create_table(
            "consilium_cases",
            sa.Column("id", sa.String(), nullable=False),
            sa.Column("title", sa.String(), nullable=False),
            sa.Column("question", sa.String(), nullable=False),
            sa.Column("direction", sa.String(), nullable=False),
            sa.Column("status", sa.String(), nullable=False),
            sa.Column("version", sa.Integer(), nullable=False),
            sa.Column("subject_codes", sa.JSON(), nullable=False),
            sa.Column("recording_ids", sa.JSON(), nullable=False),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.Column("updated_at", sa.DateTime(), nullable=False),
            sa.PrimaryKeyConstraint("id"),
        )
    if not inspector.has_table("consilium_entries"):
        op.create_table(
            "consilium_entries",
            sa.Column("id", sa.String(), nullable=False),
            sa.Column("case_id", sa.String(), nullable=False),
            sa.Column("kind", sa.String(), nullable=False),
            sa.Column("entry_id", sa.String(), nullable=False),
            sa.Column("revision", sa.Integer(), nullable=False),
            sa.Column("payload", sa.JSON(), nullable=False),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.ForeignKeyConstraint(["case_id"], ["consilium_cases.id"]),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint(
                "case_id", "kind", "entry_id", "revision", name="ux_consilium_revision",
            ),
        )
        op.create_index("ix_consilium_entries_case_id", "consilium_entries", ["case_id"])
    if not inspector.has_table("consilium_requests"):
        op.create_table(
            "consilium_requests",
            sa.Column("id", sa.String(), nullable=False),
            sa.Column("case_id", sa.String(), nullable=False),
            sa.Column("scope", sa.String(), nullable=False),
            sa.Column("request_id", sa.String(), nullable=False),
            sa.Column("fingerprint", sa.String(), nullable=False),
            sa.Column("response", sa.JSON(), nullable=False),
            sa.ForeignKeyConstraint(["case_id"], ["consilium_cases.id"]),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("scope", "request_id", name="ux_consilium_request"),
        )
        op.create_index("ix_consilium_requests_case_id", "consilium_requests", ["case_id"])


def downgrade() -> None:
    """Удаляет чувствительную историю (только dev/CI)."""
    inspector = sa.inspect(op.get_bind())
    for name in ("consilium_requests", "consilium_entries", "consilium_cases"):
        if inspector.has_table(name):
            op.drop_table(name)
