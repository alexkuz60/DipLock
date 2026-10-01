"""Pydantic-схемы ответов API.

Единый контракт backend ↔ frontend: схемы попадают в OpenAPI, из которого
генерируются TypeScript-типы UI (см. `docs/ui.md`). Любое изменение формы
ответа должно проходить через эти модели.
"""
from app.schemas.analysis import (
    AnalyzeResponse,
    BestFitDipole,
    BrodmannAreaOut,
    BrodmannIndexOut,
    BrodmannLabelsOut,
    DipoleFit,
    JobCreated,
    JobState,
    JobStatus,
    MetaResponse,
    PipelineInfo,
    SurfaceOut,
    SurfaceRef,
    TrajectoryPoint,
)
from app.schemas.server import ServerRestartOut

__all__ = [
    "AnalyzeResponse",
    "BestFitDipole",
    "BrodmannAreaOut",
    "BrodmannIndexOut",
    "BrodmannLabelsOut",
    "DipoleFit",
    "JobCreated",
    "JobState",
    "JobStatus",
    "MetaResponse",
    "PipelineInfo",
    "ServerRestartOut",
    "SurfaceOut",
    "SurfaceRef",
    "TrajectoryPoint",
]
