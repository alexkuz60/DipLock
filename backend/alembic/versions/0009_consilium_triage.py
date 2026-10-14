"""Триаж готовности досье Консилиума (Jev, §5.2).

Revision ID: 0009
Revises: 0008
Create Date: 2026-10-13 10:00:00.000000

"""
import sqlalchemy as sa

from alembic import op

revision: str = "0009"
down_revision: str | None = "0008"
branch_labels: str | list[str] | None = None
depends_on: str | list[str] | None = None


def upgrade() -> None:
    """Создаёт строки триажа; определения заморожены после autogenerate."""
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table("consilium_triage"):
        op.create_table(
            "consilium_triage",
            sa.Column("id", sa.String(), nullable=False),
            sa.Column("case_id", sa.String(), nullable=False),
            sa.Column("snapshot_id", sa.String(), nullable=False),
            sa.Column("status", sa.String(), nullable=False),
            sa.Column("model", sa.String(), nullable=True),
            sa.Column("questions_version", sa.String(), nullable=False),
            sa.Column("sufficient", sa.Boolean(), nullable=True),
            sa.Column("sufficient_prob", sa.Float(), nullable=True),
            sa.Column("deficit", sa.String(), nullable=True),
            sa.Column("deficit_confidence", sa.Float(), nullable=True),
            sa.Column("completeness_score", sa.Float(), nullable=True),
            sa.Column("answers", sa.JSON(), nullable=False),
            sa.Column("warnings", sa.JSON(), nullable=False),
            sa.Column("error", sa.String(), nullable=True),
            sa.Column("latency_ms", sa.Float(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.ForeignKeyConstraint(["case_id"], ["consilium_cases.id"]),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index("ix_consilium_triage_case_id", "consilium_triage", ["case_id"])
        op.create_index("ix_consilium_triage_snapshot_id", "consilium_triage", ["snapshot_id"])


def downgrade() -> None:
    """Удаляет чувствительные результаты триажа (только dev/CI)."""
    inspector = sa.inspect(op.get_bind())
    if inspector.has_table("consilium_triage"):
        op.drop_table("consilium_triage")