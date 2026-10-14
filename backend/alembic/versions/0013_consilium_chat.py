"""Боковая консультация Консилиума (срез 0015): нити чата и реплики.

Revision ID: 0013
Revises: 0012
Create Date: 2026-10-14 19:00:00.000000

"""
import sqlalchemy as sa

from alembic import op

revision: str = "0013"
down_revision: str | None = "0012"
branch_labels: str | list[str] | None = None
depends_on: str | list[str] | None = None


def upgrade() -> None:
    """Создаёт нити консультаций и append-only реплики; определения заморожены после autogenerate."""
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table("consilium_chats"):
        op.create_table(
            "consilium_chats",
            sa.Column("id", sa.String(), nullable=False),
            sa.Column("case_id", sa.String(), nullable=False),
            sa.Column("role", sa.String(), nullable=False),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.ForeignKeyConstraint(["case_id"], ["consilium_cases.id"]),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("case_id", "role", name="ux_consilium_chat_case_role"),
        )
        op.create_index("ix_consilium_chats_case_id", "consilium_chats", ["case_id"])
    if not inspector.has_table("consilium_chat_messages"):
        op.create_table(
            "consilium_chat_messages",
            sa.Column("id", sa.String(), nullable=False),
            sa.Column("case_id", sa.String(), nullable=False),
            sa.Column("chat_id", sa.String(), nullable=False),
            sa.Column("author_kind", sa.String(), nullable=False),
            sa.Column("role", sa.String(), nullable=False),
            sa.Column("status", sa.String(), nullable=False),
            sa.Column("text", sa.String(), nullable=True),
            sa.Column("model", sa.String(), nullable=True),
            sa.Column("instruction_version", sa.String(), nullable=True),
            sa.Column("snapshot_id", sa.String(), nullable=True),
            sa.Column("warnings", sa.JSON(), nullable=False),
            sa.Column("error", sa.String(), nullable=True),
            sa.Column("job_id", sa.String(), nullable=True),
            sa.Column("latency_ms", sa.Float(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.Column("finished_at", sa.DateTime(), nullable=True),
            sa.ForeignKeyConstraint(["case_id"], ["consilium_cases.id"]),
            sa.ForeignKeyConstraint(["chat_id"], ["consilium_chats.id"]),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index(
            "ix_consilium_chat_messages_case_id", "consilium_chat_messages", ["case_id"],
        )
        op.create_index(
            "ix_consilium_chat_messages_chat_id", "consilium_chat_messages", ["chat_id"],
        )


def downgrade() -> None:
    """Удаляет чувствительные переписки консультаций (только dev/CI)."""
    inspector = sa.inspect(op.get_bind())
    for name in ("consilium_chat_messages", "consilium_chats"):
        if inspector.has_table(name):
            op.drop_table(name)