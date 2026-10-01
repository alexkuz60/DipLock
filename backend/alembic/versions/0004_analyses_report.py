"""Кирпичный слой B6/B7/B13: ``analyses``/``dipole_points`` и ``report_*`` (4.4, шаг ③).

Схема утверждена делегированным решением 01.10.2026 (§8.3 ``docs/data-blocks.md``):
``analyses`` — прогон расчёта (= B7), ``dipole_points`` — точки пакета (= B6,
UNIQUE «эпоха × поддиапазон»), ``report_*`` — автоотчёт (= B13, история прогонов
не UPSERT — §8.4.2). Строки пишет write-API при успехе задачи ``kind=report``
(``services/results_store.py``); ``report_runs.analyses_id`` — вариант (а):
одна истина на прогон.

Определения заморожены (см. ревизию 0001); порядок создания — по FK.

Revision ID: 0004
Revises: 0003
Create Date: 2026-10-01

"""
from typing import Any

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0004"
down_revision: str | None = "0003"
branch_labels: str | list[str] | None = None
depends_on: str | list[str] | None = None


def _analyses_columns() -> list[sa.Column]:
    """Замороженные колонки ``analyses`` (§8.3)."""
    return [
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "recording_id", sa.String(),
            sa.ForeignKey("recordings.recording_id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column("kind", sa.String(), nullable=True),
        sa.Column("params_sig", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("job_id", sa.String(), nullable=True),
        sa.Column("reference", sa.String(), nullable=True),
        sa.Column("channels", sa.JSON(), nullable=True),
        sa.Column("sfreq", sa.Float(), nullable=True),
        sa.Column("epoch_length_ms", sa.Float(), nullable=True),
        sa.Column("grid_mm", sa.Float(), nullable=True),
        sa.Column("n_epochs_total", sa.Integer(), nullable=True),
        sa.Column("n_epochs_used", sa.Integer(), nullable=True),
        sa.Column("warnings", sa.JSON(), nullable=True),
        sa.Column("duration_sec_calc", sa.Float(), nullable=True),
    ]


def _analysis_bands_columns() -> list[sa.Column]:
    """Замороженные колонки ``analysis_bands`` (B7 ``per_band_status``)."""
    return [
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "analysis_id", sa.Integer(),
            sa.ForeignKey("analyses.id", ondelete="CASCADE"),
        ),
        sa.Column("band_key", sa.String(), nullable=True),
        sa.Column("band_hz_lo", sa.Float(), nullable=True),
        sa.Column("band_hz_hi", sa.Float(), nullable=True),
        sa.Column("state", sa.String(), nullable=True),
        sa.Column("n_points", sa.Integer(), nullable=True),
        sa.Column("n_kd_passed", sa.Integer(), nullable=True),
        sa.Column("n_errors", sa.Integer(), nullable=True),
        sa.Column("moment_max_nam", sa.Float(), nullable=True),
    ]


def _dipole_points_columns() -> list[Any]:
    """Замороженные колонки ``dipole_points`` (B6) + ключ «эпоха × поддиапазон»."""
    return [
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "analysis_id", sa.Integer(),
            sa.ForeignKey("analyses.id", ondelete="CASCADE"),
        ),
        sa.Column("band_key", sa.String(), nullable=True),
        sa.Column("band_hz_lo", sa.Float(), nullable=True),
        sa.Column("band_hz_hi", sa.Float(), nullable=True),
        sa.Column("epoch_index", sa.Integer(), nullable=True),
        sa.Column("peak_time_ms", sa.Float(), nullable=True),
        sa.Column("head_coords", sa.JSON(), nullable=True),
        sa.Column("mni_coords", sa.JSON(), nullable=True),
        sa.Column("moment_dir", sa.JSON(), nullable=True),
        sa.Column("amplitude_nam", sa.Float(), nullable=True),
        sa.Column("gof", sa.Float(), nullable=True),
        sa.Column("anatomical_structure", sa.String(), nullable=True),
        sa.Column("brodmann_area", sa.String(), nullable=True),
        sa.Column("method", sa.String(), nullable=True),
        sa.Column("kd_passed", sa.Integer(), nullable=True),
        sa.Column("kd_basis", sa.JSON(), nullable=True),
        sa.Column("refined", sa.JSON(), nullable=True),
        sa.UniqueConstraint(
            "analysis_id", "band_key", "epoch_index", name="ux_dipole_points_epoch",
        ),
    ]


def _report_runs_columns() -> list[sa.Column]:
    """Замороженные колонки ``report_runs`` (B13, решения §8.4)."""
    return [
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "recording_id", sa.String(),
            sa.ForeignKey("recordings.recording_id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column(
            "analyses_id", sa.Integer(),
            sa.ForeignKey("analyses.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("params_sig", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("job_id", sa.String(), nullable=True),
        sa.Column("n_epochs_total", sa.Integer(), nullable=True),
        sa.Column("n_epochs_used", sa.Integer(), nullable=True),
        sa.Column("n_epochs_rejected", sa.Integer(), nullable=True),
        sa.Column("qc_status", sa.String(), nullable=True),
        sa.Column("good_data_percent", sa.Float(), nullable=True),
        sa.Column("warnings", sa.JSON(), nullable=True),
        sa.Column("duration_sec_calc", sa.Float(), nullable=True),
        sa.Column("html_path", sa.String(), nullable=True),
        sa.Column("html_version", sa.String(), nullable=True),
    ]


def _report_band_summaries_columns() -> list[sa.Column]:
    """Замороженные колонки ``report_band_summaries`` (агрегат полосы B7)."""
    return [
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "report_run_id", sa.Integer(),
            sa.ForeignKey("report_runs.id", ondelete="CASCADE"),
        ),
        sa.Column("band_key", sa.String(), nullable=True),
        sa.Column("band_hz_lo", sa.Float(), nullable=True),
        sa.Column("band_hz_hi", sa.Float(), nullable=True),
        sa.Column("n_epochs_used", sa.Integer(), nullable=True),
        sa.Column("n_points", sa.Integer(), nullable=True),
        sa.Column("n_no_attribution", sa.Integer(), nullable=True),
        sa.Column("median_gof", sa.Float(), nullable=True),
        sa.Column("median_riv", sa.Float(), nullable=True),
    ]


def _report_name_counts_columns() -> list[sa.Column]:
    """Замороженные колонки ``report_name_counts`` (все имена, §8.4.4)."""
    return [
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "report_run_id", sa.Integer(),
            sa.ForeignKey("report_runs.id", ondelete="CASCADE"),
        ),
        sa.Column("band_key", sa.String(), nullable=True),
        sa.Column("kind", sa.String(), nullable=True),
        sa.Column("name", sa.String(), nullable=True),
        sa.Column("count", sa.Integer(), nullable=True),
        sa.Column("share", sa.Float(), nullable=True),
        sa.Column("median_gof", sa.Float(), nullable=True),
    ]


def _report_dynamics_columns() -> list[sa.Column]:
    """Замороженные колонки ``report_dynamics`` (5 бинов, гранулярность HTML)."""
    return [
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "report_run_id", sa.Integer(),
            sa.ForeignKey("report_runs.id", ondelete="CASCADE"),
        ),
        sa.Column("band_key", sa.String(), nullable=True),
        sa.Column("name", sa.String(), nullable=True),
        sa.Column("bin_index", sa.Integer(), nullable=True),
        sa.Column("share", sa.Float(), nullable=True),
    ]


# Таблицы в порядке FK + индексы (имена ровно как в моделях — страж паритета).
# Элементы — колонки и table-level ограничения (UniqueConstraint у B6).
_TABLES: tuple[tuple[str, list[Any]], ...] = (
    ("analyses", _analyses_columns()),
    ("analysis_bands", _analysis_bands_columns()),
    ("dipole_points", _dipole_points_columns()),
    ("report_runs", _report_runs_columns()),
    ("report_band_summaries", _report_band_summaries_columns()),
    ("report_name_counts", _report_name_counts_columns()),
    ("report_dynamics", _report_dynamics_columns()),
)

_INDEXES: tuple[tuple[str, str, tuple[str, ...]], ...] = (
    ("ix_analyses_recording_id", "analyses", ("recording_id",)),
    ("ix_analysis_bands_analysis_id", "analysis_bands", ("analysis_id",)),
    ("ix_dipole_points_analysis_id", "dipole_points", ("analysis_id",)),
    ("ix_dipole_points_band_kd", "dipole_points", ("band_key", "kd_passed")),
    ("ix_report_runs_recording_id", "report_runs", ("recording_id",)),
    (
        "ix_report_runs_recording_created",
        "report_runs",
        ("recording_id", "created_at"),
    ),
    (
        "ix_report_band_summaries_report_run_id",
        "report_band_summaries",
        ("report_run_id",),
    ),
    ("ix_report_name_counts_report_run_id", "report_name_counts", ("report_run_id",)),
    ("ix_report_dynamics_report_run_id", "report_dynamics", ("report_run_id",)),
)


def upgrade() -> None:
    """Создаёт таблицы кирпичного слоя и их индексы (идемпотентно)."""
    inspector = sa.inspect(op.get_bind())
    for table, columns in _TABLES:
        if not inspector.has_table(table):
            op.create_table(table, *columns)
    for name, table, column_names in _INDEXES:
        op.create_index(name, table, list(column_names), if_not_exists=True)


def downgrade() -> None:
    """Удаляет таблицы кирпичного слоя (**все данные**; только dev/CI)."""
    inspector = sa.inspect(op.get_bind())
    for name, table, _column_names in reversed(_INDEXES):
        if inspector.has_table(table):
            op.drop_index(name, table_name=table, if_exists=True)
    for table, _columns in reversed(_TABLES):
        if inspector.has_table(table):
            op.drop_table(table)
