"""Контракт служебных роутов управления сервером (перезапуск из UI)."""
from pydantic import BaseModel, Field


class ServerRestartOut(BaseModel):
    """202-ответ POST /api/v1/server/restart: процесс перезапустится после ответа."""

    restarting: bool = Field(description="Всегда true: exec запланирован после 202")
    restart_after_sec: float = Field(
        description="Пауза перед заменой процесса — UI столько ждёт до начала опроса",
    )
    server_started_at: str = Field(
        description=(
            "Старт текущего процесса (ISO): UI сравнивает с ним `code.server_started_at` "
            "из /init-status и считает перезапуск завершённым, когда значения разошлись"
        ),
    )
