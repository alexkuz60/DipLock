"""Pydantic-схемы ответов API.

Единый контракт backend ↔ frontend: схемы попадают в OpenAPI, из которого
генерируются TypeScript-типы UI (см. `docs/ui.md`). Любое изменение формы
ответа должно проходить через эти модели.
"""
from app.schemas.analysis import (
    AnalyzeResponse,
    ArtifactTypes,
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

__all__ = [
    "AnalyzeResponse",
    "ArtifactTypes",
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
    "SurfaceOut",
    "SurfaceRef",
    "TrajectoryPoint",
]
