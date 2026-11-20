"""Общий чат консилиума с ролевыми ИИ-агентами: роли, нити, реплики.

Revision ID: 0019
Revises: 0018
Create Date: 2026-11-20

"""
import sqlalchemy as sa

from alembic import op

revision: str = "0019"
down_revision: str | None = "0018"
branch_labels: str | list[str] | None = None
depends_on: str | list[str] | None = None


def upgrade() -> None:
    """Создаёт ``agent_roles``, ``agent_threads``, ``agent_messages`` (идемпотентно)."""
    existing = set(sa.inspect(op.get_bind()).get_table_names())
    if "agent_roles" not in existing:
        op.create_table(
            "agent_roles",
            sa.Column("id", sa.String(), primary_key=True),
            sa.Column("label", sa.String(), nullable=False),
            sa.Column("instruction", sa.String(), nullable=False),
            sa.Column("provider_id", sa.String(), nullable=True),
            sa.Column("model", sa.String(), nullable=True),
            sa.Column("enabled", sa.Boolean(), nullable=False),
            sa.Column("builtin", sa.Boolean(), nullable=False),
            sa.Column("sort", sa.Integer(), nullable=False),
            sa.Column("updated_at", sa.DateTime(), nullable=False),
        )
    if "agent_threads" not in existing:
        op.create_table(
            "agent_threads",
            sa.Column("id", sa.String(), primary_key=True),
            sa.Column("title", sa.String(), nullable=False),
            sa.Column("created_at", sa.DateTime(), nullable=False),
        )
    if "agent_messages" not in existing:
        op.create_table(
            "agent_messages",
            sa.Column("id", sa.String(), primary_key=True),
            sa.Column("thread_id", sa.String(), sa.ForeignKey("agent_threads.id"), nullable=False),
            sa.Column("author_kind", sa.String(), nullable=False),
            sa.Column("role_id", sa.String(), nullable=True),
            sa.Column("question_id", sa.String(), nullable=True),
            sa.Column("addressees", sa.JSON(), nullable=False),
            sa.Column("status", sa.String(), nullable=False),
            sa.Column("text", sa.String(), nullable=True),
            sa.Column("model", sa.String(), nullable=True),
            sa.Column("error", sa.String(), nullable=True),
            sa.Column("warnings", sa.JSON(), nullable=False),
            sa.Column("job_id", sa.String(), nullable=True),
            sa.Column("latency_ms", sa.Float(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.Column("finished_at", sa.DateTime(), nullable=True),
        )
        op.create_index("ix_agent_messages_thread_id", "agent_messages", ["thread_id"])
        op.create_index(
            "ix_agent_messages_thread_created", "agent_messages",
            ["thread_id", "created_at", "id"],
        )


def downgrade() -> None:
    """Убирает таблицы чата агентов (только dev/CI)."""
    existing = set(sa.inspect(op.get_bind()).get_table_names())
    for table in ("agent_messages", "agent_threads", "agent_roles"):
        if table in existing:
            op.drop_table(table)
