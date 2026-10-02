"""Локальный ресурс: детекция GPU, тумблер MNE_USE_CUDA и роуты /resource.

Тесты идут без GPU и CuPy: пробы ``nvidia-smi``/CuPy подменяются, а настоящий
MNE-конфиг пользователя не трогается (autouse-фикстура ``conftest.py`` ставит
``MNE_USE_CUDA=false``, ``get_config``/``set_config`` в тестах монкпатчатся).
"""
import pytest

from app.core.config import Settings, settings
from app.services import gpu
from app.services.filter_design import band_filter_kwargs

_SMI_NAME = "NVIDIA RTX A4000"
_CUPY_OK = (True, _SMI_NAME, 16376, None)
_CUPY_MISSING = (False, None, None, "CuPy не установлен (ImportError)")


@pytest.fixture(autouse=True)
def _clean_gpu_cache():
    """Кэш пробы CuPy — на процесс: сбрасываем, чтобы тесты не влияли друг на друга."""
    gpu.clear_gpu_cache()
    yield
    gpu.clear_gpu_cache()


def _patch_probes(monkeypatch, smi: str | None, cupy: tuple) -> None:
    """Подменить обе пробы детекции (nvidia-smi и CuPy) и живую память."""
    monkeypatch.setattr(gpu, "_probe_nvidia_smi", lambda: smi)
    monkeypatch.setattr(gpu, "_probe_cupy", lambda: cupy)
    monkeypatch.setattr(gpu, "_cupy_free_mb", lambda: 15000 if cupy[0] else None)


# ---------- детекция ----------


def test_detect_gpu_with_cupy(monkeypatch) -> None:
    """GPU + CuPy → usable: имя, память и без причины отказа."""
    _patch_probes(monkeypatch, _SMI_NAME, _CUPY_OK)
    info = gpu.detect_gpu()
    assert info.present is True
    assert info.name == _SMI_NAME
    assert info.cupy is True
    assert info.usable is True
    assert info.mem_total_mb == 16376
    assert info.mem_free_mb == 15000
    assert info.reason is None


def test_detect_gpu_without_cupy(monkeypatch) -> None:
    """Драйвер NVIDIA есть, CuPy нет → причина называет CuPy (текст для UI)."""
    _patch_probes(monkeypatch, _SMI_NAME, _CUPY_MISSING)
    info = gpu.detect_gpu()
    assert info.present is True
    assert info.cupy is False
    assert info.usable is False
    assert info.reason == "CuPy не установлен (ImportError)"
    assert info.mem_total_mb is None


def test_detect_gpu_without_nvidia(monkeypatch) -> None:
    """Нет ни GPU, ни CuPy → «GPU не найден», usable=False."""
    _patch_probes(monkeypatch, None, _CUPY_MISSING)
    info = gpu.detect_gpu()
    assert info.present is False
    assert info.usable is False
    assert info.reason is not None
    assert "GPU не найден" in info.reason


# ---------- тумблер ----------


def test_get_use_cuda_falls_back_to_env_default(monkeypatch) -> None:
    """Выбора в MNE-конфиге нет → дефолт ``Settings.use_cuda`` (``.env``)."""
    monkeypatch.setattr(gpu, "get_config", lambda key, default=None: None)
    assert gpu.get_use_cuda() is bool(settings.use_cuda)
    assert gpu.get_use_cuda(Settings(use_cuda=True)) is True


def test_get_use_cuda_reads_mne_config(monkeypatch) -> None:
    """Выбор пользователя в MNE-конфиге приоритетнее дефолта из .env."""
    monkeypatch.setattr(gpu, "get_config", lambda key, default=None: "true")
    assert gpu.get_use_cuda() is True
    monkeypatch.setattr(gpu, "get_config", lambda key, default=None: "false")
    assert gpu.get_use_cuda() is False


def test_set_use_cuda_writes_mne_config(monkeypatch) -> None:
    """Включение/выключение пишет MNE-конфиг (и env процесса) — не localStorage."""
    _patch_probes(monkeypatch, _SMI_NAME, _CUPY_OK)
    calls: list[tuple] = []
    monkeypatch.setattr(
        gpu, "set_config",
        lambda key, value, set_env=True: calls.append((key, value, set_env)),
    )
    gpu.set_use_cuda(True)
    gpu.set_use_cuda(False)
    assert calls == [
        ("MNE_USE_CUDA", "true", True),
        ("MNE_USE_CUDA", "false", True),
    ]


def test_set_use_cuda_refuses_without_cupy(monkeypatch) -> None:
    """Включать нечего: без рабочей CUDA — отказ с текстом для UI (409)."""
    _patch_probes(monkeypatch, _SMI_NAME, _CUPY_MISSING)
    monkeypatch.setattr(
        gpu, "set_config", lambda *args, **kwargs: pytest.fail("set_config не должен зваться"),
    )
    with pytest.raises(gpu.GpuUnavailableError) as exc:
        gpu.set_use_cuda(True)
    assert "CuPy" in str(exc.value)


# ---------- n_jobs для сервисов фильтрации ----------


def test_filter_n_jobs_gated_by_toggle_and_cuda(monkeypatch) -> None:
    """``'cuda'`` — только при включённом тумблере **и** рабочей CUDA."""
    _patch_probes(monkeypatch, _SMI_NAME, _CUPY_OK)
    # тумблер выключен
    monkeypatch.setattr(gpu, "get_config", lambda key, default=None: "false")
    assert gpu.filter_n_jobs() is None
    # тумблер включён, CUDA работает
    monkeypatch.setattr(gpu, "get_config", lambda key, default=None: "true")
    assert gpu.filter_n_jobs() == "cuda"
    # тумблер включён, но CuPy недоступен — честный CPU без «CUDA not used»
    _patch_probes(monkeypatch, _SMI_NAME, _CUPY_MISSING)
    assert gpu.filter_n_jobs() is None


def test_band_filter_kwargs_n_jobs_only_for_fir(monkeypatch) -> None:
    """FIR-ветка получает ``n_jobs='cuda'``, IIR — никогда (MNE: только fir)."""
    monkeypatch.setattr(gpu, "filter_n_jobs", lambda cfg=None: "cuda")
    fir = band_filter_kwargs(1.0, 40.0, 500.0)
    assert fir["n_jobs"] == "cuda"
    iir = band_filter_kwargs(8.0, 8.5, 500.0)  # ширина 0.5 ≤ filter_iir_max_width_hz
    assert iir["method"] == "iir"
    assert "n_jobs" not in iir


# ---------- роуты ----------


def test_resource_get(client, monkeypatch) -> None:
    """GET /api/v1/resource — детекция + состояние тумблера в одном контракте."""
    monkeypatch.setattr(
        gpu,
        "detect_gpu",
        lambda: gpu.GpuInfo(
            present=True, name=_SMI_NAME, cupy=True, usable=True,
            mem_total_mb=16376, mem_free_mb=15000, reason=None,
        ),
    )
    monkeypatch.setattr(gpu, "get_use_cuda", lambda cfg=None: True)
    res = client.get("/api/v1/resource")
    assert res.status_code == 200
    body = res.json()
    assert body["gpu"]["usable"] is True
    assert body["gpu"]["name"] == _SMI_NAME
    assert body["gpu"]["mem_free_mb"] == 15000
    assert body["use_cuda"] is True


def test_resource_put_disable_writes_config(client, monkeypatch) -> None:
    """Выключение тумблера всегда возможно и пишет MNE-конфиг."""
    calls: list[tuple] = []
    monkeypatch.setattr(
        gpu, "set_config",
        lambda key, value, set_env=True: calls.append((key, value)),
    )
    res = client.put("/api/v1/resource", json={"use_cuda": False})
    assert res.status_code == 200
    assert calls == [("MNE_USE_CUDA", "false")]
    assert res.json()["use_cuda"] is False


def test_resource_put_enable_conflict_without_cuda(client, monkeypatch) -> None:
    """409 + текст причины для UI, когда CUDA недоступна."""
    _patch_probes(monkeypatch, _SMI_NAME, _CUPY_MISSING)
    res = client.put("/api/v1/resource", json={"use_cuda": True})
    assert res.status_code == 409
    assert "CuPy" in res.json()["detail"]

