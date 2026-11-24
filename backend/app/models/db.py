"""SQLAlchemy модели для локального режима (SQLite).

Схему создаёт и изменяет **только alembic** (`init_db` поднимает её до head,
`alembic/versions/` — замороженные определения, 4.2); `Base.metadata` здесь —
источник истины для autogenerate, расхождение с миграциями ловит страж
`tests/test_migrations.py::test_migration_schema_matches_models`.
"""
import asyncio
import threading
from datetime import datetime
from pathlib import Path
from typing import Any

from alembic.config import Config
from sqlalchemy import (
    JSON,
    Boolean,
    Column,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    event,
)
from sqlalchemy.dialects import postgresql
from sqlalchemy.engine import URL
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from alembic import command
from app.core.config import settings

# SQLite для локальной разработки; PostgreSQL используется в продакшене через docker-compose
# URL берём из settings (загружает .env) для единой конфигурации.
DATABASE_URL = settings.database_url

_IS_SQLITE = DATABASE_URL.startswith("sqlite")

# SQLite: журнал по умолчанию `delete` — читатель блокирует писателя, и при
# `max_concurrent_jobs=2` конкурентная запись отдавала `database is locked`
# вместо ожидания. WAL + busy_timeout снимают это; PostgreSQL — pre_ping.
engine = create_async_engine(
    DATABASE_URL,
    echo=False,
    pool_pre_ping=not _IS_SQLITE,
    connect_args={"timeout": 30} if _IS_SQLITE else {},
)
AsyncSessionLocal = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

if _IS_SQLITE:

    @event.listens_for(engine.sync_engine, "connect")
    def _sqlite_pragmas(dbapi_connection: Any, _record: Any) -> None:
        """Прагмы на каждое соединение: WAL, NORMAL, ожидание блокировки 30 с."""
        cursor = dbapi_connection.cursor()
        try:
            cursor.execute("PRAGMA journal_mode=WAL")
            cursor.execute("PRAGMA synchronous=NORMAL")
            cursor.execute("PRAGMA busy_timeout=30000")
        finally:
            cursor.close()

# alembic.ini и каталог миграций лежат в backend/ (db.py → app/models/ → backend/).
_BACKEND_DIR = Path(__file__).resolve().parents[2]
_ALEMBIC_INI = _BACKEND_DIR / "alembic.ini"
_MIGRATION_LOCK = threading.Lock()  # контекст Alembic общий даже при разных async-запросах



class Base(DeclarativeBase):
    """Базовый класс моделей: ``DeclarativeBase`` (SQLAlchemy 2.0) вместо ``declarative_base()``."""


class Session(Base):
    """Сессия расчёта: legacy `/analyze` и write-API UI-разделов (4.4, шаг ②).

    ``kind`` различает источник строки: ``legacy`` — `/analyze`/`/jobs` (старые
    строки без ``recording_id``), ``preprocess``/``dipoles``/``dipole_refine``/
    ``spectrogram`` — задачи разделов UI, оставляющие строку при успехе (остаток
    F21). ``recording_id`` — связь с `recordings` для каскада «TTL строки =
    TTL записи» (§8.4.3); NULL у legacy-загрузок `/analyze`, у которых файла
    записи уже нет.
    """

    __tablename__ = "sessions"
    __table_args__ = (
        # Страницы готовности/сессий: фильтр по записи + «новые сверху».
        Index("ix_sessions_recording_created", "recording_id", "created_at", "id"),
    )
    id = Column(String, primary_key=True, index=True)
    filename = Column(String)
    n_channels = Column(Integer)
    sfreq = Column(Float)
    duration_sec = Column(Float)
    epoch_length_ms = Column(Float)
    freq_band = Column(String)
    created_at = Column(DateTime, default=datetime.utcnow)
    # Шаг ② (4.4): происхождение и параметры прогона UI-раздела.
    recording_id = Column(
        String,
        ForeignKey(
            "recordings.recording_id",
            name="fk_sessions_recording_id",
            ondelete="CASCADE",
        ),
        nullable=True, index=True,
    )
    kind = Column(String, nullable=True, server_default="legacy")
    job_id = Column(String, nullable=True)
    params_json = Column(JSON, nullable=True)


class EpochRecord(Base):
    """Эпоха сессии: все полосы сетки ``freq_bands`` (4.1, N38).

    Колонки мощностей — ровно ключи ``settings.freq_bands`` + ``_power``:
    раньше таблица хранила 4 полосы при 7 в конфиге, и γ и новые полосы
    молча терялись при записи. Смена сетки — только вместе с колонками и
    **новой миграцией** alembic (догонка старых файлов — в ревизии ``0001``,
    страж паритета — `tests/test_migrations.py`).
    """

    __tablename__ = "epochs"
    id = Column(Integer, primary_key=True)
    session_id = Column(String, ForeignKey("sessions.id"), index=True)
    epoch_index = Column(Integer)
    start_time_sec = Column(Float)
    duration_ms = Column(Float)
    has_artifact = Column(Integer, default=0)
    delta_power = Column(Float)
    delta_theta_power = Column(Float)
    theta_power = Column(Float)
    alpha_power = Column(Float)
    beta_power = Column(Float)
    gamma_power = Column(Float)
    high_gamma_power = Column(Float)


class Dipole(Base):
    __tablename__ = "dipoles"
    # Индексы под запросы Фазы 5 (N37): фильтры таблицы и агрегация по ROI/полосе.
    __table_args__ = (
        Index("ix_dipoles_trajectory_json", "trajectory_json", postgresql_using="gin"),
    )
    id = Column(Integer, primary_key=True)
    session_id = Column(String, ForeignKey("sessions.id"), index=True)
    epoch_id = Column(Integer, ForeignKey("epochs.id"), index=True)
    time_ms = Column(Float)
    mni_x = Column(Float)
    mni_y = Column(Float)
    mni_z = Column(Float)
    amplitude_nam = Column(Float)
    gof = Column(Float, index=True)
    anatomical_roi = Column(String)
    brodmann_area = Column(String, index=True)
    freq_band = Column(String)
    # JSON, а в PostgreSQL — jsonb + GIN (N37): на SQLite вариант игнорируется.
    trajectory_json = Column(JSON().with_variant(postgresql.JSONB(), "postgresql"))
    # Шаг ② (4.4): метод точки — `fast_grid` (быстрый расчёт) / `bem_fit`
    # (точный фитинг); NULL у legacy-строк `/analyze` (метод там не фиксировался).
    method = Column(String, nullable=True)


class RecordingRecord(Base):
    """Строка записи просмотра в БД (4.4, шаг ①; кирпич B1).

    Паспорт целиком живёт в сайдкаре ``recording.json`` — здесь только то, что
    должно пережить реестр в памяти и участвовать в БД-связях: ``digest``
    (дедуп), ``patient_alias`` — **анонимизированный** псевдоним вместо PHI из
    заголовка EDF (B1 «человек (псевдоним)»), и метрики для TTL. ``accessed_at``
    освежается при повторной загрузке: TTL строки = TTL записи (§8.4.3
    ``docs/data-blocks.md``), дочерние строки уходят каскадом вместе с записью.
    """

    __tablename__ = "recordings"
    __table_args__ = (
        # Дедуп по содержимому: один отпечаток — одна запись.
        Index("ix_recordings_digest", "digest", unique=True),
        # Страница готовности: сортировка «новые сверху» без сортировки всей таблицы.
        Index("ix_recordings_created", "created_at", "recording_id"),
    )
    recording_id = Column(String, primary_key=True)
    filename = Column(String, nullable=True)
    digest = Column(String, nullable=True)
    patient_alias = Column(String, nullable=True)
    n_channels = Column(Integer, nullable=True)
    sfreq = Column(Float, nullable=True)
    duration_sec = Column(Float, nullable=True)
    created_at = Column(DateTime, nullable=True)
    accessed_at = Column(DateTime, nullable=True)


class Analysis(Base):
    """Прогон расчёта диполей = кирпич B7 (4.4, шаг ③; §8.3 ``docs/data-blocks.md``).

    Одна строка на прогон: одиночный быстрый расчёт пакета автоотчёта. Состав
    ``params_sig`` тот же, что у ``report_runs`` (вариант (а): отчёт держит FK
    ``report_runs.analyses_id`` — одна истина на прогон). Паспорт — то, что
    получено с записи (референс, каналы, sfreq) и сетка расчёта.
    """

    __tablename__ = "analyses"
    __table_args__ = (
        # Список прогонов: фильтр по записи + «новые сверху».
        Index("ix_analyses_recording_created", "recording_id", "created_at", "id"),
    )
    id = Column(Integer, primary_key=True)
    recording_id = Column(
        String, ForeignKey("recordings.recording_id", ondelete="CASCADE"),
        nullable=True, index=True,
    )
    kind = Column(String, nullable=True)  # fast_grid | bem_fit | refine
    params_sig = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    job_id = Column(String, nullable=True)
    reference = Column(String, nullable=True)
    channels = Column(JSON, nullable=True)
    sfreq = Column(Float, nullable=True)
    epoch_length_ms = Column(Float, nullable=True)
    grid_mm = Column(Float, nullable=True)
    n_epochs_total = Column(Integer, nullable=True)
    n_epochs_used = Column(Integer, nullable=True)
    warnings = Column(JSON, nullable=True)
    duration_sec_calc = Column(Float, nullable=True)


class AnalysisBand(Base):
    """Статус одной полосы в прогоне = B7 ``per_band_status`` (§8.3).

    ``moment_max_nam`` — база КД **внутри** полосы (концепция §3: нормировка на
    максимум своего поддиапазона); ``band_key`` — стабильная адресация полосы,
    границы — производные.
    """

    __tablename__ = "analysis_bands"
    id = Column(Integer, primary_key=True)
    analysis_id = Column(
        Integer, ForeignKey("analyses.id", ondelete="CASCADE"), index=True,
    )
    band_key = Column(String, nullable=True)
    band_hz_lo = Column(Float, nullable=True)
    band_hz_hi = Column(Float, nullable=True)
    state = Column(String, nullable=True)  # ok | empty
    n_points = Column(Integer, nullable=True)
    n_kd_passed = Column(Integer, nullable=True)
    n_errors = Column(Integer, nullable=True)
    moment_max_nam = Column(Float, nullable=True)


class DipolePoint(Base):
    """Дипольная точка поддиапазона = кирпич B6 (§8.3).

    Ключ «эпоха × поддиапазон» — UNIQUE ``(analysis_id, band_key, epoch_index)``:
    момент пика GFP — измерение пары, а не часть ключа. ``kd_basis`` несёт базис
    КД ``{moment_share_x, gof_min, moment_max_nam}`` (правило 2 §2
    ``docs/data-blocks.md``); ``kd_passed`` — вердикт или NULL, пока методика
    (C0 ``concept.md``) не задала пороги. Индекс ``(band_key, kd_passed)`` —
    вход ROI-анализа 4.5.
    """

    __tablename__ = "dipole_points"
    __table_args__ = (
        UniqueConstraint(
            "analysis_id", "band_key", "epoch_index", name="ux_dipole_points_epoch",
        ),
        Index("ix_dipole_points_band_kd", "band_key", "kd_passed"),
    )
    id = Column(Integer, primary_key=True)
    analysis_id = Column(
        Integer, ForeignKey("analyses.id", ondelete="CASCADE"), index=True,
    )
    band_key = Column(String, nullable=True)
    band_hz_lo = Column(Float, nullable=True)
    band_hz_hi = Column(Float, nullable=True)
    epoch_index = Column(Integer, nullable=True)
    peak_time_ms = Column(Float, nullable=True)
    head_coords = Column(JSON, nullable=True)
    mni_coords = Column(JSON, nullable=True)
    moment_dir = Column(JSON, nullable=True)
    amplitude_nam = Column(Float, nullable=True)
    gof = Column(Float, nullable=True)
    anatomical_structure = Column(String, nullable=True)
    brodmann_area = Column(String, nullable=True)
    method = Column(String, nullable=True)  # fast_grid | bem_fit
    kd_passed = Column(Integer, nullable=True)  # 1/0/NULL (не оценено)
    kd_basis = Column(JSON, nullable=True)
    refined = Column(JSON, nullable=True)


class DipoleCluster(Base):
    """Кластер диполей прогона = кирпич B8 (С2; §8.3 ``docs/data-blocks.md``).

    Строка пакета ``kind=dipole_batch``: геометрия скопления + **профиль
    признаков** (``features`` — JSON ``ClusterFeaturesOut``; неизмерённое —
    ``None``, никогда 0). ``cluster_params`` — паспорт кластеризации прогона
    (нормированные единицы + базис); одинаков у всех строк анализа, хранится
    на каждой для автономности выгрузки. ``n_bands_matched``/``band_share``/
    ``matched_band_keys`` — устойчивость по поддиапазонам (одна полоса за
    расчёт; полный список полос — в ``analysis_bands``).

    Ключ: UNIQUE ``(analysis_id, band_key, cluster_index)`` — адресация
    «полоса × номер» внутри прогона (крупные первыми в ``cluster_index``).
    """

    __tablename__ = "dipole_clusters"
    __table_args__ = (
        UniqueConstraint(
            "analysis_id", "band_key", "cluster_index",
            name="ux_dipole_clusters_band_index",
        ),
    )
    id = Column(Integer, primary_key=True)
    analysis_id = Column(
        Integer, ForeignKey("analyses.id", ondelete="CASCADE"), index=True,
    )
    band_key = Column(String, nullable=True)
    cluster_index = Column(Integer, nullable=True)
    centroid_mni = Column(JSON, nullable=True)
    n_points = Column(Integer, nullable=True)
    share = Column(Float, nullable=True)
    volume_cm3 = Column(Float, nullable=True)
    density_per_cm3 = Column(Float, nullable=True)
    extent_mm = Column(JSON, nullable=True)
    top_structures = Column(JSON, nullable=True)
    top_brodmann = Column(JSON, nullable=True)
    features = Column(JSON, nullable=True)
    cluster_params = Column(JSON, nullable=True)
    n_bands_matched = Column(Integer, nullable=True)
    band_share = Column(Float, nullable=True)
    matched_band_keys = Column(JSON, nullable=True)


class ReportRun(Base):
    """Один прогон автоотчёта = кирпич B13 (§8.3; решения §8.4).

    История, не UPSERT (§8.4.2): каждая задача оставляет свою строку, «последний
    отчёт» — ``ORDER BY created_at DESC LIMIT 1``. ``warnings`` — JSON-колонка
    (§8.4.1: состав свободный, ничего из сказанного сервером не теряется), а
    числовые QC — отдельные колонки под сортировку/фильтр. ``html_path`` — путь
    к HTML **относительно** ``cache_dir`` (сам файл остаётся на диске, в БД —
    путь и ``html_version`` = ETag).
    """

    __tablename__ = "report_runs"
    __table_args__ = (
        Index("ix_report_runs_recording_created", "recording_id", "created_at"),
    )
    id = Column(Integer, primary_key=True)
    recording_id = Column(
        String, ForeignKey("recordings.recording_id", ondelete="CASCADE"),
        nullable=True, index=True,
    )
    analyses_id = Column(
        Integer, ForeignKey("analyses.id", ondelete="SET NULL"), nullable=True,
    )
    params_sig = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    job_id = Column(String, nullable=True)
    n_epochs_total = Column(Integer, nullable=True)
    n_epochs_used = Column(Integer, nullable=True)
    n_epochs_rejected = Column(Integer, nullable=True)
    qc_status = Column(String, nullable=True)
    good_data_percent = Column(Float, nullable=True)
    warnings = Column(JSON, nullable=True)
    duration_sec_calc = Column(Float, nullable=True)
    html_path = Column(String, nullable=True)
    html_version = Column(String, nullable=True)


class ReportBandSummary(Base):
    """Агрегат одной полосы пакета отчёта (B7 по полосе, §8.3).

    ``median_gof`` — **только внутри полосы** (GOF между полосами не сравним,
    принцип 3 ``docs/rules/dipoles.md``); кросс-полосной фильтр — ``median_riv``.
    """

    __tablename__ = "report_band_summaries"
    id = Column(Integer, primary_key=True)
    report_run_id = Column(
        Integer, ForeignKey("report_runs.id", ondelete="CASCADE"), index=True,
    )
    band_key = Column(String, nullable=True)
    band_hz_lo = Column(Float, nullable=True)
    band_hz_hi = Column(Float, nullable=True)
    n_epochs_used = Column(Integer, nullable=True)
    n_points = Column(Integer, nullable=True)
    n_no_attribution = Column(Integer, nullable=True)
    median_gof = Column(Float, nullable=True)
    median_riv = Column(Float, nullable=True)
    # Доля вращения момента (срез 2): CW/CCW по «плоским» тройкам траектории
    # (`services/moment_rotation.py`, взгляд снаружи сферы); доли среди
    # троек с определённым знаком, `rotation_triples` — знаменатель.
    # NULL — плоских троек не было (или отчёт собран до среза 2).
    rotation_cw_share = Column(Float, nullable=True)
    rotation_ccw_share = Column(Float, nullable=True)
    rotation_triples = Column(Integer, nullable=True)
    # Магистраль потока и упорядоченность (срез 3, `services/flow_metrics.py`):
    # R векторов смещения траектории позиций (`flow_orderliness` ∈ [0; 1],
    # `flow_steps` — число шагов, `flow_basis` — mni | head) и топ переходов
    # «структура → структура» (`flow_top_transitions`, JSON-список
    # {from_structure, to_structure, count, share}). NULL/[] — не измерено.
    flow_orderliness = Column(Float, nullable=True)
    flow_steps = Column(Integer, nullable=True)
    flow_basis = Column(String, nullable=True)
    flow_top_transitions = Column(JSON, nullable=True)


class ReportNameCount(Base):
    """Счётчик «название × полоса» отчёта (§8.4.4: **все** имена, не топ-N).

    Нормализация вместо JSON нужна ради SQL «BA × полоса» (ROI-анализ 4.5);
    топ-5/12 в HTML — вопрос отображения. ``median_gof`` — внутри своей полосы.
    """

    __tablename__ = "report_name_counts"
    id = Column(Integer, primary_key=True)
    report_run_id = Column(
        Integer, ForeignKey("report_runs.id", ondelete="CASCADE"), index=True,
    )
    band_key = Column(String, nullable=True)
    kind = Column(String, nullable=True)  # structure | brodmann
    name = Column(String, nullable=True)
    count = Column(Integer, nullable=True)
    share = Column(Float, nullable=True)
    median_gof = Column(Float, nullable=True)


class ReportDynamics(Base):
    """Динамика активности структуры: 5 бинов времени (гранулярность как в HTML)."""

    __tablename__ = "report_dynamics"
    id = Column(Integer, primary_key=True)
    report_run_id = Column(
        Integer, ForeignKey("report_runs.id", ondelete="CASCADE"), index=True,
    )
    band_key = Column(String, nullable=True)
    name = Column(String, nullable=True)
    bin_index = Column(Integer, nullable=True)
    share = Column(Float, nullable=True)


class GroupAnalysis(Base):
    """Прогон группового анализа (остаток 4.7, Фаза 5): снимок определения.

    Хранит **определение** — фильтры и отпечаток — а не замороженные числа:
    агрегат пересчитывается по живой БД при чтении (решение-точка 1 плана:
    честность по текущим данным; строки-участники живут отдельно и убывают
    каскадно вместе с записями, §8.4.3). История прогонов — не UPSERT
    (§8.4.2): каждая кнопка «Сохранить прогон» оставляет свою строку.
    """

    __tablename__ = "group_analyses"
    id = Column(Integer, primary_key=True)
    name = Column(String, nullable=True)  # подпись пользователя; NULL — без имени
    band_key = Column(String, nullable=True)
    filters = Column(JSON, nullable=True)  # GroupAggregateIn без recording_ids
    params_sig = Column(String, nullable=True)  # отпечаток фильтров (ключ истории)
    created_at = Column(DateTime, default=datetime.utcnow)
    n_sessions_requested = Column(Integer, nullable=True)  # размер группы при создании


class GroupAnalysisMember(Base):
    """Участник группы: запись в составе прогона (many-to-many + порядок выбора).

    ``recording_id`` — без FK: SQLite не проверяет внешние ключи по умолчанию,
    а членство обязано убывать вместе с записью — это делает явным
    ``recording_store._delete_recording_rows`` (тот же приём, что и для
    строк ``sessions``/``analyses``, §8.4.3).
    """

    __tablename__ = "group_analysis_members"
    __table_args__ = (
        Index("ux_group_members_pair", "group_analysis_id", "recording_id", unique=True),
    )
    id = Column(Integer, primary_key=True)
    group_analysis_id = Column(
        Integer, ForeignKey("group_analyses.id", ondelete="CASCADE"), index=True,
    )
    recording_id = Column(String, nullable=True, index=True)
    position = Column(Integer, nullable=True)  # порядок выбора в UI — колонки карты


class Hypothesis(Base):
    """Сохранённое правило-гипотеза «N из M» = библиотека исследований (Т4).

    Строка — **правило** (полоса + условия + порог) и фиксированная выборка
    проб, а не разовый ответ проверки: проверка пересчитывается (история
    ``report_runs`` меняется), правило накапливается. ``conditions`` — JSON
    списка ``{feature, op, value}``; ``recording_ids`` — выборка на момент
    сохранения (пересохранение — новая строка, история не UPSERT).
    Интерпретации/диагнозов здесь нет («не навреди»).
    """

    __tablename__ = "hypotheses"
    id = Column(Integer, primary_key=True)
    label = Column(String, nullable=True)
    band_key = Column(String, nullable=True)
    conditions = Column(JSON, nullable=True)
    min_share = Column(Float, nullable=True)
    recording_ids = Column(JSON, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class AgentRole(Base):
    """Роль ИИ-агента чата консилиума: инструкция и (необязательно) своя модель.

    Роль — данные, а не код: правится из интерфейса. ``provider_id``/``model`` —
    выбор из модельного роутера; пусто — маршрут ``chat``. ``reasoning`` — уровень
    размышления (low/medium/high, директива в инструкции), ``skills`` — навыки
    специалиста через запятую.
    """

    __tablename__ = "agent_roles"
    id = Column(String, primary_key=True)  # slug: psychologist, archivist, ...
    label = Column(String, nullable=False)
    instruction = Column(String, nullable=False)
    provider_id = Column(String, nullable=True)
    model = Column(String, nullable=True)
    reasoning = Column(String, nullable=True)
    skills = Column(String, nullable=True)
    enabled = Column(Boolean, nullable=False, default=True)
    builtin = Column(Boolean, nullable=False, default=False)
    sort = Column(Integer, nullable=False, default=0)
    updated_at = Column(DateTime, nullable=False)


class AgentThread(Base):
    """Нить общего чата исследователя с ролевыми агентами."""

    __tablename__ = "agent_threads"
    id = Column(String, primary_key=True)
    title = Column(String, nullable=False)
    created_at = Column(DateTime, nullable=False)


class AgentMessage(Base):
    """Реплика общего чата: исследователя или одного агента (все видят нить)."""

    __tablename__ = "agent_messages"
    __table_args__ = (
        Index("ix_agent_messages_thread_created", "thread_id", "created_at", "id"),
    )
    id = Column(String, primary_key=True)
    thread_id = Column(String, ForeignKey("agent_threads.id"), nullable=False, index=True)
    author_kind = Column(String, nullable=False)  # researcher | agent
    role_id = Column(String, nullable=True)  # роль агента (NULL у исследователя)
    question_id = Column(String, nullable=True)  # исходная реплика исследователя для ответа
    addressees = Column(JSON, nullable=False)  # роли, к которым обращена реплика
    status = Column(String, nullable=False)  # ok | running | failed | interrupted
    text = Column(String, nullable=True)
    model = Column(String, nullable=True)
    error = Column(String, nullable=True)
    warnings = Column(JSON, nullable=False)
    job_id = Column(String, nullable=True)
    latency_ms = Column(Float, nullable=True)
    created_at = Column(DateTime, nullable=False)
    finished_at = Column(DateTime, nullable=True)


class AgentWebSearch(Base):
    """Веб-поиск Архивариуса: запрос, найденные материалы и машинный перевод.

    Результаты хранятся JSON-списком ``{title, url, snippet, title_ru,
    snippet_ru, error}``. Поиск и перевод — только явными кнопками; последний
    поиск нити подмешивается в промпт роли ``archivist``.
    """

    __tablename__ = "agent_web_searches"
    __table_args__ = (
        Index("ix_agent_web_searches_thread_created", "thread_id", "created_at", "id"),
    )
    id = Column(String, primary_key=True)
    thread_id = Column(String, ForeignKey("agent_threads.id"), nullable=False, index=True)
    role_id = Column(String, nullable=True)
    query = Column(String, nullable=False)
    provider = Column(String, nullable=False)
    results = Column(JSON, nullable=False)
    created_at = Column(DateTime, nullable=False)
    translated_at = Column(DateTime, nullable=True)


class KnowledgeFolder(Base):
    """Папка библиотеки знаний: дерево «Источники» (книги, статьи, веб-страницы).

    ``parent_id`` — вложенность; удаление папки каскадно убирает документы
    (файлы на диске удаляет сервис, БД — внешние ключи).
    """

    __tablename__ = "knowledge_folders"
    id = Column(String, primary_key=True)
    name = Column(String, nullable=False)
    parent_id = Column(String, ForeignKey("knowledge_folders.id"), nullable=True, index=True)
    created_at = Column(DateTime, nullable=False)


class KnowledgeDocument(Base):
    """Документ библиотеки: файл на диске либо сохранённая веб-страница.

    ``status``: ``ok`` (текст извлечён), ``empty`` (текстового слоя нет —
    скан без OCR), ``failed`` (разбор упал, причина в ``error``). ``sha256``
    даёт дедуп: повторная загрузка того же файла возвращает существующий
    документ, а не копию.
    """

    __tablename__ = "knowledge_documents"
    __table_args__ = (
        Index("ix_knowledge_documents_folder_created", "folder_id", "created_at", "id"),
    )
    id = Column(String, primary_key=True)
    folder_id = Column(String, ForeignKey("knowledge_folders.id"), nullable=True, index=True)
    title = Column(String, nullable=False)
    filename = Column(String, nullable=False)
    kind = Column(String, nullable=False)  # pdf | docx | xlsx | image | web | text
    source_url = Column(String, nullable=True)
    sha256 = Column(String, nullable=False, index=True)
    size_bytes = Column(Integer, nullable=False, default=0)
    pages = Column(Integer, nullable=True)
    text_chars = Column(Integer, nullable=False, default=0)
    status = Column(String, nullable=False, default="ok")
    error = Column(String, nullable=True)
    meta = Column(JSON, nullable=False, default=dict)
    created_at = Column(DateTime, nullable=False)
    indexed_at = Column(DateTime, nullable=True)


class KnowledgeChunk(Base):
    """Фрагмент документа: единица поиска и цитирования в чате.

    ``heading`` — ближайший заголовок раздела/главы, ``page_from``/``page_to`` —
    страницы PDF. ``embedding`` — вектор провайдера (JSON-список), пусто, если
    эмбеддинги недоступны: поиск тогда идёт по TF-IDF.
    """

    __tablename__ = "knowledge_chunks"
    __table_args__ = (
        Index("ix_knowledge_chunks_document_ordinal", "document_id", "ordinal"),
    )
    id = Column(String, primary_key=True)
    document_id = Column(
        String, ForeignKey("knowledge_documents.id"), nullable=False, index=True,
    )
    ordinal = Column(Integer, nullable=False)
    heading = Column(String, nullable=True)
    page_from = Column(Integer, nullable=True)
    page_to = Column(Integer, nullable=True)
    text = Column(Text, nullable=False)
    tokens = Column(Integer, nullable=False, default=0)
    embedding = Column(JSON, nullable=True)


class KnowledgeTag(Base):
    """Поисковый тег Базы знаний (одно имя на всю библиотеку)."""

    __tablename__ = "knowledge_tags"
    id = Column(String, primary_key=True)
    name = Column(String, nullable=False, unique=True)
    created_at = Column(DateTime, nullable=False)


class KnowledgeDocTag(Base):
    """Связь документа с тегом (составной ключ)."""

    __tablename__ = "knowledge_doc_tags"
    document_id = Column(
        String, ForeignKey("knowledge_documents.id"), primary_key=True,
    )
    tag_id = Column(String, ForeignKey("knowledge_tags.id"), primary_key=True, index=True)


class KnowledgeAnnotation(Base):
    """Аннотация раздела: заметка исследователя к документу или фрагменту."""

    __tablename__ = "knowledge_annotations"
    __table_args__ = (
        Index("ix_knowledge_annotations_document_created", "document_id", "created_at", "id"),
    )
    id = Column(String, primary_key=True)
    document_id = Column(
        String, ForeignKey("knowledge_documents.id"), nullable=False, index=True,
    )
    chunk_id = Column(String, ForeignKey("knowledge_chunks.id"), nullable=True)
    heading = Column(String, nullable=True)
    note = Column(Text, nullable=False)
    created_at = Column(DateTime, nullable=False)


class KnowledgeLink(Base):
    """Ребро графа знаний: связь документа, тега или понятия с другим узлом.

    В граф попадают только подтверждённые связи (``confirmed``): ИИ может
    предложить ребро, но показывается оно отдельно и в граф не входит.
    """

    __tablename__ = "knowledge_links"
    __table_args__ = (
        Index("ix_knowledge_links_from", "from_kind", "from_id"),
        Index("ix_knowledge_links_to", "to_kind", "to_id"),
    )
    id = Column(String, primary_key=True)
    from_kind = Column(String, nullable=False)  # document | tag | concept
    from_id = Column(String, nullable=False)
    to_kind = Column(String, nullable=False)
    to_id = Column(String, nullable=False)
    relation = Column(String, nullable=False)  # cites | related | defines | mentions
    confirmed = Column(Boolean, nullable=False, default=False)
    created_at = Column(DateTime, nullable=False)


class AgentThreadAttachment(Base):
    """Вложение нити чата: документ библиотеки, веб-ссылка или отчёт ЭЭГ.

    Пока вложение прикреплено, его содержимое (фрагменты документа, сводка
    отчёта) попадает в промпт ролей. Наружу уходит только при отправке
    сообщения — правило «явное действие».
    """

    __tablename__ = "agent_thread_attachments"
    __table_args__ = (
        Index("ix_agent_thread_attachments_thread", "thread_id", "created_at", "id"),
    )
    id = Column(String, primary_key=True)
    thread_id = Column(String, ForeignKey("agent_threads.id"), nullable=False, index=True)
    kind = Column(String, nullable=False)  # document | web | report | analysis
    ref_id = Column(String, nullable=False)
    label = Column(String, nullable=False)
    created_at = Column(DateTime, nullable=False)


def _sync_driver_url(url: URL) -> str:
    """Синхронный URL для alembic: срезаем async-драйвер из URL движка.

    ``sqlite+aiosqlite`` → ``sqlite``, ``postgresql+asyncpg`` → ``postgresql``
    (поставляемый psycopg2-binary): миграции выполняются синхронным API.
    ``str(url)`` маскирует пароль («***») — берём ``render_as_string`` явно,
    иначе подключение к PostgreSQL ушло бы с паролем-заглушкой.
    """
    sync = url.set(drivername=url.drivername.partition("+")[0])
    return sync.render_as_string(hide_password=False)


def _upgrade_to_head(database_url: str) -> None:
    """Поднимает схему до последней ревизии alembic (блокирующий I/O — для потока).

    URL передаётся явно: тесты подменяют ``engine`` на изолированную БД,
    а ``alembic.ini`` URL не задаёт (env.py иначе взял бы ``settings``).
    """
    config = Config(str(_ALEMBIC_INI))
    # set_main_option использует ConfigParser-интерполяцию: % в URL экранируем.
    config.set_main_option("sqlalchemy.url", database_url.replace("%", "%%"))
    with _MIGRATION_LOCK:
        command.upgrade(config, "head")


_SCHEMA_READY: set[str] = set()


async def init_db() -> None:
    """Поднимает схему БД до head: схему создают и меняют только миграции.

    Файлы, созданные ``create_all`` до alembic (в т.ч. «до 4.1» с 4 полосами),
    ревизия ``0001`` догоняет автоматически — ручная догонка (4.1) удалена.
    Выполняется в отдельном потоке: синхронные запросы блокируют event loop.

    Миграция выполняется **один раз на URL за процесс** (первый вызов — в
    ``lifespan``, см. `app/main.py`); повторные вызовы из операций хранилищ —
    дешёвый guard по `_SCHEMA_READY` (аудит 15.10.2026: «init_db() на каждой
    операции БД вместо upgrade в lifespan»). Ключ — именно URL: тесты подменяют
    движок на изолированную БД, и её схема обязана подняться.
    """
    url = _sync_driver_url(engine.url)
    if url in _SCHEMA_READY:
        return
    await asyncio.to_thread(_upgrade_to_head, url)
    _SCHEMA_READY.add(url)

