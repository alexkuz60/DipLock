"""Пакет сессии (zip), BIDS/CSV-экспорт и run manifest (N40/4.6, `session_bundle`).

Проверяется то, на что опирается исследователь: пакет — честный архив
«EDF + параметры + результаты» (или минимальный BIDS) с манифестом версий,
кэш не пересобирается на тех же входах, CSV — RFC 4180 с честными пустыми
полями, а манифест задачи читается до и после её завершения.

API — полный флоу задачи (202 → поллинг → результат → zip-ассет с ETag/304)
и синхронные выгрузки (CSV, manifest) с 400/404 на кривой вход.
"""
import io
import json
import os
import shutil
import zipfile

import numpy as np
import pytest

from app.core.config import settings
from app.services.recordings import recording_registry
from app.services.session_bundle import (
    BUNDLE_FORMATS,
    BundleParams,
    bundle_signature,
    clear_bundle_cache,
    dipoles_csv,
    read_bundle_zip,
    run_bundle,
)
from tests.conftest import write_minimal_edf
from tests.test_dipole_scanner import _wait_finished

_PREFIX = "/api/v1"


def _upload_dirs() -> set[str]:
    root = settings.upload_dir
    if not os.path.isdir(root):
        return set()
    return {name for name in os.listdir(root) if os.path.isdir(os.path.join(root, name))}


@pytest.fixture(autouse=True)
def clean_state():
    """Изоляция реестра, каталогов загрузок и кэша пакетов между тестами."""
    recording_registry.clear()
    before = _upload_dirs()
    yield
    recording_registry.clear()
    for name in _upload_dirs() - before:
        shutil.rmtree(os.path.join(settings.upload_dir, name), ignore_errors=True)


def _bundle_edf(tmp_path, name: str = "bundle.edf", with_events: bool = True):
    """Синтетический EDF; по умолчанию EDF+ с аннотацией (события для BIDS)."""
    path = tmp_path / name
    channels = list(settings.standard_channels[:8])
    sfreq = 250.0
    times = np.arange(int(4.0 * sfreq)) / sfreq
    data = np.stack([
        np.sin(2 * np.pi * (6 + index) * times) * (10.0 + 2.0 * index)
        for index in range(len(channels))
    ])
    annotations = [(1.5, 0.0, "STIM/5"), (2.5, 0.0, "Sound/On")] if with_events else None
    write_minimal_edf(path, channels, data, sfreq, annotations=annotations)
    return path


def _register(tmp_path, edf_path, recording_id: str = "rec-bundle"):
    upload_dir = tmp_path / recording_id
    upload_dir.mkdir(parents=True, exist_ok=True)
    target = upload_dir / edf_path.name
    shutil.copyfile(edf_path, target)
    return recording_registry.register(str(target), str(upload_dir), edf_path.name, settings)


# ---------- сервис: подпись, сборка, CSV -------------------------------


def test_signature_is_stable_and_tracks_inputs(tmp_path):
    """Одинаковые входы — один отпечаток; смена формата или задачи — новый."""
    recording = _register(tmp_path, _bundle_edf(tmp_path))
    params = BundleParams(format="session")

    first = bundle_signature(settings, recording, params, [])
    assert first == bundle_signature(settings, recording, params, [])
    assert first != bundle_signature(settings, recording, BundleParams(format="bids"), [])
    # Новая задача записи (другие входы) — другой отпечаток → пересборка
    fake_job = {"job_id": "j1", "kind": "spectrum", "saved_at": "2026-10-04T00:00:00",
                "meta": {"params_sig": "p1"}}
    assert first != bundle_signature(settings, recording, params, [fake_job])
    assert len(first) == 16


def test_run_bundle_session_contains_manifest_jobs_and_edf(tmp_path):
    """session-пакет: manifest.json + passport.json + EDF; повтор — кэш-попадание."""
    recording = _register(tmp_path, _bundle_edf(tmp_path))
    params = BundleParams(format="session")

    out = run_bundle(recording, settings, params)

    assert out["format"] == "session"
    assert out["warnings"] == []
    assert any(name.endswith(recording.filename) for name in out["files"])
    assert "manifest.json" in out["files"] and "passport.json" in out["files"]

    cached = read_bundle_zip(settings, recording.recording_id, out["sig"])
    assert cached is not None
    data, version = cached
    assert version == out["sig"]
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        names = archive.namelist()
        assert "manifest.json" in names
        manifest = json.loads(archive.read("manifest.json"))
        assert manifest["versions"].get("mne")
        assert manifest["assets"]
        passport = json.loads(archive.read("passport.json"))
        assert passport["recording_id"] == recording.recording_id
        edf_names = [n for n in names if n.endswith(".edf")]
        assert len(edf_names) == 1 and archive.getinfo(edf_names[0]).file_size > 0

    # Те же входы: zip уже на диске, пересборки нет (mtime не меняется)
    path = os.path.join(settings.cache_dir, "bundles", recording.recording_id,
                        f"{out['sig']}.zip")
    mtime = os.path.getmtime(path)
    again = run_bundle(recording, settings, params)
    assert again["sig"] == out["sig"]
    assert os.path.getmtime(path) == mtime, "кэш-попадание не переписывает zip"


def test_run_bundle_bids_layout_and_events(tmp_path):
    """BIDS-пакет: dataset_description, participants, сайдкар, события, EDF по BIDS-пути."""
    recording = _register(tmp_path, _bundle_edf(tmp_path, with_events=True))

    out = run_bundle(recording, settings, BundleParams(format="bids"))
    data, _ = read_bundle_zip(settings, recording.recording_id, out["sig"])

    label = "".join(char for char in recording.recording_id if char.isalnum())
    subject = f"sub-{label}"
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        names = archive.namelist()
        assert "dataset_description.json" in names
        assert "participants.tsv" in names
        description = json.loads(archive.read("dataset_description.json"))
        assert description["DatasetType"] == "raw"
        # Честный «unknown», а не выдуманный «rest»
        sidecar_name = f"{subject}/eeg/{subject}_task-unknown_eeg.json"
        assert sidecar_name in names
        sidecar = json.loads(archive.read(sidecar_name))
        assert sidecar["TaskName"] == "unknown"
        assert sidecar["SamplingFrequency"] == 250.0
        events_name = f"{subject}/eeg/{subject}_task-unknown_events.tsv"
        assert events_name in names
        events = archive.read(events_name).decode("utf-8")
        assert events.splitlines()[0] == "onset\tduration\ttrial_type\tsource"
        assert "STIM/5" in events
        edf_name = f"{subject}/eeg/{subject}_task-unknown_eeg.edf"
        assert edf_name in names
        assert archive.getinfo(edf_name).file_size > 0


def test_bundle_without_edf_warns_but_builds(tmp_path):
    """Файл EDF пропал — пакет собирается без данных, честный warning."""
    recording = _register(tmp_path, _bundle_edf(tmp_path))
    shutil.rmtree(recording.upload_dir, ignore_errors=True)
    assert not os.path.isfile(recording.path)

    out = run_bundle(recording, settings, BundleParams(format="session"))

    assert any("не найден" in text for text in out["warnings"])
    assert not any(name.endswith(".edf") for name in out["files"])
    assert read_bundle_zip(settings, recording.recording_id, out["sig"]) is not None


def test_clear_bundle_cache_removes_zip(tmp_path):
    """Чистка вместе с записью убирает zip (то, что делает _drop_signal_cache)."""
    recording = _register(tmp_path, _bundle_edf(tmp_path))
    out = run_bundle(recording, settings, BundleParams(format="session"))

    clear_bundle_cache(settings, recording.recording_id)

    assert read_bundle_zip(settings, recording.recording_id, out["sig"]) is None


def test_dipoles_csv_is_rfc4180_with_honest_empty_cells():
    """CSV: CRLF, кавычки по необходимости, None → пустая ячейка, пусто → шапка."""
    rows = [
        {
            "session_id": "s1", "epoch_id": "e1", "time_ms": 120.0,
            "freq_band": "4-8", "mni": [-42.0, None, 58.0],
            "amplitude_nam": 12.5, "gof": 0.91,
            "anatomical_roi": "таламус, слева",  # запятая → кавычки (RFC 4180)
            "brodmann_area": "BA7-lh", "method": "fast_grid",
        },
        {
            "session_id": "s1", "epoch_id": "e2", "time_ms": None,
            "freq_band": None, "mni": None, "amplitude_nam": None, "gof": None,
            "anatomical_roi": None, "brodmann_area": None, "method": None,
        },
    ]

    text = dipoles_csv(rows)
    lines = text.split("\r\n")

    assert text.endswith("\r\n")
    assert lines[0].startswith("session_id,epoch_id,time_ms,freq_band")
    assert '"таламус, слева"' in lines[1], "поле с запятой обязано быть в кавычках"
    assert "-42.0,," in lines[1], "пустые MNI-координаты — пустые ячейки, не None"
    # Пустой результат — честная шапка, а не ошибка
    assert dipoles_csv([]) == (
        "session_id,epoch_id,time_ms,freq_band,"
        "mni_x,mni_y,mni_z,amplitude_nam,gof,anatomical_roi,brodmann_area,method\r\n"
    )


# ---------- API: задача пакета, ассет, выгрузки ------------------------


def _upload(client, path) -> dict:
    with open(path, "rb") as fh:
        response = client.post(
            f"{_PREFIX}/recordings",
            files={"file": (path.name, fh, "application/octet-stream")},
        )
    assert response.status_code == 201, response.text
    return response.json()


def test_bundle_job_flow_with_zip_asset(client, tmp_path):
    """202 → поллинг → результат с zip_url → zip 200 + ETag → 304 → 404 после чистки."""
    edf = _bundle_edf(tmp_path, name="api.edf")
    recording_id = _upload(client, edf)["recording_id"]

    created = client.post(f"{_PREFIX}/recordings/{recording_id}/bundle", data={})
    assert created.status_code == 202, created.text
    job_id = created.json()["job_id"]
    assert created.json()["result_url"] == (
        f"{_PREFIX}/recordings/{recording_id}/bundle/{job_id}"
    )

    status = _wait_finished(client, job_id, timeout=30.0)
    assert status["status"] == "succeeded", status.get("error")

    result = client.get(f"{_PREFIX}/recordings/{recording_id}/bundle/{job_id}")
    assert result.status_code == 200, result.text
    body = result.json()
    assert body["format"] == "session"
    assert body["zip_url"] == (
        f"{_PREFIX}/recordings/{recording_id}/bundle/{job_id}/zip"
    )
    assert "manifest.json" in body["files"]

    zip_response = client.get(body["zip_url"])
    assert zip_response.status_code == 200, zip_response.text[:200]
    assert zip_response.headers["content-type"].startswith("application/zip")
    assert "attachment" in zip_response.headers["content-disposition"]
    etag = zip_response.headers["etag"]
    assert etag

    cached = client.get(body["zip_url"], headers={"If-None-Match": etag})
    assert cached.status_code == 304 and cached.content == b""

    # Чужой recording_id задачу не подбирает (как у всех задач записи)
    foreign = client.get(f"{_PREFIX}/recordings/rec-foreign/bundle/{job_id}")
    assert foreign.status_code == 404

    # Кэш очищен вместе с записью — честный 404 с просьбой пересобрать
    clear_bundle_cache(settings, recording_id)
    missing = client.get(body["zip_url"])
    assert missing.status_code == 404
    assert "соберите пакет заново" in missing.json()["detail"]


def test_bundle_unknown_format_is_400_and_unknown_recording_404(client, tmp_path):
    """Кривой формат — 400 с текстом; неизвестная запись — 404 (правило 8)."""
    edf = _bundle_edf(tmp_path, name="fmt.edf")
    recording_id = _upload(client, edf)["recording_id"]

    bad = client.post(
        f"{_PREFIX}/recordings/{recording_id}/bundle", data={"format": "zip7"},
    )
    assert bad.status_code == 400
    assert "format" in bad.json()["detail"]
    assert all(fmt in bad.json()["detail"] for fmt in BUNDLE_FORMATS)

    unknown = client.post(f"{_PREFIX}/recordings/rec-nope/bundle", data={})
    assert unknown.status_code == 404


def test_dipoles_csv_endpoint_empty_and_unknown(client, tmp_path):
    """CSV-выгрузка: пустая запись — честная шапка; неизвестная — 404."""
    edf = _bundle_edf(tmp_path, name="csv.edf")
    recording_id = _upload(client, edf)["recording_id"]

    response = client.get(f"{_PREFIX}/recordings/{recording_id}/dipoles.csv")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/csv")
    assert "attachment" in response.headers["content-disposition"]
    assert response.text.splitlines()[0].startswith("session_id,epoch_id")
    assert len(response.text.splitlines()) == 1, "данных нет — только шапка"

    unknown = client.get(f"{_PREFIX}/recordings/rec-nope/dipoles.csv")
    assert unknown.status_code == 404


def test_job_manifest_endpoint(client, tmp_path):
    """manifest: версии и параметры задачи; 404 — неизвестная задача."""
    edf = _bundle_edf(tmp_path, name="man.edf")
    recording_id = _upload(client, edf)["recording_id"]
    created = client.post(f"{_PREFIX}/recordings/{recording_id}/bundle", data={})
    job_id = created.json()["job_id"]
    _wait_finished(client, job_id, timeout=30.0)

    response = client.get(f"{_PREFIX}/jobs/{job_id}/manifest")
    assert response.status_code == 200, response.text
    manifest = response.json()
    assert manifest["manifest_version"] == 1
    assert manifest["kind"] == "bundle"
    assert manifest["recording_id"] == recording_id
    # params_sig — repr параметров задачи (тот же отпечаток, что в истории)
    assert manifest["params_sig"] and "format='session'" in manifest["params_sig"]
    assert manifest["versions"].get("python")
    assert manifest["versions"].get("mne")
    assert manifest["assets"]
    # Контракт RunManifestOut: лишних ключей нет
    assert set(manifest) == {
        "manifest_version", "kind", "recording_id", "params_sig",
        "finished_at", "versions", "assets",
    }

    unknown = client.get(f"{_PREFIX}/jobs/00000000-0000-0000-0000-000000000000/manifest")
    assert unknown.status_code == 404


def test_manifest_is_saved_next_to_result_in_job_file():
    """Run manifest пишется в файл задачи рядом с результатом (сам манифест)."""
    from app.services import job_store

    record = {
        "job_id": "manifest-test-job",
        "kind": "spectrum",
        "meta": {"recording_id": "rec-x", "params_sig": "SpectrumParams()"},
        "finished_at": "2026-10-04T12:00:00",
    }
    path = job_store.save_record(settings, record)
    assert path is not None
    try:
        with open(path, encoding="utf-8") as fh:
            payload = json.load(fh)
        manifest = payload["manifest"]
        assert manifest["manifest_version"] == 1
        assert manifest["kind"] == "spectrum"
        assert manifest["params_sig"] == "SpectrumParams()"
        assert manifest["finished_at"] == "2026-10-04T12:00:00"
        assert manifest["versions"].get("python")
        assert manifest["assets"]
    finally:
        os.remove(path)