"""Тесты виртуальных каналов «ЭЭГ» (`app/services/channel_mix.py`, срез 5+).

Микс — это правило группировки имён 10-20, а не данные: поэтому проверяется
разбор имён (область, полушарие, срединные каналы), состав групп на реальном
монтаже `standard_channels` и то, что пустые группы в паспорт не попадают.
"""
import pytest

from app.core.config import settings
from app.services.channel_mix import (
    MIX_PREFIX,
    channel_group,
    channel_hemisphere,
    channel_label,
    channel_mix_channels,
    is_mix_channel,
    mix_channels,
    mixes_for,
    parse_mix_id,
)
from app.services.spectrogram import SpectrogramError, SpectrogramParams, validate_params


@pytest.mark.parametrize(
    ("name", "group"),
    [
        ("Fp1", "frontal"),
        ("AF7", "frontal"),
        ("F3", "frontal"),
        ("Fz", "frontal"),
        ("FT9", "temporal"),
        ("T7", "temporal"),
        ("TP9", "temporal"),
        ("FC1", "central"),
        ("C3", "central"),
        ("Cz", "central"),
        ("CP1", "parietal"),
        ("P3", "parietal"),
        ("Pz", "parietal"),
        ("PO3", "occipital"),
        ("O1", "occipital"),
        ("Oz", "occipital"),
        # Служебные и «нестандартные» имена: только «Все каналы», не область
        ("A1", None),
        ("M2", None),
        ("", None),
    ],
)
def test_group_follows_10_20_prefixes(name, group):
    """Двухбуквенные префиксы важнее однобуквенных: FT7 — височный, FC1 — центральный."""
    assert channel_group(name) == group


@pytest.mark.parametrize(
    ("name", "side"),
    [
        ("F3", "left"),
        ("F4", "right"),
        ("T7", "left"),
        ("T8", "right"),
        ("O1", "left"),
        ("O2", "right"),
        ("Fp1", "left"),
        ("Fp2", "right"),
        # Срединные каналы полушарию не принадлежат
        ("Fz", None),
        ("Cz", None),
        ("Pz", None),
        ("Oz", None),
        ("A1", None),
    ],
)
def test_hemisphere_comes_from_channel_number(name, side):
    """Нечётный номер — левое полушарие, чётный — правое; «z» — средняя линия."""
    assert channel_hemisphere(name) == side


def test_mix_lists_keep_montage_order():
    """Состав микса — каналы записи в порядке монтажа, а не порядок групп."""
    channels = list(settings.standard_channels)

    assert mix_channels("all", channels) == channels
    assert mix_channels("left", channels) == [
        "Fp1", "F3", "C3", "P3", "O1", "F7", "T7", "P7",
    ]
    assert mix_channels("right", channels) == [
        "Fp2", "F4", "C4", "P4", "O2", "F8", "T8", "P8",
    ]
    assert mix_channels("frontal", channels) == ["Fp1", "Fp2", "F3", "F4", "F7", "F8", "Fz"]
    assert mix_channels("occipital", channels) == ["O1", "O2", "Oz"]
    # Неизвестная группа — не «все каналы»: пустой список честнее
    assert mix_channels("nope", channels) == []


def test_channel_mix_channels_distinguishes_electrode_from_mix():
    """Обычный канал — ``None`` (микс не при чём), виртуальный — список каналов."""
    channels = ["Fp1", "Fp2", "O1"]

    assert channel_mix_channels("Fp1", channels) is None
    assert channel_mix_channels(f"{MIX_PREFIX}all", channels) == channels
    assert channel_mix_channels(f"{MIX_PREFIX}occipital", channels) == ["O1"]
    # Группа известна, но каналов таких нет: пустой список — это ошибка расчёта
    assert channel_mix_channels(f"{MIX_PREFIX}central", channels) == []


def test_mixes_for_drops_empty_groups():
    """В паспорт попадают только группы, которые есть в монтаже записи."""
    options = mixes_for(["Fp1", "Fp2", "O1", "Fz"])

    assert [option["id"] for option in options] == [
        f"{MIX_PREFIX}all",
        f"{MIX_PREFIX}left",
        f"{MIX_PREFIX}right",
        f"{MIX_PREFIX}frontal",
        f"{MIX_PREFIX}occipital",
    ]
    frontal = next(option for option in options if option["group"] == "frontal")
    assert frontal["label"] == "Лобные"
    assert frontal["channels"] == ["Fp1", "Fp2", "Fz"]
    # Ни височных, ни теменных электродов в записи нет — вариантов нет
    assert all(option["group"] not in ("temporal", "parietal") for option in options)


def test_mix_ids_and_labels():
    """id микса — ``mix:<группа>``; подпись — русская; мусор не проходит за микс."""
    assert parse_mix_id(f"{MIX_PREFIX}parietal") == "parietal"
    assert parse_mix_id("Fp1") is None
    assert parse_mix_id(f"{MIX_PREFIX}nope") is None
    assert is_mix_channel(f"{MIX_PREFIX}all") and not is_mix_channel("Fp1")
    assert channel_label(f"{MIX_PREFIX}frontal") == "Микс: Лобные"
    assert channel_label("Fp1") == "Fp1"


def test_unknown_mix_is_rejected_by_params():
    """Опечатка в id микса — 400 с текстом, а не «канал не найден в записи»."""
    validate_params(SpectrogramParams(channel=f"{MIX_PREFIX}frontal"), settings)

    with pytest.raises(SpectrogramError, match="Неизвестный виртуальный канал"):
        validate_params(SpectrogramParams(channel=f"{MIX_PREFIX}nope"), settings)
