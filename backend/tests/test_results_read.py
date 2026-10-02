"""Read-API сессий (4.7): ``GET /sessions`` и дочерние строки.

Проверяем инварианты read из `docs/rules/results-db.md`: страница с честным
``total``, счётчики детей, 404 на неизвестную сессию (не пустой список),
мощности эпох — честные ``None``, фильтры и пагинация. Сид — через тот же
write-API (4.4), что и прод: read обязан видеть ровно те строки.
"""
import asyncio
import os
import shutil

import pytest
from sqlalchemy import select

from app.core.config import settings
from app.models import db as db_module
from app.services import recording_store, results_store
from app.services.dipole_scanner import DipoleScanParams
from app.services.preprocess import PreprocessParams
from app.services.recordings import recording_registry
from tests.test_recording_store import _recording

_PREFIX = "/api/v1"
_REC = "rec-read-api"


def _upload_dirs() -> set[str]:
    root = settings.upload_dir
    if not os.path.isdir(root):
        return set()
    return {name for name in os.listdir(root) if os.path.isdir(os.path.join(root, name))}


@pytest.fixture(autouse=True)
def clean_state():
    """Строки теста убираются до и после: общая tmp-БД не помнит соседей."""
    asyncio.run(recording_store.drop_recording_rows(_REC))
    recording_registry.clear()
    before = _upload_dirs()
    yield
    asyncio.run(recording_store.drop_recording_rows(_REC))
    recording_registry.clear()
    for name in _upload_dirs() - before:
        shutil.rmtree(os.path.join(settings.upload_dir, name), ignore_errors=True)


def _seed() -> tuple[str, str]:
    """Две сессии записи: preprocess (3 эпохи, 1 отброшена) и dipoles (2 точки).

    Возвращает ``(id дипольной, id нарезочной)`` — порядок kind: 'dipoles' < 'preprocess'.
    """
    rec = _recording(_REC)
    preprocess_params = PreprocessParams(stage="epochs", epoch_length_ms=1000.0)
    preprocess_result = {
        "recording_id": _REC,
        "stage": "epochs",
        "epoch_length_ms": 1000.0,
        "n_epochs_total": 3,
        "n_epochs_used": 2,
        "rejected_epochs": [1],
        "sfreq": 250.0,
    }
    asyncio.run(results_store.persist_recording_result(
        "preprocess", rec, preprocess_params, preprocess_result, "job-read-pre",
    ))

    dipole_params = DipoleScanParams(filter_band=(4, 8), epoch_length_ms=1000.0)
    dipole_result = {
        "recording_id": _REC,
        "filter_band_hz": [4.0, 8.0],
        "epoch_length_ms": 1000.0,
        "sfreq": 250.0,
        "method": "fast_grid",
        "points": [
            {
                "epoch_index": 0,
                "time_ms": 120.0,
                "mni_coords": [-42.0, -18.0, 58.0],
                "amplitude_nam": 12.5,
                "gof": 0.91,
                "anatomical_structure": "таламус (слева)",
                "brodmann_area": "BA7-lh",
            },
            {
                "epoch_index": 2,
                "time_ms": 880.0,
                "mni_coords": None,  # MNI не считался — честный None
                "amplitude_nam": 7.0,
                "gof": 0.55,
                "anatomical_structure": None,
                "brodmann_area": None,
            },
        ],
    }
    asyncio.run(results_store.persist_recording_result(
        "dipoles", rec, dipole_params, dipole_result, "job-read-dip",
    ))

    async def _ids() -> list[str]:
        await db_module.init_db()
        async with db_module.AsyncSessionLocal() as session:
            rows = await session.scalars(
                select(db_module.Session.id)
                .where(db_module.Session.recording_id == _REC)
                .order_by(db_module.Session.kind)
            )
            return list(rows.all())

    ids = asyncio.run(_ids())
    assert len(ids) == 2, "сид обязан дать ровно две сессии"
    return ids[0], ids[1]


def test_sessions_page_honest_total_and_counts(client):
    """Страница: total до пагинации, счётчики детей, фильтры recording_id/kind."""
    first, second = _seed()

    page = client.get(f"{_PREFIX}/sessions", params={"recording_id": _REC})
    assert page.status_code == 200, page.text
    body = page.json()
    assert body["total"] == 2
    assert len(body["items"]) == 2

    by_kind = {item["kind"]: item for item in body["items"]}
    assert by_kind["preprocess"]["n_epochs"] == 3
    assert by_kind["preprocess"]["n_epochs_rejected"] == 1
    assert by_kind["preprocess"]["n_dipoles"] == 0
    assert by_kind["dipoles"]["n_epochs"] == 2  # сетка из точек, одна точка на эпоху
    assert by_kind["dipoles"]["n_dipoles"] == 2
    assert by_kind["dipoles"]["freq_band"] == "4-8"

    # Пагинация не прячет общий размер
    page1 = client.get(
        f"{_PREFIX}/sessions", params={"recording_id": _REC, "limit": 1},
    ).json()
    assert page1["total"] == 2 and len(page1["items"]) == 1
    page2 = client.get(
        f"{_PREFIX}/sessions",
        params={"recording_id": _REC, "limit": 1, "offset": 1},
    ).json()
    assert page2["total"] == 2 and len(page2["items"]) == 1
    assert page1["items"][0]["id"] != page2["items"][0]["id"]

    # Фильтр kind
    only_dip = client.get(
        f"{_PREFIX}/sessions", params={"recording_id": _REC, "kind": "dipoles"},
    ).json()
    assert only_dip["total"] == 1
    assert only_dip["items"][0]["id"] in (first, second)

    # Чужая запись — пустая страница, а не 404
    foreign = client.get(
        f"{_PREFIX}/sessions", params={"recording_id": "rec-nope"},
    ).json()
    assert foreign["total"] == 0 and foreign["items"] == []


def test_session_detail_and_404(client):
    """Паспорт счётчиками и ключами мощностей; неизвестная сессия — 404."""
    dipole_session, _ = _seed()

    detail = client.get(f"{_PREFIX}/sessions/{dipole_session}")
    assert detail.status_code == 200, detail.text
    body = detail.json()
    assert body["recording_id"] == _REC
    assert body["power_bands"] == list(settings.freq_bands)
    assert body["n_epochs"] == 2 and body["n_dipoles"] == 2

    missing = client.get(f"{_PREFIX}/sessions/session-nope")
    assert missing.status_code == 404
    assert "не найдена" in missing.json()["detail"]


def test_session_epochs_powers_and_pagination(client):
    """Эпохи: ключи freq_bands, has_artifact — bool, пагинация по epoch_index."""
    dipole_session, _ = _seed()

    epochs = client.get(f"{_PREFIX}/sessions/{dipole_session}/epochs")
    assert epochs.status_code == 200, epochs.text
    rows = epochs.json()
    assert [row["epoch_index"] for row in rows] == [0, 2]
    assert all(row["session_id"] == dipole_session for row in rows)
    for row in rows:
        assert set(row["powers"]) == set(settings.freq_bands)
        # Задача UI не пишет PSD: честные None, а не нули
        assert all(value is None for value in row["powers"].values())
        assert row["has_artifact"] is False

    paged = client.get(
        f"{_PREFIX}/sessions/{dipole_session}/epochs", params={"limit": 1},
    ).json()
    assert len(paged) == 1 and paged[0]["epoch_index"] == 0

    missing = client.get(f"{_PREFIX}/sessions/session-nope/epochs")
    assert missing.status_code == 404


def test_session_dipoles_mni_and_band_filter(client):
    """Диполи: MNI-список/честный None, фильтр полосы, 404 без сессии."""
    dipole_session, _ = _seed()

    dipoles = client.get(f"{_PREFIX}/sessions/{dipole_session}/dipoles")
    assert dipoles.status_code == 200, dipoles.text
    rows = dipoles.json()
    assert len(rows) == 2
    assert rows[0]["mni"] == [-42.0, -18.0, 58.0]
    assert rows[0]["anatomical_roi"] == "таламус (слева)"
    assert rows[0]["method"] == "fast_grid"
    assert rows[1]["mni"] is None  # MNI не считался
    assert rows[1]["gof"] == 0.55

    # Фильтр полосы: своя — 2, чужая — пустой список (не 404)
    same = client.get(
        f"{_PREFIX}/sessions/{dipole_session}/dipoles", params={"freq_band": "4-8"},
    ).json()
    assert len(same) == 2
    other = client.get(
        f"{_PREFIX}/sessions/{dipole_session}/dipoles", params={"freq_band": "40-80"},
    ).json()
    assert other == []

    missing = client.get(f"{_PREFIX}/sessions/session-nope/dipoles")
    assert missing.status_code == 404
