"""Отчёты по результатам групповых анализов — раздел «Итоги» (оба типа).

Тип 1 «Сравнение» (B9, `services/compare.py`) и Тип 2 «Группа N>2»
(остаток 4.7, `services/group_analysis.py`) уже посчитаны: результаты живут в
файле задачи ``kind=compare`` и в строках ``group_analyses``. Этот модуль
**ничего нового не считает** — он пересказывает готовые числа самодостаточным
HTML в той же теме, что автоотчёт записи (``THEME_CSS``/``THEME_JS`` из
``services/report.py``): тот же приём, что часть 1 автоотчёта над
препроцессингом. Обязательные подписи источника (``notes``) и предупреждения
(``warnings``) вставляются в документ без правок.

Сборка ленивая — тот же приём, что промах кэша карт разности: первый
``GET …/report`` строит файл в дисковый кэш
``reports/{compare|group}/{source_id}/{sig}.html``, повторные читают его.
Отпечаток ``sig`` входит в имя файла: смена исходных чисел (у группы — свежий
пересчёт агрегата по живой БД, §8.4.2) адресует новый файл, старый убирается
при сборке — на источник всегда один отпечаток. Версия ассета — хеш
содержимого; отдача — ``asset_response`` (ETag/304, единый помощник A2).

Жизненный цикл кэша: ``reports/compare`` чистится вместе с файлом задачи
(``orphans.sweep_group_report_cache`` — история задач живёт по
``jobs_history_limit``); ``reports/group`` живёт с историей прогонов — строки
``group_analyses`` не удаляются («история не UPSERT», §8.4.2), сирот там не
бывает.
"""
import hashlib
import json
import os
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import Any

import matplotlib
import numpy as np

from app.core.config import Settings
from app.services import journal
from app.services.cache_store import cache_path, cache_read, cache_write
from app.services.report import (
    THEME_CSS,
    THEME_JS,
    bullets,
    esc,
    kv,
    num,
    pct,
    table,
)

# Рендер только в Agg (тот же приём, что в services/report.py): без дисплея
# matplotlib и так свалился бы, но честный вызов вместо молчаливого фолбэка.
matplotlib.use("Agg")

# Версия формата HTML обоих отчётов: входит в отпечаток — смена разметки
# отправляет старые файлы кэша в невалидность (урок A7, как REPORT_HTML_VERSION).
GROUP_REPORT_HTML_VERSION = 1

# Ключи кэша внутри reports/: «compare» — Тип 1, «group» — Тип 2.
COMPARE_KIND = "compare"
GROUP_KIND = "group"

# Метрики, не входящие в отпечаток: меняются при каждом чтении источника
# (см. ``_stable``)
_VOLATILE_KEYS = frozenset({"duration_sec_calc"})


@dataclass
class ReportDoc:
    """Собранный или прочитанный из кэша документ отчёта."""

    data: bytes
    sig: str
    version: str
    title: str
    warnings: list[str] = field(default_factory=list)


def _stable(payload: Any) -> Any:
    """Копия payload без метрик длительности — они меняются при каждом чтении.

    ``duration_sec_calc`` свежего пересчёта сделал бы отпечаток новым на
    каждый запрос: документ пересобирался бы впустую, а ETag не совпадал бы
    сам с собой (200 вместо 304). Числа агрегата при этом остаются в отпечатке.
    """
    if isinstance(payload, dict):
        return {
            key: _stable(value)
            for key, value in payload.items()
            if key not in _VOLATILE_KEYS
        }
    if isinstance(payload, list):
        return [_stable(item) for item in payload]
    return payload


def _signature(kind: str, payload: Any) -> str:
    """Отпечаток источника + версии формата — имя файла в дисковом кэше.

    ``default=str`` прогоняет datetime/примитивы снимка прогона через
    стабильное строковое представление: два пересчёта с одними числами дают
    один отпечаток, изменившиеся числа — другой (документ пересобирается).
    """
    blob = json.dumps(
        {"v": GROUP_REPORT_HTML_VERSION, "kind": kind, "payload": _stable(payload)},
        sort_keys=True,
        ensure_ascii=False,
        default=str,
    )
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:16]


def group_report_html_path(
    cfg: Settings, kind: str, source_id: str, signature: str,
) -> str:
    """Путь HTML отчёта в дисковом кэше (корень — только из ``settings``)."""
    return cache_path(cfg.cache_dir, "reports", kind, source_id, f"{signature}.html")


def read_group_report_html(
    cfg: Settings, kind: str, source_id: str, signature: str,
) -> tuple[bytes, str] | None:
    """Байты HTML + версию для ETag; ``None`` — файла нет (очищен/не собран)."""
    data = cache_read(group_report_html_path(cfg, kind, source_id, signature))
    if data is None:
        return None
    return data, hashlib.sha256(data).hexdigest()[:16]


def _drop_stale(cfg: Settings, kind: str, source_id: str, keep: str) -> None:
    """Убирает файлы других отпечатков источника (на источник один sig).

    ``cache_clear`` здесь не годится: он роняет каталог целиком, а каталог
    только что получил свежий файл. Файл удаляется с диска напрямую —
    промах чтения не должен ронять сборку (свойство кэша, правило 4
    ``docs/rules/data-and-caches.md``).
    """
    directory = cache_path(cfg.cache_dir, "reports", kind, source_id)
    if not os.path.isdir(directory):
        return
    for name in os.listdir(directory):
        if name == f"{keep}.html":
            continue
        try:
            os.remove(os.path.join(directory, name))
        except OSError:
            continue


def _compare_title(result: dict[str, Any]) -> str:
    """Заголовок документа Типа 1 — подпись в шапке раздела и в метаданных."""
    side_a = result.get("side_a") or {}
    side_b = result.get("side_b") or {}
    label_a = side_a.get("label") or side_a.get("filename") or "A"
    label_b = side_b.get("label") or side_b.get("filename") or "B"
    return f"Сравнение: {label_a} ↔ {label_b}"


def _group_title(detail: dict[str, Any]) -> str:
    """Заголовок документа Типа 2: подпись прогона + полоса агрегата."""
    run = detail.get("run") or {}
    aggregate = detail.get("aggregate") or {}
    name = run.get("name") or f"прогон №{run.get('id')}"
    band = (aggregate.get("filters") or {}).get("band_key") or run.get("band_key") or "?"
    return f"Группа: {name} (полоса {band})"


# ---------- общая разметка HTML ------------------------------------------------


def _fmt_dt(value: Any) -> str:
    """Дата/время из JSON-снимка → читаемая строка; ``None`` — честное «—»."""
    if value is None:
        return "—"
    if hasattr(value, "strftime"):
        try:
            return value.strftime("%Y-%m-%d %H:%M:%S")  # type: ignore[union-attr]
        except (TypeError, ValueError):
            return str(value)
    return str(value)


def _pval(p: Any) -> str:
    """p-значение: четыре знака, но нуля на границе чувствительности не показываем."""
    if p is None:
        return "—"
    try:
        value = float(p)
    except (TypeError, ValueError):
        return str(p)
    return "<0.0001" if 0.0 < value < 0.0001 else f"{value:.4f}"


def _fingerprint_html(kind: str, signature: str, rows: list[tuple[str, Any]]) -> str:
    """Отпечаток источника в шапке: два собранных HTML сверяются парами.

    Тот же приём, что «Полный отпечаток параметров» автоотчёта (§3.9.4 №8):
    «что именно отличается» читается из списков полей, а не по дате сборки.
    """
    import platform as py_platform

    import mne

    base: list[tuple[str, Any]] = [
        ("Отпечаток (ключ кэша)", signature),
        ("Формат HTML", f"v{GROUP_REPORT_HTML_VERSION}"),
        ("Источник", kind),
        ("Python / MNE", f"{py_platform.python_version()} / {mne.__version__}"),
    ]
    return (
        "<details><summary>Полный отпечаток параметров (сверка двух отчётов парами)</summary>"
        + kv(base + rows)
        + "</details>"
    )


def _save_to_bytes(rep: Any, figures: list[Any], target_path: str) -> bytes:
    """Сохраняет ``mne.Report`` во временный файл рядом с целевым и читает байты.

    MNE каталог не создаёт (FileNotFoundError на первом отчёте), поэтому путь
    подготавливаем до ``save``; в кэш байты попадут через атомарный
    ``cache_write``, а временный файл убирается всегда (приём ``report.py``).
    """
    from matplotlib import pyplot as plt

    build_path = target_path[: -len(".html")] + ".building.html"
    os.makedirs(os.path.dirname(build_path), exist_ok=True)
    try:
        rep.save(build_path, open_browser=False, overwrite=True)
        with open(build_path, "rb") as fh:
            return fh.read()
    finally:
        for fig in figures:
            plt.close(fig)
        if os.path.exists(build_path):
            os.remove(build_path)


# ---------- фигуры (только числа сервера, без пересчёта на клиенте) -------------


def _psd_figure(result: dict[str, Any]) -> Any | None:
    """PSD обеих сторон и дельта B − A на общей частотной оси.

    Значимые кластеры — заливкой на ряду дельты (та же смысловая связка, что в
    панели ``SpectrumStats`` UI). ``None`` — рядов нет или длины разошлись
    (старый результат задачи): картинка не рисуется, числовые секции
    документа от этого не страдают.
    """
    from matplotlib import pyplot as plt

    freqs = [float(f) for f in (result.get("freqs") or [])]
    psd_a = [float(v) for v in (result.get("psd_mean_a_uv2") or [])]
    psd_b = [float(v) for v in (result.get("psd_mean_b_uv2") or [])]
    delta = [float(v) for v in (result.get("psd_delta_db") or [])]
    if not freqs or len(psd_a) != len(freqs) or len(psd_b) != len(freqs):
        return None
    has_delta = len(delta) == len(freqs)
    side_a = result.get("side_a") or {}
    side_b = result.get("side_b") or {}
    stats = result.get("stats") or {}
    clusters = [c for c in (stats.get("clusters") or []) if c.get("significant")]

    fig, (ax_psd, ax_delta) = plt.subplots(2, 1, sharex=True, figsize=(7.5, 5.5))
    ax_psd.plot(
        freqs, psd_a, color="#2563eb", linewidth=1.4,
        label=f"A — {side_a.get('label') or side_a.get('filename') or 'A'}",
    )
    ax_psd.plot(
        freqs, psd_b, color="#dc2626", linewidth=1.4,
        label=f"B — {side_b.get('label') or side_b.get('filename') or 'B'}",
    )
    ax_psd.set_yscale("log")
    ax_psd.set_ylabel("PSD, мкВ²/Гц")
    ax_psd.legend(loc="best", fontsize=8)
    ax_psd.grid(True, alpha=0.3)
    if has_delta:
        ax_delta.plot(freqs, delta, color="#111827", linewidth=1.2)
        ax_delta.axhline(0.0, color="#6b7280", linewidth=0.8)
        for cluster in clusters:
            ax_delta.axvspan(
                float(cluster.get("freq_min_hz") or 0.0),
                float(cluster.get("freq_max_hz") or 0.0),
                color="#f59e0b",
                alpha=0.18,
            )
        ax_delta.set_ylabel("Δ, дБ (B − A)")
    else:
        ax_delta.set_ylabel("Δ, дБ")
        ax_delta.text(
            0.5, 0.5, "дельта не посчитана", ha="center", va="center",
            transform=ax_delta.transAxes, color="#6b7280",
        )
    ax_delta.set_xlabel("Частота, Гц")
    ax_delta.grid(True, alpha=0.3)
    fig.suptitle("PSD и дельта B − A (оранжевая заливка — значимые кластеры)")
    fig.tight_layout()
    return fig


def _heatmap_figure(
    labels: Sequence[str], columns: Sequence[str], values: Sequence[float], title: str,
) -> Any:
    """Тепловая карта «строка × запись»: доли ячеек, % (приём heatmap UI)."""
    from matplotlib import pyplot as plt

    grid = np.asarray(values, dtype=float).reshape(len(labels), len(columns))
    fig, ax = plt.subplots(
        figsize=(max(5.0, 1.7 * len(columns) + 3.0), max(3.0, 0.4 * len(labels) + 1.4)),
    )
    image = ax.imshow(grid, aspect="auto", cmap="viridis")
    ax.set_xticks(range(len(columns)), [str(c) for c in columns], rotation=45, ha="right")
    ax.set_yticks(range(len(labels)), [str(label) for label in labels])
    ax.set_xlabel("Записи группы (колонки таблицы)")
    ax.set_title(title)
    fig.colorbar(image, ax=ax, shrink=0.85, label="Доля точек своей записи, %")
    fig.tight_layout()
    return fig


def _short_name(value: Any) -> str:
    """Имя файла для колонки карты: без каталога, с обрезкой длинных имён."""
    text = os.path.basename(str(value or ""))
    if not text:
        return "—"
    return text if len(text) <= 18 else f"{text[:15]}…"


# ---------- Тип 1: отчёт по результату сравнения -------------------------------


def _num_auto(value: Any) -> str:
    """Число без потери масштаба: три значащих цифры, сверхмалое — экспонентой."""
    if value is None:
        return "—"
    try:
        number = float(value)
    except (TypeError, ValueError):
        return str(value)
    return f"{number:.3g}"


def _bands_table(bands: Sequence[dict[str, Any]]) -> str:
    """Таблица дельт по полосам: те же числа, что таблица UI (B − A везде)."""
    headers = (
        "Полоса", "A, мкВ²", "B, мкВ²", "Δ, мкВ²", "Δ, дБ", "95% ИИ, дБ",
        "Эффект", "p", "q (FDR)", "Каналов после FDR",
    )
    rows: list[list[Any]] = []
    for band in bands:
        ci = band.get("ci95_delta_db")
        ci_text = (
            f"[{_num_auto(ci[0])}, {_num_auto(ci[1])}]"
            if isinstance(ci, (list, tuple)) and len(ci) == 2 else "—"
        )
        fdr_n = len(band.get("fdr_significant_channels") or [])
        rows.append([
            f"{band.get('name')} ({_num_auto(band.get('fmin'))}–{_num_auto(band.get('fmax'))} Гц)",
            _num_auto(band.get("power_a_uv2")),
            _num_auto(band.get("power_b_uv2")),
            _num_auto(band.get("delta_uv2")),
            num(band.get("delta_db"), 2),
            ci_text,
            _num_auto(band.get("effect")),
            _pval(band.get("p_value")),
            _pval(band.get("q_value")),
            str(fdr_n),
        ])
    return table(headers, rows)


def _clusters_table(clusters: Sequence[dict[str, Any]]) -> str:
    """Таблица кластеров кластерного теста «частота × канал»."""
    headers = (
        "p", "Значим", "Частоты, Гц", "Направление", "Δ дБ внутри",
        "Каналов", "Точек", "Каналы (первые 12)",
    )
    rows: list[list[Any]] = []
    for cluster in clusters:
        channels = [str(c) for c in (cluster.get("channels") or [])]
        shown = ", ".join(channels[:12]) + (" …" if len(channels) > 12 else "")
        rows.append([
            _pval(cluster.get("p_value")),
            "да" if cluster.get("significant") else "нет",
            f"{_num_auto(cluster.get('freq_min_hz'))} – {_num_auto(cluster.get('freq_max_hz'))}",
            str(cluster.get("direction") or "—"),
            num(cluster.get("mean_delta_db"), 2),
            str(len(channels)),
            str(int(cluster.get("n_points") or 0)),
            shown or "—",
        ])
    return table(headers, rows)


def _topomap_html(cfg: Settings, band: dict[str, Any], result: dict[str, Any]) -> str | None:
    """Карта разности одной полосы: base64 из кэша, иначе ссылка на эндпоинт.

    Встроенная картинка делает документ самодостаточным (печать/новая вкладка
    без запросов); промах кэша карты не роняет отчёт — остаётся ``<img>`` по
    URL, который лениво пересчитает пару (прецедент ``cached_compare_topomap``).
    """
    import base64

    from app.services.compare import compare_topomap_path

    url = band.get("topomap_delta_url")
    if not url:
        return None
    side_a = result.get("side_a") or {}
    name = str(band.get("name") or "")
    path = compare_topomap_path(
        cfg, str(side_a.get("recording_id") or ""),
        str(result.get("signature") or ""), name,
    )
    data = cache_read(path)
    if data:
        encoded = base64.b64encode(data).decode("ascii")
        image = f'<img src="data:image/png;base64,{encoded}" alt="Карта разности {esc(name)}">'
    else:
        sep = "&" if "?" in str(url) else "?"
        version = str(result.get("topomap_version") or "")
        src = esc(f"{url}{sep}v={version}")
        image = f'<img src="{src}" alt="Карта разности {esc(name)}">'
    return (
        f"<h3>Полоса {esc(name)}</h3>"
        "<p>Дельты дБ по каналам, дивергентная палитра RdBu_r со шкалой (−m, m): "
        "красный — мощность выросла в B, синяя — упала.</p>"
        f'<p style="max-width: 520px">{image}</p>'
    )


def _build_compare_report(
    cfg: Settings, result: dict[str, Any], *, signature: str, path: str,
) -> bytes:
    """Собирает HTML-отчёт по результату ``kind=compare`` (Тип 1 «Итогов»)."""
    import mne
    from mne.report import Report

    side_a = result.get("side_a") or {}
    side_b = result.get("side_b") or {}
    match = result.get("match") or {}
    bands = list(result.get("bands") or [])
    stats = result.get("stats") or {}
    built_at = time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime())
    section = "Отчёт по сравнению (Тип 1)"

    rep = Report(title=f"DipLock — {_compare_title(result)}")
    rep.add_custom_css(THEME_CSS)
    rep.add_custom_js(THEME_JS)

    filter_band = match.get("filter_band_hz")
    filter_text = (
        f"{_num_auto(filter_band[0])}–{_num_auto(filter_band[1])} Гц"
        if isinstance(filter_band, (list, tuple)) and len(filter_band) == 2 else "без фильтра"
    )
    rep.add_html(
        "<p>Дифференциальный анализ двух записей (B9): обе стороны обработаны "
        "<b>одними и теми же параметрами</b>, поэтому дельты определены. "
        "<b>Направление всех дельт — B − A</b>: знак числа означает «насколько "
        "выросло в B относительно A».</p>"
        f"<p>Пара: A — {esc(side_a.get('label'))} ({esc(side_a.get('filename'))}) · "
        f"B — {esc(side_b.get('label'))} ({esc(side_b.get('filename'))}) · "
        f"полос в таблице: {len(bands)} · собрано: {built_at} · "
        f"MNE {esc(mne.__version__)}</p>"
        + _fingerprint_html(
            "сравнение двух записей (B9)", signature,
            [
                ("Запись A", side_a.get("recording_id")),
                ("Запись B", side_b.get("recording_id")),
                ("Сигнатура пары", result.get("signature")),
                ("Версия карт разности", result.get("topomap_version")),
                ("sfreq, Гц", match.get("sfreq")),
                ("Длина эпохи, мс", match.get("epoch_length_ms")),
                ("Метод PSD", match.get("psd_method")),
                ("Референс", match.get("reference")),
                ("Фильтр, Гц", filter_text),
                ("Notch, Гц",
                 match.get("notch_hz") if match.get("notch_hz") is not None else "выключен"),
                ("Каналов в расчёте", len(match.get("channels") or [])),
            ],
        ),
        title="О отчёте",
        section=section,
    )

    only_a = [str(c) for c in (match.get("channels_only_a") or [])]
    only_b = [str(c) for c in (match.get("channels_only_b") or [])]
    pair_html = (
        table(
            ("Сторона", "Файл", "Условие", "Эпох", "Каналов"),
            [
                ["A", side_a.get("filename"), side_a.get("label"),
                 side_a.get("n_epochs"), side_a.get("n_channels")],
                ["B", side_b.get("filename"), side_b.get("label"),
                 side_b.get("n_epochs"), side_b.get("n_channels")],
            ],
        )
        + kv([
            ("sfreq, Гц", match.get("sfreq")),
            ("Длина эпохи, мс", match.get("epoch_length_ms")),
            ("Метод PSD", match.get("psd_method")),
            ("Референс", match.get("reference")),
            ("Фильтр расчёта, Гц", filter_text),
            ("Notch, Гц",
             match.get("notch_hz") if match.get("notch_hz") is not None else "выключен"),
            ("Общих каналов", len(match.get("channels") or [])),
        ])
        + (
            f"<p><b>Только в A:</b> {esc(', '.join(only_a))} — исключены из сравнения.</p>"
            if only_a else ""
        )
        + (
            f"<p><b>Только в B:</b> {esc(', '.join(only_b))} — исключены из сравнения.</p>"
            if only_b else ""
        )
    )
    rep.add_html(pair_html, title="Пара и совпадение параметров", section=section)

    rep.add_html(
        _bands_table(bands)
        + "<p>95% bootstrap-ИИ дельты дБ: ноль внутри интервала — различие не "
        "подтверждено. <b>q (FDR)</b> — поправка по всем полосам результата; "
        "подсветку строк в UI задают значимые каналы внутри полосы "
        "(<i>fdr_significant_channels</i>), а не q самой полосы.</p>",
        title="Дельты по полосам (B − A)",
        section=section,
    )

    figures: list[Any] = []
    psd_fig = _psd_figure(result)
    if psd_fig is not None:
        figures.append(psd_fig)
        rep.add_figure(psd_fig, title="PSD-кривые и дельта B − A", section=section)

    topomaps = [
        html for html in (
            _topomap_html(cfg, band, result) for band in bands
        ) if html is not None
    ]
    if topomaps:
        rep.add_html("".join(topomaps), title="Карты разности B − A", section=section)

    if stats:
        clusters = list(stats.get("clusters") or [])
        rep.add_html(
            kv([
                ("Метод", stats.get("method")),
                ("Пермутаций", stats.get("n_permutations")),
                ("Уровень α", stats.get("alpha")),
                ("Кластеров найдено", stats.get("n_clusters")),
                ("Значимых (p < α)", stats.get("n_significant")),
            ])
            + (
                _clusters_table(clusters) if clusters
                else "<p>Кластеров нет: различия по «канал × частота» не подтвердились.</p>"
            ),
            title="Кластерный тест (MNE)",
            section=section,
        )

    ind = result.get("indices") or {}
    spec = result.get("specparam") or {}

    def _peaks_table(peaks: Sequence[dict[str, Any]]) -> str:
        return table(
            ("Центр, Гц", "Высота, дБ", "Ширина, Гц"),
            [
                [num(p.get("center_hz"), 2), num(p.get("amplitude_db"), 2),
                 num(p.get("bandwidth_hz"), 2)]
                for p in peaks
            ],
        )

    rep.add_html(
        kv([
            ("IAF, Гц (A)", num(ind.get("iaf_a_hz"), 2)),
            ("IAF, Гц (B)", num(ind.get("iaf_b_hz"), 2)),
            ("ΔIAF (B − A), Гц", num(ind.get("delta_iaf_hz"), 2)),
            ("θ/β (A)", num(ind.get("theta_beta_a"), 2)),
            ("θ/β (B)", num(ind.get("theta_beta_b"), 2)),
            ("Δθ/β (B − A)", num(ind.get("delta_theta_beta"), 2)),
            ("(θ+α)/β (A)", num(ind.get("theta_alpha_beta_a"), 2)),
            ("(θ+α)/β (B)", num(ind.get("theta_alpha_beta_b"), 2)),
            ("Δ(θ+α)/β (B − A)", num(ind.get("delta_theta_alpha_beta"), 2)),
        ])
        + "<h3>1/f-разложение (specparam)</h3>"
        + kv([
            ("Показатель спада A", num(spec.get("exponent_a"), 2)),
            ("Показатель спада B", num(spec.get("exponent_b"), 2)),
            ("Δ показателя (B − A)", num(spec.get("delta_exponent"), 2)),
            ("Сдвиг A, дБ", num(spec.get("offset_a"), 2)),
            ("Сдвиг B, дБ", num(spec.get("offset_b"), 2)),
            ("Δ сдвига (B − A), дБ", num(spec.get("delta_offset"), 2)),
            ("R² фита A", num(spec.get("fit_r_squared_a"), 3)),
            ("R² фита B", num(spec.get("fit_r_squared_b"), 3)),
        ])
        + (
            "<h3>Пики A</h3>" + _peaks_table(list(spec.get("peaks_a") or []))
            if spec.get("peaks_a") else ""
        )
        + (
            "<h3>Пики B</h3>" + _peaks_table(list(spec.get("peaks_b") or []))
            if spec.get("peaks_b") else ""
        ),
        title="Индексы (IAF, θ/β) и 1/f",
        section=section,
    )

    notes = [str(item) for item in (result.get("notes") or [])]
    warnings = [str(item) for item in (result.get("warnings") or [])]
    rep.add_html(
        "<h3>Каветы интерпретации (показываются без правок)</h3>" + bullets(notes)
        + "<h3>Предупреждения расчёта</h3>" + bullets(warnings),
        title="Каветы и предупреждения",
        section=section,
    )

    return _save_to_bytes(rep, figures, path)


# ---------- Тип 2: отчёт по прогону группы ------------------------------------


def _group_rows_table(
    rows: Sequence[dict[str, Any]], participants: Sequence[dict[str, Any]],
) -> str:
    """Таблица строк агрегата: показатели группы + ячейки по записям.

    Знаменатели разные (правило чтения чисел): ``Share строки, %`` — доля
    строки от всех точек выборки в полосе, ячейка — доля от точек **своей**
    записи; подпись обоих знаменателей стоит в секции «Как читать числа».
    """
    headers = (
        "Строка", "Полуш.", "Точек", "Share строки, %", "GOF ср", "GOF мед",
        "СТОД GOF", "момент, нАм", "Сессий",
        *(f"№{index + 1}" for index in range(len(participants))),
    )
    rows_out: list[list[Any]] = []
    for row in rows:
        cells = list(row.get("cells") or [])
        cell_text = [
            f"{pct(cell.get('share'))} ({int(cell.get('count') or 0)})"
            if index < len(cells) else "—"
            for index, cell in enumerate(cells)
        ]
        rows_out.append([
            row.get("name"),
            row.get("hemisphere"),
            str(int(row.get("count") or 0)),
            pct(row.get("share")),
            num(row.get("mean_gof"), 3),
            num(row.get("median_gof"), 3),
            num(row.get("std_gof"), 3),
            _num_auto(row.get("mean_amplitude_nam")),
            str(int(row.get("n_sessions") or 0)),
            *cell_text,
        ])
    return table(headers, rows_out)


def _group_heatmap(
    rows: Sequence[dict[str, Any]], participants: Sequence[dict[str, Any]],
    columns: Sequence[str], title: str,
) -> Any | None:
    """Тепловая карта «строки словаря × записи»; ``None`` — строк нет."""
    if not rows or not participants:
        return None
    labels = [str(row.get("name") or "") for row in rows]
    values: list[float] = []
    for row in rows:
        cells = list(row.get("cells") or [])
        for index in range(len(participants)):
            share = cells[index].get("share") if index < len(cells) else None
            values.append(100.0 * float(share or 0.0))
    return _heatmap_figure(labels, columns, values, title)


def _build_group_report(
    detail: dict[str, Any], *, signature: str, path: str,
) -> bytes:
    """Собирает HTML-отчёт по прогону группового анализа (Тип 2 «Итогов»).

    ``detail`` — результат ``get_group_analysis``: паспорт прогона + свежий
    пересчёт агрегата по живой БД, поэтому документ честно подписывает
    «числа пересчитаны в момент сборки», а не дату сохранения определения.
    """
    import mne
    from mne.report import Report

    run = detail.get("run") or {}
    agg = detail.get("aggregate") or {}
    filters = agg.get("filters") or {}
    participants = list(agg.get("participants") or [])
    structures = list(agg.get("structures") or [])
    brodmann = list(agg.get("brodmann") or [])
    clusters = list(agg.get("clusters") or [])
    cluster_params = agg.get("cluster_params") or {}
    notes = [str(item) for item in (agg.get("notes") or [])]
    warnings = [str(item) for item in (agg.get("warnings") or [])]
    built_at = time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime())
    section = "Отчёт по группе (Тип 2)"
    band_hz = filters.get("band_hz") or [None, None]

    rep = Report(title=f"DipLock — {_group_title(detail)}")
    rep.add_custom_css(THEME_CSS)
    rep.add_custom_js(THEME_JS)

    rep.add_html(
        "<p>Групповой анализ (тип 2): агрегат «структура/поле Бродмана × записи» "
        "по пакетам диполей участников. Числа <b>пересчитаны по живой БД в момент "
        "сборки</b> — история хранит определение прогона, а не устаревшие цифры "
        "(§8.4.2).</p>"
        f"<p>Прогон: {esc(run.get('name') or f'№{run.get('id')}')} · "
        f"полоса: {esc(filters.get('band_key'))} "
        f"({_num_auto(band_hz[0])}–{_num_auto(band_hz[1])} Гц) · "
        f"участников: {len(participants)} · точек выборки: "
        f"{int(agg.get('n_points_total') or 0)} · собрано: {built_at} · "
        f"MNE {esc(mne.__version__)}</p>"
        + _fingerprint_html(
            "групповой анализ (остаток 4.7)", signature,
            [
                ("Прогон (id)", run.get("id")),
                ("Создан", _fmt_dt(run.get("created_at"))),
                ("Отпечаток определения", run.get("params_sig")),
                ("Запрошено участников", run.get("n_sessions_requested")),
                ("Живых участников", run.get("n_members_alive")),
                ("Полоса", filters.get("band_key")),
                ("Отбор по GOF", filters.get("gof_min")
                 if filters.get("gof_min") is not None else "без отбора"),
                ("Длина эпохи, мс", filters.get("epoch_length_ms")
                 if filters.get("epoch_length_ms") is not None else "любая"),
                ("Даты прогона",
                 f"{_fmt_dt(filters.get('date_from'))} … {_fmt_dt(filters.get('date_to'))}"),
                ("Топ строк", filters.get("top_n")),
            ],
        ),
        title="О отчёте",
        section=section,
    )

    rep.add_html(
        "<h3>Как читать числа (подписи источника, без правок)</h3>" + bullets(notes)
        + "<h3>Фильтры расчёта</h3>"
        + kv([
            ("Полоса",
             f"{filters.get('band_key')} ({_num_auto(band_hz[0])}–{_num_auto(band_hz[1])} Гц)"),
            ("Отбор точек по GOF", filters.get("gof_min")
             if filters.get("gof_min") is not None else "без отбора"),
            ("Длина эпохи прогона, мс", filters.get("epoch_length_ms")
             if filters.get("epoch_length_ms") is not None else "любая"),
            ("Создан не раньше", _fmt_dt(filters.get("date_from"))),
            ("Создан не позже", _fmt_dt(filters.get("date_to"))),
            ("Фильтр строк", ", ".join(str(n) for n in filters.get("names") or [])
             if filters.get("names") else "все строки"),
            ("Топ строк словаря", filters.get("top_n")),
        ])
        + "<h3>Участники (колонки таблиц и карты)</h3>"
        + table(
            ("№", "Запись", "Файл", "Взятый прогон", "Точек в полосе"),
            [
                [
                    str(index + 1),
                    participant.get("recording_id"),
                    participant.get("filename") or "—",
                    (
                        f"{participant.get('analysis_kind')}, "
                        f"{_fmt_dt(participant.get('analysis_created_at'))}"
                        if participant.get("analysis_id") else "нет подходящего прогона"
                    ),
                    str(int(participant.get("n_points") or 0)),
                ]
                for index, participant in enumerate(participants)
            ],
        ),
        title="Как читать числа, фильтры и участники",
        section=section,
    )

    hidden = int(agg.get("n_structure_names") or 0) - len(structures)
    hidden_ba = int(agg.get("n_brodmann_names") or 0) - len(brodmann)
    top_note = ""
    if hidden > 0 or hidden_ba > 0:
        top_note = (
            f"<p>Показан топ: структур — {len(structures)} из "
            f"{int(agg.get('n_structure_names') or 0)}, полей — {len(brodmann)} из "
            f"{int(agg.get('n_brodmann_names') or 0)} (полный счёт — в БД, §8.4.4).</p>"
        )
    rep.add_html(
        "<p>Ячейка — доля точек <b>своей записи</b> (между записями сравнима "
        "только она); знаменатель строки — все точки выборки в полосе.</p>"
        + (_group_rows_table(structures, participants) if structures
           else "<p>Структуры не названы или строк нет (атлас недоступен?).</p>")
        + top_note,
        title="Структуры (топ строк)",
        section=section,
    )
    rep.add_html(
        _group_rows_table(brodmann, participants) if brodmann
        else "<p>Поля Бродмана не названы или строк нет (атлас недоступен?).</p>",
        title="Поля Бродмана (топ строк)",
        section=section,
    )

    columns = [
        f"№{index + 1} {_short_name(participant.get('filename') or participant.get('recording_id'))}"
        for index, participant in enumerate(participants)
    ]
    figures: list[Any] = []
    for rows, title in (
        (structures, "Тепловая карта: структуры × записи"),
        (brodmann, "Тепловая карта: поля Бродмана × записи"),
    ):
        fig = _group_heatmap(rows, participants, columns, title)
        if fig is not None:
            figures.append(fig)
            rep.add_figure(fig, title=title, section=section)

    cluster_rows = [
        [
            str(index + 1),
            "[" + ", ".join(num(v, 1) for v in (cluster.get("centroid_mni") or [])) + "]",
            str(int(cluster.get("n_points") or 0)),
            str(int(cluster.get("n_sessions") or 0)),
            pct(cluster.get("session_share")),
            num(cluster.get("volume_cm3"), 2),
            num(cluster.get("density_per_cm3"), 1),
            pct(cluster.get("share")),
            "[" + ", ".join(num(v, 0) for v in (cluster.get("extent_mm") or [])) + "]",
            ", ".join(str(n) for n in cluster.get("top_structures") or []) or "—",
            ", ".join(str(n) for n in cluster.get("top_brodmann") or []) or "—",
        ]
        for index, cluster in enumerate(clusters)
    ]
    rep.add_html(
        kv([
            ("Размер вокселя, мм", cluster_params.get("voxel_mm")),
            ("Минимум точек в кластере", cluster_params.get("min_points")),
            ("Связность", cluster_params.get("connectivity")),
        ])
        + (
            table(
                ("№", "Центроид MNI, мм", "Точек", "Записей", "Устойчивость, %",
                 "Объём, см³", "Плотность, /см³", "Доля, %", "Протяжённость, мм",
                 "Структуры топ-3", "BA топ-3"),
                cluster_rows,
            ) if cluster_rows
            else "<p>Кластеров нет: точек выборки мало или они разрознены "
                 "(предупреждения — ниже).</p>"
        ),
        title="Кластеры диполей (B8)",
        section=section,
    )

    rep.add_html(bullets(warnings), title="Предупреждения", section=section)

    return _save_to_bytes(rep, figures, path)


# ---------- сборка (ленивая) и метаданные --------------------------------------


def _ensure(
    cfg: Settings, kind: str, source_id: str, payload: Any,
    build: Callable[[str, str], bytes], title: str, warnings: list[str],
) -> ReportDoc:
    """Читает документ из кэша или собирает заново — общий каркас обоих типов.

    ``build(signature, path)`` вызывается только при промахе; замер уходит в
    журнал шагов с ``cache_hit`` (правило журнала — ``docs/data_map.md`` §9).
    """
    sig = _signature(kind, payload)
    path = group_report_html_path(cfg, kind, source_id, sig)
    started = time.perf_counter()
    data = cache_read(path)
    cache_hit = data is not None
    if data is None:
        data = build(sig, path)
        cache_write(path, data, label="Кэш отчёта группового анализа")
        _drop_stale(cfg, kind, source_id, keep=sig)
    journal.record(
        "report", f"{kind}_report",
        ms=(time.perf_counter() - started) * 1000.0,
        params_key=sig, bytes_out=len(data), cache_hit=cache_hit,
        note=f"source={source_id}",
    )
    return ReportDoc(
        data=data,
        sig=sig,
        version=hashlib.sha256(data).hexdigest()[:16],
        title=title,
        warnings=warnings,
    )


def ensure_compare_report(
    cfg: Settings, job_id: str, result: dict[str, Any],
) -> ReportDoc:
    """HTML-отчёт по результату задачи ``kind=compare`` (Тип 1 «Итогов»)."""
    return _ensure(
        cfg, COMPARE_KIND, job_id, result,
        lambda sig, path: _build_compare_report(cfg, result, signature=sig, path=path),
        title=_compare_title(result),
        warnings=[str(item) for item in (result.get("warnings") or [])],
    )


def ensure_group_report(
    cfg: Settings, run_id: int, detail: dict[str, Any],
) -> ReportDoc:
    """HTML-отчёт по прогону группового анализа (Тип 2 «Итогов»)."""
    return _ensure(
        cfg, GROUP_KIND, str(run_id), detail,
        lambda sig, path: _build_group_report(detail, signature=sig, path=path),
        title=_group_title(detail),
        warnings=[
            str(item)
            for item in ((detail.get("aggregate") or {}).get("warnings") or [])
        ],
    )








