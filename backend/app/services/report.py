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
from dataclasses import asdict, dataclass, field, replace
from typing import Any

import matplotlib
import numpy as np

from app.core.config import Settings
from app.schemas.analysis import PreprocessStage
from app.services import job_store, journal
from app.services.artifact_detector import annotations_from_zones
from app.services.cache_store import cache_clear, cache_path, cache_read, cache_write
from app.services.dipole_scanner import (
    GRID_STEP_MM,
    DipoleScanParams,
    compute_dipole_scan,
    montage_sparse_warning,
)
from app.services.preprocess import PreprocessParams, run_preprocess
from app.services.recordings import Recording
from app.services.roi import aggregate_roi

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
TOP_ROI = 12  # строк ROI-агрегата каждого словаря (структуры и BA отдельно)

# Стадии части 1 (та же очередь, что у раздела EDF)
REPORT_STAGES: tuple[PreprocessStage, ...] = ("filter", "artifacts", "epochs")

# Версия формата HTML отчёта: входит в report_signature, поэтому смена
# разметки (кросс-проверки §3.9.4, отпечаток в шапке) отправляет старые
# файлы кэша в невалидность, а не показывает устаревший документ (урок A7:
# забытая версия = старые ассеты на диске и в браузере).
# 1 — до кросс-проверок сквозного пайплайна (02.10.2026).
# 2 — кросс-проверки сквозного пайплайна (02.10.2026).
# 3 — строка кавета редкого монтажа в шапке кросс-проверок (срез A, 02.10.2026).
# 4 — секция «ROI-анализ» части 2 (срез B/4.5, 02.10.2026).
REPORT_HTML_VERSION = 4


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
            f"v{REPORT_HTML_VERSION}",
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
    counts: Counter, by_name: dict[str, list[dict[str, Any]]],
    n_points: int, limit: int | None = None,
) -> list[dict[str, Any]]:
    """Строки «имя | точек | доля | медианный GOF» по убыванию числа точек.

    GOF считается медианой по точкам этой структуры **внутри своей полосы**:
    сравнивать его между полосами нельзя (принцип 3 в ``docs/rules/dipoles.md``),
    поэтому в отчёте он идёт с колонкой доли эпох, а не как общий ранжир.

    ``limit=None`` — весь словарь: полный счёт нужен write-API (§8.4.4
    ``docs/data-blocks.md`` — в БД идут все имена, а не топ-N); срезы
    ``top_*`` — вопрос отображения HTML.
    """
    rows: list[dict[str, Any]] = []
    for name, count in counts.most_common(limit):
        rows.append(
            {
                "name": str(name),
                "count": int(count),
                "share": int(count) / n_points if n_points else 0.0,
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

    name_structures = _top_rows(struct_counts, by_struct, n_points)
    name_brodmann = _top_rows(ba_counts, by_ba, n_points)
    top_structures = name_structures[:TOP_STRUCTURES]
    top_brodmann = name_brodmann[:TOP_BRODMANN]

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
        # Полный счёт всех имён словаря (§8.4.4): в БД пишутся целиком, в HTML —
        # только срезы top_*; потребляет write-API (results_store) и убирает.
        "name_counts": {"structure": name_structures, "brodmann": name_brodmann},
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


def _edf_stage_match(
    cfg: Settings, recording: Recording, artifacts_sig: str, art: dict[str, Any],
) -> tuple[str, bool | None]:
    """Сверка чисел отчёта с последней стадией EDF тех же параметров (№1 §3.9.4).

    Источник — файлы задач (``job_store``): в них лежит ``meta.params_sig``
    (отпечаток параметров) и результат стадии. ``None`` — стадии для сверки нет
    (не запускалась либо параметры отличаются): это «нечего сверять», а не ошибка.
    Числа обязаны совпасть «по построению» (общий ``run_preprocess``) — но именно
    поэтому расхождение здесь означает дефект пайплайна, а не шум.
    """
    best: dict[str, Any] | None = None
    try:
        records = job_store.load_records(cfg)
    except Exception:  # файлы истории — не источник истины, сверка не критична
        logger.warning("Файлы задач не прочитаны для сверки со стадией EDF", exc_info=True)
        records = []
    for record in records:
        if record.get("kind") != "preprocess" or record.get("status") != "succeeded":
            continue
        meta = record.get("meta") or {}
        if meta.get("recording_id") != recording.recording_id:
            continue
        if meta.get("stage") != "artifacts" or meta.get("params_sig") != artifacts_sig:
            continue
        if isinstance(record.get("result"), dict):
            best = record  # load_records от старых к новым — остаётся последний
    if best is None:
        return (
            "Сверка со стадией EDF: не выполнялась "
            "(нет стадии «Артефакты» с теми же параметрами)"
        ), None
    other = best["result"]
    pct = float(art.get("good_data_percent") or 0.0)
    other_pct = float(other.get("good_data_percent") or 0.0)
    same_pct = abs(pct - other_pct) <= 0.01
    same_kinds = (other.get("artifact_types") or {}) == (art.get("artifact_types") or {})
    if same_pct and same_kinds:
        return (
            f"Сверка со стадией EDF: сошлось (чистые данные {pct:.1f} %, "
            "счётчики видов артефактов совпали)"
        ), True
    return (
        f"РАСХОЖДЕНИЕ со стадией EDF: те же параметры дают другие числа "
        f"(отчёт {pct:.1f} % против стадии {other_pct:.1f} %) — пайплайны разошлись"
    ), False


def _cross_checks(
    cfg: Settings,
    recording: Recording,
    params: ReportParams,
    band_keys: Sequence[str],
    stages: dict[str, dict[str, Any]],
    summaries: Sequence[dict[str, Any]],
) -> tuple[list[str], list[str]]:
    """Кросс-проверки сквозного пайплайна (§3.9.4): (строки шапки, предупреждения).

    Пункты: №1 сверка со стадией EDF, №2 доля выживших эпох как вердикт
    (первое предупреждение = первая строка отчёта), №3 согласованность нарезки
    «часть 1 ↔ пакет», №4 доля точек без атрибуции, №5 аутlier-структура в
    топах, №7 верхняя граница полос пакета против Nyquist записи. Пороги —
    в ``core/config.py``. №6 (L1 «было/стало») и №8 (отпечаток в шапке) —
    разметка: их добавляют ``_part1_html`` и ``_fingerprint_html``.
    """
    info: list[str] = []
    warns: list[str] = []
    filt = stages["filter"]
    art = stages["artifacts"]
    epochs = stages["epochs"]
    n_total = int(epochs.get("n_epochs_total") or 0)
    n_used = int(epochs.get("n_epochs_used") or 0)

    # №2 — доля выживших эпох как вердикт: первое предупреждение = первая строка
    drop_share = (1.0 - n_used / n_total) if n_total else 0.0
    if n_total and drop_share > cfg.report_epoch_drop_warn_share:
        warns.append(
            f"ВЕРДИКТ: отброшено {drop_share:.0%} эпох ({n_total - n_used} из {n_total}, "
            f"порог {cfg.report_epoch_drop_warn_share:.0%}) — "
            "таблицы структур ниже могут быть шумом"
        )

    # №1 — сверка со стадией EDF (params_sig той же формы, что у EDF)
    line, matched = _edf_stage_match(
        cfg, recording, repr(replace(params.preprocess, stage="artifacts")), art,
    )
    if matched is False:
        warns.append(line)
    info.append(line)

    # №3 — нарезка части 1 против пакета (у каждой полосы свой segment_epochs)
    if n_used and summaries:
        diff = [
            (str(s["band_key"]), int(s["n_epochs_used"]))
            for s in summaries
            if int(s["n_epochs_used"]) != n_used
        ]
        if diff:
            listing = ", ".join(f"{key} {count}" for key, count in diff)
            info.append(
                f"Нарезка: часть 1 — {n_used} эпох; пакет нарезал иначе: {listing}"
            )
            worst = max(abs(count - n_used) for _, count in diff) / n_used
            if worst > cfg.report_epochs_mismatch_warn_share:
                warns.append(
                    f"Нарезка пакета расходится с частью 1 более чем на "
                    f"{cfg.report_epochs_mismatch_warn_share:.0%} "
                    f"(часть 1 — {n_used} эпох; {listing}): структуры полос "
                    "считались не по тем эпохам, что описаны в части 1"
                )
        else:
            info.append(f"Нарезка: часть 1 и пакет сошлись ({n_used} эпох)")

    # №4 — доля точек без атрибуции (fsaverage/атлас недоступны или точка вне мозга)
    for summary in summaries:
        points = int(summary.get("n_points") or 0)
        missing = int(summary.get("n_no_attribution") or 0)
        if points and missing / points > cfg.report_no_attribution_warn_share:
            warns.append(
                f"{summary['band_key']}: {missing / points:.0%} точек без атрибуции "
                f"({missing} из {points}) — таблицы полосы малоинформативны"
            )

    # №5 — аутlier: структура «активна» почти в всех эпохах своей полосы
    for summary in summaries:
        for row in summary.get("top_structures") or []:
            share = float(row.get("share") or 0.0)
            if share > cfg.report_top_share_max:
                warns.append(
                    f"{summary['band_key']}: структура «{row['name']}» активна в "
                    f"{share:.0%} эпох (порог {cfg.report_top_share_max:.0%}) — "
                    "вероятна привязка к одному узлу сетки"
                )

    # №7 — верхняя граница полос пакета против Nyquist записи
    catalog = report_band_catalog(cfg)
    sfreq = float(filt.get("sfreq") or 0.0)
    if sfreq:
        offending = [key for key in band_keys if catalog[key][1] > sfreq / 2.0]
        if offending:
            top = max(catalog[key][1] for key in offending)
            warns.append(
                "Полосы пакета выше Nyquist записи: "
                + ", ".join(f"{key} (до {catalog[key][1]:g} Гц)" for key in offending)
                + f" требуют sfreq ≥ {2 * top:g} Гц, а запись {sfreq:g} Гц — "
                "верхние частоты отсечены"
            )

    # Кавет редкого монтажа (обсуждение 01.10.2026): погрешность позиции при
    # разреженной сетке — в шапку отчёта один раз (в предупреждениях полос он
    # отфильтрован в run_report, иначе дубль по числу полос). 0 каналов —
    # стадия без списка (юнит-тесты `_stages`), кавет не выдумываем.
    n_channels = len(filt.get("channels") or [])
    sparse = montage_sparse_warning(n_channels, cfg) if n_channels else None
    if sparse:
        warns.append(sparse)
    return info, warns


def _cross_checks_html(info: Sequence[str], warns: Sequence[str]) -> str:
    """Блок «Контроли пайплайна» в шапке отчёта (вердикт №2 — первой строкой)."""
    parts: list[str] = ["<h3>Контроли сквозного пайплайна</h3>"]
    parts.extend(f"<p><strong>⚠ {_esc(item)}</strong></p>" for item in warns)
    if info:
        parts.append("<ul>" + "".join(f"<li>{_esc(item)}</li>" for item in info) + "</ul>")
    return "".join(parts)


def _fingerprint_html(
    params: ReportParams, band_keys: Sequence[str], signature: str,
) -> str:
    """Полный отпечаток параметров в шапке (№8 §3.9.4).

    Два собранных HTML сверяются парами: «что именно отличается» читается из
    списков полей, а не угадывается по дате/полосам/сетке.
    """
    import platform as py_platform

    import mne

    rows: list[tuple[str, Any]] = [
        ("report_signature (ключ кэша)", signature),
        ("Формат HTML", f"v{REPORT_HTML_VERSION}"),
        ("Полосы пакета", ", ".join(band_keys)),
        ("Шаг сетки, мм", f"{params.grid_mm:g}"),
        ("Python / MNE", f"{py_platform.python_version()} / {mne.__version__}"),
    ]
    rows.extend(
        (f"preprocess.{key}", value)
        for key, value in sorted(asdict(params.preprocess).items())
    )
    return (
        "<details><summary>Полный отпечаток параметров (сверка двух отчётов парами)</summary>"
        + _kv(rows)
        + "</details>"
    )


def _part1_html(
    stages: dict[str, dict[str, Any]],
    meta: dict[str, Any] | None = None,
    band_top_hz: float | None = None,
) -> str:
    """Часть 1: качество сырого файла и результаты трёх стадий препроцессинга.

    ``meta`` — паспорт записи (единицы EDF, каналы вне монтажа — №7 «шире QC»),
    ``band_top_hz`` — верхняя граница полос пакета (сверка с Nyquist записи).
    """
    filt = stages["filter"]
    art = stages["artifacts"]
    epochs = stages["epochs"]

    band = filt.get("band_hz")
    meta = meta or {}
    sfreq = float(filt.get("sfreq") or 0.0)
    # Единицы EDF: None = автоопределение MNE; флаг масштаба — из паспорта (№7)
    units = str(meta.get("edf_units") or "авто (определены при чтении)")
    if meta.get("units_autoscaled"):
        units += "; масштаб трактован как микровольты"
    unmatched = ", ".join(str(c) for c in (meta.get("unmatched_channels") or [])) or "—"
    passport = _kv(
        [
            ("Файл записи", filt.get("recording_id", "")),
            ("Длительность, с", _num(filt.get("duration_sec"), 1)),
            ("Частота дискретизации, Гц", _num(filt.get("sfreq"), 1)),
            (
                "Верхняя граница пакета / Nyquist, Гц",
                f"{band_top_hz:g} / {sfreq / 2:g}"
                if band_top_hz and sfreq else "—",
            ),
            ("Единицы EDF", units),
            ("Каналы вне монтажа 10-20", unmatched),
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
        clean_rows: list[tuple[str, Any]] = [
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
        # №6 §3.9.4: остаток наводки (L1) — числом «было/стало» прямо в части 1,
        # чтобы эффективность notch была видна без раздела «EDF».
        for line_row in loss.get("line_noise") or []:
            freq = line_row.get("freq_hz")
            freq_text = f"{float(freq):g}" if freq is not None else "?"
            clean_rows.append(
                (
                    f"Сетевой шум {freq_text} Гц (L1), дБ было → стало",
                    f"{_num(line_row.get('before_db'), 1)} → "
                    f"{_num(line_row.get('after_db'), 1)}",
                )
            )
        clean_html = _kv(clean_rows)

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


_HEMISPHERE_RU = {"lh": "слева", "rh": "справа", "mid": "срединная"}


def _roi_html(roi: dict[str, Any] | None) -> str:
    """Секция «ROI-анализ» части 2 (4.5): надёжные точки × полосы + полушария.

    Доли эпох уже показаны тепловой картой выше — здесь то, чего в ней нет:
    счёт точек «GOF ≥ порога» **внутри каждой полосы** и распределение по
    полушариям. Подпись обязана повторить правило чтения (§8.1
    ``docs/data-blocks.md``: «Правило подписи переносится в 4.5 (ROI)»).
    """
    if not roi or not roi.get("n_points_total"):
        return "<p>ROI-агрегат не посчитан: в пакете нет точек.</p>"
    bands = list(roi.get("bands") or [])
    threshold = float(roi.get("gof_threshold") or 0.0)
    hidden = int(roi.get("n_structure_names") or 0) - len(roi.get("structures") or [])
    hidden_ba = int(roi.get("n_brodmann_names") or 0) - len(roi.get("brodmann") or [])

    def _rows_table(rows: Sequence[dict[str, Any]]) -> str:
        if not rows:
            return "<p>не названы (атлас недоступен?)</p>"
        body: list[list[Any]] = []
        for row in rows:
            cells: list[Any] = [row["name"], _HEMISPHERE_RU.get(row["hemisphere"], "—")]
            for band_key in bands:
                cell = (row.get("bands") or {}).get(band_key) or {}
                count = int(cell.get("count") or 0)
                cells.append(
                    f"{int(cell.get('gof_pass') or 0)} из {count}" if count else "—"
                )
            cells.append(int(row.get("count") or 0))
            body.append(cells)
        return _table(("ROI", "Полушарие", *bands, "Всего точек"), body)

    hemi = dict(roi.get("hemisphere_counts") or {})
    total = int(roi.get("n_points_total") or 0)
    asymmetry = _table(
        ("Полушарие", "Точек", "Доля, %"),
        [
            [label, int(hemi.get(key) or 0), _pct((hemi.get(key) or 0) / total if total else 0.0)]
            for key, label in (("lh", "слева"), ("rh", "справа"), ("mid", "срединные"))
        ]
        + [[
            "без названной структуры",
            int(roi.get("n_without_structure") or 0),
            _pct((roi.get("n_without_structure") or 0) / total if total else 0.0),
        ]],
    )
    top_note = ""
    if hidden > 0 or hidden_ba > 0:
        top_note = (
            f"<p>Показан топ: структур — {len(roi['structures'])} из "
            f"{roi['n_structure_names']}, полей — {len(roi['brodmann'])} из "
            f"{roi['n_brodmann_names']} (полный счёт — в БД, §8.4.4).</p>"
        )
    return (
        f"<p><b>Как читать:</b> «GOF ≥ {threshold:g}» — счёт точек <b>внутри "
        "своей полосы</b>: между полосами GOF не сравним (узкая полоса завышает "
        "R², docs/rules/dipoles.md, принцип 3) — сравнивайте полосы по долям и "
        "RIV, а не по GOF. Полушарие — производная от имени атласа, асимметрия "
        f"— по точкам всех полос ({total} точек, одна на эпоху).</p>"
        + f"<h3>Надёжные точки (GOF ≥ {threshold:g}): структуры × полосы</h3>"
        + _rows_table(list(roi.get("structures") or []))
        + f"<h3>Надёжные точки (GOF ≥ {threshold:g}): поля Бродмана × полосы</h3>"
        + _rows_table(list(roi.get("brodmann") or []))
        + "<h3>Асимметрия полушарий</h3>"
        + asymmetry
        + top_note
    )


# Подпись «как читать» для части 2: дословный смысл принципа 3 пакетного
# сценария (docs/rules/dipoles.md) — она обязана стоять перед любыми таблицами.
GOF_NOTE = (
    "<p><b>GOF между полосами не сравним.</b> Узкая полоса даёт гладкий "
    "автокоррелированный сигнал и завышает R² по построению: «GOF > 0.9» в δ и "
    "в γ — разные числа. Кросс-полосной фильтр доверия — RIV/CI (in-band "
    "ковариация шума); сравнивать полосы можно по долям эпох и RIV, но не по "
    "GOF (docs/rules/dipoles.md, принцип 3).</p>"
)

# ---------- тема отчёта (светлая для печати / тёмная для просмотра) ----------
#
# Тема — параметр **отображения**, не расчёта: она не входит в отпечаток
# кэша (report_signature) и не влияет на ETag — один HTML на обе темы,
# переключение в рантайме. Светлая — родная разметка MNE.Report
# (Bootstrap 5.1.1), ничего не переопределяем; тёмная — оверрайды через
# переменные --dl-* под селектором html[data-theme="dark"]. Печать
# (@media print) возвращает светлую палитру при любой выбранной теме,
# поэтому «Ctrl+P» всегда даёт печатный вариант. При обновлении MNE/
# Bootstrap разметка секций может смениться (docs/rules/safety.md, дрейф MNE).

THEME_CSS = """
html[data-theme="dark"] {
  --dl-bg: #14181d;
  --dl-panel: #1a2027;
  --dl-card: #1b2129;
  --dl-stripe: #202730;
  --dl-fg: #dfe3e8;
  --dl-fg-2: #a8b1bd;
  --dl-border: #2c343e;
  --dl-link: #7fb2ff;
}
html[data-theme="dark"],
html[data-theme="dark"] body {
  background-color: var(--dl-bg);
  color: var(--dl-fg);
}
html[data-theme="dark"] a { color: var(--dl-link); }
html[data-theme="dark"] .text-muted { color: var(--dl-fg-2) !important; }
html[data-theme="dark"] nav.navbar {
  background-color: var(--dl-panel);
  border-bottom: 1px solid var(--dl-border);
  color: var(--dl-fg);
}
html[data-theme="dark"] .col-2 {
  background-color: var(--dl-panel);
  border-right: 1px solid var(--dl-border);
}
html[data-theme="dark"] .nav-link { color: var(--dl-fg-2); }
html[data-theme="dark"] .nav-link:hover,
html[data-theme="dark"] .nav-link.active { color: var(--dl-link); }
html[data-theme="dark"] .accordion-item {
  background-color: var(--dl-card);
  border-color: var(--dl-border);
}
html[data-theme="dark"] .accordion-button {
  background-color: var(--dl-card);
  color: var(--dl-fg);
}
html[data-theme="dark"] .accordion-button:not(.collapsed) {
  background-color: var(--dl-stripe);
  color: var(--dl-fg);
  box-shadow: none;
}
html[data-theme="dark"] .accordion-button::after { filter: invert(1); }
html[data-theme="dark"] .accordion-body {
  background-color: transparent;
  color: var(--dl-fg);
}
html[data-theme="dark"] table {
  color: var(--dl-fg);
  background-color: transparent;
}
html[data-theme="dark"] thead th {
  background-color: var(--dl-stripe);
  color: var(--dl-fg);
  border-bottom-color: var(--dl-border);
}
html[data-theme="dark"] tbody tr:nth-child(even) {
  background-color: var(--dl-stripe);
}
html[data-theme="dark"] td,
html[data-theme="dark"] th { border-color: var(--dl-border); }
html[data-theme="dark"] .table {
  --bs-table-bg: transparent;
  --bs-table-color: var(--dl-fg);
  --bs-table-border-color: var(--dl-border);
  --bs-table-striped-bg: var(--dl-stripe);
  --bs-table-striped-color: var(--dl-fg);
  --bs-table-hover-bg: var(--dl-stripe);
  --bs-table-hover-color: var(--dl-fg);
}
html[data-theme="dark"] pre {
  background-color: var(--dl-panel);
  color: var(--dl-fg);
  border-color: var(--dl-border);
}
html[data-theme="dark"] hr { border-color: var(--dl-border); }
html[data-theme="dark"] img {
  background-color: #ffffff;
  border-radius: 6px;
}
#diplock-theme-toggle {
  position: fixed;
  right: 14px;
  bottom: 14px;
  z-index: 1080;
  padding: 6px 12px;
  font-size: 13px;
  line-height: 1.4;
  border: 1px solid var(--dl-border, #dee2e6);
  border-radius: 8px;
  background-color: var(--dl-panel, #f8f9fa);
  color: var(--dl-fg, #212529);
  cursor: pointer;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.25);
}
#diplock-theme-toggle:hover {
  border-color: var(--dl-link, #0d6efd);
  color: var(--dl-link, #0d6efd);
}
@media print {
  #diplock-theme-toggle,
  .accordion-button::after { display: none !important; }
  html[data-theme="dark"] {
    --dl-bg: #ffffff;
    --dl-panel: #ffffff;
    --dl-card: #ffffff;
    --dl-stripe: #f4f4f4;
    --dl-fg: #000000;
    --dl-fg-2: #333333;
    --dl-border: #999999;
    --dl-link: #0645ad;
  }
  html[data-theme="dark"] img { background-color: transparent; }
}
"""

THEME_JS = """/* Тема автоотчёта: ?theme=dark или кнопка в углу; печать всегда светлая. */
(function () {
  var root = document.documentElement;
  var button = null;
  function theme() {
    return root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  }
  function apply(next) {
    if (next === 'dark') root.setAttribute('data-theme', 'dark');
    else root.removeAttribute('data-theme');
    try {
      var url = new URL(window.location.href);
      if (next === 'dark') url.searchParams.set('theme', 'dark');
      else url.searchParams.delete('theme');
      window.history.replaceState(null, '', url.toString());
    } catch (error) { /* URL недоступен — тема живёт только на сеанс */ }
    if (button) {
      button.textContent = next === 'dark' ? 'Светлая тема' : 'Тёмная тема';
    }
  }
  var initial = 'light';
  try {
    if (new URL(window.location.href).searchParams.get('theme') === 'dark') {
      initial = 'dark';
    }
  } catch (error) { /* без query — остаётся светлая */ }
  apply(initial);
  function start() {
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', start);
      return;
    }
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.id = 'diplock-theme-toggle';
      button.setAttribute('data-testid', 'report-theme-toggle');
      button.title =
        'Тема отчёта: тёмная удобна на экране; печать (Ctrl+P) всегда светлая';
      button.addEventListener('click', function () {
        apply(theme() === 'dark' ? 'light' : 'dark');
      });
      document.body.appendChild(button);
      apply(theme());
    }
  }
  start();
})();
"""


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
    checks_html: str = "",
    roi: dict[str, Any] | None = None,
) -> bytes:
    """Собирает MNE.Report (обе части) и возвращает самодостаточный HTML.

    ``checks_html`` — блок кросс-проверок §3.9.4 (вердикт первой строкой).
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
    # Тема отчёта (светлая/тёмная) — CSS и мини-JS вшиваются в самодостаточный
    # HTML: один файл на обе темы, ?theme=dark и кнопка в углу (THEME_CSS/THEME_JS)
    rep.add_custom_css(THEME_CSS)
    rep.add_custom_js(THEME_JS)
    rep.add_html(
        # №2: вердикт — первая строка документа; сверки — сразу за ним
        checks_html
        + "<p>Сквозной отчёт пайплайна DipLock: часть 1 пересказывает числа, которые "
        "уже считает препроцессинг (стадии filter / artifacts / epochs), часть 2 — "
        "пакетный быстрый расчёт диполей по именованным полосам.</p>"
        f"<p>Запись: {_esc(recording.filename)} · полос пакета: {len(band_keys)} · "
        f"длина эпохи: {params.preprocess.epoch_length_ms:g} мс · шаг сетки: "
        f"{params.grid_mm:g} мм · собрано: {built_at} · "
        f"MNE {_esc(mne.__version__)}</p>"
        # №8: полный отпечаток параметров — два HTML сверяются парами
        + _fingerprint_html(params, band_keys, signature),
        title="О отчёте",
        section=section1,
    )
    catalog = report_band_catalog(cfg)
    band_top = max((catalog[key][1] for key in band_keys), default=None)
    rep.add_html(
        _part1_html(stages, meta=recording.meta, band_top_hz=band_top),
        title="Качество записи и препроцессинг", section=section1,
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
    # ROI-анализ (4.5): секция после тепловой карты — надёжные точки по полосам
    # и асимметрия (тех же чисел нет в heatmap)
    rep.add_html(
        _roi_html(roi),
        title="ROI-анализ (надёжность и полушария)",
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
    # Нарезка пакета видит BAD_-зоны стадий (находка кросс-проверки №3
    # 02.10.2026): без них часть 1 отбраковывала эпохи детекторов, а пакет —
    # только края своей полосы, и числа расходились (66 против 128 из 130).
    stage_annotations = annotations_from_zones(stages["artifacts"].get("artifacts") or [])
    # Кавет редкого монтажа добавляется один раз (в кросс-проверки шапки) —
    # из предупреждений полос он убирается, иначе дублировался бы по числу полос.
    sparse_caveat = montage_sparse_warning(
        len(stages["filter"].get("channels") or []), cfg,
    )
    summaries: list[dict[str, Any]] = []
    warnings: list[str] = []
    package_points: dict[str, list[dict[str, Any]]] = {}
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
            artifact_annotations=stage_annotations,
        )
        # Точки пакета — для кирпича dipole_points (4.4, шаг ③): в контракт
        # ReportResult они не входят, write-API потребляет ключ и убирает.
        package_points[key] = list(scan_result.get("points") or [])
        summary = summarize_band(key, (low, high), scan_result)
        if sparse_caveat:
            # Кавет монтажа уже будет в кросс-проверках шапки — по строке на
            # полосу он превратился бы в дубли (по числу полос пакета).
            summary["warnings"] = [
                w for w in summary["warnings"] if not w.endswith(sparse_caveat)
            ]
        summaries.append(summary)
        warnings.extend(summary.get("warnings") or [])

    # ROI-агрегат (4.5): те же точки пакета, что уйдут в dipole_points — один
    # источник для секции HTML и вкладки UI («ROI»); подписи GOF внутри полосы
    # и полушария считаются здесь (services/roi.py).
    roi = aggregate_roi(
        package_points, band_keys,
        gof_threshold=cfg.roi_gof_threshold, top_n=TOP_ROI,
    )

    # Кросс-проверки сквозного пайплайна (§3.9.4): идут в шапку HTML (вердикт
    # первой строкой) и в предупреждения результата (пилюля UI).
    cross_info, cross_warns = _cross_checks(
        cfg, recording, params, band_keys, stages, summaries,
    )
    warnings.extend(cross_warns)
    checks_html = _cross_checks_html(cross_info, cross_warns)

    report("localize", 0.92, message="Сборка MNE.Report")
    data = _build_report(
        recording, cfg, params, band_keys, stages, summaries, checks_html, roi=roi,
    )
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
        "roi": roi,  # ROI-агрегат (4.5): вкладка UI и подпись отчёта — одни числа
        "_package_points": package_points,  # внутренний ключ write-API (4.4)
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







