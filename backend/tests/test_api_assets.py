"""Тесты единого помощника отдачи ассетов (A2, этап 3).

До этапа 3 условия ``304`` и заголовки ассетов собирались вручную в пяти
эндпоинтах, и ассеты расходились мелочами: где-то ETag собирался составным, где-то
``Cache-Control`` был другим. Здесь проверяется контракт помощника (тег, условие
304, метаданные) и то, что ручных копий в коде больше нет.
"""
from pathlib import Path

import pytest

from app.api.assets import (
    CACHE_PRIVATE_DAY,
    CACHE_PRIVATE_HOUR,
    CACHE_PUBLIC_DAY,
    CACHE_PUBLIC_WEEK,
    asset_response,
    byte_range_response,
    etag_matches,
    normalize_etag,
)

_APP_DIR = Path(__file__).resolve().parents[1] / "app"


@pytest.mark.parametrize("raw,expected", [
    ('"v1"', "v1"),
    ('W/"v1"', "v1"),
    ("v1", "v1"),
    ('  "v1"  ', "v1"),
])
def test_normalize_etag(raw, expected):
    """Сравнение идёт по версии: кавычки и признак слабости тега не мешают."""
    assert normalize_etag(raw) == expected


@pytest.mark.parametrize("header,matched", [
    (None, False),
    ("", False),
    ('"v1"', True),
    # Браузер вернёт тег как получил; слабый тег и тег без кавычек — тот же ассет
    ('W/"v1"', True),
    ("v1", True),
    ('"other", "v1"', True),
    ("*", True),
    # Сравнение по частям: "v1" не должен совпадать с "v10" (подстрочный поиск совпадал)
    ('"v10"', False),
    ('"v1x"', False),
])
def test_etag_matches(header, matched):
    """``If-None-Match`` разбирается как список тегов, а не как подстрока."""
    assert etag_matches(header, "v1") is matched


def test_asset_response_200_carries_etag_and_cache_control():
    """Обычная отдача: тело, ETag в кавычках и заголовок кэша по типу ассета."""
    response = asset_response(b"payload", "v1")

    assert response.status_code == 200
    assert response.body == b"payload"
    assert response.headers["etag"] == '"v1"'
    assert response.headers["cache-control"] == CACHE_PUBLIC_DAY
    assert response.media_type == "application/json"


def test_asset_response_304_has_no_body_but_keeps_metadata():
    """``304`` не несёт тело, но повторяет метаданные ассета (``X-…``)."""
    response = asset_response(
        b"payload", "v1",
        if_none_match='"v1"',
        media_type="image/png",
        cache_control=CACHE_PRIVATE_HOUR,
        headers={"X-Mri-Slice-Mm": "12"},
    )

    assert response.status_code == 304
    assert not response.body
    assert response.headers["etag"] == '"v1"'
    assert response.headers["cache-control"] == CACHE_PRIVATE_HOUR
    assert response.headers["x-mri-slice-mm"] == "12"


def test_asset_response_composite_version_is_quoted_as_a_whole():
    """Составная версия (плита + срез) — один тег: клиент сравнивает его целиком."""
    response = asset_response(b"png", "v1-axial-12", cache_control=CACHE_PUBLIC_WEEK)

    assert response.headers["etag"] == '"v1-axial-12"'
    assert response.headers["cache-control"] == CACHE_PUBLIC_WEEK


def test_asset_response_media_type_and_private_cache():
    """Производные записи качаются приватно (TTL записи), картинки — своим типом."""
    response = asset_response(
        b"grid", "v1", media_type="application/octet-stream",
        cache_control=CACHE_PRIVATE_DAY, headers={"X-Spectrogram-Channel": "Fp1"},
    )

    assert response.media_type == "application/octet-stream"
    assert response.headers["cache-control"] == CACHE_PRIVATE_DAY
    assert response.headers["x-spectrogram-channel"] == "Fp1"


def test_304_condition_lives_only_in_assets_module():
    """Правило 4 ``docs/rules/api-jobs.md``: ручных копий ETag/304 быть не должно."""
    offenders = [
        path.relative_to(_APP_DIR).as_posix()
        for path in _APP_DIR.rglob("*.py")
        if path.name != "assets.py" and "status_code=304" in path.read_text(encoding="utf-8")
    ]

    assert offenders == []


@pytest.mark.parametrize("header,status,span", [
    (None, 200, None),
    ("bytes=0-9", 206, (0, 9)),
    ("bytes=10-", 206, (10, 19)),
    ("bytes=-5", 206, (15, 19)),
    # Конец за файлом обрезается, а не отвергается (RFC 9110).
    ("bytes=15-999", 206, (15, 19)),
    # Мусор и многодиапазонный заголовок — файл целиком, как разрешает RFC.
    ("items=0-9", 200, None),
    ("bytes=abc", 200, None),
    ("bytes=5-2", 200, None),
    ("bytes=0-1,4-5", 200, None),
])
def test_byte_range_response_slices(header, status, span):
    """``Range`` режется по границам; непонятный заголовок не ломает отдачу."""
    response = byte_range_response(b"0123456789abcdefghij", range_header=header)

    assert response.status_code == status
    assert response.headers["accept-ranges"] == "bytes"
    if span is None:
        assert response.body == b"0123456789abcdefghij"
        assert "content-range" not in response.headers
    else:
        start, end = span
        assert response.body == b"0123456789abcdefghij"[start : end + 1]
        assert response.headers["content-range"] == f"bytes {start}-{end}/20"


def test_byte_range_response_416_reports_size():
    """Диапазон за пределами файла — ``416`` и размер в ``Content-Range``."""
    response = byte_range_response(b"0123456789", range_header="bytes=10-")

    assert response.status_code == 416
    assert not response.body
    assert response.headers["content-range"] == "bytes */10"
