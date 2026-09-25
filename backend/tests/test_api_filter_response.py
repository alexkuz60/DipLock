"""`GET /filter-response` (шаг 2.5): АЧХ фильтра для UI — форма и 400-тексты.

Лёгкий синхронный расчёт (не задача): контракт `FilterResponseOut` из
`schemas/analysis.py`, расчёт — `services/filter_design.filter_response`.
"""
import pytest


def test_filter_response_band_returns_passband_curve(client):
    response = client.get(
        "/api/v1/filter-response", params={"band_min": 1.0, "band_max": 40.0, "sfreq": 500.0},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["method"] == "fir"
    assert body["band_hz"] == [1.0, 40.0]
    assert len(body["freqs_hz"]) == len(body["gain_db"]) and len(body["freqs_hz"]) > 300
    assert body["filter_length_sec"] and body["filter_length_sec"] > 0
    assert body["edge_buffer_sec"] == pytest.approx(body["filter_length_sec"] / 2)
    # 0 дБ в полосе пропускания
    gain_by_freq = dict(zip(body["freqs_hz"], body["gain_db"], strict=True))
    nearest = min(gain_by_freq, key=lambda freq: abs(freq - 10.0))
    assert abs(gain_by_freq[nearest]) < 1.0


def test_filter_response_narrow_band_reports_iir(client):
    response = client.get(
        "/api/v1/filter-response",
        params={"band_min": 7.58, "band_max": 8.08, "sfreq": 500.0},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["method"] == "iir"
    assert body["filter_length_sec"] is None
    assert body["edge_buffer_sec"] == 0.0


def test_filter_response_notch_with_harmonics(client):
    response = client.get(
        "/api/v1/filter-response",
        params={"notch_hz": 50.0, "notch_harmonics": 2, "sfreq": 500.0},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["method"] == "none"  # только notch — полосы нет
    assert body["notch_freqs"] == [50.0, 100.0, 150.0]
    gain_by_freq = dict(zip(body["freqs_hz"], body["gain_db"], strict=True))
    for probe in (50.0, 100.0, 150.0):
        nearest = min(gain_by_freq, key=lambda freq: abs(freq - probe))
        assert gain_by_freq[nearest] < -20.0, probe


@pytest.mark.parametrize(
    ("params", "detail"),
    [
        ({}, "Задайте полосу"),
        ({"band_min": 1.0}, "парой band_min и band_max"),
        ({"band_min": 40.0, "band_max": 1.0}, "меньше band_max"),
        ({"band_min": 1.0, "band_max": 40.0, "notch_harmonics": 7}, "0…4"),
        ({"band_min": 1.0, "band_max": 40.0, "sfreq": 10.0}, "50 до 2000"),
        ({"band_min": 1.0, "band_max": 40.0, "notch_hz": 300.0}, "Nyquist"),
    ],
)
def test_filter_response_validates_params(client, params, detail):
    response = client.get("/api/v1/filter-response", params=params)
    assert response.status_code == 400
    assert detail in response.json()["detail"]
