"""RAM-состояние стриминга ответов раунда (срез 0011).

Частичный текст ответа — **не результат**: готовые тексты пишутся в БД до
объявления успеха задачи (§8 `docs/rules/consilium.md`), в файл задачи они не
попадают, поэтому и стрим живёт только в памяти процесса. Перезапуск бэкенда
теряет частичный текст — клиент честно возвращается к поллингу раунда и
дочитывает готовые ответы из БД.

Каждое событие попадает в журнал ``RoundProgress.log`` — подписчик SSE
дочитывает журнал по мере роста и не пропускает дельты между тиками.
"""

import asyncio
from dataclasses import dataclass, field

from app.schemas.consilium import ConsiliumStreamEvent, StreamRoleStatus


@dataclass
class RoleProgress:
    """Состояние одной роли в текущем запуске раунда."""

    role: str
    status: StreamRoleStatus = "waiting"
    text: str = ""
    model: str | None = None
    error: str | None = None


@dataclass
class RoundProgress:
    """Журнал событий раунда и будильник для SSE-подписчиков."""

    round_id: str
    roles: dict[str, RoleProgress] = field(default_factory=dict)
    log: list[ConsiliumStreamEvent] = field(default_factory=list)
    finished: bool = False
    error: str | None = None
    changed: asyncio.Event = field(default_factory=asyncio.Event)

    def _emit(self, event: ConsiliumStreamEvent) -> None:
        self.log.append(event)
        self.changed.set()

    def role_started(self, role: str) -> None:
        """Роль начала запрос к внешней модели."""
        entry = self.roles.setdefault(role, RoleProgress(role=role))
        entry.status = "streaming"
        self._emit(ConsiliumStreamEvent(type="role_started", role=role, status="streaming"))

    def append_delta(self, role: str, delta: str) -> None:
        """Кусочек текста роли по мере генерации (без обрезки краёв)."""
        entry = self.roles.setdefault(role, RoleProgress(role=role))
        entry.status = "streaming"
        entry.text += delta
        self._emit(ConsiliumStreamEvent(type="delta", role=role, delta=delta))

    def role_finished(
        self, role: str, *, status: StreamRoleStatus,
        model: str | None = None, error: str | None = None,
    ) -> None:
        """Роль получила ответ (done) или честный отказ (failed)."""
        entry = self.roles.setdefault(role, RoleProgress(role=role))
        entry.status = status
        entry.model = model
        entry.error = error
        self._emit(ConsiliumStreamEvent(
            type="role_done", role=role, status=status, model=model, error=error,
        ))

    def finish(self, error: str | None = None) -> None:
        """Запуск завершён: подписчики дочитывают журнал и получают round_done."""
        self.finished = True
        self.error = error
        self.changed.set()


_ROUNDS: dict[str, RoundProgress] = {}


def open_round(round_id: str, roles: tuple[str, ...]) -> RoundProgress:
    """Открыть поток запуска; прежний запуск того же раунда (повтор ответа)
    закрывается — его подписчики получают честный ``round_done``."""
    previous = _ROUNDS.get(round_id)
    if previous is not None:
        previous.finish("Запущен новый запрос по этому раунду")
    progress = RoundProgress(
        round_id=round_id,
        roles={role: RoleProgress(role=role) for role in roles},
    )
    _ROUNDS[round_id] = progress
    return progress


def get_round(round_id: str) -> RoundProgress | None:
    """Текущий поток раунда (``None`` — запуск уже завершён или перезапущен)."""
    return _ROUNDS.get(round_id)


def close_round(round_id: str, error: str | None = None) -> None:
    """Закрыть поток: подписчики получают ``round_done``, состояние уходит из RAM."""
    progress = _ROUNDS.pop(round_id, None)
    if progress is not None:
        progress.finish(error)