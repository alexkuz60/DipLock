"""Веб-поиск Архивариуса: запросы, найденные материалы и машинный перевод.

Revision ID: 0020
Revises: 0019
Create Date: 2026-11-22

"""
import sqlalchemy as sa

from alembic import op

revision: str = "0020"
down_revision: str | None = "0019"
branch_labels: str | list[str] | None = None
depends_on: str | list[str] | None = None


def upgrade() -> None:
    """Создаёт ``agent_web_searches`` (идемпотентно)."""
    existing = set(sa.inspect(op.get_bind()).get_table_names())
    if "agent_web_searches" not in existing:
        op.create_table(
            "agent_web_searches",
            sa.Column("id", sa.String(), primary_key=True),
            sa.Column(
                "thread_id", sa.String(), sa.ForeignKey("agent_threads.id"), nullable=False,
            ),
            sa.Column("role_id", sa.String(), nullable=True),
            sa.Column("query", sa.String(), nullable=False),
            sa.Column("provider", sa.String(), nullable=False),
            sa.Column("results", sa.JSON(), nullable=False),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.Column("translated_at", sa.DateTime(), nullable=True),
        )
        op.create_index(
            "ix_agent_web_searches_thread_id", "agent_web_searches", ["thread_id"],
        )
        op.create_index(
            "ix_agent_web_searches_thread_created", "agent_web_searches",
            ["thread_id", "created_at", "id"],
        )


def downgrade() -> None:
    """Убирает таблицу веб-поиска (только dev/CI)."""
    existing = set(sa.inspect(op.get_bind()).get_table_names())
    if "agent_web_searches" in existing:
        op.drop_table("agent_web_searches")
