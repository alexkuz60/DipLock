"""Кластеры диполей пакета = B8: ``dipole_clusters`` (Т3, персист 31.10.2026).

Схема — §8.3 ``docs/data-blocks.md`` (B8): одна строка на кластер прогона
``kind=dipole_batch``, геометрия + **профиль признаков** (``features`` JSON;
неизмерённое — ``None``, не 0). Паспорт кластеризации ``cluster_params``
дублируется на каждой строке анализа для автономной выгрузки.

Определения заморожены (см. ревизию 0001); порядок создания — по FK.

Revision ID: 0016
Revises: 0015
Create Date: 2026-10-31

"""
from typing import Any

import sqlalchemy as sa

from alembic import op

revision: str = "0016"
down_revision: str | None = "0015"
branch_labels: str | list[str] | None = None
depends_on: str | list[str] | None = None


def _dipole_clusters_columns() -> list[Any]:
    """Замороженные колонки ``dipole_clusters`` (B8) + UNIQUE «полоса × номер»."""
    return [
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "analysis_id", sa.Integer(),
            sa.ForeignKey("analyses.id", ondelete="CASCADE"),
        ),
        sa.Column("band_key", sa.String(), nullable=True),
        sa.Column("cluster_index", sa.Integer(), nullable=True),
        sa.Column("centroid_mni", sa.JSON(), nullable=True),
        sa.Column("n_points", sa.Integer(), nullable=True),
        sa.Column("share", sa.Float(), nullable=True),
        sa.Column("volume_cm3", sa.Float(), nullable=True),
        sa.Column("density_per_cm3", sa.Float(), nullable=True),
        sa.Column("extent_mm", sa.JSON(), nullable=True),
        sa.Column("top_structures", sa.JSON(), nullable=True),
        sa.Column("top_brodmann", sa.JSON(), nullable=True),
        sa.Column("features", sa.JSON(), nullable=True),
        sa.Column("cluster_params", sa.JSON(), nullable=True),
        sa.Column("n_bands_matched", sa.Integer(), nullable=True),
        sa.Column("band_share", sa.Float(), nullable=True),
        sa.Column("matched_band_keys", sa.JSON(), nullable=True),
        sa.UniqueConstraint(
            "analysis_id", "band_key", "cluster_index",
            name="ux_dipole_clusters_band_index",
        ),
    ]


def upgrade() -> None:
    """Создаёт ``dipole_clusters`` (идемпотентно)."""
    inspector = sa.inspect(op.get_bind())
    if inspector.has_table("dipole_clusters"):
        return
    op.create_table("dipole_clusters", *_dipole_clusters_columns())
    op.create_index(
        "ix_dipole_clusters_analysis_id", "dipole_clusters", ["analysis_id"],
    )


def downgrade() -> None:
    """Убирает ``dipole_clusters`` (только dev/CI)."""
    if sa.inspect(op.get_bind()).has_table("dipole_clusters"):
        op.drop_table("dipole_clusters")
