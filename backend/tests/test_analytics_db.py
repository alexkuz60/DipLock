"""Тесты аналитической проекции журнала (4.3): запись, импорт, запросы.

Фиксируются ровно свойства, которые нельзя потерять: ``record`` дублирует
строку в базу, JSONL-формат не меняется (``recording_id`` — только здесь),
импорт наследия идемпотентен, агрегаты считает SQLite (медиана/суммы/топ),
и сбой базы не ломает расчёт — как у журнала (п.4 правил данных).
"""
import json
import os
import sqlite3
from pathlib import Path

import pytest

from app.core.config import settings
from app.services import analytics_db, journal


@pytest.fixture(autouse=True)
def clean():
    """База и журнал пусты между тестами; флаг наследия сбрасывается."""
    journal.clear_journal()
    analytics_db.clear_analytics()
    yield
    journal.clear_journal()
    analytics_db.clear_analytics()


def _rows() -> list[dict]:
    """Строки ``steps`` прямым SQL: тест проверяет схему, а не обёртку."""
    with sqlite3.connect(analytics_db.analytics_path()) as conn:
        conn.row_factory = sqlite3.Row
        return [dict(row) for row in conn.execute("SELECT * FROM steps")]


def _write_jsonl(lines: list[dict], *, rotated: bool = False) -> None:
    """Пишет строки в файл журнала (текущее поколение или ротированное)."""
    path = journal.journal_path()
    if rotated:
        path = f"{path}.1"
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "a", encoding="utf-8") as fh:
        for line in lines:
            fh.write(json.dumps(line, ensure_ascii=False) + "\n")


def _raw(ts: str, pipeline: str, step: str, ms: float, **extra) -> dict:
    """Сырая строка формата `docs/data_map.md` §9 для написания в файл."""
    return {
        "ts": ts, "job_id": "-", "pipeline": pipeline, "step": step,
        "params_key": "-", "bytes_in": None, "bytes_out": None, "ms": ms,
        "cache_hit": "-", "epochs": None, "note": "", **extra,
    }


# ---------- запись из record ----------


def test_record_duplicates_line_into_analytics():
    """``record`` пишет строку и в файл, и в базу (прочерки нормализованы)."""
    journal.record("spectrum", "psd", ms=10.0, cache_hit=True, epochs=4)

    (row,) = _rows()

    assert (row["pipeline"], row["step"]) == ("spectrum", "psd")
    assert row["ms"] == 10.0
    assert row["cache_hit"] == 1
    assert row["epochs"] == 4
    assert row["job_id"] == "-" and row["recording_id"] == "-"
    # Строка действительно продублирована: jsonl и база живут разом
    assert journal.read_journal(limit=1)


def test_jsonl_format_is_unchanged():
    """Формат JSONL не изменился: recording_id в файл не попадает (4.3)."""
    journal.record("spectrum", "psd", ms=1.0)

    (line,) = [
        json.loads(raw) for raw in
        Path(journal.journal_path()).read_text(encoding="utf-8").splitlines() if raw.strip()
    ]

    assert list(line) == [
        "ts", "job_id", "pipeline", "step", "params_key", "bytes_in", "bytes_out",
        "ms", "cache_hit", "epochs", "note",
    ]
    assert "recording_id" not in line


def test_ingest_is_idempotent_after_record():
    """Импорт уже вставленных строк не создаёт дублей (line_key по содержимому)."""
    journal.record("spectrum", "psd", ms=10.0)

    assert analytics_db.ingest_journal() == 0
    assert len(_rows()) == 1


def test_journal_disabled_writes_nowhere(monkeypatch):
    """``JOURNAL_ENABLED=false`` выключает и проекцию: она — проекция журнала."""
    monkeypatch.setattr(settings, "journal_enabled", False)
    journal.record("spectrum", "psd", ms=10.0)

    assert not os.path.exists(journal.journal_path())
    assert analytics_db.step_stats()["count"] == 0


def test_broken_path_does_not_break_record(tmp_path, monkeypatch):
    """Сбой базы гасится: ``record`` не бросает, строка в журнале остаётся."""
    blocker = tmp_path / "blocker"
    blocker.write_text("файл, а не каталог", encoding="utf-8")
    monkeypatch.setattr(settings, "analytics_db_path", str(blocker / "analytics.db"))

    journal.record("spectrum", "psd", ms=10.0)   # не должно упасть

    assert journal.read_journal(limit=1)


# ---------- импорт наследия ----------


def test_ingest_reads_both_generations_without_duplicates():
    """Насилие дочитывается из обоих поколений; повторный импорт — без прироста."""
    _write_jsonl(
        [_raw("2026-10-01T10:00:00.000", "spectrum", "psd", 1.0)],
        rotated=True,
    )
    _write_jsonl(
        [
            _raw("2026-10-02T10:00:00.000", "dipoles", "grid_scan", 2.0),
            "не json — битая строка пропускается",
        ],
    )

    assert analytics_db.ingest_journal() == 2
    assert analytics_db.ingest_journal() == 0
    assert {row["step"] for row in _rows()} == {"psd", "grid_scan"}


def test_ingest_normalizes_dash_forms_to_one_key():
    """Прочерк в обеих формах (``'-'`` и ``None``) — один ``line_key``: не задвоится."""
    _write_jsonl([_raw("2026-10-01T10:00:00.000", "spectrum", "psd", 1.0)])
    # Та же строка, но «нулевая» форма, как её отдаёт journal._parse
    parsed = journal._parse(json.dumps(_raw(
        "2026-10-01T10:00:00.000", "spectrum", "psd", 1.0,
    )).encode())

    analytics_db.ingest_journal()
    analytics_db.insert_step(parsed)

    assert len(_rows()) == 1

# ---------- запросы: один SQL ----------


def test_step_stats_sum_median_and_filters():
    """Суммы/медиана считаются SQLite: чётная выборка — среднее двух центральных."""
    journal.record("spectrum", "psd", ms=10.0)
    journal.record("spectrum", "psd", ms=20.0)
    journal.record("dipoles", "grid_scan", ms=100.0)

    all_stats = analytics_db.step_stats()
    psd_stats = analytics_db.step_stats(pipeline="spectrum", step="psd")

    assert all_stats["count"] == 3
    assert all_stats["sum_ms"] == 130.0
    assert all_stats["median_ms"] == 20.0          # [10, 20, 100] → центральный
    assert all_stats["min_ms"] == 10.0 and all_stats["max_ms"] == 100.0
    assert psd_stats["count"] == 2
    assert psd_stats["sum_ms"] == 30.0
    assert psd_stats["median_ms"] == 15.0          # (10 + 20) / 2 — чётное число
    assert psd_stats["max_ms"] == 20.0


def test_step_stats_empty_selection_is_null():
    """Пустая выборка — count 0 и null величин («неизмеренное — null»)."""
    stats = analytics_db.step_stats(pipeline="нет-такого")

    assert stats["count"] == 0
    assert stats["sum_ms"] is None and stats["median_ms"] is None


def test_top_steps_ordered_by_total_ms():
    """Топ отвечает «где уходит время»: сумма по (pipeline, step) по убыванию."""
    journal.record("dipoles", "grid_scan", ms=100.0)
    journal.record("spectrum", "psd", ms=30.0)
    journal.record("spectrum", "psd", ms=20.0)

    top = analytics_db.top_steps(5)

    assert [(row["pipeline"], row["step"]) for row in top] == [
        ("dipoles", "grid_scan"), ("spectrum", "psd"),
    ]
    assert top[1]["count"] == 2 and top[1]["sum_ms"] == 50.0


def test_cache_ratio_counts_hits_misses_and_untracked():
    """Доля попаданий: кэшируемые true/false и не-кэшируемые считаются отдельно."""
    journal.record("spectrum", "load_edf", ms=1.0, cache_hit=True)
    journal.record("spectrum", "load_edf", ms=2.0, cache_hit=False)
    journal.record("spectrum", "psd", ms=3.0)      # cache_hit=None — untracked

    ratio = analytics_db.cache_ratio(pipeline="spectrum")
    psd_ratio = analytics_db.cache_ratio(step="psd")

    assert (ratio["hits"], ratio["misses"], ratio["untracked"]) == (1, 1, 1)
    assert ratio["hit_share"] == 0.5
    # у шага без кэшируемых истин доля неизмерима — null, а не 0
    assert psd_ratio["hit_share"] is None


def test_recording_summary_answers_what_is_computed():
    """Вопрос «что посчитано по этой записи» — группировка по пайплайнам."""
    with journal.job_scope("job-1", recording_id="rec-9"):
        journal.record("preprocess", "filter", ms=5.0)
        journal.record("preprocess", "epochs", ms=7.0)
    with journal.job_scope("job-2", recording_id="rec-other"):
        journal.record("spectrum", "psd", ms=50.0)

    summary = analytics_db.recording_summary("rec-9")

    assert [(row["pipeline"], row["count"], row["sum_ms"]) for row in summary] == [
        ("preprocess", 2, 12.0),
    ]
    assert analytics_db.recording_summary("rec-unknown") == []


def test_recording_id_reaches_base_but_not_jsonl():
    """recording_id живёт только в базе: у jsonl его поля нет (страж формата)."""
    with journal.job_scope("job-1", recording_id="rec-9"):
        journal.record("preprocess", "filter", ms=5.0)

    (row,) = _rows()
    line = json.loads(Path(journal.journal_path()).read_text(encoding="utf-8").strip())

    assert row["recording_id"] == "rec-9" and row["job_id"] == "job-1"
    assert "recording_id" not in line


def test_schema_version_is_recorded():
    """Схема версионируется: PRAGMA user_version = SCHEMA_VERSION после открытия."""
    analytics_db.step_stats()  # любое чтение поднимает схему

    with sqlite3.connect(analytics_db.analytics_path()) as conn:
        version = conn.execute("PRAGMA user_version").fetchone()[0]

    assert version == analytics_db.SCHEMA_VERSION

