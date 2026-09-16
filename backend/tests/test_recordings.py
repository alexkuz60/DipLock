"""Тесты эндпоинтов записей (срез 2.2): загрузка → метаданные, без обработки."""
import os
import shutil

import numpy as np
import pytest

from app.core.config import settings
from app.services.recordings import (
    RecordingRegistry,
    file_digest,
    read_sidecar,
    recording_registry,
)
from tests.conftest import write_minimal_edf


def _upload_dirs() -> set[str]:
    """Каталоги записей в upload_dir (по одному на запись)."""
    root = settings.upload_dir
    if not os.path.isdir(root):
        return set()
    return {name for name in os.listdir(root) if os.path.isdir(os.path.join(root, name))}


@pytest.fixture(autouse=True)
def clean_registry():
    """Изоляция реестра и каталогов загрузок между тестами.

    Успешная загрузка по контракту оставляет файл на диске (его читают
    эндпоинты просмотра), поэтому каталоги, созданные тестом, удаляются после
    него: иначе каталог данных засоряется и повторный прогон становится
    недетерминированным.
    """
    recording_registry.clear()
    before = _upload_dirs()
    yield
    recording_registry.clear()
    for name in _upload_dirs() - before:
        shutil.rmtree(os.path.join(settings.upload_dir, name), ignore_errors=True)


def _upload(client, path, name="probe.edf"):
    with open(path, "rb") as fh:
        return client.post(
            "/api/v1/recordings", files={"file": (name, fh, "application/octet-stream")}
        )


def test_upload_recording_returns_metadata_and_keeps_file(client, edf_file):
    r = _upload(client, edf_file)

    assert r.status_code == 201, r.text
    meta = r.json()
    assert meta["recording_id"]
    assert meta["filename"] == "probe.edf"
    assert meta["n_channels"] == 5
    assert meta["channels"] == list(settings.standard_channels[:5])
    assert meta["unmatched_channels"] == []
    assert meta["sfreq"] == 250.0
    assert meta["duration_sec"] == 4.0
    assert meta["units_autoscaled"] is False
    assert meta["edf_units"] is None
    assert meta["warnings"] == []
    assert meta["created_at"]

    # В отличие от /analyze файл записи остаётся на диске: его читают
    # эндпоинты просмотра (сигналы, предподготовка).
    rec = recording_registry.get(meta["recording_id"])
    assert rec is not None
    assert os.path.exists(rec.path)


def test_get_recording_by_id_and_404_for_unknown(client, edf_file):
    meta = _upload(client, edf_file).json()

    r = client.get(f"/api/v1/recordings/{meta['recording_id']}")
    assert r.status_code == 200
    assert r.json()["recording_id"] == meta["recording_id"]

    missing = client.get("/api/v1/recordings/00000000-0000-0000-0000-000000000000")
    assert missing.status_code == 404


def test_upload_rejects_non_edf_suffix(client):
    r = client.post(
        "/api/v1/recordings",
        files={"file": ("notes.txt", b"hello", "text/plain")},
    )
    assert r.status_code == 400
    assert ".edf" in r.json()["detail"]


def test_upload_rejects_broken_edf_and_cleans_disk(client):
    before = _upload_dirs()
    r = client.post(
        "/api/v1/recordings",
        files={"file": ("broken.edf", b"not an edf", "application/octet-stream")},
    )
    assert r.status_code == 400
    assert "Не удалось прочитать EDF" in r.json()["detail"]

    # Неудачная загрузка не оставляет мусора: новых каталогов записей нет
    assert _upload_dirs() == before


def test_upload_rejects_too_large(client, edf_file, monkeypatch):
    monkeypatch.setattr("app.api.routes.MAX_UPLOAD_SIZE", 8)

    r = _upload(client, edf_file)
    assert r.status_code == 413
    assert "МБ" in r.json()["detail"]


def _register_copy(registry, edf_file, tmp_path, name):
    """Регистрирует копию тестового EDF в реестре (новый uuid-каталог)."""
    upload_dir = tmp_path / name
    upload_dir.mkdir()
    path = upload_dir / f"{name}.edf"
    shutil.copy(edf_file, path)
    return registry.register(str(path), str(upload_dir), f"{name}.edf", settings)


def test_registry_evicts_oldest_over_limit(edf_file, tmp_path):
    registry = RecordingRegistry(max_recordings=2, ttl_hours=24, upload_dir=str(tmp_path))
    first = _register_copy(registry, edf_file, tmp_path, "rec_a")
    second = _register_copy(registry, edf_file, tmp_path, "rec_b")
    third = _register_copy(registry, edf_file, tmp_path, "rec_c")

    assert registry.get(first.recording_id) is None
    assert not os.path.exists(first.upload_dir)
    assert registry.get(second.recording_id) is not None
    assert registry.get(third.recording_id) is not None
    assert len(registry.list()) == 2


def test_registry_drops_expired_by_ttl(edf_file, tmp_path):
    registry = RecordingRegistry(max_recordings=10, ttl_hours=1, upload_dir=str(tmp_path))
    rec = _register_copy(registry, edf_file, tmp_path, "old")
    rec.created_at -= 2 * 3600  # «записана» 2 часа назад

    assert registry.get(rec.recording_id) is None
    assert not os.path.exists(rec.upload_dir)
    assert registry.list() == []


def _other_edf(tmp_path, name: str = "other.edf") -> str:
    """Второй корректный EDF с другим содержимым (должен остаться другой записью)."""
    path = tmp_path / name
    ch_names = list(settings.standard_channels[:5])
    sfreq = 200.0
    t = np.arange(int(4 * sfreq)) / sfreq
    data = np.vstack([np.sin(2 * np.pi * (7 + i) * t) * 15 for i in range(len(ch_names))])
    write_minimal_edf(path, ch_names, data, sfreq)
    return str(path)


def test_upload_same_file_twice_reuses_recording_without_copy(client, edf_file):
    """Повторная загрузка того же файла открывает прежнюю запись, а не пишет копию."""
    first = _upload(client, edf_file)
    assert first.status_code == 201, first.text
    recording_id = first.json()["recording_id"]
    before = _upload_dirs()
    assert recording_id in before

    second = _upload(client, edf_file)
    assert second.status_code == 200, second.text
    body = second.json()
    assert body["recording_id"] == recording_id
    assert body["deduplicated"] is True
    # Копия не создана: каталогов столько же, и он один — каталог первой записи
    assert _upload_dirs() == before

    # Флаг относится к загрузке, а не к файлу: обычный паспорт его не выставляет
    meta = client.get(f"/api/v1/recordings/{recording_id}").json()
    assert meta["deduplicated"] is False
    assert meta["sfreq"] == first.json()["sfreq"]


def test_upload_other_file_creates_new_recording(client, edf_file, tmp_path):
    """Другое содержимое — другая запись: дедуп не «склеивает» разные файлы."""
    first = _upload(client, edf_file)
    before = _upload_dirs()

    with open(_other_edf(tmp_path), "rb") as fh:
        second = client.post(
            "/api/v1/recordings",
            files={"file": ("other.edf", fh, "application/octet-stream")},
        )

    assert second.status_code == 201, second.text
    assert second.json()["deduplicated"] is False
    assert second.json()["recording_id"] != first.json()["recording_id"]
    assert len(_upload_dirs()) == len(before) + 1


def test_sidecar_keeps_digest_and_passport(client, edf_file):
    """Отпечаток и паспорт лежат рядом с файлом — дедуп переживает рестарт."""
    meta = _upload(client, edf_file).json()
    recording = recording_registry.get(meta["recording_id"])

    payload = read_sidecar(recording.upload_dir)
    assert payload is not None
    assert payload["digest"] == file_digest(recording.path)
    assert payload["filename"] == "probe.edf"
    assert payload["meta"]["sfreq"] == 250.0


def test_dedup_survives_new_registry(client, edf_file):
    """Новый процесс (dev `--reload`) находит отпечаток в сайдкарах каталогов."""
    meta = _upload(client, edf_file).json()
    digest = file_digest(recording_registry.get(meta["recording_id"]).path)

    restarted = RecordingRegistry(
        max_recordings=10, ttl_hours=24, upload_dir=settings.upload_dir,
    )
    found = restarted.find_by_digest(digest, settings)

    assert found is not None
    assert found.recording_id == meta["recording_id"]
    assert found.owned is False  # каталог найден на диске, а не создан процессом


def test_restore_does_not_delete_adopted_dir(client, edf_file):
    """Сброс памяти не удаляет каталог, которого процесс не создавал."""
    meta = _upload(client, edf_file).json()
    recording = recording_registry.get(meta["recording_id"])

    restarted = RecordingRegistry(
        max_recordings=10, ttl_hours=24, upload_dir=settings.upload_dir,
    )
    restarted.find_by_digest(file_digest(recording.path), settings)
    restarted.clear()

    assert os.path.isdir(recording.upload_dir)
    assert restarted.get(meta["recording_id"]) is None


def test_prune_orphans_removes_old_dir_and_keeps_root_file(tmp_path, edf_file):
    """Уборка сносит устаревшие каталоги и не трогает корневой файл записей."""
    root = tmp_path / "edf"
    root.mkdir()
    shutil.copy(edf_file, root / "test.edf")  # файл из репозитория — не каталог записи
    old = root / "0d0d0d0d-0000-0000-0000-000000000000"
    old.mkdir()
    shutil.copy(edf_file, old / "probe.edf")
    stale = 1700000000.0  # далёкое прошлое
    os.utime(old, (stale, stale))

    fresh = root / "1d1d1d1d-0000-0000-0000-000000000000"
    fresh.mkdir()
    shutil.copy(edf_file, fresh / "probe.edf")

    registry = RecordingRegistry(max_recordings=10, ttl_hours=1, upload_dir=str(root))
    removed = registry.prune_orphans(settings)

    assert removed == [old.name]
    assert not old.exists()
    assert fresh.is_dir()
    assert (root / "test.edf").exists()

