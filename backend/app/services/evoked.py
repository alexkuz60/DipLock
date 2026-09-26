"""ERP-усреднение по событиям (шаг 2.7: стимул → эпоха → усреднение).

Задача ``kind='evoked'`` — отдельный контракт (``EvokedResult``), а не четвёртая
стадия предподготовки: усреднённая волна — результат анализа, а не шаг
подготовки. Подготовка сигнала и отбраковка переиспользуются из
`services/preprocess.py` (те же ``PreprocessParams`` и ``segment_epochs_events``):
числа отброшенных эпох в ERP и в стадии «Нарезка эпох» обязаны совпадать.

Цепочка: подготовленный сигнал → ``BAD_``-зоны (пороги формы) → эпохи-окна
вокруг события → baseline-коррекция (опционально) → ``epochs.average()``.
Главные числа ответа — ``n_used``/``n_total``: сколько событий вошло в среднее.
"""
import logging
import time
from dataclasses import dataclass
from typing import Any

from app.core.config import Settings
from app.services import journal
from app.services.epoch_segmenter import segment_epochs_events
from app.services.preprocess import PreprocessError, PreprocessParams, _detect, _prepare_raw
from app.services.recordings import Recording

logger = logging.getLogger(__name__)


class EvokedError(ValueError):
    """Ошибка параметров/данных задачи ERP — превращается в понятный текст в задаче."""


@dataclass
class EvokedParams:
    """Параметры задачи ERP: baseline + параметры подготовки сигнала/нарезки.

    Подготовка и пороги живут в ``PreprocessParams`` (форма повторяет форму
    стадии «Нарезка эпох», DRY): окно события — ``epoch_pre_ms``/``epoch_post_ms``
    и ``event_id`` с ``epoch_mode='events'``. Baseline — относительно момента
    события, мс (``None`` в обоих — без коррекции).
    """

    preprocess: PreprocessParams
    baseline_start_ms: float | None = None
    baseline_end_ms: float | None = None


def run_evoked(
    recording: Recording,
    cfg: Settings,
    params: EvokedParams,
    progress: Any,
) -> dict[str, Any]:
    """Считает усреднённую ERP-волну по событиям; результат — ``EvokedResult``.

    Возвращает dict (его валидирует ``EvokedResult`` в API). Ошибки окна/событий
    — ``EvokedError`` с текстом для UI; тяжёлые вычисления вызывающий код
    запускает в воркере (`job_manager`), прогресс — колбэком ``progress``.
    """
    started = time.perf_counter()
    prep = params.preprocess
    if prep.epoch_mode != "events" or not prep.event_id:
        raise EvokedError("ERP требует событийный режим: укажите описание события")
    tmin = -prep.epoch_pre_ms / 1000.0
    tmax = prep.epoch_post_ms / 1000.0

    progress("evoked", message=f"Усреднение по событиям «{prep.event_id}»")
    try:
        raw, _clean_report = _prepare_raw(recording, cfg, prep)
        annotations, _stats = _detect(raw, cfg, prep, progress)
        epochs, events = segment_epochs_events(
            raw, annotations,
            event_id=prep.event_id,
            tmin=tmin, tmax=tmax,
            filter_band=prep.filter_band,
        )
    except PreprocessError as exc:
        raise EvokedError(str(exc)) from exc
    except ValueError as exc:
        raise EvokedError(str(exc)) from exc

    warnings: list[str] = []
    rejected = [index for index, log in enumerate(epochs.drop_log) if log]
    if rejected:
        warnings.append(
            f"Отброшено событий: {len(rejected)} из {len(events)} "
            f"(аннотации BAD_ от детекторов артефактов)"
        )

    baseline: tuple[float, float] | None = None
    if params.baseline_start_ms is not None and params.baseline_end_ms is not None:
        baseline = (params.baseline_start_ms / 1000.0, params.baseline_end_ms / 1000.0)
        epochs.apply_baseline(baseline, verbose=False)

    evoked = epochs.average()
    sfreq = float(evoked.info["sfreq"])
    # Данные — в µV (мкВольты — единица UI во всех графиках), с округлением до
    # нановольт: float64 в JSON раздул бы ответ втрое без выигрыша в точности.
    data_uv = [
        [round(float(value) * 1e6, 3) for value in channel]
        for channel in evoked.data
    ]
    times = [round(float(value), 5) for value in evoked.times]

    progress("done", 1.0, message=f"Усреднено событий: {len(epochs)} из {len(events)}")
    journal.record(
        "evoked", "epochs",
        ms=(time.perf_counter() - started) * 1000.0,
        note=f"event={prep.event_id}, {prep.epoch_pre_ms:g}+{prep.epoch_post_ms:g}ms",
        epochs=len(events),
    )
    return {
        "recording_id": recording.recording_id,
        "event_id": prep.event_id,
        "tmin": tmin,
        "tmax": tmax,
        "sfreq": sfreq,
        "times": times,
        "channels": list(evoked.ch_names),
        "data_uv": data_uv,
        "baseline": list(baseline) if baseline is not None else None,
        "n_total": len(events),
        "n_used": len(epochs),
        "rejected_epochs": rejected,
        "warnings": warnings,
        "duration_sec_calc": round(time.perf_counter() - started, 3),
    }
