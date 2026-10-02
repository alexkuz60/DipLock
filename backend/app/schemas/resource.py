"""Контракт локального ресурса (GPU/CUDA): ``GET/PUT /api/v1/resource``.

Раздел «Настройки» → панель «Локальный ресурс»: автоопределение GPU сервера
и тумблер «Использовать GPU» (источник истины — сервер, см.
``services/gpu.py``). Читаётся вместе с ``/meta``, но отдельным лёгким
запросом: детекция (``nvidia-smi``/CuPy) не должна удорожать метаданные.
"""
from pydantic import BaseModel, Field


class GpuStatusOut(BaseModel):
    """Автоопределение GPU локального сервера (один запрос, без расчётов)."""

    present: bool = Field(description="NVIDIA GPU виден системе (nvidia-smi или CuPy)")
    name: str | None = Field(default=None, description="Имя устройства")
    cupy: bool = Field(description="CuPy установлен и CUDA инициализируется")
    usable: bool = Field(
        description=(
            "CUDA доступна для ускорения MNE (бэкенд MNE — только CuPy); "
            "включение тумблера без неё отвечает 409"
        ),
    )
    mem_total_mb: int | None = Field(default=None, description="Память GPU, МБ")
    mem_free_mb: int | None = Field(default=None, description="Свободная память сейчас, МБ")
    reason: str | None = Field(
        default=None,
        description="Почему CUDA недоступна — текст для UI (None, когда usable)",
    )


class LocalResourceOut(BaseModel):
    """``GET /api/v1/resource`` — локальный ресурс: детекция GPU + тумблер."""

    gpu: GpuStatusOut
    use_cuda: bool = Field(
        description=(
            "Тумблер «Использовать GPU»: MNE-конфиг сервера (MNE_USE_CUDA), "
            "дефолт USE_CUDA из .env"
        ),
    )


class LocalResourceUpdate(BaseModel):
    """``PUT /api/v1/resource``: новое состояние тумблера."""

    use_cuda: bool
