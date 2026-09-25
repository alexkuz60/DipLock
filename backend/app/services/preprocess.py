"""Предподготовка записи: стадии ``filter`` / ``artifacts`` / ``epochs`` (срез 2.7).

Раздел EDF показывает запись, которую пользователь может предподготовить к
анализу — но **только по кнопке** (правило `docs/ui.md`: правка параметра ничего
не запускает). Здесь живёт то, что стоит за кнопками:

* ``filter``  — читает EDF, ставит монтаж 10-20, применяет notch и полосовой
  фильтр к continuous raw (до нарезки: короткие эпохи короче FIR-фильтра),
  фиксирует параметры. Возвращает только сводку: сигналы вьюера отдаёт
  отдельный бинарный эндпоинт (2.5) и здесь не дублируются;
* ``artifacts`` — детекция артефактов на предподготовленном сигнале; зоны
  (onset/duration/каналы) уходят прямо в слои вьюера (2.6);
* ``epochs`` — нарезка эпох без наложения + reject-фильтр; индексы и
  каналы-виновники отброшенных эпох приходят в UI (штриховка, причины
  блокировки и рамки в треках каналов-виновников).

Стадии раздельные: пересчёт фильтра не обесценивает найденные артефакты, а
правка порогов не заставляет пересчитывать эпохи. Но каждая стадия считает
свой результат **на свежем** предподготовленном сигнале — иначе артефакты
искались бы на сигнале с устаревшими параметрами фильтра.

Тяжёлые вычисления — CPU-bound: вызывающий код обязан запускать воркер в
потоке (`job_manager`). Прогресс сообщается колбэком ``progress(stage, ...)``.
"""
import logging
import time
from dataclasses import dataclass
from typing import Any

from app.core.config import Settings
from app.schemas.analysis import ArtifactZoneOut, PreprocessStage
from app.services import journal
from app.services.artifact_cleaner import CleanSpec
from app.services.artifact_detector import (
    channel_qc_summary,
    channel_snr_db,
    detect_artifacts,
    find_bad_channels,
    qc_summary,
    record_qc_status,
)
from app.services.epoch_segmenter import EDGE_DESC, segment_epochs
from app.services.filter_design import design_filter
from app.services.prepared_signal import prepared_raw_report
from app.services.recordings import Recording

logger = logging.getLogger(__name__)


class PreprocessError(ValueError):
    """Ошибка параметров/данных стадии — превращается в понятный текст в задаче."""


@dataclass
class PreprocessParams:
    """Параметры стадии предподготовки (плоская проекция формы запроса).

    Поля сгруппированы по стадиям, ровно как ``STAGE_PARAM_KEYS`` в UI: правка
    параметра помечает устаревшей только свою стадию, поэтому и на сервере
    каждая стадия видит только свои значения.
    """

    stage: PreprocessStage = "filter"
    # Стадия `filter`
    filter_band: tuple[float, float] | None = None
    notch_hz: float | None = None
    reference: str = "average"
    reference_channels: list[str] | None = None
    # Очистка (этап 4) — тоже `filter`: она меняет сигнал подготовки и входит в
    # ключ кэша prepared_raw (A4/N5). Порядок шагов — `services/artifact_cleaner.py`.
    notch_harmonics: int = 0  # доп. гармоники notch (50 → 100/150/200 Гц)
    bad_channels: list[str] | None = None  # каналы «bad» для интерполяции
    interpolate_bads: bool = False
    clean_method: str = "none"  # none | ica | ssp
    ica_n_components: int = 0  # 0 — auto (MNE выберет сам)
    # Стадия `artifacts`
    z_threshold: float = 5.0
    pp_threshold_uv: float = 100.0
    flat_line_uv: float = 1.0  # размах в окне flat_line_window_ms (N7/F20)
    flat_line_ms: float = 200.0
    run_ica: bool = False
    # Стадия `epochs`
    epoch_length_ms: float = 2000.0


def _reject_channels(log: tuple[str, ...] | list[str], ch_names: list[str]) -> list[str]:
    """Каналы-виновники отбраковки эпохи из её записи ``epochs.drop_log`` MNE.

    Амплитудный reject именует каналы, роняющие эпоху; рядом лежат служебные
    записи (``TOO_SHORT`` — хвост нарезки, ``NO_DATA``/``USER`` — отсечённые
    края и аннотации ``BAD_``) — виновниками считаем только реальные каналы
    записи, у эпох без канала-виновника список пуст.
    """
    known = set(ch_names)
    return [str(name) for name in log if str(name) in known]


def _prepare_raw(
    recording: Recording, cfg: Settings, params: PreprocessParams,
) -> tuple[Any, dict[str, Any]]:
    """Читает запись и применяет предподготовку (монтаж, референс, фильтры).

    Полоса фильтра — из параметров стадии `filter`; ``None`` означает «без
    фильтра» (пользователь выбрал пресет «Без фильтра»). Единицы берутся из
    конфигурации сервера, как и в остальном пайплайне.

    Сигнал приходит из кэша подготовленного сигнала (A4): стадии `artifacts` и
    `epochs` с теми же параметрами не читают EDF заново.
    """
    l_freq: float | None = None
    h_freq: float | None = None
    if params.filter_band is not None:
        l_freq, h_freq = params.filter_band

    spec = CleanSpec(
        notch_harmonics=params.notch_harmonics,
        bad_channels=tuple(params.bad_channels or ()),
        interpolate_bads=params.interpolate_bads,
        method=params.clean_method,
        ica_n_components=params.ica_n_components,
    )
    try:
        return prepared_raw_report(
            recording,
            cfg,
            l_freq=l_freq,
            h_freq=h_freq,
            notch_hz=params.notch_hz,
            reference_channels=params.reference_channels,
            # Имя пайплайна для журнала шагов: стадии различимы в замерах
            pipeline=f"preprocess-{params.stage}",
            # Пустая очистка — прежний ключ кэша: без опций сигнал общий со
            # спектром/спектрограммой/диполями (A4/N5)
            clean=spec if spec != CleanSpec() else None,
        )
    except ValueError as exc:
        raise PreprocessError(str(exc)) from exc
    except Exception as exc:
        raise PreprocessError(f"Не удалось прочитать EDF: {exc}") from exc


def _detect(
    raw: Any, cfg: Settings, params: PreprocessParams, progress: Any,
) -> tuple[Any, dict[str, Any]]:
    """Детекция артефактов с порогами из параметров стадии.

    ``flat_line_*`` в сервисе берутся из настроек, поэтому передаём копию
    конфигурации с порогами стадии — детектор остаётся неизменным.
    """
    progress("artifacts", message="Детекция артефактов")
    stage_cfg = cfg.model_copy(update={
        "flat_line_threshold_uv": params.flat_line_uv,
        "flat_line_min_duration_ms": params.flat_line_ms,
    })
    return detect_artifacts(
        raw, stage_cfg,
        z_threshold=params.z_threshold,
        pp_threshold_uv=params.pp_threshold_uv,
        run_ica=params.run_ica,
    )


def _zones(stats: dict[str, Any]) -> list[ArtifactZoneOut]:
    """Зоны артефактов из статистики детектора (для слоёв вьюера)."""
    return [ArtifactZoneOut(**zone) for zone in stats.get("zones", [])]


def _params_note(params: PreprocessParams, extra: str = "") -> str:
    """Короткий контекст стадии для журнала шагов: полоса, пороги, результат.

    Параметры стадии в журнале нужны не для красоты: без них строка «filter
    1.4 с» не отвечает, чем именно этот запуск отличался от соседнего
    (`docs/data_map.md` §9, поле ``note``).
    """
    parts: list[str] = []
    if params.filter_band is not None:
        parts.append(f"band={params.filter_band[0]:g}-{params.filter_band[1]:g}")
    if params.notch_hz:
        note = f"notch={params.notch_hz:g}"
        if params.notch_harmonics:
            note += f"(+{params.notch_harmonics} гарм.)"
        parts.append(note)
    if params.bad_channels:
        parts.append(f"bad={','.join(params.bad_channels)}")
    if params.interpolate_bads:
        parts.append("interp=1")
    if params.clean_method != "none":
        parts.append(f"clean={params.clean_method}")
    if params.reference != "average":
        parts.append(f"ref={params.reference}")
    if params.stage == "artifacts":
        parts.append(
            f"z={params.z_threshold:g}, pp={params.pp_threshold_uv:g}, "
            f"flat={params.flat_line_uv:g}/{params.flat_line_ms:g}"
        )
        if params.run_ica:
            parts.append("ica=1")
    if params.stage == "epochs":
        parts.append(f"epoch={params.epoch_length_ms:g}ms")
    if extra:
        parts.append(extra)
    return ", ".join(parts)


def run_preprocess(
    recording: Recording,
    cfg: Settings,
    params: PreprocessParams,
    progress: Any,
) -> dict[str, Any]:
    """Считает одну стадию предподготовки; результат — ``PreprocessResult``.

    Возвращает dict (его валидирует ``PreprocessResult`` в API): так воркер не
    зависит от схемы ответа, а прогресс доступен по ходу вычислений.
    """
    started = time.perf_counter()
    progress("load_edf", message="Чтение EDF, монтаж 10-20")

    def _journal(epochs: int | None = None, extra: str = "") -> None:
        """Одна строка журнала на стадию (шаг целиком, не «эпоха за эпохой»)."""
        journal.record(
            f"preprocess-{params.stage}", params.stage,
            ms=(time.perf_counter() - started) * 1000.0,
            note=_params_note(params, extra),
            epochs=epochs,
        )

    raw, clean_report = _prepare_raw(recording, cfg, params)
    warnings: list[str] = []

    base: dict[str, Any] = {
        "recording_id": recording.recording_id,
        "stage": params.stage,
        "channels": list(raw.ch_names),
        "sfreq": float(raw.info["sfreq"]),
        "duration_sec": round(float(raw.times[-1]) if raw.n_times else 0.0, 3),
        "warnings": warnings,
    }

    if params.stage == "filter":
        band = list(params.filter_band) if params.filter_band is not None else None
        if band is None:
            warnings.append("Полоса пропускания не задана — сигнал без band-pass фильтра")
        # Паспорт фильтра (N11/N12): метод, длина FIR-ядра и краевой буфер — UI
        # показывает их рядом с формой и в подписи «треки без фильтра» (N14).
        l_freq, h_freq = params.filter_band or (None, None)
        design = design_filter(l_freq, h_freq, float(raw.info["sfreq"]))
        base.update({
            "band_hz": band,
            "notch_hz": params.notch_hz,
            "reference": params.reference,
            "filter_method": design.method,
            "filter_length_sec": design.filter_length_sec,
            "edge_buffer_sec": design.edge_buffer_sec,
            "clean": clean_report or None,
        })
        if design.edge_buffer_sec > 0 and design.filter_length_sec is not None:
            warnings.append(
                f"Переходный процесс FIR-фильтра: ±{design.edge_buffer_sec:.2f} с "
                f"у краёв записи (длина ядра {design.filter_length_sec:.2f} с) — "
                "эпохи в этих зонах отбрасываются (BAD_edge)"
            )
        warnings.extend(clean_report.get("warnings", []))
        if params.clean_method == "ssp":
            warnings.append(
                "SSP-очистка — экспериментальна: проекторы необратимы и режут "
                "подпространство сигнала целиком (альтернатива — метод ICA)"
            )
        progress("done", 1.0, message="Фильтр и референс применены")
        base["duration_sec_calc"] = round(time.perf_counter() - started, 3)
        _journal()
        return base

    annotations, stats = _detect(raw, cfg, params, progress)

    if params.stage == "artifacts":
        zones = stats.get("zones", [])
        bad_channels = find_bad_channels(raw, cfg.bad_channel_z)
        # QC-светофор записи (шаг 2.2): SNR каналов, мёртвые (bads загрузки —
        # константные до референса, `edf_loader`) и вердикт по четырём категориям
        snr = channel_snr_db(raw)
        dead_channels = [ch for ch in raw.ch_names if ch in set(raw.info["bads"])]
        qc = qc_summary(
            zones, list(raw.ch_names), base["duration_sec"],
            line_noise_level=stats.get("line_noise_level"),
            bad_channels=bad_channels,
            snr_db_by_channel=snr,
            dead_channels=dead_channels,
        )
        bad_or_dead = sorted(set(bad_channels) | set(dead_channels))
        record_status, record_reasons = record_qc_status(
            qc["good_data_percent"], qc["line_noise_level"], qc["snr_db"],
            bad_or_dead, cfg,
        )
        base.update({
            "artifacts": [zone.model_dump() for zone in _zones(stats)],
            "artifact_types": stats["by_type"],
            "ica_applied": bool(stats.get("ica_applied")),
            # QC-иконки каналов (шаг 0.4 + расширение 2.2): сводка из тех же зон,
            # SNR и признак мёртвого канала + пороги из конфига
            "channel_qc": channel_qc_summary(
                zones, list(raw.ch_names), base["duration_sec"],
                snr_db=snr, dead_channels=dead_channels,
            ),
            "qc_warn_share": float(cfg.qc_channel_warn_share),
            "qc_bad_share": float(cfg.qc_channel_bad_share),
            "qc_snr_warn_db": float(cfg.qc_snr_warn_db),
            "qc_snr_bad_db": float(cfg.qc_snr_bad_db),
            # Числа QC (этап «числа QC»): чистые данные, доли по типам, уровень 50 Гц
            "good_data_percent": qc["good_data_percent"],
            "artifact_share_by_kind": qc["artifact_share_by_kind"],
            "line_noise_level": qc["line_noise_level"],
            "bad_channels": bad_channels,
            "snr_db_median": qc["snr_db"],
            "dead_channels": dead_channels,
            "record_status": record_status,
            "record_status_reasons": record_reasons,
        })
        if bad_channels:
            warnings.append(
                f"Плохие каналы (авто): {', '.join(bad_channels)} — можно интерполировать "
                "(стадия «Фильтр и референс», опция «Интерполировать bad-каналы»)"
            )
        if dead_channels:
            warnings.append(
                f"Мёртвые каналы (константные до референса): {', '.join(dead_channels)} — "
                "интерполяция bad-каналов их чинит"
            )
        if not stats.get("ica_applied") and params.run_ica:
            warnings.append(
                "ICA не применена: в записи нет EOG-подобных каналов или фитинг не удался"
            )
        progress("done", 1.0, message=f"Найдено артефактов: {stats['total']}")
        base["duration_sec_calc"] = round(time.perf_counter() - started, 3)
        _journal(extra=f"artifacts={stats['total']}")
        return base

    # Стадия `epochs`: нарезка. Отброшенные эпохи (по аннотациям BAD_ от наших
    # детекторов) нужны UI для штриховки, поэтому вместо одного числа отдаём
    # индексы (порядок событий).
    progress("epochs", message=f"Нарезка эпох по {params.epoch_length_ms:.0f} мс")
    try:
        epochs = segment_epochs(
            raw, annotations,
            epoch_length_ms=params.epoch_length_ms,
            filter_band=params.filter_band,
        )
    except ValueError as exc:
        raise PreprocessError(str(exc)) from exc

    rejected = [index for index, log in enumerate(epochs.drop_log) if log]
    ch_names = list(raw.ch_names)
    base.update({
        "epoch_length_ms": params.epoch_length_ms,
        "n_epochs_total": len(epochs.drop_log),
        "n_epochs_used": len(epochs),
        "rejected_epochs": rejected,
        # Каналы-виновники — из drop_log MNE: UI показывает причины блокировки
        # и рамки в соответствующих треках. Amplitude reject MNE отключён
        # (reject=None), поэтому каналы приходят только из аннотаций BAD_
        # (пустые) — frame-слои не показываются, зоны детекторов — на треках.
        "rejected_epoch_channels": [
            {"index": index, "channels": _reject_channels(epochs.drop_log[index], ch_names)}
            for index in rejected
        ],
    })
    if rejected:
        warnings.append(
            f"Отброшено эпох: {len(rejected)} из {len(epochs.drop_log)} "
            f"(аннотации BAD_ от детекторов артефактов)"
        )
    # Краевой буфер фильтра (N12) — отдельная видимая причина: пользователь
    # должен понимать, что «края пустые» — честный отказ, а не потеря данных.
    edge_dropped = sum(1 for log in epochs.drop_log if EDGE_DESC in log)
    if edge_dropped:
        warnings.append(
            f"Краевой буфер фильтра: {edge_dropped} эпох у краёв записи "
            f"отброшены ({EDGE_DESC} — переходный процесс FIR)"
        )
    progress("done", 1.0, message=f"Эпох: {len(epochs)} из {len(epochs.drop_log)}")
    base["duration_sec_calc"] = round(time.perf_counter() - started, 3)
    _journal(
        epochs=len(epochs.drop_log),
        extra=f"used={len(epochs)}, rejected={len(rejected)}",
    )
    return base
