"""Run manifest: версии + параметры + отпечатки ассетов рядом с результатом (N40/4.6).

Прогон воспроизводим, если рядом с результатом лежит ответ на три вопроса:
**на чём** (версии Python/MNE/…), **чем** (отпечаток параметров `params_sig`) и
**на каких данных** (отпечатки ассетов FSAverage). `/meta` версии отдаёт, но
«рядом с результатом» их раньше не было: файл задачи (`services/job_store.py`)
теперь несёт блок `manifest`, а пакет сессии (`services/session_export.py`)
собирает его в `manifest.json` — два HTML/zip сверяются парами по нему.

**Паспорт критерия** (С0) — блок `criteria`: пороги КД (`kd_moment_share`,
`kd_gof_min`) и их базисы нормировки («доля от максимума поддиапазона» /
«абсолютный»). Пока методика не задала пороги, поля `None` — вердикт `kd_passed`
остаётся честным «не оценено» (`docs/rules/results-db.md` §8.4 п.5). Каким методом
посчитан GOF каждой точки — в её поле `method` (`fast_grid`/`bem_fit`), в паспорт
критерия оно не дублируется.
"""
from typing import Any

from app.core.config import KD_GOF_BASIS, KD_MOMENT_BASIS, Settings
from app.services.asset_versions import asset_versions
from app.utils.versions import library_versions

# Версия формата манифеста: сменили состав полей — поднимите (урок A7:
# старые файлы обязаны отличаться от новых, а не «молча совпасть»).
# v2 (15.10.2026): блок `criteria` — паспорт критерия КД (С0).
RUN_MANIFEST_VERSION = 2


def build_manifest(cfg: Settings, record: dict[str, Any]) -> dict[str, Any]:
    """Блок manifest для файла задачи: kind/recording_id/параметры/версии/ассеты.

    ``record`` — сериализованная задача (`Job.to_record`): `meta.params_sig` —
    repr параметров, тот же отпечаток, что в журнале шагов и истории задач.
    """
    meta = record.get("meta")
    if not isinstance(meta, dict):
        meta = {}
    return {
        "manifest_version": RUN_MANIFEST_VERSION,
        "kind": record.get("kind"),
        "recording_id": meta.get("recording_id"),
        "params_sig": meta.get("params_sig"),
        "finished_at": record.get("finished_at") or record.get("created_at"),
        "versions": library_versions(),
        # Отпечатки файлов данных (size+mtime, O(1)): смена BEM/трансформа
        # меняет отпечаток — результат «на других ассетах» виден глазом.
        "assets": asset_versions(str(cfg.subjects_dir or "")),
        # Паспорт критерия КД (С0): пороги и их базисы нормировки. None — методика
        # не задала пороги (concept.md §3: «своих» дефолтов у проекта нет).
        "criteria": {
            "kd_moment_share": cfg.kd_moment_share,
            "kd_gof_min": cfg.kd_gof_min,
            "kd_moment_basis": KD_MOMENT_BASIS,
            "kd_gof_basis": KD_GOF_BASIS,
        },
    }
