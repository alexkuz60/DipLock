"""Тесты журнала шагов (A5, этап 5): формат строки, привязка задачи, чтение.

Журнал — диагностика, а не часть контракта, поэтому здесь фиксируются ровно те
свойства, которые нельзя потерять при рефакторинге: строка появляется на шаг
(включая упавший), сбой записи не ломает расчёт, ``job_id`` доезжает до сервисов
из ``job_manager`` без параметров, а чтение переживает битые строки и ротацию.
Сквозная проверка одна: шаги задачи спектрограммы действительно оказываются в
журнале с её ``job_id``.
"""
import json
import os
import time

import pytest

from app.core.config import settings
from app.services import journal
from app.services.prepared_signal import clear_prepared_cache, prepared_raw
from app.services.recordings import Recording
from tests.test_spectrogram import _register, _tone_edf, _wait_finished

_PREFIX = "/api/v1"


@pytest.fixture(autouse=True)
def clean_journal():
    """Журнал между тестами пуст: строки не должны перетекать."""
    journal.clear_journal()
    yield
    journal.clear_journal()


def _raw_lines() -> list:
    """Строки файла журнала как есть (в файле прочерк — «-», а не ``null``)."""
    path = journal.journal_path()
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as fh:
        return [json.loads(line) for line in fh if line.strip()]


# ---------- формат строки ----------

def test_step_writes_line_with_all_fields():
    """Один шаг — одна строка со всеми полями формата `docs/data_map.md` §9."""
    with journal.step(
        "spectrum", "psd", params_key="sig-1", epochs=4, note="n_fft=256",
    ) as entry:
        entry.bytes_out = 1234

    (line,) = _raw_lines()

    assert list(line) == [
        "ts", "job_id", "pipeline", "step", "params_key", "bytes_in", "bytes_out",
        "ms", "cache_hit", "epochs", "note",
    ]
    assert line["job_id"] == "-"            # синхронный вызов — без задачи
    assert (line["pipeline"], line["step"]) == ("spectrum", "psd")
    assert line["params_key"] == "sig-1"
    assert line["bytes_out"] == 1234
    assert line["cache_hit"] == "-"         # шаг не кэшируется
    assert line["epochs"] == 4
    assert line["note"] == "n_fft=256"
    assert line["ms"] >= 0
    # ts — ISO-8601 с миллисекундами (цифры после точки считаются, а не «примерно»)
    assert len(line["ts"].split(".")[-1]) == 3


def test_read_journal_turns_dashes_into_null():
    """В ответе прочерк — ``null``: правило «неизмеренное — null» (api-jobs п.5)."""
    journal.record("signals", "cache_read", ms=3.0, cache_hit=True, bytes_out=10)

    (entry,) = journal.read_journal()

    assert entry["job_id"] is None
    assert entry["params_key"] is None
    assert entry["cache_hit"] is True
    assert entry["bytes_out"] == 10


def test_step_records_error_and_reraises():
    """Упавший шаг тоже виден в журнале: «почему упало» ищут не только по логу."""
    with pytest.raises(ValueError), journal.step("dipoles", "grid_scan", note="grid=7mm"):
        raise ValueError("нет эпох")

    (line,) = _raw_lines()

    assert line["step"] == "grid_scan"
    assert "error=ValueError" in line["note"]
    assert line["note"].startswith("grid=7mm")   # свой контекст шага не потерян


def test_job_scope_marks_steps_and_restores_context():
    """``job_id`` приходит из задачи; вне задачи снова прочерк (без утечки)."""
    with journal.job_scope("job-7"):
        journal.record("spectrum", "psd", ms=1.0)
        assert journal.current_job_id() == "job-7"

    journal.record("spectrum", "psd", ms=1.0)

    assert [line["job_id"] for line in _raw_lines()] == ["job-7", "-"]


# ---------- надёжность: выключение, сбой записи, битые строки ----------

def test_disabled_journal_writes_nothing(monkeypatch):
    """``JOURNAL_ENABLED=false`` — ни файла, ни строк: журнал можно выключить."""
    monkeypatch.setattr(settings, "journal_enabled", False)

    journal.record("signals", "build_level", ms=1.0)

    assert _raw_lines() == []
    assert journal.read_journal() == []


def test_write_failure_is_reported_not_raised(tmp_path, monkeypatch, caplog):
    """Сбой записи журнала не ломает расчёт (как у кэшей): warning и пустой хвост."""
    blocker = tmp_path / "not-a-dir"
    blocker.write_text("x")
    monkeypatch.setattr(journal, "journal_path", lambda cfg=None: str(blocker / "journal.jsonl"))

    with caplog.at_level("WARNING"):
        journal.record("demo", "step", ms=1.0)

    assert "Журнал шагов не записан" in caplog.text
    assert journal.read_journal() == []


def test_broken_and_foreign_lines_are_skipped():
    """Битые строки и строки чужого формата не роняют чтение журнала."""
    journal.record("signals", "build_level", ms=1.0)
    with open(journal.journal_path(), "a", encoding="utf-8") as fh:
        fh.write("не json\n")
        fh.write(json.dumps({"ts": "x"}) + "\n")                       # нет pipeline/step
        fh.write(json.dumps({"pipeline": "spectrum", "step": "psd"}) + "\n")

    entries = journal.read_journal()

    assert [entry["step"] for entry in entries] == ["build_level", "psd"]

# ---------- ротация и чтение хвоста ----------

def test_rotation_keeps_two_generations(monkeypatch):
    """Ротация по размеру: старое поколение уезжает в ``.1``, диск не растёт."""
    monkeypatch.setattr(settings, "journal_max_bytes", 300)
    for index in range(12):
        journal.record("signals", "build_level", ms=float(index), note="x" * 40)

    path = journal.journal_path()
    assert os.path.exists(f"{path}.1")
    # Текущий файл не больше лимита плюс одна строка (ротация идёт «перед записью»)
    assert os.path.getsize(path) < 300 + 400

    entries = journal.read_journal(limit=1000)

    assert entries, "журнал пуст: строки не пишутся"
    # История ограничена двумя поколениями: это диагностика, а не архив
    assert len(entries) < 12
    assert entries[-1]["ms"] == 11.0


def test_read_journal_filters_by_pipeline_and_limits():
    """Фильтр по пайплайну и ``limit`` — про хвост, а не про всю историю."""
    for index in range(5):
        journal.record("signals", "build_level", ms=float(index))
        journal.record("spectrum", "psd", ms=float(index))

    spectrum = journal.read_journal(pipeline="spectrum")

    assert [entry["ms"] for entry in spectrum] == [0.0, 1.0, 2.0, 3.0, 4.0]
    assert [entry["ms"] for entry in journal.read_journal(limit=2)] == [4.0, 4.0]


# ---------- шаги продакшен-пайплайнов ----------

def test_prepared_signal_reports_cache_hit(edf_file):
    """Холодное чтение EDF и попадание в кэш — две строки с разным ``cache_hit``."""
    clear_prepared_cache()
    recording = Recording(
        recording_id="journal-rec",
        filename="probe.edf",
        path=str(edf_file),
        upload_dir=str(edf_file.parent),
        created_at=time.time(),
        meta={"sfreq": 250.0, "duration_sec": 4.0},
    )

    prepared_raw(recording, settings, pipeline="spectrum")
    prepared_raw(recording, settings, pipeline="spectrum")
    clear_prepared_cache()

    loads = [line for line in _raw_lines() if line["step"] == "load_edf"]

    assert [line["cache_hit"] for line in loads] == [False, True]
    assert loads[0]["bytes_in"] == os.path.getsize(str(edf_file))
    assert loads[1]["bytes_in"] is None
    # Одна сигнатура у двух задач — значит, они делили один подготовленный сигнал
    assert loads[0]["params_key"] == loads[1]["params_key"]
    assert loads[0]["params_key"]


def test_spectrogram_job_steps_carry_job_id(client, tmp_path):
    """Сквозная проверка: шаги задачи видны в ``GET /journal`` с её ``job_id``."""
    recording = _register(tmp_path, _tone_edf(tmp_path))

    created = client.post(
        f"{_PREFIX}/recordings/{recording.recording_id}/spectrogram",
        data={"channel": "Fp1", "band_min": 1, "band_max": 40, "window_ms": 500},
    )
    assert created.status_code == 202, created.text
    job_id = created.json()["job_id"]
    assert _wait_finished(client, job_id)["status"] == "succeeded"

    response = client.get(f"{_PREFIX}/journal", params={"pipeline": "spectrogram"})
    assert response.status_code == 200, response.text
    payload = response.json()

    assert payload["enabled"] is True
    assert payload["journal_path"] == journal.journal_path()
    steps = [entry["step"] for entry in payload["entries"]]
    assert "load_edf" in steps and "stft" in steps and "grid_write" in steps
    # Контекст задачи доехал до потока воркера (все строки помечены её job_id)
    assert {entry["job_id"] for entry in payload["entries"]} == {job_id}

    stft = next(entry for entry in payload["entries"] if entry["step"] == "stft")
    assert stft["epochs"] and stft["epochs"] > 0
    assert stft["ms"] >= 0
    assert stft["note"].startswith("channel=Fp1")


def test_journal_route_returns_empty_and_validates_limit(client):
    """Пустой хвост — пустой список (не 404), а ``limit`` проверяется схемой."""
    empty = client.get(f"{_PREFIX}/journal", params={"pipeline": "нет-такого"})

    assert empty.status_code == 200, empty.text
    assert empty.json()["entries"] == []
    assert client.get(f"{_PREFIX}/journal", params={"limit": 0}).status_code == 422

