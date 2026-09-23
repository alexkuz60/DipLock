"""Тесты строк БД пайплайна анализа и сборки эпох (F21).

Проверяет то, чего раньше не было вовсе: таблица ``epochs`` заполняется, а
``dipoles.epoch_id`` — **настоящая ссылка** на ``epochs.id``, а не номер эпохи.
В SQLite внешние ключи по умолчанию не проверяются, поэтому проверяем связь
явно (``PRAGMA foreign_key_check`` + join) — именно этого не хватало: в
PostgreSQL (прод) висящая ссылка отклоняет вставку.
"""
import asyncio
import sqlite3
from typing import Any

import mne
import numpy as np
import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.config import settings
from app.models import db as db_module
from app.services.analysis_pipeline import save_analysis_to_db
from app.services.bandpass_filter import compute_band_power, compute_band_powers
from app.services.epoch_segmenter import epoch_records, make_epoch_events, segment_epochs


def _rows(path, sql: str) -> list:
    """Строки изолированной SQLite (своё соединение: тест и сервис не делят его)."""
    con = sqlite3.connect(path)
    try:
        return con.execute(sql).fetchall()
    finally:
        con.close()


@pytest.fixture
def sqlite_db(tmp_path, monkeypatch):
    """Изолированная БД: подменяет сессию и ``init_db`` модуля моделей."""
    path = tmp_path / "analysis.db"
    engine = create_async_engine(f"sqlite+aiosqlite:///{path}")
    maker = async_sessionmaker(engine, expire_on_commit=False)

    async def _init():
        async with engine.begin() as conn:
            await conn.run_sync(db_module.Base.metadata.create_all)

    monkeypatch.setattr(db_module, "AsyncSessionLocal", maker)
    monkeypatch.setattr(db_module, "init_db", _init)
    asyncio.run(_init())
    return path


def _result(**overrides) -> dict[str, Any]:
    """Результат пайплайна для записи в БД: 3 эпохи, 2 best-fit диполя."""
    result: dict[str, Any] = {
        "session_id": "session-db",
        "filename": "rec.edf",
        "n_channels": 18,
        "sfreq": 500.0,
        "duration_sec": 6.0,
        "epoch_length_ms": 2000.0,
        "freq_band": "all",
        "epochs": [
            {
                "epoch_index": 0, "start_time_sec": 0.0, "duration_ms": 2000.0,
                "has_artifact": False,
                "band_powers": {
                    "delta_power": 1.0, "theta_power": 2.0,
                    "alpha_power": 3.0, "beta_power": 4.0,
                },
            },
            {
                "epoch_index": 1, "start_time_sec": 2.0, "duration_ms": 2000.0,
                "has_artifact": True, "band_powers": {},
            },
            {
                "epoch_index": 2, "start_time_sec": 4.0, "duration_ms": 2000.0,
                "has_artifact": False,
                "band_powers": {
                    "delta_power": 5.0, "theta_power": 6.0,
                    "alpha_power": 7.0, "beta_power": 8.0,
                },
            },
        ],
        "dipoles": [
            {"epoch_index": 0, "trajectory": [{"time_ms": 100.0}]},
            {"epoch_index": 2, "trajectory": []},
        ],
        "best_fit_dipoles": [
            {
                "epoch_index": 0, "time_ms": 100.0,
                "mni_x": 1.0, "mni_y": 2.0, "mni_z": 3.0,
                "amplitude_nam": 40.0, "gof": 0.9,
                "anatomical_roi": "precentral-lh", "brodmann_area": "BA4-lh",
            },
            {
                "epoch_index": 2, "time_ms": 80.0,
                "mni_x": 4.0, "mni_y": 5.0, "mni_z": 6.0,
                "amplitude_nam": 30.0, "gof": 0.8,
                "anatomical_roi": "postcentral-lh", "brodmann_area": "BA3-lh",
            },
        ],
    }
    result.update(overrides)
    return result


# ---------- сборка записей эпох (без БД) ----------

def _raw_with_rejected_epoch() -> mne.io.RawArray:
    """Синтетическая запись 4 с: во второй секунде спайк 1000 мкВ (его роняет BAD_)."""
    sfreq = 250.0
    ch_names = list(settings.standard_channels)
    rng = np.random.RandomState(7)
    data = rng.randn(len(ch_names), int(sfreq * 4.0)) * 1e-6
    data[0, 300: 305] = 1e-3  # 1000 мкВ в середине второй секунды
    raw = mne.io.RawArray(data, mne.create_info(ch_names, sfreq, "eeg"), verbose=False)
    for montage in ("colin27_1020", "standard_1020"):
        try:
            raw.set_montage(montage, on_missing="ignore", verbose=False)
            break
        except (ValueError, KeyError):
            continue
    return raw


def _epochs_with_spike():
    """Raw + нарезанные эпохи (одна отброшена BAD_-аннотацией, последняя короче окна).

    Amplitude reject MNE отключён: всплеск больше не роняет эпоху сам по себе —
    его, как это делают детекторы, помечает аннотация ``BAD_peak_to_peak``.
    """
    raw = _raw_with_rejected_epoch()
    epochs = segment_epochs(
        raw,
        mne.Annotations([1.2], [0.05], ["BAD_peak_to_peak"]),
        epoch_length_ms=1000.0,
    )
    return raw, epochs


def test_epoch_records_marks_dropped_epochs_and_keeps_order():
    """``epoch_records`` описывает все эпохи, помечает отброшенные и держит порядок."""
    raw, epochs = _epochs_with_spike()
    events = make_epoch_events(raw, 1000.0)
    # Часть эпох отброшена: в объекте MNE их нет, но начала лежат в `events`.
    assert len(events) == len(epochs.drop_log) > len(epochs)

    _means, per_epoch = compute_band_powers(epochs, settings.freq_bands)
    records = epoch_records(epochs, events, 1000.0, per_epoch)

    assert [r["epoch_index"] for r in records] == list(range(len(events)))
    assert [r["has_artifact"] for r in records] == [bool(reason) for reason in epochs.drop_log]
    assert records[1]["has_artifact"] is True
    assert records[0]["has_artifact"] is False and records[0]["band_powers"]
    # Отброшенная эпоха PSD не считался — мощностей у неё нет, а не нули.
    assert records[1]["band_powers"] == {}
    # Мощности прошедших эпох идут в порядке эпох (selection), а не «как получилось».
    for pos, epoch_index in enumerate(epochs.selection):
        assert records[epoch_index]["band_powers"]["alpha_power"] == pytest.approx(
            float(per_epoch["alpha"][pos])
        )
    assert records[1]["start_time_sec"] == pytest.approx(float(events[1, 0]) / raw.info["sfreq"])
    assert all(record["duration_ms"] == 1000.0 for record in records)


def test_epoch_records_without_powers_has_empty_bands():
    """Без мощностей записи всё равно собираются (БД пишет NULL, не 0)."""
    raw, epochs = _epochs_with_spike()
    records = epoch_records(epochs, make_epoch_events(raw, 1000.0), 1000.0)
    assert len(records) == len(epochs.drop_log)
    assert all(record["band_powers"] == {} for record in records)


# ---------- запись в БД ----------

def test_save_analysis_writes_epochs_sessions_and_dipoles(sqlite_db):
    """Эпохи, сессия и диполи попадают в БД одним сохранением."""
    asyncio.run(save_analysis_to_db(_result()))

    assert _rows(sqlite_db, "select count(*) from sessions")[0][0] == 1
    assert _rows(sqlite_db, "select count(*) from epochs")[0][0] == 3
    assert _rows(sqlite_db, "select count(*) from dipoles")[0][0] == 2

    # Мощности по диапазонам доезжают в свои колонки, у отброшенной — NULL.
    powers = _rows(
        sqlite_db,
        "select epoch_index, alpha_power, beta_power, has_artifact "
        "from epochs order by epoch_index",
    )
    assert [row[0] for row in powers] == [0, 1, 2]
    assert [row[3] for row in powers] == [0, 1, 0]
    assert powers[0][1] == pytest.approx(3.0) and powers[0][2] == pytest.approx(4.0)
    assert powers[1][1] is None and powers[1][2] is None
    assert powers[2][1] == pytest.approx(7.0)


def test_dipole_epoch_id_is_real_foreign_key(sqlite_db):
    """``dipoles.epoch_id`` ссылается на id эпохи, и ссылка не висит (F21)."""
    asyncio.run(save_analysis_to_db(_result()))

    linked = _rows(
        sqlite_db,
        "select e.epoch_index from dipoles d join epochs e on d.epoch_id = e.id "
        "order by e.epoch_index",
    )
    assert [row[0] for row in linked] == [0, 2]
    # Главная проверка: висящих ссылок нет (в SQLite FK молчит, в PostgreSQL — нет).
    assert _rows(sqlite_db, "pragma foreign_key_check") == []


def test_dipole_trajectory_is_kept_and_epoch_id_is_row_id(sqlite_db):
    """``epoch_id`` — id строки БД (1, 3), а не номер эпохи (0, 2); траектория сохранена."""
    asyncio.run(save_analysis_to_db(_result()))

    rows = _rows(
        sqlite_db,
        "select d.epoch_id, d.trajectory_json, e.epoch_index "
        "from dipoles d join epochs e on d.epoch_id = e.id order by e.epoch_index",
    )
    assert [row[0] for row in rows] == [1, 3]
    assert [row[2] for row in rows] == [0, 2]
    assert '"time_ms": 100.0' in rows[0][1]


def test_save_result_without_epochs_keeps_dipoles_unlinked(sqlite_db):
    """Старый результат (без ``epochs``) не ломает сохранение: ``epoch_id`` = NULL."""
    asyncio.run(save_analysis_to_db(_result(epochs=[])))

    assert _rows(sqlite_db, "select count(*) from epochs")[0][0] == 0
    assert _rows(sqlite_db, "select count(*) from dipoles")[0][0] == 2
    assert _rows(sqlite_db, "select epoch_id from dipoles") == [(None,), (None,)]
    assert _rows(sqlite_db, "pragma foreign_key_check") == []


def test_dipole_without_matching_epoch_is_not_linked(sqlite_db):
    """Диполь с эпохой, которой нет в списке, пишется без ссылки (не падаем)."""
    result = _result()
    result["best_fit_dipoles"][1]["epoch_index"] = 99
    asyncio.run(save_analysis_to_db(result))

    assert _rows(sqlite_db, "select epoch_id from dipoles") == [(1,), (None,)]
    assert _rows(sqlite_db, "pragma foreign_key_check") == []


# ---------- мощности по эпохам (общий PSD) ----------

def test_compute_band_powers_returns_per_epoch_and_means(epochs_alpha):
    """``compute_band_powers`` даёт и средние, и мощности по эпохам — один расчёт."""
    means, per_epoch = compute_band_powers(epochs_alpha, settings.freq_bands)

    assert means == pytest.approx(compute_band_power(epochs_alpha, settings.freq_bands))
    for name, values in per_epoch.items():
        assert len(values) == len(epochs_alpha)
        assert float(np.mean(values)) == pytest.approx(means[name])


def test_compute_band_powers_empty_bands(epochs_alpha):
    """Без диапазонов оба словаря пусты (пайплайн не обязан их проверять)."""
    assert compute_band_powers(epochs_alpha, {}) == ({}, {})
