"""Кэш статических ассетов fsaverage (F6).

Меш `lh/rh.inflated` и атлас `PALS_B12_Brodmann` не меняются между запусками,
поэтому:

* версия ассета считается по «отпечатку» входов (размер + mtime файлов, номер
  сборки и её параметры) — O(1), без чтения данных; сам расчёт отпечатка живёт
  в ``services/asset_versions.py`` (A7, этап 6), здесь — только вызов;
* JSON строится один раз и кладётся на диск в ``settings.cache_dir/surface``;
* готовые байты держим в памяти (``lru_cache``) — отдача без парсинга и сериализации.

Итог: вместо 2.86 МБ и ~1.6 с пересчёта на каждый запрос — мгновенный кэшируемый
ассет; тяжёлые индексы вершин Brodmann (≈2 МБ) вынесены в отдельный эндпоинт.
"""
import json
import logging
import time
from dataclasses import dataclass
from functools import lru_cache

from app.core.config import Settings
from app.services import asset_versions, journal
from app.services.cache_store import cache_path, cache_read, cache_write
from app.utils.brain_export import export_fsaverage_surface

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class _AssetCtx:
    """Хэшируемый контекст ассета (ключ кэша вместо самого Settings)."""

    subjects_dir: str
    cache_dir: str
    api_prefix: str

    @classmethod
    def from_settings(cls, settings: Settings) -> "_AssetCtx":
        return cls(
            subjects_dir=str(settings.subjects_dir),
            cache_dir=str(settings.cache_dir),
            api_prefix=str(settings.api_prefix),
        )


def surface_version(ctx: _AssetCtx) -> str:
    """Версия ассета по «отпечатку» входов fsaverage (используется как ETag)."""
    return asset_versions.fingerprint("surface", ctx.subjects_dir)



def _cache_paths(ctx: _AssetCtx, version: str) -> tuple[str, str]:
    """Пути файлов кэша: (меш, индексы Brodmann)."""
    return (
        cache_path(ctx.cache_dir, "surface", f"surface-{version}.json"),
        cache_path(ctx.cache_dir, "surface", f"brodmann-{version}.json"),
    )


@lru_cache(maxsize=4)
def _build_assets(ctx: _AssetCtx) -> tuple[bytes, bytes, str]:
    """Строит байты меша и BA-индексов (или берёт их с диска) + версию ассета."""
    started = time.perf_counter()
    version = surface_version(ctx)
    mesh_path, ba_path = _cache_paths(ctx, version)
    mesh_cached, ba_cached = cache_read(mesh_path), cache_read(ba_path)
    if mesh_cached is not None and ba_cached is not None:
        logger.info("Поверхность fsaverage взята из кэша (version=%s)", version)
        journal.record(
            "asset-surface", "cache_read",
            ms=(time.perf_counter() - started) * 1000.0,
            params_key=version, cache_hit=True,
            bytes_out=len(mesh_cached) + len(ba_cached), note="меш + BA, lru_cache в RAM",
        )
        return mesh_cached, ba_cached, version

    payload = export_fsaverage_surface(ctx)
    ba_labels: dict[str, dict] = payload.pop("ba_labels", {}) or {}

    mesh_payload = {
        "version": version,
        "lh": payload["lh"],
        "rh": payload["rh"],
        "n_brodmann_areas": len(ba_labels),
        "brodmann_url": f"{ctx.api_prefix}/surface/brodmann",
    }
    ba_payload = {
        "version": version,
        "areas": {name: {"name": name, **values} for name, values in ba_labels.items()},
    }
    mesh_bytes = json.dumps(mesh_payload, separators=(",", ":")).encode("utf-8")
    ba_bytes = json.dumps(ba_payload, separators=(",", ":")).encode("utf-8")

    cache_write(mesh_path, mesh_bytes, label="Кэш поверхности")
    cache_write(ba_path, ba_bytes, label="Кэш поверхности (BA)")
    logger.info(
        "Поверхность fsaverage построена (version=%s, меш=%.2f МБ, BA=%.2f МБ)",
        version, len(mesh_bytes) / 1e6, len(ba_bytes) / 1e6,
    )
    journal.record(
        "asset-surface", "build",
        ms=(time.perf_counter() - started) * 1000.0,
        params_key=version, cache_hit=False,
        bytes_out=len(mesh_bytes) + len(ba_bytes), note="меш + BA, source=fsaverage",
    )
    return mesh_bytes, ba_bytes, version


@lru_cache(maxsize=2)
def _parsed_brodmann(ctx: _AssetCtx) -> dict[str, dict]:
    """Распаренные BA-метки (парсим кэш один раз на версию ассета)."""
    _, ba_bytes, _ = _build_assets(ctx)
    return json.loads(ba_bytes).get("areas", {})


def asset_version(settings: Settings) -> str:
    """Версия ассета без построения данных (O(1), для /meta и SurfaceRef)."""
    return surface_version(_AssetCtx.from_settings(settings))


def surface_ref(settings: Settings) -> dict[str, str]:
    """Ссылка на кэшируемый меш: версия считается без построения данных (O(1)).

    Возвращает поля ``SurfaceRef`` (``version``/``url``/``brodmann_url``) — схема
    одна на ``/meta``, результат анализа и UI, поэтому собирается в одном месте.
    """
    prefix = settings.api_prefix
    return {
        "version": asset_version(settings),
        "url": f"{prefix}/surface",
        "brodmann_url": f"{prefix}/surface/brodmann",
    }


def get_surface_bytes(settings: Settings) -> tuple[bytes, str]:
    """Байты JSON меша fsaverage + версия ассета (для ETag/Cache-Control)."""
    mesh_bytes, _, version = _build_assets(_AssetCtx.from_settings(settings))
    return mesh_bytes, version


def get_brodmann_bytes(settings: Settings) -> tuple[bytes, str]:
    """Байты JSON всех полей Бродмана + версия ассета."""
    _, ba_bytes, version = _build_assets(_AssetCtx.from_settings(settings))
    return ba_bytes, version


def get_brodmann_area(settings: Settings, name: str) -> dict | None:
    """Индексы вершин одного поля Бродмана (или None, если метки нет)."""
    return _parsed_brodmann(_AssetCtx.from_settings(settings)).get(name)


def brodmann_area_names(settings: Settings) -> list[str]:
    """Имена всех доступных полей Бродмана (лёгкий ответ для UI)."""
    return sorted(_parsed_brodmann(_AssetCtx.from_settings(settings)))


def clear_asset_cache() -> None:
    """Сбрасывает in-memory кэш (используется в тестах)."""
    _build_assets.cache_clear()
    _parsed_brodmann.cache_clear()
