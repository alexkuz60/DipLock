"""Менеджер фоновых задач (F7): этапы, прогресс, ограничение параллелизма.

Один долгий HTTP-запрос = весь пайплайн — модель, которая не переживает UI:
нет прогресса, при обрыве соединения результат теряется, параллельность не
ограничена. Здесь задача живёт на сервере:

* ``submit()`` создаёт задачу и возвращает её сразу (HTTP 202 + ``job_id``);
* исполнение — в потоке (``asyncio.to_thread``), event-loop не блокируется;
* ``asyncio.Semaphore`` ограничивает число одновременных тяжёлых расчётов;
* воркер сообщает этап и прогресс колбэком — UI рисует прогресс-бар по этапам;
* шаги расчёта видны в журнале (`services/journal.py`) с ``job_id`` задачи:
  ``job_scope`` ставит контекст вокруг потока, а сервисы пишут замеры сами.

Хранилище — in-memory (история ограничена ``jobs_history_limit``) **плюс** файл
задачи на диске: завершённые задачи пишутся ``services/job_store.py``
(``results_dir/jobs/<job_id>.json``) и поднимаются обратно на старте приложения
(``restore``), поэтому история и ссылки на результат переживают рестарт процесса
(A8, этап 6). Файл задачи — не кэш: он не участвует в ETag/``cache_clear`` и
сносится обходом сирот вместе с кэшами исчезнувшей записи.
"""
import asyncio
import logging
import traceback
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from app.core.config import Settings, settings
from app.schemas.analysis import JOB_STATES, JobState
from app.services import job_store, journal

logger = logging.getLogger(__name__)

# Колбэк прогресса: cb(stage, progress=None, message="")
ProgressCallback = Callable[..., None]


def noop_progress(
    stage: str,
    progress: float | None = None,
    message: str = "",
    epochs_done: int | None = None,
    epochs_total: int | None = None,
) -> None:
    """Заглушка колбэка прогресса: этапы задачи некому показывать.

    Нужна синхронному ``POST /analyze``: он считает полный пайплайн в одном
    запросе, и прогресс-бар рисовать негде. Параметры ``epochs_done``/
    ``epochs_total`` принимаются, чтобы подпись совпадала с колбэком задачи
    (`job_manager`) — сервисы вызывают прогресс единообразно.
    """


# Этапы пайплайна анализа и их «целевой» прогресс (для UI-прогресс-бара)
PIPELINE_STAGES: dict[str, float] = {
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
STAGE_TITLES: dict[str, str] = {
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
    filename: str | None = None
    status: JobState = "queued"  # queued | running | succeeded | failed
    stage: str = "queued"
    progress: float = 0.0
    message: str = ""
    created_at: datetime = field(default_factory=datetime.utcnow)
    started_at: datetime | None = None
    finished_at: datetime | None = None
    error: str | None = None
    # Хвост traceback (последние кадры) для разворота в UI (N31): текст
    # ошибки говорит «что», traceback — «где». Храним укороченным: полный
    # traceback пайплайна MNE — килобайты, в файл задачи идёт хвост.
    error_traceback: str | None = None
    session_id: str | None = None
    result: dict[str, Any] | None = None
    meta: dict[str, Any] = field(default_factory=dict)
    # Детальный прогресс этапов с эпохами (срез 3.4): «12 из 30 эпох» читается
    # лучше, чем плавающая дробь 0.42 — UI рисует по ним прогресс-бар задачи.
    epochs_done: int = 0
    epochs_total: int = 0
    task: asyncio.Task | None = field(default=None, repr=False)
    restored: bool = False
    """true — задача поднята с диска (``job_store``), а не исполнялась этим процессом."""

    def mark_started(self) -> None:
        """Переводит задачу в ``running`` (слот семафора получен)."""
        self.status = "running"
        self.started_at = datetime.utcnow()
        self.set_progress("load_edf", message="Чтение EDF и монтаж 10-20")

    def set_progress(
        self,
        stage: str,
        progress: float | None = None,
        message: str = "",
        epochs_done: int | None = None,
        epochs_total: int | None = None,
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
            progress: float | None = None,
            message: str = "",
            epochs_done: int | None = None,
            epochs_total: int | None = None,
        ) -> None:
            self.set_progress(stage, progress, message, epochs_done, epochs_total)

        return _cb

    def finish(self, result: dict[str, Any]) -> None:
        """Успешное завершение: фиксируем результат и прогресс 1.0."""
        self.result = result
        self.session_id = result.get("session_id")
        self.status = "succeeded"
        self.finished_at = datetime.utcnow()
        self.set_progress("done", 1.0, message="Готово")

    def fail(self, error: BaseException) -> None:
        """Провал задачи: сохраняем текст ошибки и хвост traceback для UI (N31)."""
        self.status = "failed"
        self.error = str(error)
        self.error_traceback = traceback.format_exc()[-4000:]
        self.finished_at = datetime.utcnow()
        self.message = f"Ошибка: {error}"

    @property
    def elapsed_sec(self) -> float | None:
        """Длительность выполнения в секундах (None, если ещё не начиналась)."""
        if self.started_at is None:
            return None
        end = self.finished_at or datetime.utcnow()
        return round((end - self.started_at).total_seconds(), 3)

    def as_dict(self) -> dict[str, Any]:
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
            "error_traceback": self.error_traceback,
        }

    def to_record(self) -> dict[str, Any]:
        """Задача для файла на диске: примитивы + ``meta`` + ``result`` (A8).

        Всё, что нужно, чтобы после рестарта процесса отдать ``GET /jobs/{id}``
        и результат задачи: даты — строками ISO (обратно ``from_record``).
        """

        def iso(value: datetime | None) -> str | None:
            return value.isoformat() if value is not None else None

        return {
            "job_id": self.job_id,
            "kind": self.kind,
            "filename": self.filename,
            "status": self.status,
            "stage": self.stage,
            "progress": self.progress,
            "message": self.message,
            "epochs_done": self.epochs_done,
            "epochs_total": self.epochs_total,
            "created_at": iso(self.created_at),
            "started_at": iso(self.started_at),
            "finished_at": iso(self.finished_at),
            "error": self.error,
            "error_traceback": self.error_traceback,
            "session_id": self.session_id,
            "meta": self.meta,
            "result": self.result,
        }

    @classmethod
    def from_record(cls, record: dict[str, Any]) -> "Job":
        """Восстанавливает задачу из файла (``job_store.load_records``).

        ``restored=True``: задача исполнялась прежним процессом, у неё нет
        ``asyncio.Task``, но статус, ошибка и результат читаются как у живой.
        """

        def moment(key: str, default: datetime | None = None) -> datetime | None:
            raw = record.get(key)
            if not isinstance(raw, str):
                return default
            try:
                return datetime.fromisoformat(raw)
            except ValueError:
                return default

        created_at = moment("created_at") or datetime.utcnow()
        # Состояние из файла задачи сужаем к ``JobState``: повреждённый файл не
        # должен показывать в UI состояние вне контракта API.
        restored_status = str(record.get("status") or "succeeded")
        status: JobState = restored_status if restored_status in JOB_STATES else "succeeded"
        return cls(
            job_id=str(record.get("job_id")),
            kind=str(record.get("kind") or "analyze"),
            filename=record.get("filename"),
            status=status,
            stage=str(record.get("stage") or "done"),
            progress=float(record.get("progress") or 0.0),
            message=str(record.get("message") or ""),
            created_at=created_at,
            started_at=moment("started_at"),
            finished_at=moment("finished_at", created_at),
            error=record.get("error"),
            error_traceback=record.get("error_traceback"),
            session_id=record.get("session_id"),
            result=record.get("result"),
            meta=dict(record.get("meta") or {}),
            epochs_done=int(record.get("epochs_done") or 0),
            epochs_total=int(record.get("epochs_total") or 0),
            restored=True,
        )


class JobManager:
    """Реестр задач с ограничением параллелизма и историей."""

    def __init__(self, max_concurrent: int = 2, history_limit: int = 50) -> None:
        self._max_concurrent = max(1, int(max_concurrent))
        self._history_limit = max(1, int(history_limit))
        self._semaphore = asyncio.Semaphore(self._max_concurrent)
        self._jobs: dict[str, Job] = {}
        self._order: list[str] = []
        self._tasks: set[asyncio.Task] = set()

    @property
    def max_concurrent(self) -> int:
        """Сколько тяжёлых расчётов может идти одновременно."""
        return self._max_concurrent

    def create(self, kind: str, filename: str | None = None, **meta: Any) -> Job:
        """Регистрирует задачу в состоянии ``queued``."""
        job = Job(job_id=str(uuid.uuid4()), kind=kind, filename=filename, meta=dict(meta))
        self._jobs[job.job_id] = job
        self._order.append(job.job_id)
        self._trim_history()
        return job

    def submit(
        self,
        kind: str,
        filename: str | None,
        fn: Callable,
        *args: Any,
        on_success: Callable[..., Any] | None = None,
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
        on_success: Callable[..., Any] | None = None,
        **kwargs: Any,
    ) -> Job:
        """Ждёт свободный слот, выполняет воркер в потоке, фиксирует итог."""
        async with self._semaphore:
            job.mark_started()
            try:
                # Шаги пайплайна помечаются `job_id` (журнал шагов, этап 5):
                # `to_thread` копирует контекст, поэтому воркер и сервисы видят
                # его без передачи параметров.
                with journal.job_scope(job.job_id):
                    result = await asyncio.to_thread(fn, job.progress_cb(), *args, **kwargs)
                job.finish(result)
                logger.info(
                    "Задача %s (%s) выполнена за %.1f с", job.job_id, job.kind, job.elapsed_sec or 0.0,
                )
            except Exception as exc:
                job.fail(exc)
                logger.exception("Задача %s (%s) завершилась ошибкой", job.job_id, job.kind)
            else:
                if on_success is not None:
                    try:
                        await on_success(job, result)
                    except Exception:
                        logger.exception("Постобработка задачи %s не выполнена", job.job_id)
        # Итог задачи (успех или ошибка) — на диск: иначе после рестарта процесса
        # история и результат теряются (A8). Запись в потоке (результат бывает на
        # мегабайты, а это event-loop) и **после** освобождения слота семафора:
        # запись файла не должна занимать место параллельного расчёта.
        await asyncio.to_thread(job_store.save_record, settings, job.to_record())
        return job


    def get(self, job_id: str) -> Job | None:
        """Задача по id (или None)."""
        return self._jobs.get(job_id)

    def list_jobs(self, limit: int | None = None) -> list[Job]:
        """Задачи в порядке создания (новые — в конце), последние ``limit`` штук."""
        ids = self._order[-(limit or self._history_limit):]
        return [self._jobs[jid] for jid in ids if jid in self._jobs]

    def restore(self, cfg: Settings | None = None) -> int:
        """Поднимает завершённые задачи с диска; возвращает их число (A8).

        Без этого после рестарта процесса ``GET /jobs`` пуст, а сохранённые
        результаты недостижимы по URL — именно так и было до этапа 6. Задачи,
        уже известные реестру (повторный вызов), не дублируются; битые и чужие
        по версии файлы пропускает ``job_store.load_records``.
        """
        cfg = cfg or settings
        restored = 0
        for record in job_store.load_records(cfg, limit=self._history_limit):
            job = Job.from_record(record)
            if not job.job_id or job.job_id in self._jobs:
                continue
            self._jobs[job.job_id] = job
            self._order.append(job.job_id)
            restored += 1
        if restored:
            logger.info("История задач поднята с диска: %d", restored)
        return restored

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

