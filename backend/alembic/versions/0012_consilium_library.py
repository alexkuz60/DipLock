"""Библиотека исследования Консилиума (Т5, срез 0013): предложения и решения.

Revision ID: 0012
Revises: 0011
Create Date: 2026-10-14 14:00:00.000000

"""
import sqlalchemy as sa

from alembic import op

revision: str = "0012"
down_revision: str | None = "0011"
branch_labels: str | list[str] | None = None
depends_on: str | list[str] | None = None


def upgrade() -> None:
    """Создаёт предложения, решения и исполнения; определения заморожены после autogenerate."""
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table("consilium_proposals"):
        op.create_table(
            "consilium_proposals",
            sa.Column("id", sa.String(), nullable=False),
            sa.Column("case_id", sa.String(), nullable=False),
            sa.Column("source", sa.String(), nullable=False),
            sa.Column("source_id", sa.String(), nullable=True),
            sa.Column("version", sa.Integer(), nullable=False),
            sa.Column("kind", sa.String(), nullable=False),
            sa.Column("title", sa.String(), nullable=False),
            sa.Column("hypothesis", sa.String(), nullable=True),
            sa.Column("rationale", sa.String(), nullable=True),
            sa.Column("risks", sa.String(), nullable=True),
            sa.Column("check_method", sa.String(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.Column("updated_at", sa.DateTime(), nullable=False),
            sa.ForeignKeyConstraint(["case_id"], ["consilium_cases.id"]),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index("ix_consilium_proposals_case_id", "consilium_proposals", ["case_id"])
        op.create_index("ix_consilium_proposals_source_id", "consilium_proposals", ["source_id"])
    if not inspector.has_table("consilium_decisions"):
        op.create_table(
            "consilium_decisions",
            sa.Column("id", sa.String(), nullable=False),
            sa.Column("case_id", sa.String(), nullable=False),
            sa.Column("proposal_id", sa.String(), nullable=False),
            sa.Column("decision", sa.String(), nullable=False),
            sa.Column("proposal_version", sa.Integer(), nullable=False),
            sa.Column("comment", sa.String(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.ForeignKeyConstraint(["case_id"], ["consilium_cases.id"]),
            sa.ForeignKeyConstraint(["proposal_id"], ["consilium_proposals.id"]),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index("ix_consilium_decisions_case_id", "consilium_decisions", ["case_id"])
        op.create_index("ix_consilium_decisions_proposal_id", "consilium_decisions", ["proposal_id"])
    if not inspector.has_table("consilium_executions"):
        op.create_table(
            "consilium_executions",
            sa.Column("id", sa.String(), nullable=False),
            sa.Column("case_id", sa.String(), nullable=False),
            sa.Column("proposal_id", sa.String(), nullable=False),
            sa.Column("note", sa.String(), nullable=False),
            sa.Column("result", sa.String(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.ForeignKeyConstraint(["case_id"], ["consilium_cases.id"]),
            sa.ForeignKeyConstraint(["proposal_id"], ["consilium_proposals.id"]),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index("ix_consilium_executions_case_id", "consilium_executions", ["case_id"])
        op.create_index(
            "ix_consilium_executions_proposal_id", "consilium_executions", ["proposal_id"],
        )


def downgrade() -> None:
    """Удаляет чувствительную библиотеку (только dev/CI)."""
    inspector = sa.inspect(op.get_bind())
    for name in ("consilium_executions", "consilium_decisions", "consilium_proposals"):
        if inspector.has_table(name):
            op.drop_table(name)