"""Тесты перезапуска сервера из UI (POST /api/v1/server/restart).

exec в тестах никогда не выполняется: ``server_control.exec_process``
подменяется на запись вызова, константа задержки — на 0.
"""
import os

import pytest

from app.services import server_control


@pytest.fixture
def pid_file(tmp_path, monkeypatch):
    """PID-файл лаунчера, указывающий на текущий (тестовый) процесс."""
    path = tmp_path / "server.pid"
    monkeypatch.setattr(server_control.settings, "server_pid_file", str(path))
    return path


def _write_pid(path, pid: int) -> None:
    _write_pid_text(path, str(pid))


def _write_pid_text(path, text: str) -> None:
    # utf-8, а не ascii: битый PID-файл — любое мусорное содержимое
    path.write_text(text, encoding="utf-8")


# ---------- can_restart: guard'ы до exec ----------

def test_can_restart_false_without_pid_file(tmp_path, monkeypatch):
    monkeypatch.setattr(server_control.settings, "server_pid_file", str(tmp_path / "нет.txt"))
    allowed, reason = server_control.can_restart()
    assert allowed is False
    assert "PID-файл" in reason


def test_can_restart_false_for_foreign_pid(pid_file):
    _write_pid(pid_file, os.getpid() + 1)
    allowed, reason = server_control.can_restart()
    assert allowed is False
    assert "не совпадает" in reason


def test_can_restart_false_with_reload_flag(monkeypatch, pid_file):
    """Dev-режим --reload: перезапуск из UI не нужен (watcher сам справится)."""
    _write_pid(pid_file, os.getpid())
    monkeypatch.setattr(server_control.sys, "argv", ["uvicorn", "app.main:app", "--reload"])
    allowed, reason = server_control.can_restart()
    assert allowed is False
    assert "--reload" in reason


def test_can_restart_true_for_launcher_process(pid_file):
    _write_pid(pid_file, os.getpid())
    allowed, reason = server_control.can_restart()
    assert allowed is True
    assert reason == ""


def test_can_restart_false_for_broken_pid_file(pid_file):
    """Битый PID-файл (не число) — отказ, а не необработанный ValueError."""
    _write_pid_text(pid_file, "не-число")
    allowed, _ = server_control.can_restart()
    assert allowed is False


def test_active_jobs_empty_by_default():
    server_control.job_manager.clear()
    assert server_control.active_jobs() == []


# ---------- роут: коды и контракт ----------

def test_restart_rejected_without_launcher(client, monkeypatch, tmp_path):
    """PID-файл по умолчанию не наш (тест-процесс) → 409 с текстом для UI."""
    monkeypatch.setattr(server_control.settings, "server_pid_file", str(tmp_path / "нет.pid"))
    r = client.post("/api/v1/server/restart")
    assert r.status_code == 409
    assert "PID-файл" in r.json()["detail"]


def test_restart_schedules_exec_and_answers_202(client, pid_file, monkeypatch):
    """202 до перезапуска: exec подменён, задержка 0 — ответ и фон успели отработать."""
    _write_pid(pid_file, os.getpid())
    calls: list[tuple[str, list[str]]] = []
    monkeypatch.setattr(server_control, "RESTART_DELAY_SEC", 0.0)
    monkeypatch.setattr(server_control, "exec_process", lambda: calls.append(("exec", [])))

    r = client.post("/api/v1/server/restart")
    assert r.status_code == 202
    body = r.json()
    assert body["restarting"] is True
    assert body["server_started_at"]  # метка для контроля смены процесса
    assert len(calls) == 1  # фоновая задача выполнилась после ответа


def test_restart_blocked_by_active_job(client, pid_file, monkeypatch):
    """Активная задача — 409: exec оборвал бы расчёт."""
    _write_pid(pid_file, os.getpid())
    job = server_control.job_manager.create(kind="report", filename="x.edf")
    try:
        r = client.post("/api/v1/server/restart")
        assert r.status_code == 409
        assert "Идут задачи" in r.json()["detail"]
        assert job.kind in r.json()["detail"]
    finally:
        server_control.job_manager.clear()
