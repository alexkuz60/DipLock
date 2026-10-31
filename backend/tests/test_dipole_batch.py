"""Тесты прогона по набору поддиапазонов (С1) и кластеров пакета (С2).

Проверяем: разбор полос формы (именованные + «свои» от-до, дедуп, 400),
прогон пакета на синтетическом EDF с двумя ритмами (набор результатов, одна
длина эпохи на прогон), **переиспользование ядра перебора** (forward `G` +
inverse `GᵀG` строятся один раз на пакет — §7.1), вердикты КД по максимуму
**своей** полосы (С0), сопоставление полос только нормированными величинами
(в строке сопоставления нет GOF — принцип 3), кластеры и устойчивость по
поддиапазонам (С2), контракт ``DipoleBatchResult`` и write-API
(``analyses``/``analysis_bands``/``dipole_points``).
"""
import asyncio
import os
import shutil
import time

import numpy as np
import pytest
from sqlalchemy import select

from app.api.params import dipole_batch_bands, dipole_batch_params
from app.core.config import settings
from app.models import db as db_module
from app.models.db import Analysis, AnalysisBand, DipolePoint, init_db
from app.schemas.analysis import DipoleBatchResult
from app.services import recording_store, results_store
from app.services.dipole_batch import (
    BandSpec,
    DipoleBatchError,
    DipoleBatchParams,
    batch_signature,
    run_dipole_batch,
)
from app.services.dipole_scanner import _build_kernel, _scan_kernel
from app.services.recordings import recording_registry
from tests.test_dipole_scanner import _register

_PREFIX = "/api/v1"

# Кластеры пакета требуют MNI (`_localize_point` → `mne.head_to_mni`): точки без
# MNI не участвуют в кластеризации (`cluster_points` — честный пропуск), поэтому
# без датасета fsaverage (CI) кластерная ветка скипается — прецедент
# `_NEEDS_FSAVERAGE` (tests/test_api_contract.py; конвенция: ветки с реальными
# данными скипаются без них). Нужны и поверхность, и transform.
_FSAVERAGE_READY = os.path.exists(
    os.path.join(settings.subjects_dir, "fsaverage", "surf", "lh.inflated")
) and os.path.exists(settings.fsaverage_trans)
_NEEDS_FSAVERAGE = pytest.mark.skipif(
    not _FSAVERAGE_READY, reason="fsaverage недоступен (surface/transform)",
)


@pytest.fixture(autouse=True)
def clean_state():
    """Изоляция реестра записей, каталогов загрузок и строк БД между тестами.

    Строки ``analyses``/``dipole_points`` пишет write-API (4.4) — общая tmp-БД
    тестов видит их другим тестам (глобальные счётчики), поэтому строки своих
    записей убираем каскадом §8.4.3.
    """
    recording_registry.clear()
    root = settings.upload_dir
    before = (
        {n for n in os.listdir(root) if os.path.isdir(os.path.join(root, n))}
        if os.path.isdir(root) else set()
    )
    yield
    for recording in recording_registry.list():
        asyncio.run(recording_store.drop_recording_rows(recording.recording_id))
    recording_registry.clear()
    if os.path.isdir(root):
        for name in {n for n in os.listdir(root) if os.path.isdir(os.path.join(root, n))} - before:
            shutil.rmtree(os.path.join(root, name), ignore_errors=True)


def _two_band_edf(tmp_path, seconds: float = 6.0):
    """Синтетический EDF: альфа 10 Гц + бета 20 Гц с разной амплитудой по каналам."""
    from tests.conftest import write_minimal_edf

    path = tmp_path / "batch.edf"
    channels = list(settings.standard_channels[:8])
    sfreq = 250.0
    times = np.arange(int(seconds * sfreq)) / sfreq
    gain = 5.0 + np.arange(len(channels), dtype=float)
    data = (
        np.sin(2 * np.pi * 10 * times)[None, :] * gain[:, None]
        + np.sin(2 * np.pi * 20 * times)[None, :] * (0.5 * gain[:, None])
    )
    write_minimal_edf(path, channels, data, sfreq)
    return path


def _batch(bands: str = "alpha,beta") -> DipoleBatchParams:
    """Параметры пакета через форму (та же валидация, что у роута)."""
    return dipole_batch_params(
        bands=bands, notch_hz=None,
        reference="average", reference_channels=None,
        epoch_length_ms=1000.0, grid_mm=7.0,
        cluster_voxel_norm=0.15, cluster_min_points=2,
    )


def test_batch_bands_parse_named_and_custom():
    """Именованные ключи и «свои» от-до дают BandSpec с адресом band_key."""
    specs = dipole_batch_bands("alpha,2.5-4,alpha")
    assert [s.band_key for s in specs] == ["alpha", "custom:2.5-4"]  # дубль снят
    named, custom = specs
    assert named.lo_hz < named.hi_hz  # границы из каталога freq_bands
    assert (custom.lo_hz, custom.hi_hz) == (2.5, 4.0)
    assert custom.label == "2.5–4 Гц"


def test_batch_bands_require_set_and_reject_unknown():
    """Пакет — это набор: пусто — 400; опечатка — 400 со списком доступных."""
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as empty:
        dipole_batch_bands("")
    assert empty.value.status_code == 400

    with pytest.raises(HTTPException) as unknown:
        dipole_batch_bands("alpha,omega")
    assert "omega" in unknown.value.detail


def test_batch_signature_tracks_bands_and_params():
    """Отпечаток прогона (B7 fingerprint) меняется с набором полос и параметрами."""
    base = _batch()
    same = _batch()
    other_bands = _batch("alpha")
    other_grid = DipoleBatchParams(bands=base.bands, grid_mm=4.0)
    assert batch_signature(base) == batch_signature(same)
    assert batch_signature(base) != batch_signature(other_bands)
    assert batch_signature(base) != batch_signature(other_grid)


def test_run_dipole_batch_returns_band_sets(tmp_path, monkeypatch):
    """Набор результатов: полосы со своими точками, одна длина эпохи на прогон."""
    # Порог X % снят — проверяем ветку «без порогов методики» («не оценено»);
    # живой дефолт X = 5 % и вердикты — в test_kd_criteria.py.
    monkeypatch.setattr(settings, "kd_moment_share", None)
    recording = _register(tmp_path, _two_band_edf(tmp_path), "rec-batch")
    result = run_dipole_batch(recording, settings, _batch("alpha,beta"))

    assert result["method"] == "fast_grid"
    assert result["epoch_length_ms"] == 1000.0  # одна сетка эпох на прогон (п.7)
    assert [b["band_key"] for b in result["bands"]] == ["alpha", "beta"]
    for band in result["bands"]:
        assert band["state"] == "ok"
        assert band["n_points"] > 0
        assert band["moment_max_nam"] > 0
        # КД без порогов методики — честное «не оценено» (None), а не False
        assert band["n_kd_passed"] is None
        assert all(point["kd_passed"] is None for point in band["points"])
    # Контракт валидируется на месте (как у DipoleScanResult в API)
    DipoleBatchResult(**result)


@_NEEDS_FSAVERAGE
def test_batch_clusters_carry_feature_profile(tmp_path, monkeypatch):
    """Кластеры пакета (С2) несут профиль признаков: синтетический ЭЭГ даёт кластеры.

    Ветка требует fsaverage (`head_to_mni` — MNI-координаты точек): без MNI
    точки не участвуют в кластеризации, поэтому без датасета (CI) тест
    честно скипывается (`_NEEDS_FSAVERAGE`).
    """
    monkeypatch.setattr(settings, "kd_moment_share", None)
    recording = _register(tmp_path, _two_band_edf(tmp_path), "rec-clusters")
    result = run_dipole_batch(recording, settings, _batch("alpha,beta"))

    # Профиль признаков кластера (исследовательский слой) в каждом кластере
    assert result["clusters"], "синтетический ЭЭГ даёт кластеры пакета"
    for cluster in result["clusters"]:
        features = cluster["features"]
        assert features is not None
        assert features["n_points"] == cluster["n_points"]
        assert features["moment_mean_nam"] is not None  # амплитуды измерены


def test_comparison_carries_only_normalized_measures(tmp_path):
    """В сопоставлении полос нет GOF (принцип 3) — только нормированные величины."""
    recording = _register(tmp_path, _two_band_edf(tmp_path), "rec-compare")
    result = run_dipole_batch(recording, settings, _batch("alpha,beta"))
    assert len(result["comparison"]) == 2
    for row in result["comparison"]:
        assert "gof" not in row and "median_gof" not in row
        assert row["moment_share_median"] is not None
        assert 0.0 <= row["moment_share_median"] <= 1.0
        assert "median_riv" in row  # единственный кросс-полосной фильтр доверия


def test_batch_kernel_is_built_once_per_run(tmp_path, monkeypatch):
    """Переиспользование forward/inverse ядра: одно построение на пакет полос (С1)."""
    recording = _register(tmp_path, _two_band_edf(tmp_path), "rec-kernel")
    calls = {"n": 0}
    original = _build_kernel

    def counting(*args, **kwargs):
        calls["n"] += 1
        return original(*args, **kwargs)

    monkeypatch.setattr("app.services.dipole_scanner._build_kernel", counting)
    _scan_kernel.cache_clear()
    run_dipole_batch(recording, settings, _batch("alpha,beta,15-25"))
    assert calls["n"] == 1  # ядро построено один раз на прогон, не на каждую полосу


def test_kd_verdicts_use_band_moment_max(tmp_path, monkeypatch):
    """КД (С0): момент ≥ доли максимума **своей полосы** И GOF ≥ порога."""
    monkeypatch.setattr(settings, "kd_moment_share", 0.5)
    monkeypatch.setattr(settings, "kd_gof_min", 0.0)
    recording = _register(tmp_path, _two_band_edf(tmp_path), "rec-kd")
    result = run_dipole_batch(recording, settings, _batch("alpha,beta"))

    for band in result["bands"]:
        basis = band["kd_basis"]
        assert basis["moment_share_x"] == 0.5
        assert basis["moment_max_nam"] == band["moment_max_nam"]
        assert basis["moment_basis"] == "share_of_band_max"
        assert basis["gof_basis"] == "absolute"
        passed = [p for p in band["points"] if p["kd_passed"] is True]
        assert len(passed) == band["n_kd_passed"] >= 1
        # Прошедшие — только с моментом ≥ половины максимума своей полосы
        for point in passed:
            assert point["amplitude_nam"] >= 0.5 * band["moment_max_nam"]
    # В кластеры (С2) попадают только прошедшие КД — так подписано в паспорте
    assert result["cluster_params"]["kd_filter"] == "kd_passed"


def test_batch_rejects_duplicate_and_bad_bands():
    """Сервис — последний рубеж: дубль полосы и перевёрнутые границы — ошибка."""
    with pytest.raises(DipoleBatchError, match="повторяется"):
        run_dipole_batch(
            None, settings,
            DipoleBatchParams(bands=[
                BandSpec("alpha", 8.0, 13.0, "alpha"),
                BandSpec("alpha", 8.0, 13.0, "alpha"),
            ]),
        )
    with pytest.raises(DipoleBatchError, match="нижняя граница"):
        run_dipole_batch(
            None, settings,
            DipoleBatchParams(bands=[BandSpec("custom:4-2", 4.0, 2.0, "4–2 Гц")]),
        )


# ---------- write-API (4.4): analyses/analysis_bands/dipole_points ----------


def test_dipole_batch_persists_analysis_rows(tmp_path, monkeypatch):
    """Прогон пакета пишет B7/B6: строка analyses + полосы + точки с КД."""
    # X % порога момента снимаем: здесь проверяется персист строк (вердикты
    # остаются честными NULL «не оценено»), а не математика КД (своя в
    # test_kd_criteria.py; живой дефолт методики X = 5 % — там же).
    monkeypatch.setattr(settings, "kd_moment_share", None)
    recording = _register(tmp_path, _two_band_edf(tmp_path), "rec-batch-store")
    params = _batch("alpha,beta")
    result = run_dipole_batch(recording, settings, params)
    asyncio.run(
        results_store.persist_recording_result(
            "dipole_batch", recording, params, result, "job-batch-1",
        ),
    )

    async def _read():
        await init_db()
        async with db_module.AsyncSessionLocal() as session:
            analysis = (
                await session.execute(select(Analysis).where(
                    Analysis.job_id == "job-batch-1",
                ))
            ).scalar_one()
            bands = (await session.execute(select(AnalysisBand).where(
                AnalysisBand.analysis_id == analysis.id,
            ))).scalars().all()
            points = (await session.execute(select(DipolePoint).where(
                DipolePoint.analysis_id == analysis.id,
            ))).scalars().all()
            return analysis, bands, points

    analysis, bands, points = asyncio.run(_read())
    assert analysis.params_sig == result["params_sig"]
    assert analysis.epoch_length_ms == 1000.0
    assert [b.band_key for b in bands] == ["alpha", "beta"]
    assert all(b.moment_max_nam is not None for b in bands)
    assert len(points) == sum(b["n_points"] for b in result["bands"])
    # Точки неслись с вердиктом: без порогов — NULL «не оценено», не 0
    assert all(p.kd_passed is None for p in points)


# ---------- Роуты (202 → задача → результат) ----------


def _wait_job(client, job_id: str, timeout: float = 60.0) -> dict:
    """Поллинг задачи, как делает UI."""
    deadline = time.time() + timeout
    body: dict = {}
    while time.time() < deadline:
        body = client.get(f"{_PREFIX}/jobs/{job_id}").json()
        if body["status"] in ("succeeded", "failed"):
            return body
        time.sleep(0.05)
    raise AssertionError(f"Задача не завершилась за {timeout} с: {body}")


def test_dipole_batch_endpoint_returns_result_set(client, tmp_path):
    """POST …/dipole_batch → 202 + задача → набор результатов одной сессии."""
    recording = _register(tmp_path, _two_band_edf(tmp_path), "rec-batch-api")
    response = client.post(
        f"{_PREFIX}/recordings/{recording.recording_id}/dipole_batch",
        data={"bands": "alpha,beta", "epoch_length_ms": "1000", "grid_mm": "7"},
    )
    assert response.status_code == 202
    job_id = response.json()["job_id"]
    assert _wait_job(client, job_id)["status"] == "succeeded"

    result = client.get(
        f"{_PREFIX}/recordings/{recording.recording_id}/dipole_batch/{job_id}",
    )
    assert result.status_code == 200
    payload = result.json()
    assert [b["band_key"] for b in payload["bands"]] == ["alpha", "beta"]
    assert payload["cluster_params"]["basis"] == "share_of_search_sphere_diameter"
    assert len(payload["comparison"]) == 2


def test_dipole_batch_endpoint_rejects_empty_bands(client, tmp_path):
    """Пустой набор полос — 400 (одиночный расчёт живёт в POST …/dipoles)."""
    recording = _register(tmp_path, _two_band_edf(tmp_path), "rec-batch-400")
    response = client.post(
        f"{_PREFIX}/recordings/{recording.recording_id}/dipole_batch",
        data={"bands": ""},
    )
    assert response.status_code == 400