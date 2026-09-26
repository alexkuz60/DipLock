"""Тесты менеджера фоновых задач (F7): прогресс, ошибки, семафор, история, отмена (3.2)."""
import asyncio
import threading
import time

from app.services.job_manager import STAGE_TITLES, Job, JobManager


def test_job_success_reports_stages_and_result():
    """Успешная задача: этапы/прогресс от воркера, статус succeeded, результат."""

    async def _run():
        manager = JobManager(max_concurrent=1, history_limit=5)
        seen = []

        def worker(progress):
            progress("load_edf")
            progress("dipoles", 0.9, "фитинг эпох")
            seen.append(progress)
            return {"session_id": "s1"}

        job = manager.submit("analyze", "rec.edf", worker)
        assert job.status in ("queued", "running")
        await job.task

        assert job.status == "succeeded"
        assert job.result == {"session_id": "s1"}
        assert job.session_id == "s1"
        assert job.progress == 1.0
        assert job.stage == "done"
        assert job.message == "Готово"
        assert job.started_at is not None and job.finished_at is not None
        assert job.elapsed_sec is not None and job.elapsed_sec >= 0.0
        assert job.error is None

    asyncio.run(_run())


def test_job_progress_uses_stage_targets():
    """Промежуточные этапы переводятся в целевой прогресс из PIPELINE_STAGES."""
    from app.services.job_manager import PIPELINE_STAGES

    async def _run():
        manager = JobManager()
        observed = []

        def worker(progress):
            progress("artifacts")
            observed.append(("artifacts",))
            progress("dipoles", message="фитинг")
            return {"session_id": "s2"}

        job = manager.submit("analyze", None, worker)
        await job.task

        assert observed == [("artifacts",)]
        assert job.status == "succeeded"
        assert job.stage == "done"
        assert PIPELINE_STAGES["done"] == 1.0

    asyncio.run(_run())


def test_job_failure_keeps_error_text():
    """Ошибка воркера не роняет сервер: статус failed + текст ошибки для UI."""

    async def _run():
        manager = JobManager()

        def worker(progress):
            raise ValueError("Все эпохи отброшены аннотациями BAD_")

        job = manager.submit("analyze", "bad.edf", worker)
        await job.task

        assert job.status == "failed"
        assert "аннотациями BAD_" in (job.error or "")
        assert job.message.startswith("Ошибка:")
        assert job.result is None
        assert job.finished_at is not None

    asyncio.run(_run())


def test_job_on_success_runs_in_event_loop():
    """Постобработка (запись в БД) выполняется в event-loop, а не в потоке."""

    async def _run():
        manager = JobManager()
        calls = []

        def worker(progress):
            return {"session_id": "s3"}

        async def on_success(job, result):
            calls.append((job.job_id, result["session_id"], threading.current_thread()))
            await asyncio.sleep(0)

        job = manager.submit("analyze", None, worker, on_success=on_success)
        await job.task

        assert len(calls) == 1
        assert calls[0][1] == "s3"
        # event-loop-thread теста (MainThread для asyncio.run)
        assert calls[0][2] is threading.main_thread()

    asyncio.run(_run())


def test_job_manager_limits_concurrency():
    """Семафор не даёт запускать больше задач, чем MAX_CONCURRENT_JOBS."""
    manager = JobManager(max_concurrent=2, history_limit=10)
    lock = threading.Lock()
    state = {"active": 0, "peak": 0}

    def worker(progress):
        with lock:
            state["active"] += 1
            state["peak"] = max(state["peak"], state["active"])
        time.sleep(0.15)
        with lock:
            state["active"] -= 1
        return {"session_id": "x"}

    async def _run():
        assert manager.max_concurrent == 2
        for _ in range(4):
            manager.submit("analyze", None, worker)
        deadline = time.time() + 10
        while time.time() < deadline:
            if all(j.status in ("succeeded", "failed") for j in manager.list_jobs()):
                break
            await asyncio.sleep(0.02)

    asyncio.run(_run())
    assert state["peak"] == 2
    assert all(job.status == "succeeded" for job in manager.list_jobs())


def test_history_limit_drops_oldest_finished_jobs():
    """История ограничена: завершённые старые задачи вытесняются новыми."""
    manager = JobManager(max_concurrent=1, history_limit=2)

    def worker(progress):
        return {"session_id": "h"}

    async def _run():
        for _ in range(3):
            job = manager.submit("analyze", None, worker)
            await job.task

    asyncio.run(_run())
    jobs = manager.list_jobs()
    assert len(jobs) == 2
    assert manager.get(jobs[0].job_id) is not None


def test_stage_titles_cover_pipeline_stages():
    """У каждого этапа пайплайна есть человекочитаемая подпись для UI."""
    from app.services.job_manager import PIPELINE_STAGES

    assert set(PIPELINE_STAGES) <= set(STAGE_TITLES)


# ---------- отмена (3.2) ----------


def test_cancel_queued_task_skips_worker():
    """Отмена из очереди: слот занят только проверкой, воркер не запускается."""

    async def _run():
        manager = JobManager(max_concurrent=1, history_limit=5)
        release = threading.Event()
        started = threading.Event()
        ran: list[str] = []

        def blocker(progress):
            started.set()
            release.wait(timeout=5)
            return {"session_id": "first"}

        def second_worker(progress):
            ran.append("ran")
            return {"session_id": "second"}

        first = manager.submit("analyze", None, blocker)
        assert await asyncio.to_thread(started.wait, 5), "воркер не стартовал"
        second = manager.submit("analyze", None, second_worker)

        assert manager.cancel(second.job_id) is second
        # Отмена в очереди видна сразу — не через тик прогресса
        assert second.status == "cancelled"

        release.set()
        await first.task
        await second.task

        assert second.status == "cancelled"
        assert second.result is None
        assert second.finished_at is not None
        assert ran == []
        # Семафор не «протёк»: следующая задача после отменённой выполняется
        third = manager.submit("analyze", None, lambda progress: {"session_id": "third"})
        await third.task
        assert third.status == "succeeded"

    asyncio.run(_run())


def test_cancel_running_task_interrupts_on_progress_tick():
    """Отмена идущей задачи: воркер обрывается на ближайшем тике прогресса."""

    async def _run():
        manager = JobManager(max_concurrent=1, history_limit=5)

        first_tick = threading.Event()

        def worker(progress):
            first_tick.set()
            for i in range(1000):
                progress("scan", (i + 1) / 1000, "перебор сетки")
                time.sleep(0.005)
            return {"points": ["не должно дойти"]}

        job = manager.submit("dipoles", None, worker)
        # Первый тик прогресса гарантирует running (mark_started предшествует потоку)
        assert await asyncio.to_thread(first_tick.wait, 5), "воркер не стартовал"

        assert manager.cancel(job.job_id) is job
        await job.task

        assert job.status == "cancelled"
        assert job.result is None
        assert job.message == "Отменена"
        assert job.cancel_requested is True
        # Слот освобождён отменённой задачей
        follow = manager.submit("analyze", None, lambda progress: {"ok": True})
        await follow.task
        assert follow.status == "succeeded"

    asyncio.run(_run())


def test_cancel_finished_task_is_rejected():
    """Завершённую задачу отменить нельзя: False, статус и результат не меняются."""
    ok = Job(job_id="j-ok", kind="analyze")
    ok.finish({"session_id": "s"})
    assert ok.request_cancel() is False
    assert ok.status == "succeeded"
    assert ok.result == {"session_id": "s"}

    bad = Job(job_id="j-bad", kind="analyze")
    bad.fail(ValueError("нет"))
    assert bad.request_cancel() is False
    assert bad.status == "failed"


def test_cancelled_status_restores_from_record():
    """Файл задачи с cancelled поднимается в том же статусе (A8 + 3.2)."""
    job = Job(job_id="j-c", kind="spectrum")
    job.request_cancel()

    restored = Job.from_record(job.to_record())

    assert restored.status == "cancelled"
    assert restored.message == "Отменена"
