"""Менеджер фоновых задач (F7): этапы, прогресс, ограничение параллелизма.

Один долгий HTTP-запрос = весь пайплайн — модель, которая не переживает UI:
нет прогресса, при обрыве соединения результат теряется, параллельность не
ограничена. Здесь задача живёт на сервере:

* ``submit()`` создаёт задачу и возвращает её сразу (HTTP 202 + ``job_id``);
* исполнение — в потоке (``asyncio.to_thread``), event-loop не блокируется;
* ``asyncio.Semaphore`` ограничивает число одновременных тяжёлых расчётов;
* воркер сообщает этап и прогресс колбэком — UI рисует прогресс-бар по этапам.

Хранилище — in-memory (история ограничена ``jobs_history_limit``): для локального
десктопного режима этого достаточно, результат задачи дополнительно пишется в
``results_dir`` и в БД.
"""
import asyncio
import logging
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Callable, Dict, List, Optional, Set

from app.core.config import settings

logger = logging.getLogger(__name__)

# Колбэк прогресса: cb(stage, progress=None, message="")
ProgressCallback = Callable[..., None]

# Этапы пайплайна анализа и их «целевой» прогресс (для UI-прогресс-бара)
PIPELINE_STAGES: Dict[str, float] = {
    "queued": 0.0,
    "load_edf": 0.10,
    "artifacts": 0.30,
    "filter": 0.40,
    "epochs": 0.50,
    "band_power": 0.58,
    "dipoles": 0.90,
    "localize": 0.97,
    "done": 1.0,
}

# Человекочитаемые подписи этапов (русский UI)
STAGE_TITLES: Dict[str, str] = {
    "queued": "В очереди",
    "load_edf": "Чтение EDF",
    "artifacts": "Детекция артефактов",
    "filter": "Частотная фильтрация",
    "epochs": "Нарезка эпох",
    "band_power": "Спектральная мощность",
    "dipoles": "Фитинг диполей",
    "localize": "Локализация (анатомия + Brodmann)",
    # Быстрый расчёт (срез 3.4): спектр по диапазонам и перебор сетки без BEM
    "spectrum": "Спектр (Welch PSD)",
    "topomaps": "Топокарты диапазонов",
    "scan": "Поиск диполей по сетке",
    "done": "Готово",
}


@dataclass
class Job:
    """Состояние одной фоновой задачи."""

    job_id: str
    kind: str
    filename: Optional[str] = None
    status: str = "queued"  # queued | running | succeeded | failed
    stage: str = "queued"
    progress: float = 0.0
    message: str = ""
    created_at: datetime = field(default_factory=datetime.utcnow)
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None
    error: Optional[str] = None
    session_id: Optional[str] = None
    result: Optional[Dict[str, Any]] = None
    meta: Dict[str, Any] = field(default_factory=dict)
    # Детальный прогресс этапов с эпохами (срез 3.4): «12 из 30 эпох» читается
    # лучше, чем плавающая дробь 0.42 — UI рисует по ним прогресс-бар задачи.
    epochs_done: int = 0
    epochs_total: int = 0
    task: Optional[asyncio.Task] = field(default=None, repr=False)

    def mark_started(self) -> None:
        """Переводит задачу в ``running`` (слот семафора получен)."""
        self.status = "running"
        self.started_at = datetime.utcnow()
        self.set_progress("load_edf", message="Чтение EDF и монтаж 10-20")

    def set_progress(
        self,
        stage: str,
        progress: Optional[float] = None,
        message: str = "",
        epochs_done: Optional[int] = None,
        epochs_total: Optional[int] = None,
    ) -> None:
        """Обновляет этап/прогресс. Вызывается из воркер-потока (атомарно по GIL).

        ``epochs_done``/``epochs_total`` — необязательный детальный счётчик эпох:
        воркеры с пакетной обработкой (спектр, перебор сетки) сообщают его, чтобы
        UI показывал прогресс по эпохам, а не только по этапам.
        """
        self.stage = stage
        if epochs_total is not None:
            self.epochs_total = max(0, int(epochs_total))
        if epochs_done is not None:
            self.epochs_done = max(0, int(epochs_done))
        if progress is not None:
            self.progress = max(0.0, min(1.0, float(progress)))
        elif stage in PIPELINE_STAGES:
            self.progress = PIPELINE_STAGES[stage]
        if message:
            self.message = message
        elif stage in STAGE_TITLES:
            self.message = STAGE_TITLES[stage]

    def progress_cb(self) -> ProgressCallback:
        """Колбэк для воркера: ``cb(stage, progress=None, message="", epochs_done=…, epochs_total=…)``."""

        def _cb(
            stage: str,
            progress: Optional[float] = None,
            message: str = "",
            epochs_done: Optional[int] = None,
            epochs_total: Optional[int] = None,
        ) -> None:
            self.set_progress(stage, progress, message, epochs_done, epochs_total)

        return _cb

    def finish(self, result: Dict[str, Any]) -> None:
        """Успешное завершение: фиксируем результат и прогресс 1.0."""
        self.result = result
        self.session_id = result.get("session_id")
        self.status = "succeeded"
        self.finished_at = datetime.utcnow()
        self.set_progress("done", 1.0, message="Готово")

    def fail(self, error: BaseException) -> None:
        """Провал задачи: сохраняем текст ошибки для UI."""
        self.status = "failed"
        self.error = str(error)
        self.finished_at = datetime.utcnow()
        self.message = f"Ошибка: {error}"

    @property
    def elapsed_sec(self) -> Optional[float]:
        """Длительность выполнения в секундах (None, если ещё не начиналась)."""
        if self.started_at is None:
            return None
        end = self.finished_at or datetime.utcnow()
        return round((end - self.started_at).total_seconds(), 3)

    def as_dict(self) -> Dict[str, Any]:
        """Примитивы для сериализации в ``JobStatus`` (без result — он тяжёлый)."""
        return {
            "job_id": self.job_id,
            "kind": self.kind,
            "status": self.status,
            "stage": self.stage,
            "progress": self.progress,
            "message": self.message,
            "epochs_done": self.epochs_done,
            "epochs_total": self.epochs_total,
            "filename": self.filename,
            "session_id": self.session_id,
            "created_at": self.created_at,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "elapsed_sec": self.elapsed_sec,
            "error": self.error,
        }


class JobManager:
    """Реестр задач с ограничением параллелизма и историей."""

    def __init__(self, max_concurrent: int = 2, history_limit: int = 50) -> None:
        self._max_concurrent = max(1, int(max_concurrent))
        self._history_limit = max(1, int(history_limit))
        self._semaphore = asyncio.Semaphore(self._max_concurrent)
        self._jobs: Dict[str, Job] = {}
        self._order: List[str] = []
        self._tasks: Set[asyncio.Task] = set()

    @property
    def max_concurrent(self) -> int:
        """Сколько тяжёлых расчётов может идти одновременно."""
        return self._max_concurrent

    def create(self, kind: str, filename: Optional[str] = None, **meta: Any) -> Job:
        """Регистрирует задачу в состоянии ``queued``."""
        job = Job(job_id=str(uuid.uuid4()), kind=kind, filename=filename, meta=dict(meta))
        self._jobs[job.job_id] = job
        self._order.append(job.job_id)
        self._trim_history()
        return job

    def submit(
        self,
        kind: str,
        filename: Optional[str],
        fn: Callable,
        *args: Any,
        on_success: Optional[Callable[..., Any]] = None,
        **kwargs: Any,
    ) -> Job:
        """Создаёт задачу и запускает её фоном; возвращает сразу (для HTTP 202).

        ``fn`` вызывается как ``fn(progress_cb, *args, **kwargs)`` в потоке.
        ``on_success(job, result)`` — async-колбэк, выполняется в event-loop
        после успеха (например, запись результата в БД).
        """
        meta = kwargs.pop("meta", None) or {}
        job = self.create(kind, filename, **meta)
        task = asyncio.create_task(self._execute(job, fn, *args, on_success=on_success, **kwargs))
        job.task = task
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return job

    async def _execute(
        self,
        job: Job,
        fn: Callable,
        *args: Any,
        on_success: Optional[Callable[..., Any]] = None,
        **kwargs: Any,
    ) -> Job:
        """Ждёт свободный слот, выполняет воркер в потоке, фиксирует итог."""
        async with self._semaphore:
            job.mark_started()
            try:
                result = await asyncio.to_thread(fn, job.progress_cb(), *args, **kwargs)
                job.finish(result)
                logger.info(
                    "Задача %s (%s) выполнена за %.1f с", job.job_id, job.kind, job.elapsed_sec or 0.0,
                )
            except Exception as exc:  # noqa: BLE001 — это ошибка задачи, а не запроса
                job.fail(exc)
                logger.exception("Задача %s (%s) завершилась ошибкой", job.job_id, job.kind)
            else:
                if on_success is not None:
                    try:
                        await on_success(job, result)
                    except Exception:  # noqa: BLE001 — постобработка не отменяет успех
                        logger.exception("Постобработка задачи %s не выполнена", job.job_id)
        return job

    def get(self, job_id: str) -> Optional[Job]:
        """Задача по id (или None)."""
        return self._jobs.get(job_id)

    def list_jobs(self, limit: Optional[int] = None) -> List[Job]:
        """Задачи в порядке создания (новые — в конце), последние ``limit`` штук."""
        ids = self._order[-(limit or self._history_limit):]
        return [self._jobs[jid] for jid in ids if jid in self._jobs]

    def _trim_history(self) -> None:
        """Удаляет завершённые задачи сверх лимита истории (активные не трогаем)."""
        while len(self._order) > self._history_limit:
            oldest = self._order[0]
            job = self._jobs.get(oldest)
            if job is not None and job.status in ("queued", "running"):
                break
            self._order.pop(0)
            self._jobs.pop(oldest, None)

    def clear(self) -> None:
        """Очищает реестр и отменяет задачи (используется в тестах)."""
        for task in list(self._tasks):
            task.cancel()
        self._tasks.clear()
        self._jobs.clear()
        self._order.clear()


job_manager = JobManager(
    max_concurrent=settings.max_concurrent_jobs,
    history_limit=settings.jobs_history_limit,
)

