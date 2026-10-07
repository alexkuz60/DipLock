"""Ряды монтажа «Нейромузыки»: 4 поперечные линии схемы 10-20 (вариант «Монтаж»).

Концепция (спецификация владельца 07.10.2026, варианты рендера «Нейромузыки»):

* **«Экспресс»** (реализован, не меняется) — шины L/C/R по полушариям
  (``mix.bus_weights``), быстрая черновая проба созвучия семи полос;
* **«Монтаж»** — 7 полос × 4 поперечных ряда = 28 стерео-источников для
  полноценной 3D-обработки (фронт/тыл/лево/право). Ряд — свой модуль
  пространственной локализации со своей геометрией дуги (см.
  `docs/rules/neuromusic.md`, §«Варианты рендера»).

Веса заданы владельцем как **относительные** коэффициенты внутри ряда
(внешние электроды ряда — целиком в своё полушарие, ближние к средине —
с перекрёстным «просачиванием» 0.75/0.25, срединные ``*z`` — 0.5 в оба
канала). Перед расчётом коэффициенты нормируются на среднее сумм L/R
ряда по **присутствующим** в записи каналам: так масштаб между рядами
фиксирован (сравним с mean-подходом ``bus_weights``), а отношение
L/R-вкладов — физика ряда — сохраняется точно.

Правила:

* имена каналов — **канонические** 10-20 (загрузчик нормализует алиасы
  T3→T7, T5→P7 — см. ``edf_loader._CHANNEL_ALIASES``), покрытие
  ``settings.standard_channels`` проверяется тестом-стражом;
* канал вне схемы 10-20 (EKG, A1) — ошибка входа, как в ``bus_weights``:
  молча терять электроды нельзя;
* канал 10-20, не входящий ни в один ряд (расширения 10-10, AF3 и пр.) —
  не участвует и попадает в предупреждение sidecar (рендер честно
  сообщает, что миксировал только ряды);
* ряд без каналов записи — пропускается с предупреждением (неполные
  наборы каналов допустимы: ``bus_weights`` тоже работает по присутствующим).

Модуль чистый (без MNE и диска) — юнит-тесты ``tests/test_audio_rows.py``.
"""
from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class RowDef:
    """Один поперечный ряд схемы: id, подпись и сырые веса L/R по каналам."""

    id: str
    label: str
    weights: dict[str, tuple[float, float]]
    """Канал → (доля в L, доля в R); суммы L и R у ряда совпадают."""


# Порядок рядов — от лба к затылку (порядок показа в UI и файлах рендера).
ROW_DEFS: tuple[RowDef, ...] = (
    RowDef(
        id="frontal",
        label="Лобной",
        weights={
            "Fp1": (1.0, 0.0), "Fp2": (0.0, 1.0),
            "F7": (1.0, 0.0), "F8": (0.0, 1.0),
            "F3": (0.75, 0.25), "F4": (0.25, 0.75),
            "Fz": (0.5, 0.5),
        },
    ),
    RowDef(
        id="temporal",
        label="Височной",
        weights={
            "T7": (1.0, 0.0), "T8": (0.0, 1.0),
            "C3": (0.75, 0.25), "C4": (0.25, 0.75),
            "Cz": (0.5, 0.5),
        },
    ),
    RowDef(
        id="parietal",
        label="Теменной",
        weights={
            "P7": (1.0, 0.0), "P8": (0.0, 1.0),
            "P3": (0.75, 0.25), "P4": (0.25, 0.75),
            "Pz": (0.5, 0.5),
        },
    ),
    RowDef(
        id="occipital",
        label="Затылочный",
        weights={
            "O1": (1.0, 0.0), "O2": (0.0, 1.0),
            "Oz": (0.5, 0.5),
        },
    ),
)

ROW_IDS: tuple[str, ...] = tuple(row.id for row in ROW_DEFS)

# Варианты рендера (значения поля variant в API и render_sig).
RENDER_VARIANTS: tuple[str, ...] = ("express", "montage")

# Каналы, закреплённые за рядами (для отбора «внестроечных» 10-20).
_ROW_CHANNELS: frozenset[str] = frozenset(
    channel for row in ROW_DEFS for channel in row.weights
)


@dataclass
class RowMix:
    """Готовые веса одного ряда для канонического ``w @ eeg``."""

    id: str
    label: str
    channels: list[str]
    """Каналы ряда, присутствующие в записи (порядок записи)."""

    w_left: np.ndarray
    w_right: np.ndarray
    """Веса (K,) float64 по ВСЕМ каналам записи (для ``w @ eeg``, 0 вне ряда):
    нормированы так, что среднее сумм L и R = 1 (при полном симметричном
    составе L_sum = R_sum = 1)."""

    weights: dict[str, tuple[float, float]]
    """Канал ряда → (вес L, вес R) — те же значения, что в w_left/w_right."""

    def members(self) -> dict[str, list[float]]:
        """Веса по каналам ряда — для sidecar-«партитуры»."""
        return {
            name: [float(left), float(right)]
            for name, (left, right) in self.weights.items()
        }


def row_mixes(channels: list[str]) -> tuple[list[RowMix], list[str]]:
    """Веса рядов для канонического ``w @ eeg`` по каналам записи.

    Возвращает ``(миксы, предупреждения)``: миксы — только ряды с
    присутствующими каналами (пустые ряды пропускаются, о чём говорит
    предупреждение); строки предупреждений идут в sidecar, чтобы молчаливая
    неполнота не превратилась в молчаливую потерю данных.

    ``ValueError`` — канал записи вне схемы 10-20: ряды его не принимают,
    а игнорировать электрод нельзя (инвариант ``bus_weights``).
    """
    index = {name: i for i, name in enumerate(channels)}
    strangers = [name for name in channels if not _is_standard_1020(name)]
    if strangers:
        raise ValueError(
            "Каналы вне схемы монтажа 10-20 не могут войти в ряды «Монтажа»: "
            + ", ".join(strangers)
        )

    warnings: list[str] = []
    mixes: list[RowMix] = []
    for row in ROW_DEFS:
        present = [name for name in row.weights if name in index]
        if not present:
            warnings.append(
                f"Ряд «{row.label}»: в записи нет каналов ряда — ряд пропущен"
            )
            continue
        left = np.zeros(len(channels), dtype=np.float64)
        right = np.zeros(len(channels), dtype=np.float64)
        for name in present:
            raw_left, raw_right = row.weights[name]
            left[index[name]] = raw_left
            right[index[name]] = raw_right
        # Нормировка на среднее сумм L/R: при полном составе суммы равны
        # (симметрия формул владельца), при частичном — общий множитель
        # не меняет ни отношение L/R внутри ряда, ни «просачивание» 0.75/0.25.
        scale = (float(left.sum()) + float(right.sum())) / 2.0
        if scale <= 0.0:  # не бывает при непустом ряду, но нулевую делить нельзя
            warnings.append(f"Ряд «{row.label}»: нулевые веса — ряд пропущен")
            continue
        mixes.append(RowMix(
            id=row.id,
            label=row.label,
            channels=present,
            w_left=left / scale,
            w_right=right / scale,
            weights={
                name: (float(left[index[name]] / scale), float(right[index[name]] / scale))
                for name in present
            },
        ))

    if not mixes:
        raise ValueError(
            "Нет ни одного ряда схемы 10-20 из каналов записи — "
            "вариант «Монтаж» не применим (попробуйте «Экспресс»)"
        )

    leftover = [
        name for name in channels
        if _is_standard_1020(name) and name not in _ROW_CHANNELS
    ]
    if leftover:
        warnings.append(
            "Каналы вне четырёх рядов «Монтажа» не участвуют в рендере: "
            + ", ".join(leftover)
        )
    return mixes, warnings


def _is_standard_1020(name: str) -> bool:
    """Канал — известный электрод 10-20 (тот же критерий, что в channel_mix)."""
    from app.services.channel_mix import channel_group

    return channel_group(name) is not None

