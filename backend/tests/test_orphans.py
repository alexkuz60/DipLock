"""Тесты обхода сирот (A6, этап 6).

Сирота — это всё, что осталось от записи, которой реестр уже не знает: каталог
загрузки без живого владельца, её кэши (``signals``/``spectra``/``spectrograms``)
и файлы задач. Факт из аудита: ``data/cache/spectrograms/edf/`` не убирался
никогда, потому что ``prune_orphans`` вызывался только из скрипта и тестов.

Здесь проверяется обход целиком: что он сносит (сироты), что **не** сносит
(кэши живых записей, ассеты, журнал, корневые файлы каталога загрузок) и что
сбой уборки не превращается в исключение (уборка — служебная, не расчёт).
"""
import json
import os
import shutil

import pytest

from app.core.config import settings
from app.services import job_store
from app.services.orphans import RECORDING_CACHE_SUBDIRS, sweep_orphans
from app.services.recordings import RecordingRegistry


@pytest.fixture
def isolated(tmp_path, monkeypatch):
    """Изолированные каталоги данных + свой реестр (общий не трогаем)."""
    cfg_root = tmp_path / "data"
    upload = cfg_root / "edf"
    cache = cfg_root / "cache"
    results = cfg_root / "results"
    for path in (upload, cache, results):
        path.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(settings, "upload_dir", str(upload))
    monkeypatch.setattr(settings, "cache_dir", str(cache))
    monkeypatch.setattr(settings, "results_dir", str(results))
    registry = RecordingRegistry(max_recordings=10, ttl_hours=24, upload_dir=str(upload))
    yield upload, cache, results, registry
    registry.clear()


def _register(registry: RecordingRegistry, upload, edf_file, name: str) -> str:
    """Регистрирует запись как это делает ``POST /recordings`` (файл + сайдкар)."""
    upload_dir = upload / name
    upload_dir.mkdir(parents=True, exist_ok=True)
    path = upload_dir / "probe.edf"
    shutil.copy(edf_file, path)
    recording = registry.register(str(path), str(upload_dir), "probe.edf", settings)
    return recording.recording_id


def _touch(path, content: bytes = b"data"):
    """Создаёт файл кэша вместе с каталогами."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(content)


def test_sweep_removes_orphan_caches_and_keeps_live_ones(isolated, edf_file):
    """Кэш записи, которой нет в реестре, сносится; кэш живой записи — остаётся."""
    upload, cache, _, registry = isolated
    live = _register(registry, upload, edf_file, "live-recording")

    _touch(os.path.join(cache, "signals", live, "level1.bin"))
    _touch(os.path.join(cache, "signals", "ghost", "level1.bin"))
    _touch(os.path.join(cache, "spectra", live, "sig1", "delta.png"))
    _touch(os.path.join(cache, "spectra", "ghost", "sig1", "delta.png"))
    # Тот самый факт из аудита: каталог «edf» в кэше спектрограмм.
    _touch(os.path.join(cache, "spectrograms", live, "sig1.bin"))
    _touch(os.path.join(cache, "spectrograms", "edf", "sig1.bin"))
    # Карты разности пар (B9): верхний уровень — id первой записи пары.
    _touch(os.path.join(cache, "compare", live, "sig1", "alpha.png"))
    _touch(os.path.join(cache, "compare", "ghost", "sig1", "alpha.png"))
    # Рендеры «Нейромузыки»: мастер + треки + манифест, ключ — recording_id.
    _touch(os.path.join(cache, "audio", live, "sig1", "master.wav"))
    _touch(os.path.join(cache, "audio", live, "sig1", "manifest.json"))
    _touch(os.path.join(cache, "audio", "ghost", "sig1", "master.wav"))
    # Ассеты и журнал живут по версии/диагностике — обход их не касается.
    _touch(os.path.join(cache, "surface", "surface-abc.json"))
    _touch(os.path.join(cache, "journal.jsonl"))

    report = sweep_orphans(settings, registry=registry)

    assert sorted(report.cache_dirs) == [
        "audio/ghost", "compare/ghost", "signals/ghost", "spectra/ghost", "spectrograms/edf",
    ]
    assert report.freed_bytes > 0
    assert os.path.isfile(os.path.join(cache, "signals", live, "level1.bin"))
    assert os.path.isfile(os.path.join(cache, "spectra", live, "sig1", "delta.png"))
    assert os.path.isfile(os.path.join(cache, "spectrograms", live, "sig1.bin"))
    assert os.path.isfile(os.path.join(cache, "compare", live, "sig1", "alpha.png"))
    assert os.path.isfile(os.path.join(cache, "audio", live, "sig1", "master.wav"))
    for orphan in ("ghost", "edf"):
        assert not os.path.exists(os.path.join(cache, "spectrograms", orphan))
    assert not os.path.exists(os.path.join(cache, "signals", "ghost"))
    assert not os.path.exists(os.path.join(cache, "spectra", "ghost"))
    assert not os.path.exists(os.path.join(cache, "compare", "ghost"))
    assert not os.path.exists(os.path.join(cache, "audio", "ghost"))
    assert os.path.isfile(os.path.join(cache, "surface", "surface-abc.json"))
    assert os.path.isfile(os.path.join(cache, "journal.jsonl"))
    assert RECORDING_CACHE_SUBDIRS == (
        "signals", "spectra", "spectrograms", "prepared", "reports", "compare",
        "bundles", "audio",
    )


def test_sweep_removes_stale_upload_dirs_and_keeps_root_file(isolated, edf_file):
    """Каталог загрузки без живого владельца сносится, корневой файл — нет."""
    upload, _, _, registry = isolated
    stale = upload / "0d0d0d0d-0000-0000-0000-000000000000"
    stale.mkdir()
    shutil.copy(edf_file, stale / "probe.edf")
    os.utime(stale, (1_700_000_000.0, 1_700_000_000.0))
    shutil.copy(edf_file, upload / "test.edf")  # файл из репозитория
    fresh = upload / "1d1d1d1d-0000-0000-0000-000000000000"
    fresh.mkdir()
    shutil.copy(edf_file, fresh / "probe.edf")

    report = sweep_orphans(settings, registry=registry)

    assert report.upload_dirs == [stale.name]
    assert not stale.exists()
    assert fresh.is_dir()
    assert (upload / "test.edf").exists()


def test_sweep_keeps_cache_of_recording_on_disk_without_sidecar(isolated, edf_file):
    """Каталог без сайдкара реестр не поднимает, но кэш такой записи не сносится."""
    upload, cache, _, registry = isolated
    legacy = "2d2d2d2d-0000-0000-0000-000000000000"
    (upload / legacy).mkdir()
    shutil.copy(edf_file, upload / legacy / "probe.edf")  # сайдкара нет — легаси
    _touch(os.path.join(cache, "spectrograms", legacy, "sig1.bin"))

    report = sweep_orphans(settings, registry=registry)

    assert registry.get(legacy) is None  # реестр её не знает…
    assert report.cache_dirs == []  # …но каталог на диске жив, кэш остаётся
    assert os.path.isfile(os.path.join(cache, "spectrograms", legacy, "sig1.bin"))


def test_sweep_removes_jobs_of_vanished_recordings(isolated, edf_file):
    """Файл задачи исчезнувшей записи сносится: результат всё равно недостижим."""
    upload, _, _, registry = isolated
    live = _register(registry, upload, edf_file, "live-recording")
    alive = {"job_id": "11111111-1111-1111-1111-111111111111", "kind": "spectrum",
             "status": "succeeded", "meta": {"recording_id": live}}
    ghost = {"job_id": "22222222-2222-2222-2222-222222222222", "kind": "spectrum",
             "status": "succeeded", "meta": {"recording_id": "ghost"}}
    job_store.save_record(settings, alive)
    job_store.save_record(settings, ghost)

    report = sweep_orphans(settings, registry=registry)

    assert report.job_files == [ghost["job_id"]]
    left = {os.path.basename(path) for path in job_store.record_files(settings)}
    assert left == {f"{alive['job_id']}.json"}


def test_sweep_limits_job_history(isolated, monkeypatch):
    """Лишние файлы задач сносятся по лимиту истории задач."""
    _, _, _, registry = isolated
    monkeypatch.setattr(settings, "jobs_history_limit", 2)
    for index in range(4):
        job_store.save_record(
            settings,
            {"job_id": f"3333333{index}-3333-3333-3333-333333333333", "kind": "dipoles",
             "status": "succeeded", "meta": {}},
        )

    report = sweep_orphans(settings, registry=registry)

    assert len(report.job_files) == 2
    assert len(job_store.record_files(settings)) == 2


def test_sweep_is_safe_when_registry_fails(isolated):
    """Сбой реестра не роняет уборку: отчёт пуст, исключения нет."""

    class _Broken:
        """Реестр-заглушка: любое обращение к нему падает."""

        def prune_orphans(self, cfg):
            raise RuntimeError("реестр сломан")

        def known_ids(self, cfg):
            raise RuntimeError("реестр сломан")

    report = sweep_orphans(settings, registry=_Broken())

    assert report.total == 0
    assert report.as_dict() == {
        "upload_dirs": 0, "cache_dirs": 0, "job_files": 0,
        "quota_dirs": 0, "freed_bytes": 0,
    }


def test_sweep_on_empty_dirs_does_nothing(tmp_path, monkeypatch):
    """Пустые каталоги данных — норма: обход ничего не находит и не падает."""
    for name in ("upload_dir", "cache_dir", "results_dir"):
        monkeypatch.setattr(settings, name, str(tmp_path / name))
    registry = RecordingRegistry(max_recordings=5, ttl_hours=1, upload_dir=str(tmp_path / "upload_dir"))

    report = sweep_orphans(settings, registry=registry)

    assert report.total == 0
    assert json.loads(json.dumps(report.as_dict()))["freed_bytes"] == 0


def test_sweep_keeps_group_report_subdirs_and_prunes_compare_reports(isolated):
    """HTML отчётов «Итогов»: своя чистка — compare по файлу задачи, group не трогаем.

    ``reports/compare|group`` — не recording_id: общий обход кэшей их щадит
    (иначе снёс бы как «запись compare»), а отчёт сравнения сиротеет вместе с
    выходом задачи из истории. Прогонам группы отчёт не сирота — строки
    ``group_analyses`` не удаляются (§8.4.2).
    """
    _, cache, _, registry = isolated
    alive_job = "44444444-4444-4444-4444-444444444444"
    ghost_job = "55555555-5555-5555-5555-555555555555"
    job_store.save_record(
        settings,
        {"job_id": alive_job, "kind": "compare", "status": "succeeded", "meta": {}},
    )
    _touch(os.path.join(cache, "reports", "compare", alive_job, "sig1.html"))
    _touch(os.path.join(cache, "reports", "compare", ghost_job, "sig1.html"))
    _touch(os.path.join(cache, "reports", "group", "7", "sig1.html"))
    # Имя не похоже на job_id: к задаче его не привязать — сирота
    _touch(os.path.join(cache, "reports", "compare", "weird.name", "sig1.html"))

    report = sweep_orphans(settings, registry=registry)

    assert os.path.isfile(os.path.join(cache, "reports", "compare", alive_job, "sig1.html"))
    assert os.path.isfile(os.path.join(cache, "reports", "group", "7", "sig1.html"))
    assert "reports/compare" not in report.cache_dirs
    assert "reports/group" not in report.cache_dirs
    assert f"reports/compare/{ghost_job}" in report.cache_dirs
    assert "reports/compare/weird.name" in report.cache_dirs
    assert not os.path.exists(os.path.join(cache, "reports", "compare", ghost_job))


def test_cache_quota_removes_oldest_live_caches_lru(isolated, edf_file, monkeypatch):
    """Квота (N40/4.6): при превышении уходит самый старый кэш живой записи."""
    upload, cache, _, registry = isolated
    monkeypatch.setattr(settings, "cache_quota_mb", 1)  # лимит 1 МБ
    old_id = _register(registry, upload, edf_file, "old-rec")
    new_id = _register(registry, upload, edf_file, "new-rec")
    payload = b"x" * (600 * 1024)  # два кэша по 600 КБ > 1 МБ
    _touch(os.path.join(cache, "signals", old_id, "level1.bin"), payload)
    _touch(os.path.join(cache, "signals", new_id, "level1.bin"), payload)
    # Возраст: старый каталог старше нового (LRU выбирает по mtime)
    os.utime(os.path.join(cache, "signals", old_id), (1_700_000_000.0,) * 2)

    report = sweep_orphans(settings, registry=registry)

    assert report.quota_dirs == [f"signals/{old_id}"]
    assert not os.path.exists(os.path.join(cache, "signals", old_id))
    assert os.path.isfile(os.path.join(cache, "signals", new_id, "level1.bin"))
    assert report.freed_bytes >= 600 * 1024


def test_cache_quota_treats_each_render_as_unit(isolated, edf_file, monkeypatch):
    """Квота для audio: юнит LRU — один рендер, а не все рендеры записи."""
    upload, cache, _, registry = isolated
    monkeypatch.setattr(settings, "cache_quota_mb", 1)  # лимит 1 МБ
    live = _register(registry, upload, edf_file, "rec-renders")
    payload = b"w" * (600 * 1024)
    _touch(os.path.join(cache, "audio", live, "old-sig", "master.wav"), payload)
    _touch(os.path.join(cache, "audio", live, "new-sig", "master.wav"), payload)
    os.utime(os.path.join(cache, "audio", live, "old-sig"), (1_700_000_000.0,) * 2)

    report = sweep_orphans(settings, registry=registry)

    assert report.quota_dirs == [f"audio/{live}/old-sig"]
    assert not os.path.exists(os.path.join(cache, "audio", live, "old-sig"))
    assert os.path.isfile(os.path.join(cache, "audio", live, "new-sig", "master.wav"))


def test_cache_quota_off_by_default_keeps_everything(isolated, edf_file, monkeypatch):
    """Квота по умолчанию выключена (0): сколько бы ни было — ничего не сносится."""
    upload, cache, _, registry = isolated
    assert settings.cache_quota_mb == 0, "квота выключена, пока её не включили"
    live = _register(registry, upload, edf_file, "big-rec")
    _touch(os.path.join(cache, "spectra", live, "sig1", "alpha.png"), b"y" * 50_000)

    report = sweep_orphans(settings, registry=registry)

    assert report.quota_dirs == []
    assert os.path.isfile(os.path.join(cache, "spectra", live, "sig1", "alpha.png"))


def test_cache_usage_reports_bytes_and_quota(isolated, edf_file, monkeypatch):
    """``cache_usage`` — примитивы для /init-status: занято, единицы, квота."""
    from app.services.orphans import cache_usage

    upload, cache, _, registry = isolated
    monkeypatch.setattr(settings, "cache_quota_mb", 2)
    live = _register(registry, upload, edf_file, "usage-rec")
    _touch(os.path.join(cache, "bundles", live, "sig1.zip"), b"z" * 1024)

    usage = cache_usage(settings)

    assert usage["usage_bytes"] >= 1024
    assert usage["units"] >= 1
    assert usage["quota_bytes"] == 2 * 1024 * 1024
