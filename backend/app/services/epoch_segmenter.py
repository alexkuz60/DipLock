"""Нарезка эпох БЕЗ overlap. Длина выбирается из списка: [250, 500, ..., 2000] мс.

Здесь же ``epoch_records`` — плоское описание эпох (индекс, начало, длительность,
флаг отбраковки, мощности по диапазонам). Оно нужно БД (таблица ``epochs``, F21):
без строк эпох ``dipoles.epoch_id`` ссылался на номер эпохи и висел в пустоте.
"""
from typing import Any

import mne
import numpy as np

from app.core.config import settings


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
    reject_threshold_uv: float = 150.0,
) -> mne.Epochs:
    """Разбивает сессию на эпохи без наложения (non-overlapping)."""
    valid_lengths = settings.epoch_lengths_ms  # DRY: единый список из config.py
    if epoch_length_ms not in valid_lengths:
        raise ValueError(f"Длина эпохи {epoch_length_ms} мс не в списке: {valid_lengths}")

    raw.set_annotations(artifact_annotations)
    epoch_length_sec = epoch_length_ms / 1000.0

    # События без overlap
    events = make_epoch_events(raw, epoch_length_ms)

    # Эпохи с reject-фильтрацией: эпохи с артефактами ОТБРАСЫВАЮТСЯ (drop),
    # если превышают порог. Пропущенные доступны через epochs.drop_log/metrics.
    # baseline=None явно: MNE по умолчанию берёт (None, 0), что при tmin=0
    # даёт интервал в 1 сэмпл и ValueError. Для continuous EEG без стимула
    # коррекция по baseline неприменима.
    epochs = mne.Epochs(
        raw, events, tmin=0, tmax=epoch_length_sec,
        baseline=None,
        reject=dict(eeg=reject_threshold_uv * 1e-6),
        preload=True, verbose=False,
    )

    if len(epochs) == 0:
        raise ValueError(
            f"Все эпохи отброшены reject-фильтром (порог {reject_threshold_uv} мкВ). "
            "Проверьте масштаб/единицы EDF и качество сигнала."
        )

    return epochs


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
