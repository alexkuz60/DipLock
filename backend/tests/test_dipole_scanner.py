"""Тесты быстрого расчёта диполей (`app/services/dipole_scanner.py`, срез 3.4).

Быстрая часть: перебор сетки проверяется на **синтетическом свинцовом поле** —
берём позиции электродов монтажа 10-20, ставим диполь в известную точку и
смотрим, найдёт ли `scan_point` её обратно (точность — порядка шага сетки). Так
тест проверяет физику модели без BEM и без fsaverage.

Роуты проверяются через `TestClient` на синтетическом EDF: 202 + задача,
прогресс по эпохам (`epochs_done`/`epochs_total`), результат по `result_url`.
"""
import os
import shutil
import time

import numpy as np
import pytest

from app.core.config import settings
from app.services.dipole_scanner import (
    GRID_CENTER_MM,
    GRID_RADIUS_MM,
    GRID_STEP_MM,
    MIN_SENSOR_DISTANCE_MM,
    DipoleScanError,
    DipoleScanParams,
    _leadfield,
    _scan_kernel,
    candidate_grid,
    compute_dipole_scan,
    scan_point,
    scan_point_fast,
)
from app.services.recordings import recording_registry
from app.services.spectral import channel_positions
from tests.conftest import write_minimal_edf

_PREFIX = "/api/v1"


def _upload_dirs() -> set[str]:
    root = settings.upload_dir
    if not os.path.isdir(root):
        return set()
    return {name for name in os.listdir(root) if os.path.isdir(os.path.join(root, name))}


@pytest.fixture(autouse=True)
def clean_state():
    """Изоляция реестра записей и каталогов загрузок между тестами."""
    recording_registry.clear()
    before = _upload_dirs()
    yield
    recording_registry.clear()
    for name in _upload_dirs() - before:
        shutil.rmtree(os.path.join(settings.upload_dir, name), ignore_errors=True)


def _electrodes() -> np.ndarray:
    """Матрица позиций электродов (канал × 3), метры — как в расчёте."""
    channels = list(settings.standard_channels)
    positions = channel_positions(channels)
    names = [name for name in channels if name in positions]
    assert len(names) >= 8
    return np.stack([positions[name] for name in names])


def _alpha_edf(tmp_path, seconds: float = 6.0):
    """Синтетический EDF: альфа-ритм 10 Гц с разной амплитудой по каналам."""
    path = tmp_path / "scan.edf"
    channels = list(settings.standard_channels[:8])
    sfreq = 250.0
    times = np.arange(int(seconds * sfreq)) / sfreq
    gain = 5.0 + np.arange(len(channels), dtype=float)
    data = np.sin(2 * np.pi * 10 * times)[None, :] * gain[:, None]
    write_minimal_edf(path, channels, data, sfreq)
    return path


def _register(tmp_path, edf_path, recording_id: str = "rec-dipoles"):
    upload_dir = tmp_path / recording_id
    upload_dir.mkdir(parents=True, exist_ok=True)
    target = upload_dir / edf_path.name
    shutil.copyfile(edf_path, target)
    return recording_registry.register(str(target), str(upload_dir), edf_path.name, settings)


def _wait_finished(client, job_id: str, timeout: float = 30.0) -> dict:
    """Ждёт завершения задачи (поллинг, как делает UI)."""
    deadline = time.time() + timeout
    body: dict = {}
    while time.time() < deadline:
        body = client.get(f"{_PREFIX}/jobs/{job_id}").json()
        if body["status"] in ("succeeded", "failed"):
            return body
        time.sleep(0.05)
    raise AssertionError(f"Задача не завершилась за {timeout} с: {body}")


def test_scan_point_fast_matches_scan_point():
    """N20: быстрый путь с предрасчитанным ядром даёт те же числа, что и
    одноразовый `scan_point` (тот же узел, GOF, амплитуда и направление)."""
    electrodes = _electrodes()
    grid = candidate_grid(GRID_STEP_MM)
    kernel = _scan_kernel(
        np.ascontiguousarray(electrodes, dtype=float).tobytes(),
        electrodes.shape,
        GRID_STEP_MM,
        MIN_SENSOR_DISTANCE_MM / 1000.0,
    )
    rng = np.random.default_rng(7)
    for _ in range(10):
        signal = rng.normal(size=electrodes.shape[0]) * 20e-6
        pos_ref, dir_ref, amp_ref, gof_ref = scan_point(electrodes, signal, grid)
        pos_new, dir_new, amp_new, gof_new = scan_point_fast(kernel, signal)
        # Лучший узел обязан совпасть в точности — это и есть ответ перебора
        assert np.array_equal(pos_new, pos_ref)
        assert np.isclose(gof_new, gof_ref, atol=1e-9)
        assert np.isclose(amp_new, amp_ref, rtol=1e-9)
        assert np.allclose(dir_new, dir_ref, atol=1e-9)


def test_scan_kernel_is_cached():
    """Ядро сетки кэшируется по позициям и шагу: повторный вызов — тот же объект."""
    electrodes = _electrodes()
    key = np.ascontiguousarray(electrodes, dtype=float).tobytes()
    first = _scan_kernel(key, electrodes.shape, GRID_STEP_MM, MIN_SENSOR_DISTANCE_MM / 1000.0)
    second = _scan_kernel(key, electrodes.shape, GRID_STEP_MM, MIN_SENSOR_DISTANCE_MM / 1000.0)
    assert first is second
    # Другой шаг сетки — другое ядро
    third = _scan_kernel(key, electrodes.shape, 8.0, MIN_SENSOR_DISTANCE_MM / 1000.0)
    assert third is not first


def test_scan_point_fast_is_much_faster():
    """N20: циклический путь минимум втрое быстрее одноразового (замер ~11-13x).

    Порог взят с большим запасом, чтобы тест не зависел от машины: выигрыш
    структурный (без свинцового поля и обращения GᵀG на эпоху), а не пограничный.
    """
    electrodes = _electrodes()
    grid = candidate_grid(GRID_STEP_MM)
    kernel = _scan_kernel(
        np.ascontiguousarray(electrodes, dtype=float).tobytes(),
        electrodes.shape,
        GRID_STEP_MM,
        MIN_SENSOR_DISTANCE_MM / 1000.0,
    )
    rng = np.random.default_rng(11)
    signals = rng.normal(size=(15, electrodes.shape[0])) * 20e-6
    scan_point(electrodes, signals[0], grid)  # прогрев кэшей вне замера
    scan_point_fast(kernel, signals[0])

    started = time.perf_counter()
    for signal in signals:
        scan_point(electrodes, signal, grid)
    slow_s = time.perf_counter() - started

    started = time.perf_counter()
    for signal in signals:
        scan_point_fast(kernel, signal)
    fast_s = time.perf_counter() - started

    assert fast_s * 3.0 < slow_s


def test_candidate_grid_is_sphere_with_requested_step():
    """Сетка — шар заданного радиуса, узлы кратны шагу, результат кэшируется."""
    grid = candidate_grid(GRID_STEP_MM)

    assert grid.ndim == 2 and grid.shape[1] == 3
    assert grid.shape[0] > 1000
    center_m = np.asarray(GRID_CENTER_MM) / 1000.0
    radius_m = np.linalg.norm(grid - center_m, axis=1)
    assert radius_m.max() <= GRID_RADIUS_MM / 1000.0 + 1e-9
    # Узлы стоят ровно на сетке: смещение от центра кратно шагу
    offsets = (grid * 1000.0) - np.asarray(GRID_CENTER_MM)
    assert np.allclose(offsets / GRID_STEP_MM, np.round(offsets / GRID_STEP_MM), atol=1e-6)
    assert candidate_grid(GRID_STEP_MM) is grid, "сетка должна кэшироваться"


def test_scan_point_recovers_synthetic_dipole():
    """Диполь, «измеренный» 20 электродами, находится с точностью шага сетки."""
    electrodes = _electrodes()
    grid = candidate_grid()
    true_position = np.array([0.0, 0.0, 0.05])  # MNI-подобная точка в системе головы
    true_moment = np.array([0.0, 1.0, 0.0])
    gain, _ = _leadfield(electrodes, true_position.reshape(1, 3))
    signal = (gain[:, 0, :] @ true_moment) * 1e-6  # вольты, как из EDF

    position, moment, amplitude, gof = scan_point(electrodes, signal, grid)

    step_m = GRID_STEP_MM / 1000.0
    assert np.linalg.norm(position - true_position) <= 1.5 * step_m
    assert gof > 0.95
    assert amplitude > 0
    assert float(np.dot(moment, true_moment)) > 0.9


def test_scan_point_rejects_bad_input():
    """Пустая сетка и несовпадение числа каналов — понятная ошибка, а не IndexError."""
    electrodes = _electrodes()
    with pytest.raises(DipoleScanError):
        scan_point(electrodes, np.zeros(electrodes.shape[0]), np.zeros((0, 3)))
    with pytest.raises(DipoleScanError):
        scan_point(electrodes, np.zeros(3), candidate_grid())


def test_compute_dipole_scan_returns_point_per_epoch(tmp_path):
    """Сервис: одна точка на эпоху, метрики в разумных диапазонах, метод помечен."""
    recording = _register(tmp_path, _alpha_edf(tmp_path))

    result = compute_dipole_scan(
        recording, settings,
        DipoleScanParams(filter_band=(1, 40), epoch_length_ms=1000.0),
    )

    assert result["method"] == "fast_grid"
    assert result["grid_mm"] == GRID_STEP_MM
    assert result["n_epochs_used"] > 0
    assert len(result["points"]) == result["n_epochs_used"]
    for point in result["points"]:
        assert 0.0 <= point["gof"] <= 1.0
        assert point["amplitude_nam"] > 0
        assert len(point["head_coords"]) == 3
        assert len(point["moment"]) == 3
        assert np.isclose(np.linalg.norm(point["moment"]), 1.0, atol=1e-6)
        # MNI — либо координаты, либо честное отсутствие (fsaverage не установлен)
        assert point["mni_coords"] is None or len(point["mni_coords"]) == 3
        # Атрибуция (шаг 1.4): раздельные поля — метки + расстояния + «вне мозга»
        assert "anatomical_structure" in point
        assert "structure_distance_mm" in point
        assert "brodmann_distance_mm" in point
        assert "outside_brain" in point
    # Признак метода BA-атрибуции в контракте (единый источник — объёмный атлас)
    assert result["brodmann_method"] == "nearest_cortex_vertex"
    # Каналы без позиций в модель не входят и сообщаются предупреждением
    assert all(name in settings.standard_channels for name in result["channels"])


def test_dipole_job_flow(client, tmp_path):
    """202 → поллинг с прогрессом по эпохам → точки по `result_url`."""
    recording = _register(tmp_path, _alpha_edf(tmp_path))

    created = client.post(
        f"{_PREFIX}/recordings/{recording.recording_id}/dipoles",
        data={"band_min": 1, "band_max": 40, "epoch_length_ms": 1000, "grid_mm": 8},
    )
    assert created.status_code == 202, created.text
    job_id = created.json()["job_id"]

    status = _wait_finished(client, job_id)
    assert status["status"] == "succeeded", status
    assert status["kind"] == "dipoles"
    assert status["result_url"] == f"{_PREFIX}/recordings/{recording.recording_id}/dipoles/{job_id}"
    assert status["epochs_total"] > 0
    assert status["epochs_done"] == status["epochs_total"]

    result = client.get(status["result_url"])
    assert result.status_code == 200, result.text
    body = result.json()
    assert body["recording_id"] == recording.recording_id
    assert body["method"] == "fast_grid"
    assert body["grid_mm"] == 8
    assert body["n_epochs_used"] == len(body["points"]) > 0

    # Результат чужого типа задачи этой записью не отдаётся (404, а не пустой ответ)
    assert client.get(f"{_PREFIX}/recordings/{recording.recording_id}/spectrum/{job_id}").status_code == 404
    assert client.get(f"{_PREFIX}/recordings/nope/dipoles/{job_id}").status_code == 404


def test_dipole_job_validates_params(client, tmp_path):
    """Полоса, длина эпохи и шаг сетки проверяются до запуска задачи."""
    recording = _register(tmp_path, _alpha_edf(tmp_path))
    base = f"{_PREFIX}/recordings/{recording.recording_id}/dipoles"

    assert client.post(base, data={"band_min": 1}).status_code == 400
    assert client.post(base, data={"epoch_length_ms": 333}).status_code == 400
    # Шаг сетки ограничен схемой формы (2…20 мм): 1 мм — 422 от FastAPI
    assert client.post(base, data={"grid_mm": 1}).status_code == 422
    assert client.post(base, data={"grid_mm": 50}).status_code == 422
    assert client.post(f"{_PREFIX}/recordings/nope/dipoles").status_code == 404


def test_unfinished_dipole_job_result_is_conflict(client, tmp_path):
    """Пока задача не завершена, результат — 409 с этапом и прогрессом."""
    recording = _register(tmp_path, _alpha_edf(tmp_path))
    created = client.post(
        f"{_PREFIX}/recordings/{recording.recording_id}/dipoles",
        data={"epoch_length_ms": 1000},
    )
    job_id = created.json()["job_id"]
    try:
        response = client.get(f"{_PREFIX}/recordings/{recording.recording_id}/dipoles/{job_id}")
        # Быстрая задача может успеть завершиться — тогда ответ 200 (это тоже верно)
        assert response.status_code in (200, 409)
        if response.status_code == 409:
            assert "ещё не завершена" in response.json()["detail"]
    finally:
        _wait_finished(client, job_id)
