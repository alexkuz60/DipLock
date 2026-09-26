"""Нарезка эпох БЕЗ overlap. Длина выбирается из списка: [250, 500, ..., 2000] мс.

Здесь же ``epoch_records`` — плоское описание эпох (индекс, начало, длительность,
флаг отбраковки, мощности по диапазонам). Оно нужно БД (таблица ``epochs``, F21):
без строк эпох ``dipoles.epoch_id`` ссылался на номер эпохи и висел в пустоте.
"""
from typing import Any

import mne
import numpy as np

from app.core.config import settings
from app.services.artifact_detector import BAD_PREFIX
from app.services.filter_design import design_filter

# Причина отбраковки эпох, попавших в краевой буфер переходного процесса
# фильтра (N12): та же механика BAD_-аннотаций, отдельный тип для UI.
EDGE_DESC = f"{BAD_PREFIX}edge"


def edge_annotations(
    raw: mne.io.BaseRaw,
    filter_band: tuple[float, float] | None,
) -> mne.Annotations:
    """Аннотации ``BAD_edge`` у краёв записи (переходный процесс фильтра, N12).

    Zero-phase фильтр искажает начало и конец записи на половину длины ядра
    (``filter_design.edge_buffer_sec``). Нарезка честно отбрасывает эпохи в этих
    интервалах: в покрытии и штриховке UI видна причина ``BAD_edge``, а не
    молчаливое «эпоха пропала». У IIR-полосы буфер равен нулю (короткое ядро) —
    аннотаций нет. Если переходный процесс длиннее половины записи, помечается
    вся запись: честное «запись короче ядра фильтра» лучше, чем тихая выдача
    искажённых краёв за чистые.
    """
    if filter_band is None:
        return mne.Annotations([], [], [])
    l_freq, h_freq = filter_band
    design = design_filter(l_freq, h_freq, float(raw.info["sfreq"]))
    buffer_sec = design.edge_buffer_sec
    if buffer_sec <= 0.0:
        return mne.Annotations([], [], [])
    duration_sec = float(raw.n_times) / float(raw.info["sfreq"])
    if buffer_sec * 2.0 >= duration_sec:
        return mne.Annotations([0.0], [duration_sec], [EDGE_DESC])
    return mne.Annotations(
        [0.0, duration_sec - buffer_sec],
        [buffer_sec, buffer_sec],
        [EDGE_DESC, EDGE_DESC],
    )


def make_epoch_events(raw: mne.io.BaseRaw, epoch_length_ms: float) -> np.ndarray:
    """Полный список событий нарезки (без reject): нужен и сегментации, и БД (F21).

    ``mne.Epochs.events`` хранит только эпохи, прошедшие reject, поэтому начала
    отброшенных эпох из объекта уже не достать — берём тот же список событий,
    что строила нарезка.
    """
    return mne.make_fixed_length_events(
        raw, duration=epoch_length_ms / 1000.0, first_samp=0,
    )


def merged_annotations(
    raw: mne.io.BaseRaw,
    artifact_annotations: mne.Annotations,
    filter_band: tuple[float, float] | None,
) -> mne.Annotations:
    """Аннотации файла ∪ артефактные ∪ краевые — **объединение, не перетирание** (N2).

    Аннотации файла (EDF+ TAL + маркеры ``STIM/*``, см. `services/edf_events.py`)
    лежат в ``raw.annotations`` с чтения; до шага 2.7 нарезка их перетирала и
    события не доезжали ни до нарезки, ни до вьюера. Теперь файловые ``BAD_``
    роняют эпохи наравне с нашими детекторами (правило N6), а стимульные
    описания на ``BAD_`` не начинаются и нарезку не трогают.
    """
    base = raw.annotations
    edge = edge_annotations(raw, filter_band)
    return mne.Annotations(
        onset=[float(v) for v in base.onset]
        + [float(v) for v in artifact_annotations.onset]
        + [float(v) for v in edge.onset],
        duration=[float(v) for v in base.duration]
        + [float(v) for v in artifact_annotations.duration]
        + [float(v) for v in edge.duration],
        description=list(base.description)
        + list(artifact_annotations.description)
        + list(edge.description),
    )


def _raise_all_dropped(annotations: mne.Annotations, raw: mne.io.BaseRaw) -> None:
    """Ошибка «все эпохи отброшены» с покрытием BAD_ по типам (фидбэк 24.09.2026)."""
    duration_sec = float(raw.times[-1]) if raw.n_times else 0.0
    raise ValueError(
        "Все эпохи отброшены аннотациями BAD_ (детекторы артефактов и краевой "
        f"буфер фильтра). Покрытие: {bad_coverage_text(annotations, duration_sec)}. "
        "Проверьте пороги детекции, фильтр и референс."
    )


def segment_epochs(
    raw: mne.io.BaseRaw,
    artifact_annotations: mne.Annotations,
    epoch_length_ms: float = 2000.0,
    filter_band: tuple[float, float] | None = None,
) -> mne.Epochs:
    """Разбивает сессию на эпохи без наложения (non-overlapping).

    Amplitude reject MNE отключён (``reject=None``): отбраковка идёт только
    по аннотациям ``BAD_`` от наших 11 детекторов — они строже порога MNE
    (peak_to_peak 100 мкВ < MNE reject 150 мкВ) и дают адресную информацию
    (тип артефакта, канал, время). Номера эпох — на липкой шкале. Когда
    отбрасывается **всё**, ошибка перечисляет покрытие ``BAD_`` по типам —
    иначе «кто занял запись» приходится выяснять по слоям вьюера вручную
    (фидбэк 24.09.2026).

    ``filter_band`` — полоса фильтра, которой подвергали continuous raw до
    нарезки: края записи помечаются ``BAD_edge`` (переходный процесс zero-phase
    фильтра, N12, см. ``edge_annotations``). Без полосы поведение прежнее.
    """
    valid_lengths = settings.epoch_lengths_ms  # DRY: единый список из config.py
    if epoch_length_ms not in valid_lengths:
        raise ValueError(f"Длина эпохи {epoch_length_ms} мс не в списке: {valid_lengths}")

    # Аннотации файла (N2) + краевые (N12) складываются с артефактными ДО нарезки:
    # эпохи, попавшие в переходный процесс фильтра, отбрасываются с причиной BAD_edge.
    annotations = merged_annotations(raw, artifact_annotations, filter_band)
    raw.set_annotations(annotations)
    epoch_length_sec = epoch_length_ms / 1000.0

    # События без overlap
    events = make_epoch_events(raw, epoch_length_ms)

    # baseline=None явно: MNE по умолчанию берёт (None, 0), что при tmin=0
    # даёт интервал в 1 сэмпл и ValueError. Для continuous EEG без стимула
    # коррекция по baseline неприменима.
    # reject=None: амплитудный reject MNE отключён — наши детекторы (BAD_
    # аннотации) уже отбраковывают эпохи с артефактами, включая
    # peak_to_peak (порог 100 мкВ < старый MNE reject 150 мкВ).
    epochs = mne.Epochs(
        raw, events, tmin=0, tmax=epoch_length_sec,
        baseline=None,
        reject=None,
        preload=True, verbose=False,
    )

    if len(epochs) == 0:
        _raise_all_dropped(annotations, raw)

    return epochs


def segment_epochs_events(
    raw: mne.io.BaseRaw,
    artifact_annotations: mne.Annotations,
    event_id: str,
    tmin: float,
    tmax: float,
    filter_band: tuple[float, float] | None = None,
) -> tuple[mne.Epochs, np.ndarray]:
    """Нарезка по событиям (ERP): окна ``[tmin, tmax]`` вокруг моментов события.

    События берутся из аннотаций записи (файловые EDF+ и маркеры ``STIM/*``,
    N2) по описанию ``event_id``; ``BAD_``-аннотации событиями не считаются
    (регэксп MNE их пропускает) и вдобавок роняют эпохи через reject —
    отбраковка та же, что в фиксированной нарезке.

    Возвращает ``(epochs, events)``: полный список событий нужен и для
    ``drop_log``-записей БД (``epoch_records``), и для нерегулярной сетки
    вьюера (``epoch_starts_sec`` в результате стадии). ``tmin`` обычно
    отрицателен (pre-стимульное окно ERP), эпохи у краёв записи MNE помечает
    ``TOO_SHORT`` и исключает.
    """
    if not event_id or not event_id.strip():
        raise ValueError(
            "Событийный режим требует описание события (event_id): "
            "выберите событие в блоке «Эпохи» панели"
        )
    if tmax <= tmin:
        raise ValueError(f"Окно эпохи некорректно: tmin={tmin:.3f} с ≥ tmax={tmax:.3f} с")

    annotations = merged_annotations(raw, artifact_annotations, filter_band)
    raw.set_annotations(annotations)

    available = sorted({
        str(desc) for desc in raw.annotations.description
        if not str(desc).startswith(BAD_PREFIX)
    })
    if event_id not in available:
        listing = ", ".join(f"«{desc}»" for desc in available) or "нет"
        raise ValueError(
            f"События «{event_id}» не найдены в записи. Доступные события: {listing}."
        )

    events, _ids = mne.events_from_annotations(
        raw, event_id={event_id: 1}, verbose=False,
    )

    epochs = mne.Epochs(
        raw, events, tmin=tmin, tmax=tmax,
        baseline=None,
        reject=None,
        preload=True, verbose=False,
    )
    if len(epochs) == 0:
        _raise_all_dropped(annotations, raw)
    return epochs, events


def bad_coverage_text(
    annotations: mne.Annotations, duration_sec: float,
) -> str:
    """Покрытие BAD_-зон по типам: «тип — N% записи (M зон)», по убыванию.

    Интервалы одного типа сливаются (пересекающиеся зоны не задваивают время),
    тип берётся из описания без префикса ``BAD_``. Нужно для текста ошибки
    «все эпохи отброшены»: показать, какой вид занял запись, а не заставлять
    гадать по слоям вьюера (фидбэк 24.09.2026).
    """
    duration = max(float(duration_sec), 1e-9)
    by_kind: dict[str, list[tuple[float, float]]] = {}
    for onset, dur, desc in zip(
        annotations.onset, annotations.duration, annotations.description, strict=True,
    ):
        kind = desc.removeprefix(BAD_PREFIX) if desc.startswith(BAD_PREFIX) else desc
        by_kind.setdefault(kind, []).append((float(onset), float(onset + dur)))

    parts: list[tuple[float, str]] = []
    for kind, intervals in by_kind.items():
        merged = 0.0
        cur_start: float | None = None
        cur_end = 0.0
        for start, end in sorted(intervals):
            if cur_start is None or start > cur_end:
                if cur_start is not None:
                    merged += cur_end - cur_start
                cur_start, cur_end = start, end
            else:
                cur_end = max(cur_end, end)
        if cur_start is not None:
            merged += cur_end - cur_start
        share = min(merged / duration, 1.0) * 100.0
        parts.append((share, f"{kind} — {share:.0f} % записи ({len(intervals)} зон)"))
    return ", ".join(text for _, text in sorted(parts, reverse=True)) or "зон нет"


def epoch_records(
    epochs: mne.Epochs,
    events: np.ndarray,
    epoch_length_ms: float,
    band_powers: dict[str, np.ndarray] | None = None,
) -> list[dict[str, Any]]:
    """Плоское описание **всех** созданных эпох — строки таблицы ``epochs`` (F21).

    В ``epochs`` (объект MNE) лежат только прошедшие reject; отброшенные видны в
    ``drop_log``, а их начала — в ``events`` (полный список из
    ``make_epoch_events``): ``epochs.events`` их уже не содержит. В БД пишем и
    те, и другие: иначе «сколько эпох отброшено и почему» по базе не
    восстановить. ``epoch_index`` — номер по порядку (он же ключ связи с
    диполями), а не id строки БД: id выдаёт БД при вставке, и
    ``save_analysis_to_db`` переводит индекс в id.

    ``band_powers`` — мощности по каждой эпохе (второй элемент
    ``compute_band_powers``): у отброшенных эпох PSD не считался, поэтому их
    мощности пусты (в БД — NULL, а не 0).

    .. note:: Amplitude reject MNE отключён (см. ``segment_epochs``):
       ``has_artifact=True`` только для аннотаций BAD_ от наших детекторов.
    """
    sfreq = float(epochs.info["sfreq"])
    drop_log = list(epochs.drop_log)
    selection = list(epochs.selection) if epochs.selection is not None else list(range(len(drop_log)))
    # Позиция эпохи среди прошедших reject — индекс в массивах мощностей.
    position = {epoch_index: pos for pos, epoch_index in enumerate(selection)}
    powers = band_powers or {}

    records: list[dict[str, Any]] = []
    for epoch_index in range(len(drop_log)):
        pos = position.get(epoch_index)
        values: dict[str, float] = {}
        if pos is not None:
            for name, per_epoch in powers.items():
                if pos < len(per_epoch):
                    values[f"{name}_power"] = float(per_epoch[pos])
        records.append({
            "epoch_index": epoch_index,
            "start_time_sec": round(float(events[epoch_index, 0]) / sfreq, 3),
            "duration_ms": float(epoch_length_ms),
            # Непустой drop_log = эпоха не вошла в анализ: reject по амплитуде
            # (артефакт) или неполное окно в конце записи (TOO_SHORT).
            "has_artifact": bool(drop_log[epoch_index]),
            "band_powers": values,
        })
    return records
