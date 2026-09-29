"""Базовая схема: sessions, epochs, dipoles (4.2, N37).

Первая ревизия alembic в проекте. Намеренно **терпима к существующим файлам
БД**: схема до alembic создавалась ``Base.metadata.create_all`` при каждом
сохранении, а колонки старых файлов догонялись вручную (``_add_missing_columns``,
4.1). Поэтому здесь для каждой таблицы:

* таблицы нет → создаётся с актуальными колонками (свежий файл);
* таблица есть → догоняются недостающие колонки (файл «до 4.1»: 4 полосы
  вместо 7) и недостающие индексы; лишнее не трогается.

Файл, созданный до alembic, получает версию ``0001`` автоматически — отдельный
``alembic stamp`` не нужен. Определения **заморожены**: модели
``app/models/db.py`` — источник истины для нового кода, а изменение схемы идёт
новой ревизией (``venv/bin/alembic revision --autogenerate``); расхождение
ловит страж ``tests/test_migrations.py::test_migration_schema_matches_models``.

Индексы — N37 (запросы Фазы 5 по ``brodmann_area``/``gof`` и FK-связям);
``trajectory_json`` — ``jsonb`` + GIN в PostgreSQL (на SQLite остаётся JSON).
Дополнительно к схеме alembic ведёт таблицу ``alembic_version``.

Revision ID: 0001
Revises:
Create Date: 2026-09-29

"""
from typing import Any

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0001"
down_revision: str | None = None
branch_labels: str | list[str] | None = None
depends_on: str | list[str] | None = None

# Порядок создания: sessions → epochs → dipoles (внешние ключи).
_TABLES: tuple[str, ...] = ("sessions", "epochs", "dipoles")

# Индексы (N37): имя, таблица, колонки, дополнительные опции диалекта.
_INDEXES: tuple[tuple[str, str, tuple[str, ...], dict[str, Any]], ...] = (
    ("ix_sessions_id", "sessions", ("id",), {}),
    ("ix_epochs_session_id", "epochs", ("session_id",), {}),
    ("ix_dipoles_session_id", "dipoles", ("session_id",), {}),
    ("ix_dipoles_epoch_id", "dipoles", ("epoch_id",), {}),
    ("ix_dipoles_brodmann_area", "dipoles", ("brodmann_area",), {}),
    ("ix_dipoles_gof", "dipoles", ("gof",), {}),
    # JSON-колонка: GIN в PostgreSQL, обычный индекс на SQLite (N37).
    ("ix_dipoles_trajectory_json", "dipoles", ("trajectory_json",), {"postgresql_using": "gin"}),
)


def _columns(table: str, *, with_constraints: bool = True) -> list[sa.Column]:
    """Замороженные определения колонок таблицы (снимок схемы на 29.09.2026).

    ``with_constraints=False`` — вариант для ``add_column`` старого файла:
    существующие FK уже на месте, а ALTER с REFERENCES на SQLite непредсказуем.
    """
    columns: list[sa.Column[Any]]
    if table == "sessions":
        columns = [
            sa.Column("id", sa.String(), primary_key=True),
            sa.Column("filename", sa.String()),
            sa.Column("n_channels", sa.Integer()),
            sa.Column("sfreq", sa.Float()),
            sa.Column("duration_sec", sa.Float()),
            sa.Column("epoch_length_ms", sa.Float()),
            sa.Column("freq_band", sa.String()),
            sa.Column("created_at", sa.DateTime()),
        ]
    elif table == "epochs":
        columns = [
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("session_id", sa.String(), sa.ForeignKey("sessions.id")),
            sa.Column("epoch_index", sa.Integer()),
            sa.Column("start_time_sec", sa.Float()),
            sa.Column("duration_ms", sa.Float()),
            sa.Column("has_artifact", sa.Integer()),
            # Колонки мощостей = 7 полос freq_bands (4.1, N38): старые файлы
            # имели только 4 из них — их и догоняет ветка add_column.
            sa.Column("delta_power", sa.Float()),
            sa.Column("delta_theta_power", sa.Float()),
            sa.Column("theta_power", sa.Float()),
            sa.Column("alpha_power", sa.Float()),
            sa.Column("beta_power", sa.Float()),
            sa.Column("gamma_power", sa.Float()),
            sa.Column("high_gamma_power", sa.Float()),
        ]
    else:  # dipoles
        columns = [
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("session_id", sa.String(), sa.ForeignKey("sessions.id")),
            sa.Column("epoch_id", sa.Integer(), sa.ForeignKey("epochs.id")),
            sa.Column("time_ms", sa.Float()),
            sa.Column("mni_x", sa.Float()),
            sa.Column("mni_y", sa.Float()),
            sa.Column("mni_z", sa.Float()),
            sa.Column("amplitude_nam", sa.Float()),
            sa.Column("gof", sa.Float()),
            sa.Column("anatomical_roi", sa.String()),
            sa.Column("brodmann_area", sa.String()),
            sa.Column("freq_band", sa.String()),
            sa.Column("trajectory_json", sa.JSON().with_variant(postgresql.JSONB(), "postgresql")),
        ]

    if not with_constraints:
        # Только имена и типы: FK старого файла уже на месте.
        return [sa.Column(c.name, c.type, primary_key=c.primary_key) for c in columns]
    return columns


def upgrade() -> None:
    """Создаёт отсутствующие таблицы и догоняет колонки/индексы старых файлов."""
    inspector = sa.inspect(op.get_bind())
    for table in _TABLES:
        if inspector.has_table(table):
            existing = {column["name"] for column in inspector.get_columns(table)}
            for column in _columns(table, with_constraints=False):
                if column.name not in existing:
                    op.add_column(table, column)
        else:
            op.create_table(table, *_columns(table))

    for name, table, columns, dialect_options in _INDEXES:
        op.create_index(name, table, list(columns), if_not_exists=True, **dialect_options)


def downgrade() -> None:
    """Удаляет таблицы базовой схемы (**все данные**; только dev/CI).

    Откат базовой ревизии не имеет смысла для рабочей БД: ``0001`` — точка
    отсчёта, её downgrade определён для полноты дерева миграций.
    """
    inspector = sa.inspect(op.get_bind())
    for table in reversed(_TABLES):
        if inspector.has_table(table):
            op.drop_table(table)


