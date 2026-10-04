"""Отчёты по результатам групповых анализов в разделе «Итоги» (оба типа).

`services/group_reports.py` ничего не считает заново — пересказывает готовые
числа самодостаточным HTML: результат сравнения (синтетический контракт
воркера compare, без дорогой пары) и прогон группы (seed write-API, как в
``test_group_analysis``). Здесь проверяется содержимое обоих документов,
дисковый кэш и отпечаток (смена чисел → новый файл, старый убран), роуты
«метаданные + HTML-ассет с ETag/304», шлюз 404 и встроенные карты разности.
Чистка сирот — в ``test_orphans.py``.
"""
import asyncio
import os
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.api import routes
from app.core.config import settings
from app.models import db as db_module
from app.models.db import GroupAnalysis, GroupAnalysisMember
from app.services import recording_store
from app.services.cache_store import cache_clear
from app.services.compare import clear_compare_cache, compare_topomap_path
from app.services.group_analysis import get_group_analysis
from app.services.group_reports import (
    COMPARE_KIND,
    GROUP_KIND,
    ensure_compare_report,
    ensure_group_report,
    group_report_html_path,
)
from tests.test_group_analysis import _create_run, _seed

_PREFIX = "/api/v1"
_RECS = ("rec-group-a", "rec-group-b", "rec-group-ghost")


def _drop_rows() -> None:
    """Убирает строки записей и прогонов теста (общая tmp-БД помнит соседей)."""

    async def _run() -> None:
        from sqlalchemy import delete

        await db_module.init_db()
        async with db_module.AsyncSessionLocal() as session:
            await session.execute(delete(GroupAnalysisMember))
            await session.execute(delete(GroupAnalysis))
            await session.commit()

    for rid in _RECS:
        asyncio.run(recording_store.drop_recording_rows(rid))
    asyncio.run(_run())


@pytest.fixture(autouse=True)
def clean_state():
    """Кэш отчётов и строки БД изолируются до и после каждого теста."""

    def _clean_cache() -> None:
        cache_clear(settings.cache_dir, "reports", "compare")
        cache_clear(settings.cache_dir, "reports", "group")
        clear_compare_cache(settings)

    _drop_rows()
    _clean_cache()
    yield
    _drop_rows()
    _clean_cache()


@pytest.fixture
def group_run(client):
    """Seed записей с пакетом диполей + сохранённый прогон (Тип 2)."""
    _seed()
    return _create_run(client)


def _compare_result() -> dict:
    """Синтетический результат ``kind=compare``: тот же контракт, что у воркера."""
    return {
        "signature": "sigpair1234abcd",
        "side_a": {
            "recording_id": "rec-rest", "filename": "rest.edf",
            "label": "Покой", "n_epochs": 40, "n_channels": 8,
        },
        "side_b": {
            "recording_id": "rec-task", "filename": "task.edf",
            "label": "Деятельность", "n_epochs": 40, "n_channels": 8,
        },
        "match": {
            "sfreq": 250.0,
            "filter_band_hz": [1.0, 40.0],
            "notch_hz": 50.0,
            "epoch_length_ms": 1000.0,
            "psd_method": "welch",
            "reference": "average",
            "channels": [f"C{index}" for index in range(8)],
            "channels_only_a": ["C7"],
            "channels_only_b": [],
        },
        "freqs": [1.0, 5.0, 10.0, 20.0],
        "psd_mean_a_uv2": [1.0, 2.0, 3.0, 1.5],
        "psd_mean_b_uv2": [1.2, 4.0, 9.0, 1.4],
        "psd_delta_db": [0.8, 3.0, 4.8, -0.3],
        "bands": [{
            "name": "alpha", "fmin": 8.0, "fmax": 13.0,
            "power_a_uv2": 3.0, "power_b_uv2": 9.0,
            "delta_uv2": 6.0, "delta_db": 4.77,
            "relative_power_a": 0.3, "relative_power_b": 0.5,
            "median_a_uv2": 2.9, "median_b_uv2": 8.8,
            "ci95_delta_db": [4.1, 5.4],
            "effect": 1.5, "p_value": 0.00002, "q_value": 0.0001,
            "fdr_significant_channels": ["C1", "C2"],
            "topomap_delta_url": (
                "/api/v1/compare/topomap/alpha.png"
                "?recording_id_a=rec-rest&recording_id_b=rec-task"
            ),
        }],
        "indices": {
            "iaf_a_hz": 10.0, "iaf_b_hz": 10.5, "delta_iaf_hz": 0.5,
            "theta_beta_a": 1.2, "theta_beta_b": 1.6, "delta_theta_beta": 0.4,
            "theta_alpha_beta_a": 2.0, "theta_alpha_beta_b": 2.4,
            "delta_theta_alpha_beta": 0.4,
        },
        "specparam": {
            "exponent_a": 1.1, "exponent_b": 1.3, "delta_exponent": 0.2,
            "offset_a": 3.0, "offset_b": 3.4, "delta_offset": 0.4,
            "fit_r_squared_a": 0.99, "fit_r_squared_b": 0.98,
            "peaks_a": [{"center_hz": 10.0, "amplitude_db": 5.0, "bandwidth_hz": 2.0}],
            "peaks_b": [],
        },
        "stats": {
            "method": "permutation_cluster_test", "n_permutations": 64,
            "alpha": 0.05, "n_clusters": 1, "n_significant": 1,
            "clusters": [{
                "p_value": 0.01, "significant": True,
                "channels": ["C1", "C2", "C3"],
                "freq_min_hz": 9.0, "freq_max_hz": 12.0,
                "n_points": 12, "mean_delta_db": 4.5, "direction": "B>A",
            }],
        },
        "topomap_version": "v1-compare-delta",
        "notes": ["Кластерный тест указывает на связку «частота × канал»."],
        "warnings": ["Мало эпох — предупреждение теста."],
        "duration_sec_calc": 1.0,
    }


# --------------------------- Тип 1: сравнение ---------------------------------


def test_compare_report_content_and_cache():
    """Документ Типа 1: паспорт пары, дельты, кластеры, каветы + кэш по отпечатку."""
    result = _compare_result()
    doc = ensure_compare_report(settings, "job-cmp-1", result)
    html = doc.data.decode("utf-8")

    assert doc.title == "Сравнение: Покой ↔ Деятельность"
    assert "Покой" in html and "Деятельность" in html
    # Направление дельт и числа полосы — из контракта (4.77 = num(4.77, 2))
    assert "Направление всех дельт — B − A" in html
    assert "alpha (8–13 Гц)" in html and "4.77" in html
    assert "[4.1, 5.4]" in html  # 95% bootstrap-ИИ
    assert "Кластерный тест указывает на связку" in html  # notes без правок
    assert "Мало эпох — предупреждение теста" in html  # warnings источника

    # Кэш: файл по отпечатку, повторная сборка — те же байты и версия
    path = group_report_html_path(settings, COMPARE_KIND, "job-cmp-1", doc.sig)
    assert os.path.isfile(path)
    again = ensure_compare_report(settings, "job-cmp-1", result)
    assert (again.sig, again.version) == (doc.sig, doc.version)
    assert again.data == doc.data


def test_compare_report_rebuilds_when_numbers_change():
    """Смена чисел источника — другой отпечаток и файл, старый убран (урок A7)."""
    first = ensure_compare_report(settings, "job-cmp-2", _compare_result())
    old_path = group_report_html_path(settings, COMPARE_KIND, "job-cmp-2", first.sig)

    changed = _compare_result()
    changed["bands"][0]["delta_db"] = 1.23
    second = ensure_compare_report(settings, "job-cmp-2", changed)

    assert second.sig != first.sig
    assert second.data != first.data
    assert b"1.23" in second.data
    new_path = group_report_html_path(settings, COMPARE_KIND, "job-cmp-2", second.sig)
    assert os.path.isfile(new_path)
    assert not os.path.exists(old_path), "на источник — один отпечаток в кэше"


def test_compare_report_embeds_topomap_or_links_lazy():
    """Карта разности: PNG из кэша встраивается base64, иначе — ссылка на эндпоинт."""
    import base64

    result = _compare_result()
    fake_png = b"\x89PNG\r\n\x1a\nfake"
    marker = base64.b64encode(fake_png).decode("ascii")
    png_path = compare_topomap_path(
        settings, "rec-rest", result["signature"], "alpha",
    )
    os.makedirs(os.path.dirname(png_path), exist_ok=True)
    with open(png_path, "wb") as fh:
        fh.write(fake_png)

    embedded = ensure_compare_report(settings, "job-cmp-3", result)
    assert marker in embedded.data.decode("utf-8")

    # Промах кэша: документ остаётся собираемым, картинка — по URL с версией
    # (эндпоинт лениво пересчитает пару, прецедент cached_compare_topomap).
    # Свои PNG (фигуры) MNE тоже встраивает base64 — маркером служат байты файла.
    os.remove(png_path)
    linked = ensure_compare_report(settings, "job-cmp-4", _compare_result())
    html = linked.data.decode("utf-8")
    assert marker not in html
    assert 'src="/api/v1/compare/topomap/alpha.png' in html
    assert "&amp;v=v1-compare-delta" in html


# --------------------------- Тип 2: группа ------------------------------------


def test_group_report_content_and_cache(client, group_run):
    """Документ Типа 2: участники, два знаменателя share, таблицы, кластеры."""
    detail = asyncio.run(get_group_analysis(group_run["id"], settings))
    assert detail is not None
    doc = ensure_group_report(settings, group_run["id"], detail)
    html = doc.data.decode("utf-8")

    assert doc.title == "Группа: покой vs деятельность (полоса alpha)"
    # Участники и строки агрегата (seed: таламус/BA7, 5 точек на две записи)
    assert "таламус (слева)" in html and "BA7" in html
    # Обязательные подписи: оба знаменателя и «числа пересчитаны по живой БД»
    assert "все точки выборки в полосе" in html
    assert "от точек своей записи" in html
    assert "пересчитаны по живой БД" in html
    # Тепловая карта и кластеры — секции документа
    assert "Тепловая карта" in html
    assert "Кластеры диполей" in html
    assert "Минимум точек в кластере" in html

    # Кэш по отпечатку: повтор — те же байты
    path = group_report_html_path(
        settings, GROUP_KIND, str(group_run["id"]), doc.sig,
    )
    assert os.path.isfile(path)
    again = ensure_group_report(settings, group_run["id"], detail)
    assert again.data == doc.data and again.version == doc.version


def test_group_report_rebuilds_on_fresh_recalculation(client, group_run):
    """Свежий пересчёт с другими числами — новый отпечаток, старый файл убран."""
    detail = asyncio.run(get_group_analysis(group_run["id"], settings))
    assert detail is not None
    first = ensure_group_report(settings, group_run["id"], detail)
    old_path = group_report_html_path(
        settings, GROUP_KIND, str(group_run["id"]), first.sig,
    )

    changed = asyncio.run(get_group_analysis(group_run["id"], settings))
    assert changed is not None
    changed["aggregate"]["n_points_total"] = 999
    second = ensure_group_report(settings, group_run["id"], changed)

    assert second.sig != first.sig
    assert os.path.isfile(group_report_html_path(
        settings, GROUP_KIND, str(group_run["id"]), second.sig,
    ))
    assert not os.path.exists(old_path)


# ------------------------------- роуты ----------------------------------------


def _fake_compare_job(job_id: str) -> SimpleNamespace:
    """Подмена шлюза задач: job-ok — завершённая с результатом, остальные — 404."""
    if job_id != "job-ok":
        raise HTTPException(status_code=404, detail="Задача сравнения не найдена")
    return SimpleNamespace(
        status="succeeded", kind="compare", result=_compare_result(),
    )


def test_api_compare_report_routes(client, monkeypatch):
    """Метаданные + HTML-ассет: 200/ETag/304 и честный 404 чужой задачи."""
    monkeypatch.setattr(routes, "compare_job_result", _fake_compare_job)

    meta = client.get(f"{_PREFIX}/compare/job-ok/report")
    assert meta.status_code == 200
    body = meta.json()
    assert body["title"] == "Сравнение: Покой ↔ Деятельность"
    assert body["html_url"] == f"{_PREFIX}/compare/job-ok/report/html"
    assert body["report_version"] and body["html_sig"]
    assert body["warnings"] == ["Мало эпох — предупреждение теста."]

    html = client.get(body["html_url"])
    assert html.status_code == 200
    assert html.headers["content-type"].startswith("text/html")
    assert "Покой" in html.text
    again = client.get(body["html_url"], headers={"If-None-Match": html.headers["etag"]})
    assert again.status_code == 304

    missing = client.get(f"{_PREFIX}/compare/job-missing/report")
    assert missing.status_code == 404
    assert "не найдена" in missing.json()["detail"]


def test_api_group_report_routes(client, group_run):
    """Метаданные + HTML-ассет прогона: 200/ETag/304, 404 — прогона нет."""
    meta = client.get(f"{_PREFIX}/group/analyses/{group_run['id']}/report")
    assert meta.status_code == 200
    body = meta.json()
    assert body["title"].startswith("Группа: покой vs деятельность")
    assert body["html_url"].endswith(
        f"/group/analyses/{group_run['id']}/report/html",
    )
    assert body["report_version"]

    html = client.get(body["html_url"])
    assert html.status_code == 200
    assert "таламус (слева)" in html.text
    again = client.get(body["html_url"], headers={"If-None-Match": html.headers["etag"]})
    assert again.status_code == 304

    missing = client.get(f"{_PREFIX}/group/analyses/424242/report")
    assert missing.status_code == 404
    assert "не найден" in missing.json()["detail"]



