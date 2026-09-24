"""Тесты REST API: служебные эндпоинты и валидация /analyze."""
import io
from datetime import datetime

from app.utils.versions import code_freshness


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
    # Трекер обновления бэкенда: блок code с флагом «процесс старше кода»
    assert set(body["code"]) == {"code_mtime", "server_started_at", "stale"}
    assert isinstance(body["code"]["stale"], bool)


def test_code_freshness_flags_stale_process(tmp_path):
    """Исходники новее старта процесса — бэкенд не обновлён (случай 24.09.2026).

    Симптомы устаревшего процесса в UI: счётчики артефактов разъезжаются между
    тултипом и пиулями, нарезка эпох падает по старым зонам.
    """
    module = tmp_path / "mod.py"
    module.write_text("x = 1\n", encoding="utf-8")
    start = datetime.now()
    assert code_freshness(tmp_path, started_at=start)["stale"] is False

    module.write_text("x = 2\n", encoding="utf-8")
    stale = code_freshness(tmp_path, started_at=start)
    assert stale["stale"] is True


def test_docs_available(client):
    assert client.get("/docs").status_code == 200


def test_ui_index_is_not_heuristically_cached(client):
    """index.html отдаётся с no-cache: эвристика браузера держала старый бандл

    (случай 24.09.2026: «меню пиуль не появляется» при свежей сборке).
    """
    r = client.get("/ui/")
    assert r.status_code == 200
    assert r.headers.get("cache-control") == "no-cache"


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
