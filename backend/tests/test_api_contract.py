"""Тесты контракта API (F4/F6/F7/F10): схемы, кэш ассетов, задачи, загрузки.

Тяжёлый пайплайн MNE здесь подменяется быстрой заготовкой: проверяется форма
ответа (``response_model``), поведение job-API и очистка загрузок. Полный
e2e-прогон на реальном EDF — отдельный integration-тест.
"""
import io
import os
import time

import pytest
from fastapi import HTTPException

from app.api import routes, uploads
from app.core.config import settings
from app.services import analysis_pipeline
from app.services.surface_cache import clear_asset_cache

_PREFIX = settings.api_prefix
_LH_INFLATED = os.path.join(settings.subjects_dir, "fsaverage", "surf", "lh.inflated")
_NEEDS_FSAVERAGE = pytest.mark.skipif(
    not os.path.exists(_LH_INFLATED), reason="fsaverage поверхность недоступна",
)


def _trajectory_point(time_ms: float = 100.0) -> dict:
    """Точка траектории, валидная по ``TrajectoryPoint``."""
    return {
        "time_ms": time_ms,
        "pos_head": [1.0, 2.0, 3.0],
        "ori_head": [0.0, 0.0, 1.0],
        "amplitude_nam": 12.5,
        "gof": 0.93,
        "mni_coords": [1.0, 2.0, 3.0],
        "anatomical_structure": "lateraloccipital-lh",
        "brodmann_area": "BA17-lh",
    }


def _fake_analysis_result(session_id: str = "session-test", filename: str = "rec.edf") -> dict:
    """Результат, валидный по ``AnalyzeResponse`` (замена реального пайплайна)."""
    point = _trajectory_point()
    return {
        "session_id": session_id,
        "filename": filename,
        "n_channels": 18,
        "sfreq": 500.0,
        "duration_sec": 10.0,
        "epoch_length_ms": 2000.0,
        "freq_band": "all",
        "n_epochs_total": 5,
        "n_epochs_used": 4,
        "n_epochs_dropped": 1,
        "n_artifacts": 2,
        "artifact_types": {
            "zscore_outlier": 1, "peak_to_peak": 1, "flat_line": 0, "ica_eog": 0,
        },
        "frequency_powers": {"delta": 1.0, "alpha": 2.0},
        "surface": {
            "version": "test-version",
            "url": f"{_PREFIX}/surface",
            "brodmann_url": f"{_PREFIX}/surface/brodmann",
        },
        "epochs": [
            {
                "epoch_index": 0, "start_time_sec": 0.0, "duration_ms": 2000.0,
                "has_artifact": False,
                "band_powers": {"delta_power": 1.0, "alpha_power": 2.0},
            },
            {
                "epoch_index": 1, "start_time_sec": 2.0, "duration_ms": 2000.0,
                "has_artifact": True, "band_powers": {},
            },
        ],
        "dipoles": [{
            "epoch_index": 0,
            "n_time_points": 1,
            "trajectory": [point],
            "best_fit": point,
            "error": None,
        }],
        "best_fit_dipoles": [{
            "epoch_index": 0, "time_ms": 100.0,
            "mni_x": 1.0, "mni_y": 2.0, "mni_z": 3.0,
            "amplitude_nam": 12.5, "gof": 0.93,
            "anatomical_roi": "lateraloccipital-lh", "brodmann_area": "BA17-lh",
        }],
        "results_file": "/tmp/fake.json",
        "pipeline": {
            "app_version": settings.app_version,
            "mne_version": "test",
            "numpy_version": "test",
            "python_version": "3.12",
            "epoch_length_ms": 2000.0,
            "freq_band": "all",
            "single_freq": None,
            "dipole_fit_decim": 5,
            "dipole_fit_max_epochs": 0,
            "z_threshold": 5.0,
            "pp_threshold_uv": 100.0,
            "ica_requested": True,
            "ica_applied": False,
            "edf_units": None,
            "duration_sec": 1.23,
        },
    }


def _files(content: bytes = b"fake-edf", name: str = "rec.edf"):
    """Multipart-загрузка для TestClient."""
    return {"file": (name, io.BytesIO(content), "application/octet-stream")}


def _wait_finished(client, job_id: str, timeout: float = 10.0) -> dict:
    """Ждёт завершения задачи (поллинг, как это делает UI)."""
    deadline = time.time() + timeout
    body: dict = {}
    while time.time() < deadline:
        body = client.get(f"{_PREFIX}/jobs/{job_id}").json()
        if body["status"] in ("succeeded", "failed"):
            return body
        time.sleep(0.05)
    raise AssertionError(f"Задача не завершилась за {timeout} с: {body}")


@pytest.fixture
def isolated_io(tmp_path, monkeypatch):
    """Изолирует каталоги загрузок/результатов/кэша и отключает запись в БД."""
    monkeypatch.setattr(settings, "upload_dir", str(tmp_path / "edf"))
    monkeypatch.setattr(settings, "results_dir", str(tmp_path / "results"))
    monkeypatch.setattr(settings, "cache_dir", str(tmp_path / "cache"))

    async def _no_db(result):
        return None

    monkeypatch.setattr(analysis_pipeline, "save_analysis_to_db", _no_db)
    routes.job_manager.clear()
    return tmp_path


@pytest.fixture
def fake_pipeline(monkeypatch):
    """Подменяет тяжёлый пайплайн на быструю заготовку (контракт без MNE-расчётов)."""
    calls: list = []

    def _fake(progress, filepath, filename, *args, **kwargs):
        calls.append({"filepath": filepath, "filename": filename, "kwargs": kwargs})
        progress("artifacts", 0.3, "детекция артефактов")
        return _fake_analysis_result(session_id=f"session-{len(calls)}", filename=filename)

    monkeypatch.setattr(analysis_pipeline, "run_analysis", _fake)
    return calls


# ---------- служебные эндпоинты и контракт ----------

def test_meta_endpoint_returns_environment(client):
    """GET /meta отдаёт версии, пути и активные параметры (для UI и provenance)."""
    r = client.get(f"{_PREFIX}/meta")
    assert r.status_code == 200
    body = r.json()

    assert body["app"] == settings.app_name
    assert body["app_version"] == settings.app_version
    assert body["python_version"] and body["mne_version"] and body["numpy_version"]
    assert body["database_backend"].split("+")[0] in ("sqlite", "postgresql")
    assert body["freq_bands"]["alpha"] == [8.0, 13.0]
    assert body["standard_channels"] == list(settings.standard_channels)
    assert body["surface_url"] == f"{_PREFIX}/surface"
    assert body["max_concurrent_jobs"] >= 1
    assert any("5173" in origin for origin in body["cors_origins"])


def test_openapi_documents_response_schemas(client):
    """F4: схемы ответов попадают в OpenAPI → из них генерируются TS-типы UI."""
    spec = client.get("/openapi.json").json()
    schemas = spec["components"]["schemas"]
    for name in (
        "AnalyzeResponse", "EpochSummary", "DipoleFit", "TrajectoryPoint", "BestFitDipole",
        "ArtifactThresholds", "PreprocessResult", "ArtifactZoneOut",
        "PipelineInfo", "SurfaceRef", "SurfaceOut",
        "BrodmannAreaOut", "BrodmannLabelsOut", "JobCreated", "JobStatus", "MetaResponse",
    ):
        assert name in schemas, f"в OpenAPI нет схемы {name}"

    paths = spec["paths"]
    for path in (
        f"{_PREFIX}/analyze", f"{_PREFIX}/jobs", f"{_PREFIX}/jobs/{{job_id}}",
        f"{_PREFIX}/jobs/{{job_id}}/result", f"{_PREFIX}/surface",
        f"{_PREFIX}/surface/brodmann", f"{_PREFIX}/surface/brodmann/{{area_name}}",
        f"{_PREFIX}/brodmann-labels", f"{_PREFIX}/meta",
    ):
        assert path in paths, f"в OpenAPI нет пути {path}"


def test_init_status_extended_payload(client):
    """Раздел «Состояние сервера»: версии, пути и признак сборки UI."""
    body = client.get("/init-status").json()
    assert body["status"] in {"ready", "pending"}
    assert {"mne", "config", "database"} <= set(body["checks"])
    assert body["versions"]["python"] and body["versions"]["mne"]
    assert body["ui"]["url"] == "/ui/"
    assert {"subjects_dir", "upload_dir", "results_dir", "cache_dir"} <= set(body["paths"])
    assert body["api"]["meta_url"] == f"{_PREFIX}/meta"


# ---------- санитизация имени загрузки (F10) ----------

@pytest.mark.parametrize("raw,expected", [
    ("rec.edf", "rec.edf"),
    ("../evil.edf", "evil.edf"),
    ("/tmp/../../etc/passwd.edf", "passwd.edf"),
    ("C:\\data\\EEG rec.edf", "EEG_rec.edf"),
    ("EEG F7 (rec).EDF", "EEG_F7_rec_.EDF"),
])
def test_safe_edf_name_sanitizes(raw, expected):
    """Имя загрузки не выходит за upload_dir и не содержит опасных символов."""
    assert uploads.safe_edf_name(raw) == expected


def test_safe_edf_name_default_for_empty():
    """Пустое имя получает безопасный дефолт."""
    assert uploads.safe_edf_name(None) == "recording.edf"
    assert uploads.safe_edf_name("") == "recording.edf"


@pytest.mark.parametrize("raw", ["rec.txt", "rec", "rec.edf.txt"])
def test_safe_edf_name_rejects_non_edf(raw):
    with pytest.raises(HTTPException) as err:
        uploads.safe_edf_name(raw)
    assert err.value.status_code == 400
    assert ".edf" in str(err.value.detail)


# ---------- кэшируемые статические ассеты (F6) ----------

@_NEEDS_FSAVERAGE
def test_surface_asset_is_cached_and_supports_304(client):
    """Меш отдаётся из кэша с ETag; тяжёлые BA-индексы в него не входят."""
    clear_asset_cache()
    first = client.get(f"{_PREFIX}/surface")
    assert first.status_code == 200
    assert first.headers["etag"]
    assert first.headers["cache-control"].startswith("public")

    body = first.json()
    assert body["lh"]["vertex_count"] > 0 and body["rh"]["face_count"] > 0
    assert "ba_labels" not in body  # F6: BA-индексы вынесены в отдельный эндпоинт
    assert body["brodmann_url"] == f"{_PREFIX}/surface/brodmann"

    second = client.get(
        f"{_PREFIX}/surface", headers={"If-None-Match": first.headers["etag"]},
    )
    assert second.status_code == 304


@_NEEDS_FSAVERAGE
def test_brodmann_single_area_is_available(client):
    """По одному полю Бродмана — лёгкий ответ; неизвестная метка → 404."""
    labels = client.get(f"{_PREFIX}/brodmann-labels")
    assert labels.status_code == 200
    names = labels.json()["brodmann_areas"]
    assert names and all(name.startswith("BA") for name in names)
    assert labels.json()["count"] == len(names)

    area = client.get(f"{_PREFIX}/surface/brodmann/{names[0]}")
    assert area.status_code == 200
    payload = area.json()
    assert payload["name"] == names[0]
    assert payload["hemi"] in ("lh", "rh")
    assert payload["n_vertices"] == len(payload["vertices"]) > 0

    assert client.get(f"{_PREFIX}/surface/brodmann/BA999-lh").status_code == 404


# ---------- синхронный анализ и job-API (F7) ----------

def test_analyze_returns_contract_and_cleans_upload(client, isolated_io, fake_pipeline):
    """``/analyze`` отвечает по схеме и удаляет загрузку даже при успехе."""
    r = client.post(f"{_PREFIX}/analyze", files=_files())
    assert r.status_code == 200

    body = r.json()
    assert body["session_id"] == "session-1"
    assert body["n_epochs_total"] == 5 and body["n_epochs_dropped"] == 1
    assert body["surface"]["url"] == f"{_PREFIX}/surface"
    assert body["pipeline"]["app_version"] == settings.app_version
    assert body["best_fit_dipoles"][0]["brodmann_area"] == "BA17-lh"
    # эпохи (включая отброшенные) доезжают до клиента и БД (F21)
    assert [epoch["has_artifact"] for epoch in body["epochs"]] == [False, True]
    assert body["epochs"][0]["band_powers"]["alpha_power"] == 2.0
    # траектория не дублируется в best_fit_dipoles (payload меньше)
    assert "trajectory" not in body["best_fit_dipoles"][0]

    upload_root = isolated_io / "edf"
    assert upload_root.exists() and list(upload_root.iterdir()) == []


def test_analyze_rejects_non_edf_before_pipeline(client, isolated_io, fake_pipeline):
    r = client.post(f"{_PREFIX}/analyze", files=_files(name="rec.txt"))
    assert r.status_code == 400
    assert ".edf" in r.json()["detail"]
    assert fake_pipeline == []  # пайплайн не запускался


def test_job_flow_returns_progress_and_result(client, isolated_io, fake_pipeline):
    """POST /jobs → 202, поллинг статуса с прогрессом, результат, история."""
    created = client.post(f"{_PREFIX}/jobs", files=_files())
    assert created.status_code == 202
    payload = created.json()
    assert payload["status"] in ("queued", "running")
    job_id = payload["job_id"]
    assert payload["poll_url"] == f"{_PREFIX}/jobs/{job_id}"

    status = _wait_finished(client, job_id)
    assert status["status"] == "succeeded"
    assert status["stage"] == "done"
    assert status["progress"] == 1.0
    assert status["elapsed_sec"] is not None
    assert status["result_url"] == f"{_PREFIX}/jobs/{job_id}/result"

    result = client.get(f"{_PREFIX}/jobs/{job_id}/result")
    assert result.status_code == 200
    assert result.json()["session_id"] == "session-1"

    history = client.get(f"{_PREFIX}/jobs").json()
    assert any(job["job_id"] == job_id for job in history)

    # загрузка удалена воркером даже после успеха
    assert list((isolated_io / "edf").iterdir()) == []


def test_job_unknown_ids_and_pending_result(client, isolated_io, fake_pipeline):
    assert client.get(f"{_PREFIX}/jobs/unknown-id").status_code == 404
    assert client.get(f"{_PREFIX}/jobs/unknown-id/result").status_code == 404

    created = client.post(f"{_PREFIX}/jobs", files=_files())
    job_id = created.json()["job_id"]
    # гонка: 409 (ещё считает) или 200 (уже успел) — оба варианта корректны
    assert client.get(f"{_PREFIX}/jobs/{job_id}/result").status_code in (200, 409)
    _wait_finished(client, job_id)


def test_failed_job_reports_error_and_409_on_result(client, isolated_io, monkeypatch):
    """Ошибка пайплайна не роняет сервер: статус failed + текст ошибки в UI."""

    def _boom(progress, *args, **kwargs):
        raise ValueError("Все эпохи отброшены аннотациями BAD_")

    monkeypatch.setattr(analysis_pipeline, "run_analysis", _boom)

    created = client.post(f"{_PREFIX}/jobs", files=_files())
    job_id = created.json()["job_id"]
    status = _wait_finished(client, job_id)

    assert status["status"] == "failed"
    assert "аннотациями BAD_" in status["error"]
    assert status["result_url"] is None
    result = client.get(f"{_PREFIX}/jobs/{job_id}/result")
    assert result.status_code == 409
    assert "аннотациями BAD_" in result.json()["detail"]



