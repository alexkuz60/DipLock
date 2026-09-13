"""Тесты менеджера фоновых задач (F7): прогресс, ошибки, семафор, история."""
import asyncio
import threading
import time

from app.services.job_manager import JobManager, STAGE_TITLES


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

        def worker(progress):  # noqa: ARG001
            raise ValueError("Все эпохи отброшены reject-фильтром")

        job = manager.submit("analyze", "bad.edf", worker)
        await job.task

        assert job.status == "failed"
        assert "reject-фильтром" in (job.error or "")
        assert job.message.startswith("Ошибка:")
        assert job.result is None
        assert job.finished_at is not None

    asyncio.run(_run())


def test_job_on_success_runs_in_event_loop():
    """Постобработка (запись в БД) выполняется в event-loop, а не в потоке."""

    async def _run():
        manager = JobManager()
        calls = []

        def worker(progress):  # noqa: ARG001
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

    def worker(progress):  # noqa: ARG001
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

    def worker(progress):  # noqa: ARG001
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
