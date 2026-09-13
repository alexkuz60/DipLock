"""Тесты эндпоинтов записей (срез 2.2): загрузка → метаданные, без обработки."""
import os
import shutil

import pytest

from app.core.config import settings
from app.services.recordings import RecordingRegistry, recording_registry


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
    registry = RecordingRegistry(max_recordings=2, ttl_hours=24)
    first = _register_copy(registry, edf_file, tmp_path, "rec_a")
    second = _register_copy(registry, edf_file, tmp_path, "rec_b")
    third = _register_copy(registry, edf_file, tmp_path, "rec_c")

    assert registry.get(first.recording_id) is None
    assert not os.path.exists(first.upload_dir)
    assert registry.get(second.recording_id) is not None
    assert registry.get(third.recording_id) is not None
    assert len(registry.list()) == 2


def test_registry_drops_expired_by_ttl(edf_file, tmp_path):
    registry = RecordingRegistry(max_recordings=10, ttl_hours=1)
    rec = _register_copy(registry, edf_file, tmp_path, "old")
    rec.created_at -= 2 * 3600  # «записана» 2 часа назад

    assert registry.get(rec.recording_id) is None
    assert not os.path.exists(rec.upload_dir)
    assert registry.list() == []
