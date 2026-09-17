"""Тесты дискового носителя результатов задач (A8, этап 6).

До этапа 6 задача жила только в RAM: после рестарта процесса история пустела, а
``GET /jobs/{id}`` и ``/recordings/{id}/{kind}/{job_id}`` отвечали 404. Здесь
проверяется обратное: завершённая задача (успех и ошибка) пишется на диск,
поднимается новым менеджером, и ссылки на результат снова работают. Отдельно —
границы: слишком большой результат не сохраняется (история важнее), файлы
исчезнувших записей и лишняя история сносятся обходом.
"""
import asyncio
import json
import os
from typing import Any, Callable, Dict, List

import pytest

from app.api.recording_jobs import _require_finished
from app.core.config import settings
from app.services import job_store
from app.services.job_manager import Job, JobManager


@pytest.fixture(autouse=True)
def isolated_results(tmp_path, monkeypatch):
    """Файлы задач — во временный каталог: тесты не пишут в рабочий data/results."""
    results = tmp_path / "results"
    results.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(settings, "results_dir", str(results))
    monkeypatch.setattr(settings, "job_store_enabled", True)
    monkeypatch.setattr(settings, "job_result_max_bytes", 2_000_000)
    return results


def _worker(spec: Dict[str, Any]) -> Callable:
    """Воркер по описанию: бросает ``error`` или возвращает ``result``."""

    def worker(progress):  # noqa: ARG001
        if spec.get("error") is not None:
            raise spec["error"]
        return spec.get("result", {"recording_id": "rec", "value": 1})

    return worker


def _run_jobs(manager: JobManager, specs: List[Dict[str, Any]]) -> List[Job]:
    """Прогоняет задачи менеджера в одном event-loop и возвращает их."""

    async def _run():
        jobs = [
            manager.submit(
                spec.get("kind", "spectrum"), "rec.edf", _worker(spec), meta=spec.get("meta"),
            )
            for spec in specs
        ]
        for job in jobs:
            await job.task
        return jobs

    return asyncio.run(_run())


def _run_job(manager: JobManager, **spec: Any) -> Job:
    """Одна задача менеджера до конца."""
    return _run_jobs(manager, [spec])[0]


def test_finished_job_is_written_and_restored():
    """Завершённая задача поднимается с диска новым менеджером (история и результат)."""
    manager = JobManager(max_concurrent=1, history_limit=10)
    job = _run_job(manager, result={"recording_id": "rec-1", "n_epochs": 5})

    files = job_store.record_files(settings)
    assert len(files) == 1
    assert os.path.basename(files[0]) == f"{job.job_id}.json"

    fresh = JobManager(max_concurrent=1, history_limit=10)
    assert fresh.restore(settings) == 1

    restored = fresh.get(job.job_id)
    assert restored is not None and restored.restored is True
    assert restored.status == "succeeded"
    assert restored.stage == "done"
    assert restored.result == {"recording_id": "rec-1", "n_epochs": 5}
    assert restored.message == "Готово"
    assert restored.created_at == job.created_at
    assert restored.elapsed_sec == job.elapsed_sec
    assert [item.job_id for item in fresh.list_jobs()] == [job.job_id]

    # Повторный подъём не дублирует задачу (id уже известен реестру).
    assert fresh.restore(settings) == 0


def test_failed_job_is_restored_with_error():
    """Провал тоже переживает рестарт: текст ошибки сохраняется для UI."""
    manager = JobManager(max_concurrent=1, history_limit=10)
    job = _run_job(manager, error=ValueError("Все эпохи отброшены reject-фильтром"))

    fresh = JobManager(max_concurrent=1, history_limit=10)
    assert fresh.restore(settings) == 1
    restored = fresh.get(job.job_id)

    assert restored is not None
    assert restored.status == "failed"
    assert "reject-фильтром" in (restored.error or "")
    assert restored.result is None
    with pytest.raises(Exception) as exc:
        _require_finished(restored)
    assert "завершилась ошибкой" in str(exc.value)


def test_oversized_result_keeps_history_without_result(monkeypatch):
    """Результат сверх предела не сохраняется, а задача — остаётся (история важнее)."""
    monkeypatch.setattr(settings, "job_result_max_bytes", 600)
    manager = JobManager(max_concurrent=1, history_limit=10)
    job = _run_job(manager, result={"recording_id": "rec-2", "trajectory": "x" * 4000})

    assert manager.get(job.job_id).result is not None  # в RAM результат есть

    saved = job_store.load_records(settings)
    assert len(saved) == 1
    assert saved[0]["job_id"] == job.job_id
    assert saved[0]["result"] is None
    assert saved[0][job_store.RESULT_OMITTED_KEY] is True

    fresh = JobManager(max_concurrent=1, history_limit=10)
    assert fresh.restore(settings) == 1
    restored = fresh.get(job.job_id)
    assert restored.status == "succeeded" and restored.result is None

    with pytest.raises(Exception) as exc:
        _require_finished(restored)
    # Текст отличается от «ещё не завершена»: ждать бессмысленно, нужен пересчёт.
    assert "не сохранён" in str(exc.value)


def test_store_can_be_disabled(monkeypatch):
    """``JOB_STORE_ENABLED=false`` — прежнее поведение «результат живёт в сессии»."""
    monkeypatch.setattr(settings, "job_store_enabled", False)
    manager = JobManager(max_concurrent=1, history_limit=10)
    _run_job(manager)

    assert job_store.record_files(settings) == ()


def test_prune_removes_jobs_of_unknown_and_extra_history():
    """Обход сносит задачи исчезнувших записей и историю сверх лимита."""
    manager = JobManager(max_concurrent=1, history_limit=10)
    alive, ghost, extra0, extra1, extra2 = _run_jobs(
        manager,
        [
            {"meta": {"recording_id": "alive"}},
            {"meta": {"recording_id": "ghost"}},
            {"meta": {"recording_id": "alive"}},
            {"meta": {"recording_id": "alive"}},
            {"meta": {"recording_id": "alive"}},
        ],
    )
    # Время файла задаём явно: порядок истории (кто «самый старый») — часть проверки,
    # а mtime пяти файлов, записанных подряд, разрешается недетерминированно.
    for offset, job in enumerate((alive, ghost, extra0, extra1, extra2), start=1):
        stamp = 1_700_000_000.0 + offset
        os.utime(job_store.job_path(settings, job.job_id), (stamp, stamp))

    removed = job_store.prune_records(settings, known_recording_ids={"alive"})
    assert removed == [ghost.job_id]
    assert len(job_store.record_files(settings)) == 4

    removed = job_store.prune_records(settings, known_recording_ids={"alive"}, limit=2)
    # Лимит отсчитывается от новых: остаются extra1 и extra2, уходят самые старые.
    assert set(removed) == {alive.job_id, extra0.job_id}
    left = {os.path.basename(path) for path in job_store.record_files(settings)}
    assert left == {f"{extra1.job_id}.json", f"{extra2.job_id}.json"}


def test_broken_and_foreign_files_are_skipped(isolated_results):
    """Битый файл и файл чужой версии формата не мешают подъёму истории."""
    valid = _run_job(JobManager(max_concurrent=1, history_limit=10))
    (isolated_results / job_store.JOBS_SUBDIR / "broken.json").write_text("{не json", "utf-8")
    (isolated_results / job_store.JOBS_SUBDIR / "old.json").write_text(
        json.dumps({"version": 0, "job_id": "old"}), "utf-8"
    )

    records = job_store.load_records(settings)
    assert [record["job_id"] for record in records] == [valid.job_id]


def test_job_path_rejects_traversal():
    """Имя файла задачи собирается из job_id — выход за каталог запрещён."""
    with pytest.raises(ValueError):
        job_store.job_path(settings, "../../etc/passwd")


def test_record_round_trip_keeps_meta():
    """``to_record``/``from_record`` не теряют meta: по ней строится ``result_url``."""
    job = Job(
        job_id="11111111-1111-1111-1111-111111111111",
        kind="dipoles",
        filename="rec.edf",
        status="succeeded",
        meta={"recording_id": "rec-9", "reference": "average"},
        result={"points": []},
    )
    restored = Job.from_record(job.to_record())

    assert restored.meta == {"recording_id": "rec-9", "reference": "average"}
    assert restored.kind == "dipoles"
    assert restored.restored is True
