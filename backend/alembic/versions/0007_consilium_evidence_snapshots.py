"""Материалы и неизменяемые снимки досье Консилиума (B15).

Revision ID: 0007
Revises: 0006
Create Date: 2026-10-10 20:05:51.380484

"""
import sqlalchemy as sa

from alembic import op

revision: str = "0007"
down_revision: str | None = "0006"
branch_labels: str | list[str] | None = None
depends_on: str | list[str] | None = None


def upgrade() -> None:
    """Создаёт две независимые от TTL таблицы; определения заморожены после autogenerate."""
    inspector = sa.inspect(op.get_bind())
    for name in ("consilium_evidence", "consilium_snapshots"):
        if not inspector.has_table(name):
            op.create_table(
                name,
                sa.Column("id", sa.String(), nullable=False),
                sa.Column("case_id", sa.String(), nullable=False),
                sa.Column("payload", sa.JSON(), nullable=False),
                sa.Column("created_at", sa.DateTime(), nullable=False),
                sa.ForeignKeyConstraint(["case_id"], ["consilium_cases.id"]),
                sa.PrimaryKeyConstraint("id"),
            )
            op.create_index(f"ix_{name}_case_id", name, ["case_id"])


def downgrade() -> None:
    """Удаляет чувствительные копии досье (только dev/CI)."""
    inspector = sa.inspect(op.get_bind())
    for name in ("consilium_snapshots", "consilium_evidence"):
        if inspector.has_table(name):
            op.drop_table(name)
