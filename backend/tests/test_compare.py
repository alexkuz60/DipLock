"""Тесты дифференциального анализа двух записей (B9, `app/services/compare.py`).

Синтетическая пара записей: одна и та же α-синусоида, но в B амплитуда в 10 раз
выше — дельта по α обязана быть положительной (знак B − A), а по остальным
полосам — малой. Статистика считается с урезанными пермутациями/бутстрапом
(настройки в ``settings``), чтобы тесты оставались быстрыми.

Роуты проверяются через ``TestClient``: шлюзы параметров пары (400), фоновая
задача (202 → поллинг → результат контракта ``CompareResult``) и карта разности
(PNG + ETag/304).
"""
import os
import shutil
import time

import numpy as np
import pytest

from app.core.config import settings
from app.schemas.compare import CompareResult
from app.services.compare import CompareParams, clear_compare_cache, run_compare
from app.services.recordings import recording_registry
from app.services.spectral import SpectrumParams
from tests.conftest import write_minimal_edf
from tests.test_png import _decode_png

_PREFIX = "/api/v1"


def _upload_dirs() -> set[str]:
    root = settings.upload_dir
    if not os.path.isdir(root):
        return set()
    return {name for name in os.listdir(root) if os.path.isdir(os.path.join(root, name))}


@pytest.fixture(autouse=True)
def fast_stats(monkeypatch):
    """Лёгкая статистика в тестах: 64 пермутации, 200 бутстрапов."""
    monkeypatch.setattr(settings, "compare_n_permutations", 64)
    monkeypatch.setattr(settings, "compare_n_bootstraps", 200)


@pytest.fixture(autouse=True)
def clean_state():
    """Изоляция реестра записей и дискового кэша между тестами."""
    recording_registry.clear()
    clear_compare_cache(settings)
    before = _upload_dirs()
    yield
    recording_registry.clear()
    clear_compare_cache(settings)
    for name in _upload_dirs() - before:
        shutil.rmtree(os.path.join(settings.upload_dir, name), ignore_errors=True)


def _alpha_edf(tmp_path, name: str, amplitude_uv: float = 10.0, seconds: float = 8.0):
    """EDF с α-ритмом 10 Гц: гейн по каналам растёт (average reference не «съедает»
    одинаковые каналы), шум ~0.5 мкВ даёт ненулевую внутригрупповую дисперсию —
    без него Welch/F дают nan на детерминированном синусе."""
    path = tmp_path / name
    channels = list(settings.standard_channels[:8])
    sfreq = 250.0
    rng = np.random.RandomState(7)
    times = np.arange(int(seconds * sfreq)) / sfreq
    gain = 1.0 + np.arange(len(channels), dtype=float)
    data = np.sin(2 * np.pi * 10 * times)[None, :] * (amplitude_uv * gain[:, None])
    data += rng.randn(len(channels), len(times)) * 0.5
    write_minimal_edf(path, channels, data, sfreq)
    return path


def _register(tmp_path, edf_path, recording_id: str):
    """Регистрирует запись так, как это делает ``POST /recordings``."""
    upload_dir = tmp_path / recording_id
    upload_dir.mkdir(parents=True, exist_ok=True)
    target = upload_dir / edf_path.name
    shutil.copyfile(edf_path, target)
    return recording_registry.register(str(target), str(upload_dir), edf_path.name, settings)


@pytest.fixture
def pair(tmp_path):
    """Пара «покой vs деятельность»: одинаковый сигнал, амплитуда B × 10."""
    rec_a = _register(tmp_path, _alpha_edf(tmp_path, "rest.edf", amplitude_uv=2.0), "rec-rest")
    rec_b = _register(tmp_path, _alpha_edf(tmp_path, "task.edf", amplitude_uv=20.0), "rec-task")
    return rec_a, rec_b


def _params() -> CompareParams:
    return CompareParams(
        spectrum=SpectrumParams(filter_band=(1.0, 40.0), epoch_length_ms=1000.0),
        label_a="Покой",
        label_b="Деятельность",
    )


def _wait_finished(client, job_id: str, timeout: float = 60.0) -> dict:
    deadline = time.time() + timeout
    body: dict = {}
    while time.time() < deadline:
        body = client.get(f"{_PREFIX}/jobs/{job_id}").json()
        if body["status"] in ("succeeded", "failed"):
            return body
        time.sleep(0.05)
    raise AssertionError(f"Задача не завершилась за {timeout} с: {body}")


def test_alpha_gain_gives_positive_delta(pair):
    """Амплитуда B × 10 → дельта по α ≈ +20 дБ, знак верный; не-α — мала."""
    rec_a, rec_b = pair
    result = CompareResult(**run_compare(rec_a, rec_b, settings, _params()))

    bands = {row.name: row for row in result.bands}
    assert bands["alpha"].delta_db is not None
    # 10× по амплитуде = 100× по мощности = +20 дБ (срез полосы ослабляет идеал)
    assert 10.0 < bands["alpha"].delta_db < 30.0
    # CI дельты исключает ноль: различие подтверждено бутстрапом
    assert bands["alpha"].ci95_delta_db is not None
    assert bands["alpha"].ci95_delta_db[0] > 0
    # Стороны в паспорте: разные записи, ярлыки условия на месте
    assert result.side_a.label == "Покой"
    assert result.side_b.label == "Деятельность"
    assert result.side_a.recording_id != result.side_b.recording_id


def test_match_block_reports_shared_parameters(pair):
    """B9 «совпадение параметров»: общий набор каналов, sfreq, параметры спектра."""
    rec_a, rec_b = pair
    result = CompareResult(**run_compare(rec_a, rec_b, settings, _params()))

    assert result.match.sfreq == 250.0
    assert result.match.channels_only_a == []
    assert result.match.channels_only_b == []
    assert result.match.channels == list(settings.standard_channels[:8])
    assert result.match.psd_method == "welch"
    assert result.match.epoch_length_ms == 1000.0
    # Одинаковая частотная сетка у PSD и дельт
    assert len(result.freqs) == len(result.psd_mean_a_uv2) == len(result.psd_delta_db)
    assert result.freqs == sorted(result.freqs)


def test_cluster_test_finds_alpha_difference(pair):
    """Кластерный тест находит различие по α и помечает его значимым."""
    rec_a, rec_b = pair
    result = CompareResult(**run_compare(rec_a, rec_b, settings, _params()))

    assert result.stats.method == "permutation_cluster_test"
    assert result.stats.n_permutations == 64
    assert result.stats.n_clusters >= 1
    assert result.stats.n_significant >= 1
    significant = [item for item in result.stats.clusters if item.significant]
    assert significant, "ожидается хотя бы один значимый кластер"
    # Различие в области α: кластер пересекает полосу 8–13 Гц
    assert any(
        item.freq_min_hz <= 13.0 and item.freq_max_hz >= 8.0 for item in significant
    )
    # Направление: в B мощность больше
    assert all(item.direction == "B>A" for item in significant)


def test_notes_and_delta_topomaps_present(pair):
    """Каветы интерпретации обязательны; карты разности построены и подписаны URL."""
    rec_a, rec_b = pair
    result = CompareResult(**run_compare(rec_a, rec_b, settings, _params()))

    assert len(result.notes) >= 3
    assert "не доказывает" in result.notes[0]
    with_url = [row for row in result.bands if row.topomap_delta_url]
    assert with_url, "карты разности ожидаются для пары с общими каналами"
    alpha = next(row for row in result.bands if row.name == "alpha")
    assert alpha.topomap_delta_url is not None
    assert "compare/topomap/alpha.png" in alpha.topomap_delta_url
    assert f"recording_id_a={rec_a.recording_id}" in alpha.topomap_delta_url


def test_api_rejects_same_recording_and_bad_sfreq(client, pair, tmp_path):
    """Шлюзы пары: одна запись и разные sfreq — 400 с текстом для UI."""
    rec_a, _rec_b = pair
    same = client.post(
        f"{_PREFIX}/compare",
        data={"recording_id_a": rec_a.recording_id, "recording_id_b": rec_a.recording_id},
    )
    assert same.status_code == 400
    assert "разные записи" in same.json()["detail"]

    # Запись с другим sfreq: EDF на 200 Гц рядом с парой на 250 Гц
    path = tmp_path / "fast.edf"
    channels = list(settings.standard_channels[:8])
    times = np.arange(int(4 * 200.0)) / 200.0
    data = np.repeat(np.sin(2 * np.pi * 10 * times)[None, :] * 5.0, len(channels), axis=0)
    write_minimal_edf(path, channels, data, 200.0)
    rec_c = _register(tmp_path, path, "rec-200")
    mismatch = client.post(
        f"{_PREFIX}/compare",
        data={"recording_id_a": rec_a.recording_id, "recording_id_b": rec_c.recording_id},
    )
    assert mismatch.status_code == 400
    assert "Частоты дискретизации" in mismatch.json()["detail"]


def test_api_unknown_recording_is_404(client):
    """Неизвестная запись — 404 с текстом (как у задач записи)."""
    response = client.post(
        f"{_PREFIX}/compare",
        data={"recording_id_a": "nope", "recording_id_b": "nope-2"},
    )
    assert response.status_code == 404


def test_api_job_flow_and_result_contract(client, pair):
    """202 → фоновая задача → результат контракта CompareResult, адрес в status."""
    rec_a, rec_b = pair
    created = client.post(
        f"{_PREFIX}/compare",
        data={
            "recording_id_a": rec_a.recording_id,
            "recording_id_b": rec_b.recording_id,
            "label_a": "Покой",
            "label_b": "Деятельность",
            "band_min": 1, "band_max": 40,
            "epoch_length_ms": 1000,
            "psd_method": "welch",
        },
    )
    assert created.status_code == 202
    job_id = created.json()["job_id"]
    assert created.json()["result_url"].endswith(f"/compare/{job_id}")

    body = _wait_finished(client, job_id)
    assert body["status"] == "succeeded", body.get("error")
    assert body["result_url"].endswith(f"/compare/{job_id}")

    result = client.get(f"{_PREFIX}/compare/{job_id}")
    assert result.status_code == 200
    payload = CompareResult(**result.json())
    assert payload.side_a.filename == "rest.edf"
    assert payload.side_b.filename == "task.edf"
    bands = {row.name: row for row in payload.bands}
    assert bands["alpha"].delta_db is not None and bands["alpha"].delta_db > 0

    # Чужой вид задачи на адресе сравнения — 404 (контракт не тот)
    wrong = client.get(f"{_PREFIX}/compare/does-not-exist")
    assert wrong.status_code == 404


def test_compare_topomap_png_and_etag(client, pair):
    """Карта разности: PNG с пикселями, повтор по If-None-Match — 304."""
    rec_a, rec_b = pair
    created = client.post(
        f"{_PREFIX}/compare",
        data={
            "recording_id_a": rec_a.recording_id,
            "recording_id_b": rec_b.recording_id,
            "band_min": 1, "band_max": 40, "epoch_length_ms": 1000,
        },
    )
    job_id = created.json()["job_id"]
    assert _wait_finished(client, job_id)["status"] == "succeeded"

    result = client.get(f"{_PREFIX}/compare/{job_id}").json()
    alpha = next(row for row in result["bands"] if row["name"] == "alpha")
    url = alpha["topomap_delta_url"]
    assert url is not None

    response = client.get(url)
    assert response.status_code == 200
    assert response.headers["content-type"] == "image/png"
    decoded = _decode_png(response.content)
    assert (decoded["width"], decoded["height"]) == (128, 128)

    etag = response.headers["etag"]
    again = client.get(url, headers={"If-None-Match": etag})
    assert again.status_code == 304


def test_unknown_band_on_topomap_is_400(client, pair):
    """Неизвестный диапазон — 400 с текстом, а не картинка."""
    rec_a, rec_b = pair
    response = client.get(
        f"{_PREFIX}/compare/topomap/nope.png",
        params={
            "recording_id_a": rec_a.recording_id,
            "recording_id_b": rec_b.recording_id,
        },
    )
    assert response.status_code == 400
    assert "Неизвестный диапазон" in response.json()["detail"]


