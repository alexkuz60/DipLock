"""Локальный ресурс: автоопределение GPU и тумблер ускорения MNE (CUDA).

Детекция по слоям (доки MNE «Ускорение с помощью GPU и CUDA»): NVIDIA GPU в
системе (``nvidia-smi``) → CuPy (устройство + память) → MNE CUDA. MNE 1.13.2
использует только CuPy, поэтому ``usable`` ⇔ CuPy работает; сам MNE
инициализирует CUDA лениво при первом ``n_jobs='cuda'``, когда конфиг
``MNE_USE_CUDA`` равен ``true`` — ровно это значение пишет тумблер.

Тумблер «Использовать GPU» хранится **на сервере**: выбор пользователя — в
MNE-конфиге (``set_config('MNE_USE_CUDA', …, set_env=True)``, файл
``~/.mne/mne-python.json`` переживает рестарт процесса), дефолт —
``Settings.use_cuda`` (``USE_CUDA`` в ``.env``), пока выбора нет. UI только
читает и переключает через ``GET/PUT /api/v1/resource``.

Ускорение реально только для КИХ-фильтрации (``method='fir'``, включая notch
по умолчанию) и реземплинга (``method='fft'``); IIR и фитинг диполей остаются
на CPU. Единая точка выдачи ``n_jobs`` — :func:`filter_n_jobs`: сервисы
фильтрации зовут её, а конфиг и пробу CuPy не читают сами (DRY).
"""
import logging
import shutil
import subprocess
from dataclasses import dataclass
from functools import lru_cache

from mne import get_config, set_config

from app.core.config import Settings, settings

logger = logging.getLogger(__name__)

# Ключ MNE-конфига (и env) — тот же, что в доках MNE для «навсегда включить CUDA».
CUDA_CONFIG_KEY = "MNE_USE_CUDA"


class GpuUnavailableError(RuntimeError):
    """CUDA недоступна на этом сервере — текст годится для UI (409)."""


@dataclass(frozen=True)
class GpuInfo:
    """Что знает сервер о своём GPU (поля зеркалят контракт ``GpuStatusOut``)."""

    present: bool
    name: str | None
    cupy: bool
    usable: bool
    mem_total_mb: int | None
    mem_free_mb: int | None
    reason: str | None


def _probe_nvidia_smi() -> str | None:
    """Имя первого GPU из ``nvidia-smi -L`` (None: нет утилиты/драйвера/GPU)."""
    exe = shutil.which("nvidia-smi")
    if not exe:
        return None
    try:
        proc = subprocess.run(  # noqa: S603 — список аргументов фиксирован, без shell
            [exe, "-L"], capture_output=True, text=True, timeout=3.0, check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if proc.returncode != 0:
        return None
    for line in (proc.stdout or "").splitlines():
        line = line.strip()
        if not line.startswith("GPU "):
            continue
        # «GPU 0: NVIDIA RTX A4000 (UUID: …)» → «NVIDIA RTX A4000»
        name = line.split(":", 1)[-1].split(" (", 1)[0].strip()
        return name or None
    return None


@lru_cache(maxsize=1)
def _probe_cupy() -> tuple[bool, str | None, int | None, str | None]:
    """``(CuPy работает, имя устройства, память total МБ, причина отказа)``.

    Кэшируется на процесс: импорт CuPy и первый контекст CUDA дороги, а
    «появился/пропал GPU» — событие перезапуска сервера, а не запроса страницы.
    Свободная память намеренно **не** кэшируется (живой запрос
    :func:`_cupy_free_mb`).

    Проба **функциональная**: помимо устройства считается FFT и компилируется
    элементарное ядро (nvrtc) — ровно то, что делает ``n_jobs='cuda'``. Один
    ``init_cuda`` недостаточен: он проверяет только устройство, а без
    заголовков CUDA-тулкита (``cupy-cuda12x[ctk]``) первое ядро MNE падает
    ``RuntimeError`` уже внутри фильтра (живой случай 02.10.2026) — тогда
    ``usable=False`` с причиной, а не упавшая задача.
    """
    try:
        import cupy
    except Exception as exc:  # битая установка падает десятком разных способов
        return False, None, None, f"CuPy не установлен ({exc.__class__.__name__})"
    try:
        if cupy.cuda.runtime.getDeviceCount() < 1:
            raise RuntimeError("нет CUDA-устройств")
        with cupy.cuda.Device(0):
            _, total = cupy.cuda.runtime.memGetInfo()
            props = cupy.cuda.runtime.getDeviceProperties(0)
            spectrum = cupy.fft.rfft(cupy.zeros(64, dtype=cupy.float32))
            (spectrum * spectrum).sum()
            cupy.cuda.stream.get_current_stream().synchronize()
        raw_name = props.get("name") or ""
        name = raw_name.decode() if isinstance(raw_name, bytes) else str(raw_name)
        return True, name or None, int(total // (1024 * 1024)), None
    except Exception as exc:  # драйвер/CUDA отказывают как угодно — не роняем запрос
        first_line = str(exc).splitlines()[0] if str(exc) else exc.__class__.__name__
        return False, None, None, f"CUDA не готова: {first_line}"


def _cupy_free_mb() -> int | None:
    """Свободная память GPU сейчас (МБ; None — CuPy недоступен)."""
    try:
        import cupy

        free, _ = cupy.cuda.runtime.memGetInfo()
        return int(free // (1024 * 1024))
    except Exception:  # после успеха _probe_cupy отказ маловероятен — не роняем
        return None


def detect_gpu() -> GpuInfo:
    """Автоопределение GPU локального сервера (для «Настроек», без расчётов).

    ``usable=True`` ⇔ CuPy работает — этого достаточно MNE для
    ``n_jobs='cuda'``; ``nvidia-smi`` даёт имя и признак наличия драйвера,
    когда CuPy ещё не установлен.
    """
    smi_name = _probe_nvidia_smi()
    cupy_ok, cupy_name, mem_total_mb, cupy_error = _probe_cupy()
    if cupy_ok:
        return GpuInfo(
            present=True,
            name=cupy_name or smi_name,
            cupy=True,
            usable=True,
            mem_total_mb=mem_total_mb,
            mem_free_mb=_cupy_free_mb(),
            reason=None,
        )
    if smi_name is None:
        reason = "NVIDIA GPU не найден (нужен драйвер NVIDIA с nvidia-smi)"
    else:
        reason = cupy_error or "CuPy не установлен"
    return GpuInfo(
        present=smi_name is not None,
        name=smi_name,
        cupy=False,
        usable=False,
        mem_total_mb=None,
        mem_free_mb=None,
        reason=reason,
    )


def get_use_cuda(cfg: Settings | None = None) -> bool:
    """Состояние тумблера «Использовать GPU».

    Приоритет: MNE-конфиг/env ``MNE_USE_CUDA`` (выбор через ``PUT /resource``,
    переживает рестарт) → дефолт ``Settings.use_cuda`` (``.env``), пока выбора
    нет. Env имеет приоритет над файлом конфига — так читает сам MNE.
    """
    raw = get_config(CUDA_CONFIG_KEY, None)
    if raw is None:
        return bool((cfg or settings).use_cuda)
    return str(raw).lower() == "true"


def set_use_cuda(enabled: bool) -> None:
    """Включить/выключить ускорение: пишет MNE-конфиг сервера (и env процесса).

    Включение без рабочей CUDA — :class:`GpuUnavailableError` с текстом для
    UI: тумблер не должен обещать ускорение, которого нет. Инициализация CUDA
    осталась за MNE — она случится лениво при первом ``n_jobs='cuda'``.
    """
    if enabled:
        info = detect_gpu()
        if not info.usable:
            raise GpuUnavailableError(info.reason or "CUDA недоступна")
    set_config(CUDA_CONFIG_KEY, "true" if enabled else "false", set_env=True)
    logger.info("Тумблер «Использовать GPU» → %s", "вкл" if enabled else "выкл")


def cuda_usable() -> bool:
    """Рабочая ли CUDA сейчас (кэшированная проба CuPy, без чтения памяти)."""
    return _probe_cupy()[0]


def filter_n_jobs(cfg: Settings | None = None) -> str | None:
    """``n_jobs`` для FIR-фильтрации/реземплинга: ``'cuda'`` или ``None`` (CPU).

    ``'cuda'`` — только когда тумблер включён **и** CuPy работает: MNE сам
    умеет откатиться на CPU с предупреждением, но двойная проверка не даёт
    логам пугать пользователя строкой «CUDA not used». Ветка IIR этот
    ``n_jobs`` не получает вовсе: MNE допускает ``'cuda'`` только для
    ``method='fir'`` (filter/notch) и ``method='fft'`` (реземплинг), а в
    joblib строка упала бы — правило ``docs/rules/safety.md``.
    """
    if not get_use_cuda(cfg):
        return None
    return "cuda" if cuda_usable() else None


def clear_gpu_cache() -> None:
    """Сброс кэшей детекции (тесты: GPU меняется только вместе с процессом).

    Если проба сейчас замонкпачена тестом, сбрасывать нечего — молча пропускаем
    (``monkeypatch`` откатит подмену после teardown фикстуры).
    """
    clear = getattr(_probe_cupy, "cache_clear", None)
    if clear is not None:
        clear()
