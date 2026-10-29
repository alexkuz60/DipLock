"""Run manifest: версии + параметры + отпечатки ассетов рядом с результатом (N40/4.6).

Прогон воспроизводим, если рядом с результатом лежит ответ на три вопроса:
**на чём** (версии Python/MNE/…), **чем** (отпечаток параметров `params_sig`) и
**на каких данных** (отпечатки ассетов FSAverage). `/meta` версии отдаёт, но
«рядом с результатом» их раньше не было: файл задачи (`services/job_store.py`)
теперь несёт блок `manifest`, а пакет сессии (`services/session_export.py`)
собирает его в `manifest.json` — два HTML/zip сверяются парами по нему.

**Паспорт критерия** (С0) — блок `criteria`: пороги КД (`kd_moment_share`,
`kd_gof_min`/`kd_gof_min_by_band`) и их базисы нормировки («доля от максимума
поддиапазона» / «абсолютный»). GOF — **по-полосный** (manifest v3, 29.10.2026):
карта `kd_gof_min_by_band` — фактически применённые пороги прогона (форма
перекрывает методику, полоса без записи — экспертная интерполяция
`kd_criteria.default_gof_min`); X % момента — **5 %** (эксперт методики,
29.10.2026). Оба порога активны — вердикты считаются; `kd_passed` остаётся
«не оценено» только при явно снятых порогах (`docs/rules/results-db.md`
§8.4 п.5). Каким методом посчитан GOF каждой точки — в её поле `method`
(`fast_grid`/`bem_fit`), в паспорт критерия оно не дублируется.
"""
from typing import Any

from app.core.config import KD_GOF_BASIS, KD_MOMENT_BASIS, Settings
from app.services.asset_versions import asset_versions
from app.services.kd_criteria import effective_gof_map
from app.utils.versions import library_versions

# Версия формата манифеста: сменили состав полей — поднимите (урок A7:
# старые файлы обязаны отличаться от новых, а не «молча совпасть»).
# v2 (15.10.2026): блок `criteria` — паспорт критерия КД (С0).
# v3 (29.10.2026): `criteria.kd_gof_min_by_band` — по-полосный GOF (форма
# прогона перекрывает методику; фактические пороги — из `meta` задачи).
RUN_MANIFEST_VERSION = 3

RUN_MANIFEST_VERSION = 3


def _effective_gof_map(cfg: Settings, meta: dict[str, Any]) -> dict[str, float]:
    """Фактический по-полосный порог GOF прогона для паспорта критерия.

    Каталог полос + «свои» полосы формы (``meta.kd_gof_min_by_band``); перекрытие
    — форма → методика → экспертная интерполяция (та же цепочка, что у
    вердиктов: `kd_criteria.effective_gof_map`).
    """
    return effective_gof_map(cfg, meta.get("kd_gof_min_by_band"))

def build_manifest(cfg: Settings, record: dict[str, Any]) -> dict[str, Any]:
    """Блок manifest для файла задачи: kind/recording_id/параметры/версии/ассеты.

    ``record`` — сериализованная задача (`Job.to_record`): `meta.params_sig` —
    repr параметров, тот же отпечаток, что в журнале шагов и истории задач;
    ``meta.kd_*`` — пороги КД формы прогона (`kd_criteria.kd_meta`).
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
        # GOF — фактически применённый по-полосный (manifest v3): форма прогона
        # (`meta.kd_*`) перекрывает методику, полоса без записи — интерполяция.
        "criteria": {
            "kd_moment_share": (
                meta.get("kd_moment_share")
                if meta.get("kd_moment_share") is not None
                else cfg.kd_moment_share
            ),
            "kd_gof_min": cfg.kd_gof_min,
            "kd_gof_min_by_band": _effective_gof_map(cfg, meta),
            "kd_moment_basis": KD_MOMENT_BASIS,
            "kd_gof_basis": KD_GOF_BASIS,
        },
    }
