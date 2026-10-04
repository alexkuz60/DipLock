"""Аналитическая проекция журнала шагов — файл `analytics.db` (todo 4.3).

Решение владельца 17.09.2026 (`docs/data_map.md` §9): журнал — источник, но не
средство запросов: «сколько всего шло на `psd` за неделю» и «что посчитано по
этой записи» требуют SQL. Здесь каждая строка журнала **дублируется** в
отдельный SQLite-файл (`ANALYTICS_DB_PATH`, по умолчанию `data/analytics.db`),
осознанно отдельный от транзакционной БД `database_url`: своя схема, свой
жизненный цикл, файл не коммитится (как `data/cache`), текстовые логи остаются
на `logging`.

Свойства:

1. **Строка журнала + `recording_id`.** JSONL-формат (`docs/data_map.md` §9)
   не меняется: связь «шаг → запись» кладёт сюда ``insert_step`` из ContextVar
   ``journal.job_scope`` — и вопрос «что посчитано по записи» отвечается
   одним SQL (``recording_summary``).
2. **Замер не может сломать расчёт** (правило журнала): сбой вставки
   логируется и гасится ``insert_step`` — ``record`` его не видит.
3. **Идемпотентность по содержимому строки**: первичный ключ — ``line_key``
   (sha1 канонического JSON нормализованной строки), поэтому повторный импорт
   того же файла не создаёт дублей, а строка, уже вставленная ``record``,
   при импорте распознаётся как та же самая.
4. **Насилие дочитывается один раз на процесс**: ротация стирает историю
   журнала — база её и хранит. Перед первой вставкой читаются оба поколения
   ``journal.jsonl`` целиком (``journal.iter_entries``).

Схема версионируется `PRAGMA user_version` (шаги — ``_MIGRATIONS``), а не
alembic'ом: alembic ведёт только транзакционную БД, а файл обязан подниматься
и без неё. Запросы — функции ``step_stats`` / ``top_steps`` / ``cache_ratio`` /
``recording_summary`` (каждый — один SQL); HTTP-роутов нет: слой обслуживает
будущие подсказки UI и прямые запросы к файлу.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import sqlite3
import threading
from contextlib import closing, suppress
from typing import Any

from app.core.config import Settings, settings

logger = logging.getLogger(__name__)

# Версия схемы: поднимается вместе с шагами _MIGRATIONS (PRAGMA user_version).
SCHEMA_VERSION = 1

# Прочерк «поля нет» — та же конвенция, что в журнале (journal.DASH): в базе
# строки NOT NULL, поэтому None из JSONL нормализуется в '-'.
DASH = "-"

# Один замок на запись и чтение: соединение живёт внутри вызова, параллельные
# шаги job-очереди сериализуются (строк на задачу — десятки, цена микросекунды).
_LOCK = threading.Lock()

# Насилие журнала дочитано этим процессом (флаг процесса; ``clear_analytics``
# сбрасывает его вместе с файлом — так чистят тесты).
_INGESTED = False

# Шаги миграций: {целевая версия: SQL-шаги}. Применяются один раз в порядке
# версий; PRAGMA user_version фиксирует достигнутую версию.
_MIGRATIONS: dict[int, tuple[str, ...]] = {
    1: (
        """CREATE TABLE IF NOT EXISTS steps (
            line_key TEXT PRIMARY KEY,
            ts TEXT NOT NULL,
            job_id TEXT NOT NULL DEFAULT '-',
            recording_id TEXT NOT NULL DEFAULT '-',
            pipeline TEXT NOT NULL,
            step TEXT NOT NULL,
            params_key TEXT NOT NULL DEFAULT '-',
            bytes_in INTEGER,
            bytes_out INTEGER,
            ms REAL NOT NULL DEFAULT 0.0,
            cache_hit INTEGER,
            epochs INTEGER,
            note TEXT NOT NULL DEFAULT ''
        )""",
        "CREATE INDEX IF NOT EXISTS ix_steps_pipeline_step ON steps (pipeline, step)",
        "CREATE INDEX IF NOT EXISTS ix_steps_recording ON steps (recording_id)",
        "CREATE INDEX IF NOT EXISTS ix_steps_ts ON steps (ts)",
    ),
}

_INSERT_SQL = """INSERT OR IGNORE INTO steps (
    line_key, ts, job_id, recording_id, pipeline, step, params_key,
    bytes_in, bytes_out, ms, cache_hit, epochs, note
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"""

# Прямая запись (record) — UPSERT: строка могла прийти первым импортом из
# журнала без recording_id, и связь «шаг → запись» должна затереть прочерк,
# а не воевать с ним. Импорт (ingest) идёт чистым OR IGNORE: он связь не трогает
# и не считает обновление «наследием» (rowcount).
_UPSERT_SQL = """INSERT INTO steps (
    line_key, ts, job_id, recording_id, pipeline, step, params_key,
    bytes_in, bytes_out, ms, cache_hit, epochs, note
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(line_key) DO UPDATE SET
    recording_id = CASE
        WHEN excluded.recording_id != '-' THEN excluded.recording_id
        ELSE steps.recording_id
    END"""

_INSERT_COLUMNS = (
    "ts", "job_id", "recording_id", "pipeline", "step", "params_key",
    "bytes_in", "bytes_out", "ms", "cache_hit", "epochs", "note",
)


def analytics_path(cfg: Settings | None = None) -> str:
    """Путь файла аналитической базы (логи, тесты, будущие подсказки UI)."""
    return (cfg or settings).analytics_db_path


def insert_step(
    entry: dict[str, Any],
    *,
    recording_id: str | None = None,
    cfg: Settings | None = None,
) -> None:
    """Дублирует строку журнала в базу; сбой логируется и гасится.

    ``entry`` — словарь ``journal._line``/``journal.iter_entries`` (обе формы
    прочерков нормализуются, поэтому импорт и прямая запись дают один
    ``line_key``). ``recording_id`` берёт вызывающий из ContextVar задачи —
    сам модуль про журнал знает только в ленивом импорте наследия.
    """
    cfg = cfg or settings
    row = _normalize(entry, recording_id)
    try:
        with _LOCK, closing(_connect(cfg)) as conn:
            _migrate(conn)
            if not _INGESTED:
                _ingest_locked(conn, cfg)
            conn.execute(_UPSERT_SQL, _values(row))
            conn.commit()
    except (sqlite3.Error, OSError, ValueError) as exc:
        logger.warning("Аналитическая база не записана (%s): %s", analytics_path(cfg), exc)


def ingest_journal(cfg: Settings | None = None) -> int:
    """Дочитывает оба поколения ``journal.jsonl`` в базу; возвращает число строк.

    Публичный импорт наследия (тесты, разовые сценарии): повторный вызов
    безопасен — идемпотентность по ``line_key`` (свойство 3). Сам ``record``
    зовёт тот же путь лениво через ``insert_step``.
    """
    cfg = cfg or settings
    with _LOCK, closing(_connect(cfg)) as conn:
        _migrate(conn)
        inserted = _ingest_locked(conn, cfg)
        conn.commit()
    return inserted


def clear_analytics(cfg: Settings | None = None) -> None:
    """Удаляет файл базы и сбрасывает флаг наследия (тесты; в UI такого нет)."""
    global _INGESTED
    path = analytics_path(cfg)
    with _LOCK:
        _INGESTED = False
        for suffix in ("", "-wal", "-shm"):
            with suppress(OSError):
                os.remove(f"{path}{suffix}")


# ---------- чтение: один SQL на вопрос ----------


def step_stats(
    *,
    pipeline: str | None = None,
    step: str | None = None,
    recording_id: str | None = None,
    since: str | None = None,
    until: str | None = None,
    cfg: Settings | None = None,
) -> dict[str, Any]:
    """Сумма/среднее/**медиана**/минимум/максимум длительности шагов одним SQL.

    ``since``/``until`` — ISO-8601 границы по ``ts`` (``>=`` и ``<``):
    лексикографический порядок ISO-строк совпадает с хронологическим. Пустая
    выборка даёт ``count = 0`` и ``None`` в величинах (правило «неизмеренное —
    null», `docs/rules/api-jobs.md` п.5).
    """
    where, params = _where(pipeline=pipeline, step=step, recording_id=recording_id,
                           since=since, until=until)
    sql = f"""
        WITH filtered AS (SELECT ms FROM steps {where}),
        vals AS (
            SELECT ms,
                   ROW_NUMBER() OVER (ORDER BY ms) AS rn,
                   COUNT(*) OVER () AS cnt
            FROM filtered
        )
        SELECT
            (SELECT COUNT(*) FROM filtered) AS count,
            (SELECT SUM(ms) FROM filtered) AS sum_ms,
            (SELECT AVG(ms) FROM filtered) AS mean_ms,
            (SELECT MIN(ms) FROM filtered) AS min_ms,
            (SELECT MAX(ms) FROM filtered) AS max_ms,
            (SELECT AVG(ms) FROM vals WHERE rn IN ((cnt + 1) / 2, (cnt + 2) / 2))
                AS median_ms
    """
    return _fetch_one(sql, params, cfg)


def top_steps(
    limit: int = 10,
    *,
    pipeline: str | None = None,
    recording_id: str | None = None,
    cfg: Settings | None = None,
) -> list[dict[str, Any]]:
    """Топ шагов по суммарной длительности — где уходит время пайплайнов."""
    where, params = _where(pipeline=pipeline, recording_id=recording_id)
    sql = f"""
        SELECT pipeline, step,
               COUNT(*) AS count,
               SUM(ms) AS sum_ms,
               AVG(ms) AS mean_ms,
               MAX(ms) AS max_ms
        FROM steps {where}
        GROUP BY pipeline, step
        ORDER BY sum_ms DESC
        LIMIT ?
    """
    return _fetch_all(sql, (*params, max(1, int(limit))), cfg)


def cache_ratio(
    *,
    pipeline: str | None = None,
    step: str | None = None,
    cfg: Settings | None = None,
) -> dict[str, Any]:
    """Доля кэш-попаданий: ``cache_hit IS NULL`` — «шаг не кэшируется» (untracked)."""
    where, params = _where(pipeline=pipeline, step=step)
    sql = f"""
        SELECT COUNT(*) AS total,
               COALESCE(SUM(CASE WHEN cache_hit = 1 THEN 1 ELSE 0 END), 0) AS hits,
               COALESCE(SUM(CASE WHEN cache_hit = 0 THEN 1 ELSE 0 END), 0) AS misses,
               COALESCE(SUM(CASE WHEN cache_hit IS NULL THEN 1 ELSE 0 END), 0) AS untracked
        FROM steps {where}
    """
    row = _fetch_one(sql, params, cfg)
    tracked = int(row["hits"]) + int(row["misses"])
    row["hit_share"] = (row["hits"] / tracked) if tracked else None
    return row


def recording_summary(recording_id: str, cfg: Settings | None = None) -> list[dict[str, Any]]:
    """«Что посчитано по этой записи»: пайплайны с числом шагов, суммой и последним временем."""
    sql = """
        SELECT pipeline,
               COUNT(*) AS count,
               SUM(ms) AS sum_ms,
               MAX(ts) AS last_ts
        FROM steps
        WHERE recording_id = ?
        GROUP BY pipeline
        ORDER BY sum_ms DESC
    """
    return _fetch_all(sql, (recording_id,), cfg)


# ---------- служебное ----------


def _connect(cfg: Settings) -> sqlite3.Connection:
    """Соединение с базой (каталог создаётся; закрывается вызывающим)."""
    path = analytics_path(cfg)
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    conn = sqlite3.connect(path, timeout=30.0)
    conn.row_factory = sqlite3.Row
    return conn


def _migrate(conn: sqlite3.Connection) -> None:
    """Применяет недостающие шаги схемы и фиксирует ``PRAGMA user_version``."""
    version = int(conn.execute("PRAGMA user_version").fetchone()[0])
    for target in range(version + 1, SCHEMA_VERSION + 1):
        for statement in _MIGRATIONS.get(target, ()):
            conn.execute(statement)
        # PRAGMA не принимает параметры; target — int из нашего же словаря.
        conn.execute(f"PRAGMA user_version = {target}")


def _normalize(entry: dict[str, Any], recording_id: str | None) -> dict[str, Any]:
    """Приводит строку любой из форм (``_line``/``_parse``) к канонической.

    Прочерки двух форм (``'-'`` у ``_line`` и ``None`` у ``_parse``) сходятся в
    ``'-'`` — иначе одна и та же строка дала бы два разных ``line_key``.
    """
    def dash(value: Any) -> str:
        return value if isinstance(value, str) and value else DASH

    def maybe_int(value: Any) -> int | None:
        if value in (None, "", DASH):
            return None
        try:
            return int(value)
        except (TypeError, ValueError):
            return None

    cache_hit = entry.get("cache_hit")
    return {
        "ts": str(entry.get("ts") or ""),
        "job_id": dash(entry.get("job_id")),
        "recording_id": dash(recording_id),
        "pipeline": str(entry.get("pipeline") or ""),
        "step": str(entry.get("step") or ""),
        "params_key": dash(entry.get("params_key")),
        "bytes_in": maybe_int(entry.get("bytes_in")),
        "bytes_out": maybe_int(entry.get("bytes_out")),
        "ms": round(float(entry.get("ms") or 0.0), 3),
        "cache_hit": (1 if cache_hit else 0) if isinstance(cache_hit, bool) else None,
        "epochs": maybe_int(entry.get("epochs")),
        "note": str(entry.get("note") or ""),
    }


def _values(row: dict[str, Any]) -> tuple[Any, ...]:
    """``line_key`` первым плюс значения в порядке ``_INSERT_COLUMNS``.

    ``line_key`` считается **без** ``recording_id``: строка журнала о событии
    одна, а связь с записью у неё появляется только в базе — иначе импорт из
    журнала дал бы второй ``line_key`` и задвоил строку (свойство 3 докстринга).
    """
    payload = {key: value for key, value in row.items() if key != "recording_id"}
    line_key = hashlib.sha1(  # noqa: S324 — ключ строки данных, не защита данных
        json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode(),
    ).hexdigest()
    return (line_key, *(row[column] for column in _INSERT_COLUMNS))


def _where(
    *,
    pipeline: str | None = None,
    step: str | None = None,
    recording_id: str | None = None,
    since: str | None = None,
    until: str | None = None,
) -> tuple[str, tuple[Any, ...]]:
    """``WHERE`` с параметрами: одинаковый набор фильтров для всех запросов."""
    conditions: list[str] = []
    params: list[Any] = []
    for column, value, op in (
        ("pipeline", pipeline, "="),
        ("step", step, "="),
        ("recording_id", recording_id, "="),
        ("ts", since, ">="),
        ("ts", until, "<"),
    ):
        if value is not None:
            conditions.append(f"{column} {op} ?")
            params.append(value)
    return (f"WHERE {' AND '.join(conditions)}" if conditions else "", tuple(params))


def _fetch_one(sql: str, params: tuple[Any, ...], cfg: Settings | None) -> dict[str, Any]:
    """Одна строка результата как словарь (пустая база — нули/None, не ошибка)."""
    with _LOCK, closing(_connect(cfg or settings)) as conn:
        _migrate(conn)
        row = conn.execute(sql, params).fetchone()
    return dict(row) if row is not None else {}


def _fetch_all(sql: str, params: tuple[Any, ...], cfg: Settings | None) -> list[dict[str, Any]]:
    """Все строки результата как словари."""
    with _LOCK, closing(_connect(cfg or settings)) as conn:
        _migrate(conn)
        rows = conn.execute(sql, params).fetchall()
    return [dict(row) for row in rows]


def _ingest_locked(conn: sqlite3.Connection, cfg: Settings) -> int:
    """Читает оба поколения журнала и вставляет недостающее (под ``_LOCK``).

    Импорт ``journal`` ленивый: тот импортирует этот модуль на уровне модуля
    (``record`` пишет проекцию) — верхнеуровневый импорт отсюда замкнул бы цикл.
    Флаг ``_INGESTED`` ставится здесь, но проверяет его вызывающий
    (``insert_step`` — один раз на процесс).
    """
    global _INGESTED
    from app.services import journal  # локально — см. докстринг

    inserted = 0
    for entry in journal.iter_entries(cfg):
        cursor = conn.execute(_INSERT_SQL, _values(_normalize(entry, None)))
        inserted += max(0, cursor.rowcount)
    _INGESTED = True
    if inserted:
        logger.info("Аналитическая база дочитала наследие журнала: %d строк", inserted)
    return inserted

