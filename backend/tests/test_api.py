"""Тесты REST API: служебные эндпоинты и валидация /analyze."""
import io


def _files(content: bytes = b"noise", name: str = "rec.edf"):
    return {"file": (name, io.BytesIO(content), "application/octet-stream")}


# ---------- служебные эндпоинты ----------

def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok", "service": "dip-lock-backend"}


def test_root_serves_html(client):
    r = client.get("/")
    assert r.status_code == 200
    assert "DipLock" in r.text


def test_init_status_shape(client):
    r = client.get("/init-status")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] in {"ready", "pending"}
    assert {"mne", "config", "database"} <= set(body["checks"])


def test_docs_available(client):
    assert client.get("/docs").status_code == 200


# ---------- валидация /analyze ----------

def test_analyze_requires_file(client):
    assert client.post("/api/v1/analyze").status_code == 422


def test_analyze_rejects_non_edf(client):
    r = client.post("/api/v1/analyze", files=_files(name="rec.txt"))
    assert r.status_code == 400
    assert ".edf" in r.json()["detail"]


def test_analyze_rejects_bad_epoch_length(client):
    r = client.post(
        "/api/v1/analyze", files=_files(), data={"epoch_length_ms": 123.0},
    )
    assert r.status_code == 400
    assert "epoch_length_ms" in r.json()["detail"]


def test_analyze_rejects_bad_freq_band(client):
    r = client.post(
        "/api/v1/analyze", files=_files(), data={"freq_band": "bogus"},
    )
    assert r.status_code == 400
    assert "freq_band" in r.json()["detail"]


def test_analyze_single_freq_requires_all_band(client):
    r = client.post(
        "/api/v1/analyze", files=_files(),
        data={"single_freq": 10.0, "freq_band": "alpha"},
    )
    assert r.status_code == 400
    assert "single_freq" in r.json()["detail"]
