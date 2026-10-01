"""Перезапуск процесса сервера из UI (POST /server/restart).

Контекст: рабочий режим (`start.sh`, ярлык) держит uvicorn **без** ``--reload``,
поэтому правки backend видны только после перезапуска — симптом
``init-status.code.stale=true`` (случай 24.09.2026). Раньше лечилось только
руками (``./start.sh stop && ./start.sh``); теперь кнопкой «Перезапустить
бэкенд» в разделе «Состояние сервера».

Как это работает: ответ 202 уходит клиенту, через ``RESTART_DELAY_SEC``
(даём сокету освободиться) выполняется ``os.execv`` — образ процесса
**заменяется** свежим python с теми же аргументами командной строки. PID
процесса не меняется, поэтому ``data/logs/server.pid`` остаётся валидным:
``./start.sh stop|status`` продолжают работать. История задач и результаты
стадий переживают перезапуск (``job_store`` + ``JobManager.restore``, A8),
реестр записей восстанавливается из sidecar-файлов.

Безопасность (всё в ``can_restart`` и проверке активных задач):

* перезапуск разрешён **только** когда PID-файл лаунчера содержит наш PID —
  иначе (dev-цикл, Docker, чужой процесс) 409 с текстом для UI;
* ``--reload`` (dev) — 409: там перезапуск не нужен, watcher справится сам;
* активные задачи (``queued``/``running``) — 409: exec оборвёт расчёт.
"""
import asyncio
import os
import sys
from pathlib import Path

from app.core.config import Settings, settings
from app.services.job_manager import Job, job_manager

# Пауза перед exec: 202-ответ должен уйти клиенту и освободить сокет,
# иначе браузер увидит обрыв соединения вместо ответа.
RESTART_DELAY_SEC = 0.5


def launcher_pid(cfg: Settings | None = None) -> int | None:
    """PID из файла лаунчера, либо None (файла нет / содержимое битое)."""
    cfg = cfg or settings
    try:
        raw = Path(cfg.server_pid_file).read_text(encoding="ascii").strip()
    except (OSError, UnicodeError):
        return None
    try:
        return int(raw)
    except ValueError:
        return None


def can_restart(cfg: Settings | None = None) -> tuple[bool, str]:
    """Можно ли перезапустить процесс изнутри: (да, причина отказа).

    Причина — готовый текст для UI (409 без выдумок на клиенте).
    """
    if "--reload" in sys.argv:
        return False, (
            "Сервер запущен в dev-режиме с --reload — перезапуск из UI не нужен: "
            "правки подхватываются автоматически"
        )
    cfg = cfg or settings
    pid = launcher_pid(cfg)
    if pid is None:
        return False, (
            "PID-файл лаунчера не найден — сервер запущен не через ./start.sh, "
            "перезапустите его тем способом, каким запускали"
        )
    if pid != os.getpid():
        return False, (
            f"PID-файл лаунчера ({pid}) не совпадает с текущим процессом "
            f"({os.getpid()}) — сервер запущен не лаунчером, перезапустите его вручную"
        )
    return True, ""


def active_jobs() -> list[Job]:
    """Задачи, которые оборвёт exec: статусы ``queued``/``running``."""
    return [job for job in job_manager.list_jobs() if job.status in ("queued", "running")]


def exec_process() -> None:
    """Заменяет образ процесса свежим запуском тех же аргументов (не возвращается).

    ``sys.executable + sys.argv`` воспроизводит исходную команду: и
    ``venv/bin/uvicorn app.main:app …``, и ``python -m uvicorn app.main:app …``
    дают ``argv[0]`` — путь к python-скрипту, который python запустит как файл.
    """
    os.execv(sys.executable, [sys.executable, *sys.argv])  # noqa: S606 — замена образа процесса, задумано


async def restart_soon(delay_sec: float | None = None) -> None:
    """Ждёт ``delay_sec`` (чтобы 202-ответ дошёл) и делает exec.

    ``delay_sec=None`` — значение ``RESTART_DELAY_SEC`` читается в момент
    вызова, чтобы тест мог подменить константу. Вызывается Starlette как
    фоновая задача **после** отправки ответа (``BackgroundTasks`` в роуте).
    """
    delay = RESTART_DELAY_SEC if delay_sec is None else delay_sec
    await asyncio.sleep(delay)
    exec_process()
