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


def make_epoch_events(raw: mne.io.BaseRaw, epoch_length_ms: float) -> np.ndarray:
    """Полный список событий нарезки (без reject): нужен и сегментации, и БД (F21).

    ``mne.Epochs.events`` хранит только эпохи, прошедшие reject, поэтому начала
    отброшенных эпох из объекта уже не достать — берём тот же список событий,
    что строила нарезка.
    """
    return mne.make_fixed_length_events(
        raw, duration=epoch_length_ms / 1000.0, first_samp=0,
    )


def segment_epochs(
    raw: mne.io.BaseRaw,
    artifact_annotations: mne.Annotations,
    epoch_length_ms: float = 2000.0,
) -> mne.Epochs:
    """Разбивает сессию на эпохи без наложения (non-overlapping).

    Amplitude reject MNE отключён (``reject=None``): отбраковка идёт только
    по аннотациям ``BAD_`` от наших 11 детекторов — они строже порога MNE
    (peak_to_peak 100 мкВ < MNE reject 150 мкВ) и дают адресную информацию
    (тип артефакта, канал, время). Номера эпох — на липкой шкале. Когда
    отбрасывается **всё**, ошибка перечисляет покрытие ``BAD_`` по типам —
    иначе «кто занял запись» приходится выяснять по слоям вьюера вручную
    (фидбэк 24.09.2026).
    """
    valid_lengths = settings.epoch_lengths_ms  # DRY: единый список из config.py
    if epoch_length_ms not in valid_lengths:
        raise ValueError(f"Длина эпохи {epoch_length_ms} мс не в списке: {valid_lengths}")

    raw.set_annotations(artifact_annotations)
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
        duration_sec = float(raw.times[-1]) if raw.n_times else 0.0
        raise ValueError(
            "Все эпохи отброшены аннотациями BAD_ (детекторы артефактов). "
            f"Покрытие: {bad_coverage_text(artifact_annotations, duration_sec)}. "
            "Проверьте пороги детекции, фильтр и референс."
        )

    return epochs


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
