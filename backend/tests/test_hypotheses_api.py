"""HTTP-контракт роутера гипотез (срез 4): шлюзы 400 и форма ответа 200."""
from app.core.config import settings
from app.schemas.hypotheses import HypothesisCheckOut


def _check_body(**overrides) -> dict:
    body = {
        "label": "тестовая гипотеза",
        "band_key": "alpha",
        "conditions": [{"feature": "rotation_ccw_share", "op": ">=", "value": 0.8}],
        "recording_ids": ["rec-api-1", "rec-api-2"],
    }
    body.update(overrides)
    return body


def test_check_endpoint_rejects_unknown_feature(client):
    response = client.post(
        "/api/v1/hypotheses/check",
        json=_check_body(conditions=[{"feature": "telepathy", "op": ">=", "value": 0.5}]),
    )
    assert response.status_code == 400
    assert "Неизвестный признак" in response.json()["detail"]


def test_check_endpoint_rejects_empty_selection_and_unknown_band(client):
    response = client.post(
        "/api/v1/hypotheses/check", json=_check_body(recording_ids=[]),
    )
    assert response.status_code == 400
    assert "Выборка пуста" in response.json()["detail"]
    response = client.post(
        "/api/v1/hypotheses/check", json=_check_body(band_key="omega"),
    )
    assert response.status_code == 400
    assert "Неизвестная полоса" in response.json()["detail"]


def test_check_endpoint_reports_insufficient_for_unknown_recordings(client):
    """Записи без прогонов: честное «не оценено», статус insufficient (M = 0)."""
    response = client.post("/api/v1/hypotheses/check", json=_check_body())
    assert response.status_code == 200, response.text
    result = HypothesisCheckOut.model_validate(response.json())
    assert result.n == 0 and result.m == 0
    assert result.share is None
    assert result.status == "insufficient"
    assert {row.recording_id for row in result.records} == {"rec-api-1", "rec-api-2"}
    assert all(row.passed is None for row in result.records)
    assert result.warnings  # предупреждения «прогонов автоотчёта нет»


def test_probe_context_endpoint_rejects_empty_selection(client):
    response = client.post(
        "/api/v1/hypotheses/probe-context",
        json={"recording_ids": [], "band_key": "alpha"},
    )
    assert response.status_code == 400
    assert "Выборка пуста" in response.json()["detail"]


def test_probe_context_endpoint_shape(client):
    response = client.post(
        "/api/v1/hypotheses/probe-context",
        json={"recording_ids": ["rec-api-ghost"], "band_key": "alpha"},
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["band_key"] == "alpha"
    assert payload["band_hz"] == list(
        dict(settings.freq_bands, **settings.functional_bands)["alpha"]
    )
    assert payload["records"][0]["measured"] is False
    assert payload["warnings"]