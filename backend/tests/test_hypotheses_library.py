"""Библиотека правил-гипотез (Т4): сохранение, список, удаление, перепроверка.

Проверяем: валидация при сохранении (400), append без UPSERT, форма строки
без интерпретации, 404 и recheck того же контракта, что `POST /check`.
"""
from app.schemas.hypotheses import HypothesisCheckOut, HypothesisOut


def _save_body(**overrides) -> dict:
    body = {
        "label": "у целителей CCW ≥ 80 % в γ",
        "band_key": "alpha",
        "conditions": [{"feature": "rotation_ccw_share", "op": ">=", "value": 0.8}],
        "min_share": 0.8,
        "recording_ids": ["rec-lib-1", "rec-lib-2"],
    }
    body.update(overrides)
    return body


def test_save_rejects_unknown_feature_and_empty_selection(client):
    response = client.post(
        "/api/v1/hypotheses",
        json=_save_body(conditions=[{"feature": "telepathy", "op": ">=", "value": 0.5}]),
    )
    assert response.status_code == 400
    assert "Неизвестный признак" in response.json()["detail"]
    response = client.post("/api/v1/hypotheses", json=_save_body(recording_ids=[]))
    assert response.status_code == 400
    assert "Выборка пуста" in response.json()["detail"]


def test_library_saves_lists_and_appends_without_upsert(client):
    first = client.post("/api/v1/hypotheses", json=_save_body())
    assert first.status_code == 201, first.text
    row = HypothesisOut.model_validate(first.json())
    assert row.band_key == "alpha"
    assert row.conditions == [
        {"feature": "rotation_ccw_share", "op": ">=", "value": 0.8},
    ]
    assert row.recording_ids == ["rec-lib-1", "rec-lib-2"]

    # Повторное сохранение — новая строка (история, не UPSERT)
    second = client.post("/api/v1/hypotheses", json=_save_body())
    assert second.status_code == 201
    second_row = HypothesisOut.model_validate(second.json())
    assert second_row.id != row.id

    listing = client.get("/api/v1/hypotheses")
    assert listing.status_code == 200
    ids = [item["id"] for item in listing.json()]
    assert row.id in ids and second_row.id in ids

    fetched = client.get(f"/api/v1/hypotheses/{row.id}")
    assert fetched.status_code == 200
    assert fetched.json()["label"] == row.label


def test_delete_and_recheck_lifecycle(client):
    created = client.post("/api/v1/hypotheses", json=_save_body())
    hypothesis_id = HypothesisOut.model_validate(created.json()).id

    # Recheck: нет прогонов автоотчёта — insufficient (M = 0), контракт как у /check
    recheck = client.post(f"/api/v1/hypotheses/{hypothesis_id}/recheck")
    assert recheck.status_code == 200, recheck.text
    result = HypothesisCheckOut.model_validate(recheck.json())
    assert result.status == "insufficient"
    assert result.n == 0 and result.m == 0
    assert result.share is None

    assert client.delete(f"/api/v1/hypotheses/{hypothesis_id}").status_code == 204
    assert client.get(f"/api/v1/hypotheses/{hypothesis_id}").status_code == 404
    assert client.delete(f"/api/v1/hypotheses/{hypothesis_id}").status_code == 404
    assert client.post(f"/api/v1/hypotheses/{hypothesis_id}/recheck").status_code == 404


def test_draft_rule_endpoint_shapes_candidate_without_verdict(client):
    """Т5: POST /hypotheses/draft-rule — кандидаты условий, min_share = None."""
    response = client.post("/api/v1/hypotheses/draft-rule", json={
        "features": {"kd_passed_share": 0.9, "rotation_ccw_share": 0.82},
        "band_key": "gamma",
        "recording_ids": ["rec-draft-1"],
        "label": "из профиля",
    })
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["min_share"] is None
    assert body["band_key"] == "gamma"
    features = {c["feature"] for c in body["conditions"]}
    assert "kd_passed_share" in features
    assert "rotation_ccw_share" in features

    empty = client.post("/api/v1/hypotheses/draft-rule", json={
        "features": {}, "band_key": "alpha", "recording_ids": ["rec"],
    })
    assert empty.status_code == 400
    assert "нет измеренных признаков" in empty.json()["detail"]
