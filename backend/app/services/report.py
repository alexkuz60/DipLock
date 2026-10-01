"""Сквозной автоотчёт записи (раздел «Итоги»): MNE.Report + пакет диполей по полосам.

Отчёт собирается в две части:

* **Часть 1** — качественная оценка сырого файла и результаты препроцессинга.
  Новых измерений здесь нет: три стадии ``run_preprocess`` (filter / artifacts /
  epochs) с теми же параметрами считают ровно те числа, что раздел EDF, а отчёт
  пересказывает их целиком через ``mne.Report``: светофор QC и причины, числа QC
  (чистые данные %, сетевой шум, SNR), QC-сводка по каналам, счётчики видов
  артефактов, паспорт фильтра/референса/очистки, нарезка эпох и отбраковка,
  предупреждения стадий.
* **Часть 2** — пакетный расчёт диполей по именованным полосам
  (``freq_bands`` + ``functional_bands``) через быстрый ``compute_dipole_scan``
  и агрегаты «динамика активных структур и полей Бродмана» по каждой полосе.
  Принципы пакетного сценария — ``docs/rules/dipoles.md``: GOF между полосами
  **не сравним** (узкая полоса завышает R²), кросс-полосной фильтр доверия —
  RIV/CI; подпись об этом вставляется в отчёт перед таблицами.

HTML — самодостаточный документ (MNE встраивает CSS/JS), лежит в дисковом кэше
``cache/reports/<recording_id>/<sig>.html`` (атомарная запись через
``cache_store``) и отдаётся ассетом с ETag/304. Очистка вместе с записью —
``_drop_signal_cache`` (``services/recordings.py``), сироты —
``orphans.RECORDING_CACHE_SUBDIRS``.

Тяжёлые вычисления CPU-bound: воркер запускается в потоке ``job_manager``,
отмена кооперативная (тик прогресса бросает ``JobCancelledError``).
"""
import hashlib
import html
import logging
import os
import time
from collections import Counter
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field, replace
from typing import Any

import matplotlib
import numpy as np

from app.core.config import Settings
from app.schemas.analysis import PreprocessStage
from app.services import journal
from app.services.cache_store import cache_clear, cache_path, cache_read, cache_write
from app.services.dipole_scanner import GRID_STEP_MM, DipoleScanParams, compute_dipole_scan
from app.services.preprocess import PreprocessParams, run_preprocess
from app.services.recordings import Recording

logger = logging.getLogger(__name__)

# Рендер только в Agg (тот же приём, что в services/spectral.py): без дисплея
# matplotlib и так свалился бы, но честный вызов вместо молчаливого фолбэка.
matplotlib.use("Agg")

# Подпись «атрибуции нет»: бывает, когда fsaverage/атлас недоступны (точка есть,
# а структура/BA не названы) — в сводках считается отдельным числом
# ``n_no_attribution``, а не поддельным именем структуры.

# Динамика структур: эпохи режем на 5 одинаковых бинов по времени записи, в
# таблице — доля эпох бина, где структура была активна (топ-5 структур полосы).
TIME_BINS = 5
TOP_STRUCTURES = 5
TOP_BRODMANN = 12  # строк тепловой карты «BA × полосы»

# Стадии части 1 (та же очередь, что у раздела EDF)
REPORT_STAGES: tuple[PreprocessStage, ...] = ("filter", "artifacts", "epochs")


class ReportError(ValueError):
    """Ошибка параметров отчёта — превращается в понятный текст задачи."""


@dataclass
class ReportParams:
    """Параметры автоотчёта (плоская проекция формы запроса).

    ``preprocess`` — **те же** параметры, что формы стадий раздела EDF (фильтр,
    пороги детекторов, очистка, длина эпохи): часть 1 обязана пересказывать
    ровно те числа, что видит пользователь в EDF, а не дефолты сервера.
    ``epoch_mode`` отчёта всегда ``fixed`` — событийная нарезка в сквозной
    отчёт пока не входит (решение среза, `docs/ui/summary.md`).

    Часть 2 — пакет диполей: набор именованных полос и шаг сетки поиска.
    ``band_keys`` пуст — берутся все полосы ``freq_bands`` + ``functional_bands``.
    """

    preprocess: PreprocessParams = field(default_factory=PreprocessParams)
    grid_mm: float = GRID_STEP_MM
    band_keys: list[str] = field(default_factory=list)


def report_band_catalog(cfg: Settings) -> dict[str, tuple[float, float]]:
    """Все именованные полосы пакета в порядке конфига: базовые + функциональные."""
    catalog: dict[str, tuple[float, float]] = {}
    for source in (cfg.freq_bands, cfg.functional_bands):
        for key, bounds in dict(source).items():
            catalog[str(key)] = (float(bounds[0]), float(bounds[1]))
    return catalog


def resolve_band_keys(cfg: Settings, keys: Sequence[str]) -> list[str]:
    """Набор полос пакета: пустой список — все полосы, неизвестный ключ — ошибка.

    Порядок сохраняется как в форме (и как в конфиге для «все»): отчёт читается
    сверху вниз в том же порядке, в котором считался пакет.
    """
    catalog = report_band_catalog(cfg)
    if not keys:
        return list(catalog)
    unknown = [key for key in keys if key not in catalog]
    if unknown:
        raise ReportError(
            f"Неизвестные полосы: {', '.join(unknown)}; доступны: {', '.join(catalog)}"
        )
    # Дедупликация с сохранением порядка: «α,α» — не повод считать дважды
    return list(dict.fromkeys(keys))


def report_signature(
    cfg: Settings, params: ReportParams, band_keys: Sequence[str],
) -> str:
    """Отпечаток параметров отчёта — имя файла в дисковом кэше.

    Состав отражает всё, что меняет HTML (части 1 и 2): параметры
    препроцессинга целиком (``repr`` dataclass — все поля, включая пороги),
    шаг сетки и набор полос. ETag ответа считается от **содержимого**,
    поэтому пересборка с теми же параметрами может дать другой тег (в отчёт
    входит дата сборки) — это честно, а не рассинхрон.
    """
    payload = "|".join(
        [
            repr(params.preprocess),
            f"{params.grid_mm:g}",
            ",".join(band_keys),
        ]
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


def report_html_path(cfg: Settings, recording_id: str, signature: str) -> str:
    """Путь HTML отчёта в дисковом кэше (корень — только из ``settings``)."""
    return cache_path(cfg.cache_dir, "reports", recording_id, f"{signature}.html")


def read_report_html(
    cfg: Settings, recording_id: str, signature: str,
) -> tuple[bytes, str] | None:
    """Байты HTML + версию для ETag; ``None`` — файла нет (очищен/не собран)."""
    data = cache_read(report_html_path(cfg, recording_id, signature))
    if data is None:
        return None
    return data, hashlib.sha256(data).hexdigest()[:16]


def clear_report_cache(cfg: Settings, recording_id: str) -> None:
    """Чистит HTML отчётов записи (вызывается из ``_drop_signal_cache``)."""
    cache_clear(cfg.cache_dir, "reports", recording_id)


class _StageWindow:
    """Прогресс стадии препроцессинга в общем окне 0..1 (часть 1 отчёта).

    ``run_preprocess`` зовёт колбэк без дробного прогресса («начало» / середина /
    ``done``), поэтому дробь задаёт окно: первая реплика — нижняя граница,
    ``done`` — верхняя, середина — между ними. Дробь **всегда** передаётся
    явно, иначе ``Job.set_progress`` подменил бы её дефолтом ``PIPELINE_STAGES``.
    """

    def __init__(
        self,
        report: Callable[..., None],
        lo: float,
        hi: float,
        prefix: str,
    ) -> None:
        self._report = report
        self._lo = lo
        self._hi = hi
        self._prefix = prefix
        self._started = False

    def __call__(
        self,
        stage: str,
        progress: float | None = None,
        message: str = "",
        epochs_done: int | None = None,
        epochs_total: int | None = None,
    ) -> None:
        if stage == "done":
            fraction = self._hi
        elif not self._started:
            self._started = True
            fraction = self._lo
        else:
            fraction = (self._lo + self._hi) / 2.0
        text = f"{self._prefix}: {message}" if message else self._prefix
        self._report(
            stage, fraction, message=text,
            epochs_done=epochs_done, epochs_total=epochs_total,
        )


class _BandWindow:
    """Прогресс одной полосы пакета (часть 2): подокно внутри общего 0..1.

    Внутри ``compute_dipole_scan`` ступени: чтение → нарезка → перебор сетки
    (``scan`` сообщает ``epochs_done``/``epochs_total``) → готово; дробь
    раскладывается по этим ступеням, сообщение всегда с именем полосы, чтобы
    прогресс-бар был читаемым («δ: Диполи: 12 из 30»).
    """

    def __init__(
        self,
        report: Callable[..., None],
        lo: float,
        hi: float,
        band_key: str,
    ) -> None:
        self._report = report
        self._lo = lo
        self._hi = hi
        self._band = band_key

    def __call__(
        self,
        stage: str,
        progress: float | None = None,
        message: str = "",
        epochs_done: int | None = None,
        epochs_total: int | None = None,
    ) -> None:
        span = self._hi - self._lo
        if stage == "done":
            fraction = self._hi
        elif stage == "scan" and epochs_total:
            fraction = self._lo + span * 0.85 * (epochs_done or 0) / max(1, epochs_total)
        elif stage == "epochs":
            fraction = self._lo + span * 0.15
        else:
            fraction = self._lo
        text = f"{self._band}: {message}" if message else self._band
        self._report(
            stage, fraction, message=text,
            epochs_done=epochs_done, epochs_total=epochs_total,
        )


def _noop(*args: Any, **kwargs: Any) -> None:
    """Прогресс не передан (вызов из теста/скрипта) — молчит."""


# --- Сводки по полосам (часть 2) ---------------------------------------------


def _median(values: Sequence[float]) -> float | None:
    """Медиана списка или ``None`` для пустого (честнее, чем 0)."""
    if not values:
        return None
    return float(np.median(np.asarray(values, dtype=float)))


def _top_rows(
    counts: Counter, by_name: dict[str, list[dict[str, Any]]], limit: int,
) -> list[dict[str, Any]]:
    """Топ строк «имя | точек | доля | медианный GOF» по убыванию числа точек.

    GOF считается медианой по точкам этой структуры **внутри своей полосы**:
    сравнивать его между полосами нельзя (принцип 3 в ``docs/rules/dipoles.md``),
    поэтому в отчёте он идёт с колонкой доли эпох, а не как общий ранжир.
    """
    rows: list[dict[str, Any]] = []
    for name, count in counts.most_common(limit):
        rows.append(
            {
                "name": str(name),
                "count": int(count),
                "share": 0.0,  # заполняется вызывающим: доля от числа точек
                "median_gof": _median([float(p["gof"]) for p in by_name.get(name, [])]),
            }
        )
    return rows


def summarize_band(
    band_key: str,
    band_hz: Sequence[float],
    result: dict[str, Any],
) -> dict[str, Any]:
    """Агрегаты одной полосы пакета: топы структур/BA и динамика по бинам времени.

    Вход — результат ``compute_dipole_scan`` (одна точка на эпоху, пик GFP):
    «активность структуры» = «в этой эпохе лучшая точка локализована в ней».
    Динамика — топ-5 структур полосы × ``TIME_BINS`` одинаковых бинов по
    индексам эпох: доля эпох бина, где структура активна.
    """
    points: list[dict[str, Any]] = list(result.get("points") or [])
    n_points = len(points)
    gofs = [float(p["gof"]) for p in points]
    rives = [float(p["riv"]) for p in points if p.get("riv") is not None]

    struct_counts: Counter[str] = Counter()
    ba_counts: Counter[str] = Counter()
    by_struct: dict[str, list[dict[str, Any]]] = {}
    by_ba: dict[str, list[dict[str, Any]]] = {}
    for point in points:
        structure = point.get("anatomical_structure")
        if structure:
            struct_counts[str(structure)] += 1
            by_struct.setdefault(str(structure), []).append(point)
        area = point.get("brodmann_area")
        if area:
            ba_counts[str(area)] += 1
            by_ba.setdefault(str(area), []).append(point)

    top_structures = _top_rows(struct_counts, by_struct, TOP_STRUCTURES)
    top_brodmann = _top_rows(ba_counts, by_ba, TOP_BRODMANN)
    for row in (*top_structures, *top_brodmann):
        row["share"] = row["count"] / n_points if n_points else 0.0

    # Динамика: бины по индексам эпох (0..max_epoch), доля активности структуры
    max_epoch = max((int(p.get("epoch_index", 0)) for p in points), default=0)
    span = max(1, max_epoch + 1)
    bin_totals = [0] * TIME_BINS
    bin_hits: dict[str, list[int]] = {
        row["name"]: [0] * TIME_BINS for row in top_structures
    }
    for point in points:
        index = min(TIME_BINS - 1, int(int(point.get("epoch_index", 0)) / span * TIME_BINS))
        # Знаменатель — все точки бина (эпохи), не только топ-5: доля читается
        # как «сколько эпох бина вообще пришлось на структуру».
        bin_totals[index] += 1
        structure = point.get("anatomical_structure")
        counts = bin_hits.get(str(structure)) if structure else None
        if counts is not None:
            counts[index] += 1
    dynamics = [
        {
            "name": row["name"],
            "shares": [
                bin_hits[row["name"]][index] / bin_totals[index] if bin_totals[index] else 0.0
                for index in range(TIME_BINS)
            ],
        }
        for row in top_structures
    ]

    return {
        "band_key": band_key,
        "band_hz": [float(band_hz[0]), float(band_hz[1])],
        "n_epochs_used": int(result.get("n_epochs_used", 0)),
        "n_points": n_points,
        "n_no_attribution": sum(1 for p in points if not p.get("anatomical_structure")),
        "median_gof": _median(gofs),
        "median_riv": _median(rives),
        "top_structures": top_structures,
        "top_brodmann": top_brodmann,
        "dynamics": dynamics,
        "warnings": [f"{band_key}: {w}" for w in (result.get("warnings") or [])],
    }


# --- HTML-секции MNE.Report (части 1 и 2) ------------------------------------

# Русские подписи видов — те же, что в UI (`shared/lib/artifacts.ts`:
# ARTIFACT_LABELS), чтобы отчёт и вьюер говорили об одном и том же.
ARTIFACT_TITLES: dict[str, str] = {
    "zscore_outlier": "z-score выбросы",
    "peak_to_peak": "Превышение peak-to-peak",
    "flat_line": "Плоская линия",
    "clipping": "Клиппинг (насыщение)",
    "break": "Разрыв записи",
    "electrode_pop": "Всплеск электрода",
    "muscle_emg": "Мышечный (ЭМГ)",
    "line_noise": "Сетевой шум 50/60 Гц",
    "ocular": "Окулярный (моргание)",
    "ecg": "ЭКГ-наводка",
    "ica_eog": "ICA: EOG-компоненты",
}

_STAGE_TITLES: dict[str, str] = {
    "filter": "Фильтр и референс",
    "artifacts": "Артефакты",
    "epochs": "Эпохи",
}


class Raw(str):
    """Ячейка таблицы, которую не надо экранировать (уже готовый HTML)."""


def _esc(value: Any) -> str:
    """HTML-экранирование: имена каналов/структур приходят из данных записи."""
    return html.escape(str(value))


def _num(value: Any, digits: int = 1) -> str:
    """Число с фиксированной точностью; ``None`` — честное «—»."""
    if value is None:
        return "—"
    try:
        return f"{float(value):.{digits}f}"
    except (TypeError, ValueError):
        return str(value)


def _pct(share: Any, digits: int = 1) -> str:
    """Доля 0..1 → проценты для таблиц отчёта."""
    if share is None:
        return "—"
    return f"{100.0 * float(share):.{digits}f}"


def _table(headers: Sequence[str], rows: Sequence[Sequence[Any]]) -> str:
    """Простая HTML-таблица: оформление даёт сам MNE.Report, здесь только разметка."""
    head = "".join(f"<th>{_esc(h)}</th>" for h in headers)
    cells: list[str] = []
    for row in rows:
        row_html = "".join(
            f"<td>{cell if isinstance(cell, Raw) else _esc(cell)}</td>" for cell in row
        )
        cells.append(f"<tr>{row_html}</tr>")
    return f"<table><thead><tr>{head}</tr></thead><tbody>{''.join(cells)}</tbody></table>"


def _kv(pairs: Sequence[tuple[str, Any]]) -> str:
    """Таблица «параметр → значение» (двухколоночная)."""
    return _table(("Параметр", "Значение"), [[key, value] for key, value in pairs])


def _bullets(items: Sequence[str]) -> str:
    """Маркированный список (причины светофора, предупреждения стадий)."""
    if not items:
        return "<p>нет</p>"
    return "<ul>" + "".join(f"<li>{_esc(item)}</li>" for item in items) + "</ul>"


def _part1_html(stages: dict[str, dict[str, Any]]) -> str:
    """Часть 1: качество сырого файла и результаты трёх стадий препроцессинга."""
    filt = stages["filter"]
    art = stages["artifacts"]
    epochs = stages["epochs"]

    band = filt.get("band_hz")
    passport = _kv(
        [
            ("Файл записи", filt.get("recording_id", "")),
            ("Длительность, с", _num(filt.get("duration_sec"), 1)),
            ("Частота дискретизации, Гц", _num(filt.get("sfreq"), 1)),
            ("Каналов после монтажа", len(filt.get("channels") or [])),
            (
                "Полоса пропускания, Гц",
                "— (без band-pass)" if band is None else f"{band[0]:g} … {band[1]:g}",
            ),
            ("Notch, Гц", f"{filt['notch_hz']:g}" if filt.get("notch_hz") else "выключен"),
            ("Референс", filt.get("reference", "average")),
            ("Метод фильтра", filt.get("filter_method", "none")),
            (
                "Длина FIR-ядра, с",
                _num(filt.get("filter_length_sec"), 2)
                if filt.get("filter_length_sec") is not None
                else "—",
            ),
            ("Краевой буфер, с", _num(filt.get("edge_buffer_sec"), 2)),
        ]
    )

    status = str(art.get("record_status", "ok"))
    qc_numbers = _kv(
        [
            ("Светофор записи", {"ok": "ок", "warn": "внимание", "bad": "плохо"}.get(status, status)),
            ("Чистые данные, %", _num(art.get("good_data_percent"), 1)),
            (
                "Сетевой шум (пик/фон)",
                "—" if art.get("line_noise_level") is None else f"×{_num(art['line_noise_level'], 1)}",
            ),
            (
                "SNR-медиана, дБ",
                "—" if art.get("snr_db_median") is None else _num(art["snr_db_median"], 1),
            ),
            ("Плохие каналы (авто)", ", ".join(art.get("bad_channels") or []) or "—"),
            ("Мёртвые каналы", ", ".join(art.get("dead_channels") or []) or "—"),
        ]
    )

    shares = sorted(
        (art.get("artifact_share_by_kind") or {}).items(), key=lambda item: -float(item[1]),
    )
    kinds_table = _table(
        ("Вид артефакта", "Доля времени, %"),
        [[ARTIFACT_TITLES.get(kind, kind), _pct(share)] for kind, share in shares],
    ) if shares else "<p>зоны не найдены</p>"

    zone_counts = sorted(
        (art.get("artifact_types") or {}).items(), key=lambda item: -int(item[1]),
    )
    zones_table = _table(
        ("Вид артефакта", "Зон найдено"),
        [[ARTIFACT_TITLES.get(kind, kind), int(count)] for kind, count in zone_counts],
    ) if zone_counts else "<p>—</p>"

    channel_rows = [
        [
            qc.get("channel", ""),
            _num(qc.get("artifact_sec"), 1),
            _pct(qc.get("artifact_share")),
            "—" if qc.get("snr_db") is None else _num(qc["snr_db"], 1),
            "да" if qc.get("dead") else "",
        ]
        for qc in (art.get("channel_qc") or [])
    ]
    channel_rows.sort(key=lambda row: -float(str(row[2]).replace("—", "0") or 0))
    channels_table = _table(
        ("Канал", "Секунд в зонах", "Доля времени, %", "SNR, дБ", "Мёртвый"),
        channel_rows,
    ) if channel_rows else "<p>QC-сводка по каналам не посчитана</p>"

    clean_html = ""
    clean = filt.get("clean")
    if clean:
        loss = clean.get("loss") or {}
        clean_html = _kv(
            [
                ("Метод очистки", clean.get("method", "none")),
                ("Гармоник notch", int(clean.get("notch_harmonics", 0))),
                (
                    "Интерполировано каналов",
                    ", ".join(clean.get("interpolated_channels") or []) or "—",
                ),
                ("Удалено компонентов ICA", int(clean.get("n_components_removed", 0))),
                (
                    "p95 |x| до → после, мкВ",
                    f"{_num(clean.get('amplitude_p95_uv_before'), 1)} → "
                    f"{_num(clean.get('amplitude_p95_uv_after'), 1)}",
                ),
                (
                    "Удалённая дисперсия (L5), %",
                    _num(loss.get("removed_variance_percent"), 1),
                ),
            ]
        )

    rejected = [int(i) for i in (epochs.get("rejected_epochs") or [])]
    rejected_text = ", ".join(str(i) for i in rejected[:100])
    if len(rejected) > 100:
        rejected_text += f" … (всего {len(rejected)})"
    epochs_html = _kv(
        [
            ("Режим нарезки", epochs.get("epoch_mode", "fixed")),
            ("Длина эпохи, мс", _num(epochs.get("epoch_length_ms"), 0)),
            ("Эпох нарезано", int(epochs.get("n_epochs_total", 0))),
            ("Эпох прошло отбраковку", int(epochs.get("n_epochs_used", 0))),
            ("Отброшено (BAD_)", len(rejected)),
            ("Индексы отброшенных", rejected_text or "—"),
        ]
    )

    warning_items: list[str] = []
    for stage, result in stages.items():
        title = _STAGE_TITLES.get(stage, stage)
        warning_items.extend(f"[{title}] {item}" for item in result.get("warnings") or [])

    return (
        "<h2>Паспорт и фильтрация</h2>"
        + passport
        + "<h2>Качество сырого файла (числа QC)</h2>"
        + qc_numbers
        + f"<h3>Причины вердикта</h3>{_bullets(art.get('record_status_reasons') or [])}"
        + f"<h3>Доли времени по видам артефактов</h3>{kinds_table}"
        + f"<h3>Найденные зоны</h3>{zones_table}"
        + f"<h3>QC по каналам</h3>{channels_table}"
        + (f"<h2>Очистка сигнала</h2>{clean_html}" if clean_html else "")
        + f"<h2>Нарезка эпох</h2>{epochs_html}"
        + f"<h2>Предупреждения стадий</h2>{_bullets(warning_items)}"
    )


def _band_html(summary: dict[str, Any]) -> str:
    """Часть 2, одна полоса: сводка + топы структур/BA + динамика по бинам."""
    key = summary["band_key"]
    low, high = summary["band_hz"]
    head = _kv(
        [
            ("Ключ полосы", key),
            ("Полоса, Гц", f"{low:g} … {high:g}"),
            ("Эпох в расчёте (прошло отбраковку)", int(summary["n_epochs_used"])),
            ("Точек (одна на эпоху)", int(summary["n_points"])),
            ("Точек без атрибуции структуры", int(summary["n_no_attribution"])),
            ("Медианный GOF (только внутри полосы)", _num(summary["median_gof"], 3)),
            ("Медианный RIV (кросс-полосной)", _num(summary["median_riv"], 3)),
        ]
    )

    def _name_rows(rows: Sequence[dict[str, Any]]) -> list[list[Any]]:
        return [
            [row["name"], int(row["count"]), _pct(row["share"]), _num(row["median_gof"], 3)]
            for row in rows
        ]

    name_headers = ("Название", "Эпох активно", "Доля, %", "Медианный GOF")
    structures = _table(name_headers, _name_rows(summary["top_structures"])) \
        if summary["top_structures"] else "<p>структуры не названы (атлас недоступен?)</p>"
    brodmann = _table(name_headers, _name_rows(summary["top_brodmann"])) \
        if summary["top_brodmann"] else "<p>поля Бродмана не названы (атлас недоступен?)</p>"

    dynamics = summary["dynamics"]
    if dynamics:
        bin_headers = (
            "Структура",
            *(f"Бин {index + 1}, %" for index in range(TIME_BINS)),
        )
        dynamics_table = _table(
            bin_headers,
            [[row["name"]] + [_pct(share) for share in row["shares"]] for row in dynamics],
        )
        dynamics_note = (
            f"<p>Бины — {TIME_BINS} равных отрезков по индексам эпох записи; "
            "значение — доля эпох бина, в которых структура была лучшей локацией.</p>"
        )
    else:
        dynamics_table = "<p>нет атрибуции — динамика не посчитана</p>"
        dynamics_note = ""

    warnings = summary.get("warnings") or []
    warn_html = f"<h3>Предупреждения расчёта</h3>{_bullets(warnings)}" if warnings else ""

    return (
        head
        + "<h3>Активные структуры (топ по числу эпох)</h3>"
        + structures
        + "<h3>Поля Бродмана (топ по числу эпох)</h3>"
        + brodmann
        + "<h3>Динамика активности структур по времени</h3>"
        + dynamics_table
        + dynamics_note
        + warn_html
    )


def _heatmap_model(
    summaries: Sequence[dict[str, Any]],
) -> tuple[list[str], list[str], list[float]] | None:
    """Модель тепловой карты «поле/структура × полоса»: имена, полосы, доли %.

    Источник — топы полос; предпочтение полям Бродмана (как в теме раздела),
    при их отсутствии — анатомическим структурам. ``None`` — атрибуции нет
    вовсе (fsaverage недоступен), тогда картинка не рисуется.
    """
    rows_key = "top_brodmann" if any(s["top_brodmann"] for s in summaries) else "top_structures"
    totals: Counter[str] = Counter()
    for summary in summaries:
        for row in summary[rows_key]:
            totals[row["name"]] += int(row["count"])
    if not totals:
        return None
    names = [name for name, _ in totals.most_common(TOP_BRODMANN)]
    columns = [summary["band_key"] for summary in summaries]
    lookup = {
        summary["band_key"]: {row["name"]: float(row["share"]) for row in summary[rows_key]}
        for summary in summaries
    }
    values = [
        100.0 * lookup[column].get(name, 0.0) for name in names for column in columns
    ]
    return names, columns, values


# Подпись «как читать» для части 2: дословный смысл принципа 3 пакетного
# сценария (docs/rules/dipoles.md) — она обязана стоять перед любыми таблицами.
GOF_NOTE = (
    "<p><b>GOF между полосами не сравним.</b> Узкая полоса даёт гладкий "
    "автокоррелированный сигнал и завышает R² по построению: «GOF > 0.9» в δ и "
    "в γ — разные числа. Кросс-полосной фильтр доверия — RIV/CI (in-band "
    "ковариация шума); сравнивать полосы можно по долям эпох и RIV, но не по "
    "GOF (docs/rules/dipoles.md, принцип 3).</p>"
)


def _heatmap_figure(
    names: Sequence[str], columns: Sequence[str], values: Sequence[float],
) -> Any:
    """Тепловая карта «структура/поле × полоса» (доля эпох, %)."""
    from matplotlib import pyplot as plt

    grid = np.asarray(values, dtype=float).reshape(len(names), len(columns))
    fig, ax = plt.subplots(
        figsize=(
            max(4.5, 1.0 * len(columns) + 3.5),
            max(3.0, 0.42 * len(names) + 1.2),
        ),
    )
    image = ax.imshow(grid, aspect="auto", cmap="viridis")
    ax.set_xticks(range(len(columns)), [str(c) for c in columns], rotation=45, ha="right")
    ax.set_yticks(range(len(names)), [str(n) for n in names])
    ax.set_xlabel("Полоса пакета")
    ax.set_title("Доля эпох с активной локацией, %")
    fig.colorbar(image, ax=ax, shrink=0.85)
    fig.tight_layout()
    return fig


def _build_report(
    recording: Recording,
    cfg: Settings,
    params: ReportParams,
    band_keys: Sequence[str],
    stages: dict[str, dict[str, Any]],
    summaries: Sequence[dict[str, Any]],
) -> bytes:
    """Собирает MNE.Report (обе части) и возвращает самодостаточный HTML.

    Сохраняется во временный файл рядом с целевым и читается целиком: в кэш
    попадают только готовые байты (правило «кэш не бывает наполовину
    записанным», ``docs/rules/data-and-caches.md``).
    """
    import mne
    from matplotlib import pyplot as plt
    from mne.report import Report

    signature = report_signature(cfg, params, band_keys)
    path = report_html_path(cfg, recording.recording_id, signature)
    build_path = path[: -len(".html")] + ".building.html"
    built_at = time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime())
    section1 = "Часть 1 — качество и препроцессинг"
    section2 = "Часть 2 — диполи по полосам"

    rep = Report(title=f"DipLock — автоотчёт «{recording.filename}»")
    rep.add_html(
        "<p>Сквозной отчёт пайплайна DipLock: часть 1 пересказывает числа, которые "
        "уже считает препроцессинг (стадии filter / artifacts / epochs), часть 2 — "
        "пакетный быстрый расчёт диполей по именованным полосам.</p>"
        f"<p>Запись: {_esc(recording.filename)} · полос пакета: {len(band_keys)} · "
        f"длина эпохи: {params.preprocess.epoch_length_ms:g} мс · шаг сетки: "
        f"{params.grid_mm:g} мм · собрано: {built_at} · "
        f"MNE {_esc(mne.__version__)}</p>",
        title="О отчёте",
        section=section1,
    )
    rep.add_html(
        _part1_html(stages), title="Качество записи и препроцессинг", section=section1,
    )
    rep.add_html(
        "<p>Метод: быстрый расчёт (fast_grid) — одна точка на эпоху в пике GFP, "
        f"перебор сетки с шагом {params.grid_mm:g} мм на сферической модели головы; "
        "точный BEM-фитинг в пакет не входит (docs/rules/dipoles.md).</p>" + GOF_NOTE,
        title="Как читать часть 2",
        section=section2,
    )
    for summary in summaries:
        rep.add_html(
            _band_html(summary),
            title=f"Полоса {summary['band_key']}",
            section=section2,
        )

    figures: list[Any] = []
    model = _heatmap_model(summaries)
    if model is not None:
        names, columns, values = model
        figures.append(_heatmap_figure(names, columns, values))
        rep.add_figure(
            figures[-1],
            title="Структуры/поля × полосы: доля эпох, %",
            section=section2,
        )

    # MNE сам каталог не создаёт (FileNotFoundError на первом отчёте), поэтому
    # путь подготавливаем до save; запись в кэш всё равно атомарная (cache_write).
    os.makedirs(os.path.dirname(build_path), exist_ok=True)
    try:
        rep.save(build_path, open_browser=False, overwrite=True)
        with open(build_path, "rb") as fh:
            data = fh.read()
    finally:
        for fig in figures:
            plt.close(fig)
        if os.path.exists(build_path):
            os.remove(build_path)
    return data


def run_report(
    recording: Recording,
    cfg: Settings,
    params: ReportParams,
    progress: Any = None,
) -> dict[str, Any]:
    """Собирает автоотчёт: часть 1 (три стадии) → пакет диполей → HTML в кэш.

    Возвращает dict под схему ``ReportResult`` (его валидирует API); сам HTML
    лежит в дисковом кэше, в результате — только отпечаток и версия (ETag).
    Прогресс дробится: 0.02–0.30 — стадии, 0.30–0.90 — полосы пакета,
    0.92 — сборка MNE.Report.
    """
    report = progress or _noop
    started = time.perf_counter()
    band_keys = resolve_band_keys(cfg, params.band_keys)  # ReportError на опечатке
    catalog = report_band_catalog(cfg)
    report("load_edf", 0.0, message="Отчёт: чтение записи")

    # Часть 1: те же три стадии, что раздел EDF (одинаковые параметры → одни числа)
    base = params.preprocess
    stages: dict[str, dict[str, Any]] = {}
    for index, stage in enumerate(REPORT_STAGES):
        lo = 0.02 + index * 0.09
        stages[stage] = run_preprocess(
            recording,
            cfg,
            replace(base, stage=stage),
            _StageWindow(report, lo, lo + 0.09, f"Отчёт: стадия «{stage}»"),
        )

    # Часть 2: пакетный быстрый расчёт по полосам + агрегаты структур/BA
    summaries: list[dict[str, Any]] = []
    warnings: list[str] = []
    n_bands = max(1, len(band_keys))
    for index, key in enumerate(band_keys):
        low, high = catalog[key]
        scan = DipoleScanParams(
            filter_band=(low, high),
            notch_hz=base.notch_hz,
            epoch_length_ms=base.epoch_length_ms,
            reference=base.reference,
            reference_channels=base.reference_channels,
            grid_mm=params.grid_mm,
        )
        lo = 0.30 + 0.60 * index / n_bands
        hi = 0.30 + 0.60 * (index + 1) / n_bands
        scan_result = compute_dipole_scan(
            recording, cfg, scan, progress=_BandWindow(report, lo, hi, key),
        )
        summary = summarize_band(key, (low, high), scan_result)
        summaries.append(summary)
        warnings.extend(summary.get("warnings") or [])

    report("localize", 0.92, message="Сборка MNE.Report")
    data = _build_report(recording, cfg, params, band_keys, stages, summaries)
    signature = report_signature(cfg, params, band_keys)
    cache_write(
        report_html_path(cfg, recording.recording_id, signature), data,
        label="Кэш автоотчёта",
    )
    version = hashlib.sha256(data).hexdigest()[:16]

    for stage_name, stage_result in stages.items():
        title = _STAGE_TITLES.get(stage_name, stage_name)
        warnings.extend(f"[{title}] {item}" for item in stage_result.get("warnings") or [])
    # Дубли между стадиями возможны (одно предупреждение касается двух) — гасим
    warnings = list(dict.fromkeys(warnings))

    filt = stages["filter"]
    art = stages["artifacts"]
    epochs = stages["epochs"]
    elapsed = time.perf_counter() - started
    result: dict[str, Any] = {
        "recording_id": recording.recording_id,
        "filename": recording.filename,
        "html_sig": signature,
        "report_version": version,
        "qc": {
            "status": art.get("record_status", "ok"),
            "reasons": list(art.get("record_status_reasons") or []),
            "good_data_percent": float(art.get("good_data_percent", 100.0)),
            "line_noise_level": art.get("line_noise_level"),
            "snr_db_median": art.get("snr_db_median"),
            "bad_channels": list(art.get("bad_channels") or []),
            "dead_channels": list(art.get("dead_channels") or []),
            "artifact_types": dict(art.get("artifact_types") or {}),
            "artifact_share_by_kind": dict(art.get("artifact_share_by_kind") or {}),
            "n_channels": len(filt.get("channels") or []),
        },
        "filter_band_hz": filt.get("band_hz"),
        "notch_hz": filt.get("notch_hz"),
        "reference": str(filt.get("reference", "average")),
        "filter_method": str(filt.get("filter_method", "none")),
        "n_epochs_total": int(epochs.get("n_epochs_total", 0)),
        "n_epochs_used": int(epochs.get("n_epochs_used", 0)),
        "rejected_epochs": len(epochs.get("rejected_epochs") or []),
        "bands": summaries,
        "warnings": warnings,
        "duration_sec_calc": round(elapsed, 3),
    }
    journal.record(
        "report",
        "report",
        ms=elapsed * 1000.0,
        note=(
            f"bands={len(band_keys)}, grid={params.grid_mm:g}, "
            f"epoch_ms={base.epoch_length_ms:g}"
        ),
    )
    report("done", 1.0, message=f"Отчёт готов: полос {len(band_keys)}")
    return result







