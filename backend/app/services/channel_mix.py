"""Виртуальные каналы раздела «ЭЭГ»: миксы каналов группы (срез 5+).

Зачем
-----
Раздел «ЭЭГ» показывает один канал — спектрограмма считается STFT по нему.
Пройти так все 18 каналов означает 18 задач, а чаще нужен не отдельный электрод,
а **область монтажа** (лобные, височные) или полушарие. Поэтому у канала
появились виртуальные варианты — ``mix:<группа>``: сервер сам отбирает каналы
записи по имени (стандарт 10-20) и усредняет их сигнал.

Правила
-------
* id микса — строка ``mix:frontal``: она уходит в форму расчёта и лежит в
  ``params.channel``, поэтому подпись результата и «параметры изменены»
  работают ровно как у обычного канала;
* группы заданы **именами** каналов (``Fp1``, ``T7``, ``Oz``), а не списком
  электродов конкретного файла: состав берётся из паспорта записи, и пустая
  группа в паспорт не попадает — предлагать «Затылочные» там, где затылочных
  электродов нет, значит обещать пустую линию;
* полушарие — по номеру электрода: нечётный левый, чётный правый; срединные
  каналы (``Fz``, ``Cz``, ``Pz``, ``Oz``) не входят ни в левое, ни в правое — они
  в «Все каналы»;
* микс считается **без дополнительного референса**: среднее по группе само
  является ссылкой (для «Все каналы» это common average reference — общий
  компонент записи). С average reference из микса вычиталось бы ровно это
  среднее, и «Все каналы» показывали бы пустую линию.

Модуль чистый (без MNE и диска): состав групп проверяется тестами, а расчёт
(``services/spectrogram.py``) только спрашивает ``channel_mix_channels``.
"""
from collections.abc import Sequence
from typing import Any

# Префикс id виртуального канала: им канал отличается от обычного в форме
# расчёта, в паспорте записи и в подписи результата.
MIX_PREFIX = "mix:"

# Группы в порядке показа: сначала вся запись, затем полушария, затем области
MIX_GROUPS: tuple[tuple[str, str], ...] = (
    ("all", "Все каналы"),
    ("left", "Левое полушарие"),
    ("right", "Правое полушарие"),
    ("frontal", "Лобные"),
    ("temporal", "Височные"),
    ("central", "Центральные"),
    ("parietal", "Теменные"),
    ("occipital", "Затылочные"),
)
MIX_LABELS: dict[str, str] = dict(MIX_GROUPS)

# Префикс имени канала 10-20 → группа. Двухбуквенные проверяются первыми:
# FT7 — височный, а не лобный; FC1 — центральный, а не лобный.
_PREFIX_GROUP: dict[str, str] = {
    "FP": "frontal",
    "AF": "frontal",
    "F": "frontal",
    "FT": "temporal",
    "TP": "temporal",
    "T": "temporal",
    "FC": "central",
    "C": "central",
    "CP": "parietal",
    "P": "parietal",
    "PO": "occipital",
    "O": "occipital",
    "I": "occipital",
}


def _letters(name: str) -> str:
    """Буквенная часть имени канала в верхнем регистре («EEG Fp1» → «FP»)."""
    return "".join(ch for ch in name.upper() if ch.isalpha())


def _trailing_digits(name: str) -> str:
    """Цифры в конце имени («T7» → «7», «Fp1» → «1»); пусто — номера нет."""
    digits = ""
    for ch in reversed(name):
        if not ch.isdigit():
            break
        digits = ch + digits
    return digits


def channel_group(name: str) -> str | None:
    """Область монтажа по имени канала: ``Fp1`` → ``frontal``, ``Pz`` → ``parietal``.

    ``None`` — имя не похоже на стандартный электрод 10-20 (``A1``, ``M2``,
    служебные каналы): такие каналы попадают только в «Все каналы».
    """
    letters = _letters(name)
    if not letters:
        return None
    # Срединные каналы (Oz, Fpz) отличаются от области только суффиксом «z»
    stem = letters[:-1] if letters.endswith("Z") else letters
    for size in (2, 1):
        if len(stem) >= size and stem[:size] in _PREFIX_GROUP:
            return _PREFIX_GROUP[stem[:size]]
    return None


def channel_hemisphere(name: str) -> str | None:
    """Полушарие канала: ``left`` / ``right`` / ``None`` (срединный или без номера).

    Нечётный номер — левое полушарие, чётный — правое: так устроен монтаж
    10-20 (F3/F4, T7/T8, O1/O2). ``Fz``/``Cz``/``Pz``/``Oz`` стоят по средней
    линии и полушарию не принадлежат — они входят в «Все каналы».
    """
    # Полушарие — свойство электрода монтажа: у служебных каналов (A1, M2, EKG)
    # номера тоже есть, но полушария у них нет — они не ЭЭГ-электроды
    if channel_group(name) is None:
        return None
    if _letters(name).endswith("Z"):
        return None
    digits = _trailing_digits(name)
    if not digits:
        return None
    return "left" if int(digits) % 2 == 1 else "right"


def parse_mix_id(channel: str) -> str | None:
    """Группа микса по id канала (``mix:left`` → ``left``); иначе ``None``."""
    if not channel.startswith(MIX_PREFIX):
        return None
    group = channel[len(MIX_PREFIX):]
    return group if group in MIX_LABELS else None


def is_mix_channel(channel: str) -> bool:
    """Похож ли канал на виртуальный (проверяет и префикс, и известную группу)."""
    return parse_mix_id(channel) is not None


def mix_channels(group: str, channels: Sequence[str]) -> list[str]:
    """Каналы записи, входящие в группу; порядок монтажа сохраняется."""
    if group == "all":
        return list(channels)
    if group in ("left", "right"):
        return [name for name in channels if channel_hemisphere(name) == group]
    if group in MIX_LABELS:
        return [name for name in channels if channel_group(name) == group]
    return []


def channel_mix_channels(channel: str, channels: Sequence[str]) -> list[str] | None:
    """Каналы виртуального канала или ``None``, если ``channel`` — обычный канал.

    Пустой список — «микс известен, но таких каналов в записи нет»: это ошибка
    параметров, а не отсутствие канала, и текст о ней собирает расчёт.
    """
    group = parse_mix_id(channel)
    if group is None:
        return None
    return mix_channels(group, channels)


def channel_label(channel: str) -> str:
    """Подпись канала для текстов и заголовков: у микса — «Микс: Лобные»."""
    group = parse_mix_id(channel)
    return f"Микс: {MIX_LABELS[group]}" if group is not None else channel


def mixes_for(channels: Sequence[str]) -> list[dict[str, Any]]:
    """Варианты миксов для паспорта записи.

    Пустые группы не предлагаются: вариант, который заведомо даст пустую линию,
    в списке выглядит как ошибка UI, а не как честное «в этой записи таких
    электродов нет».
    """
    options: list[dict[str, Any]] = []
    for group, label in MIX_GROUPS:
        members = mix_channels(group, channels)
        if members:
            options.append({
                "id": f"{MIX_PREFIX}{group}",
                "label": label,
                "group": group,
                "channels": members,
            })
    return options
