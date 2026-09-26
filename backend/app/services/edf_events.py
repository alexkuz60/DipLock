"""События записи EDF: аннотации EDF+ и маркеры стим-каналов (N2, шаг 2.7).

Источников событий в EDF два:

* **EDF+-аннотации** (TAL) — MNE парсит их в ``raw.annotations`` при чтении файла;
* **стим-каналы** (``status``/``trigger`` — MNE помечает их типом ``stim`` при
  ``stim_channel='auto'``) — коды триггеров живут в самом канале; их
  ``mne.find_events`` превращает в события.

Оба источника сводятся к **аннотациям** ``raw.annotations`` (стим-события — с
описанием ``STIM/<код>``): дальше паспорт записи, нарезка по событиям и ERP
работают одним механизмом (``mne.events_from_annotations``), а стим-канал
удаляется из записи — он не ЭЭГ и не должен попадать в масштаб/QC/монтаж.

Описание аннотации с префиксом ``STIM/`` в паспорте маркируется
``source='stim'`` (остальные — ``'annotation'``). ``BAD_``-аннотации событиями
**не считаются**: это отбраковка (`docs/rules/artifacts.md`), во вьюер-слой и
селект нарезки они не попадают, но в ``raw.annotations`` остаются и роняют эпохи
(правило N6, объединение — `services/epoch_segmenter.py`).
"""
import logging
from typing import Any

import mne

from app.services.artifact_detector import BAD_PREFIX

logger = logging.getLogger(__name__)

# Описание стим-события, собранного из стим-канала: STIM/<код триггера>
STIM_DESC_PREFIX = "STIM/"

# Имена стим-каналов сверх правила MNE 'status'/'trigger' (обычные имена систем)
_EXTRA_STIM_NAMES = ("stim", "sti", "markers", "marker", "trig")

# Лимит событий в паспорте: сайдкар записи — JSON, тысячи событий раздувают его
EVENTS_CAP = 5000


def stim_channel_names(raw: mne.io.BaseRaw) -> list[str]:
    """Каналы записи, похожие на стим/маркеры (тип ``stim`` у MNE или имя).

    MNE при ``stim_channel='auto'`` помечает типом ``stim`` каналы ``status`` и
    ``trigger`` (без учёта регистра); остальные производители используют
    ``Markers``/``STI``/``Trig`` — их ловим по имени сами.
    """
    types = raw.get_channel_types()
    names: list[str] = []
    for ch_name, ch_type in zip(raw.ch_names, types, strict=True):
        if ch_type == "stim" or ch_name.strip().lower() in _EXTRA_STIM_NAMES:
            names.append(ch_name)
    return names


def attach_stim_annotations(raw: mne.io.BaseRaw) -> list[str]:
    """Маркеры стим-каналов → аннотации ``STIM/<код>``; каналы удаляются.

    Мутирует ``raw``: аннотации события **добавляются** к существующим (аннотации
    файла не перетираются — N2), стим-каналы снимаются с записи. Вызывается сразу
    после чтения EDF, до ``pick``/фильтров/ресемпла: так события привязаны к
    исходному времени файла (zero-phase фильтр и ресемпл секунды не сдвигают).

    Возвращает имена удалённых каналов (пусто — стим-каналов не было).
    """
    stim = stim_channel_names(raw)
    if not stim:
        return []

    onsets: list[float] = []
    durations: list[float] = []
    descriptions: list[str] = []
    sfreq = float(raw.info["sfreq"]) or 1.0
    for ch_name in stim:
        try:
            if raw.get_channel_types(picks=ch_name)[0] != "stim":
                # Имя как у стим-канала, но тип не stim: MNE find_events требует
                # тип stim — переквалифицируем (значения всё равно коды триггеров)
                raw.set_channel_types({ch_name: "stim"}, verbose=False)
            events = mne.find_events(
                raw, stim_channel=ch_name,
                shortest_event=1, initial_event=True, verbose=False,
            )
        except Exception as exc:  # канал просто не стим — идём дальше
            logger.warning("Стим-канал %s не разобран как маркеры: %s", ch_name, exc)
            continue
        for sample, _prev, code in events:
            onsets.append((float(sample) - float(raw.first_samp)) / sfreq)
            durations.append(0.0)
            descriptions.append(f"{STIM_DESC_PREFIX}{int(code)}")
        if len(events):
            logger.info("Стим-канал %s: %d маркеров → аннотации %s…", ch_name, len(events), STIM_DESC_PREFIX)

    raw.drop_channels([ch for ch in stim if ch in raw.ch_names])
    if not onsets:
        return stim

    existing = raw.annotations
    raw.set_annotations(
        mne.Annotations(
            onset=[float(v) for v in existing.onset] + onsets,
            duration=[float(v) for v in existing.duration] + durations,
            description=list(existing.description) + descriptions,
        ),
        verbose=False,
    )
    return stim


def record_events(
    raw: mne.io.BaseRaw, cap: int = EVENTS_CAP,
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    """События записи для паспорта: отсортированы по времени, ``BAD_`` исключены.

    Первый элемент — события до ``cap`` (сайдкар не должен раздуваться),
    второй — счётчики по **всем** описаниям (из них UI собирает селект
    нарезки/ERP, и прятать «лишние» описания нельзя).
    """
    items = [
        (float(onset), float(duration), str(description))
        for onset, duration, description in zip(
            raw.annotations.onset, raw.annotations.duration, raw.annotations.description,
            strict=True,
        )
        if not str(description).startswith(BAD_PREFIX)
    ]
    items.sort(key=lambda item: item[0])

    counts: dict[str, int] = {}
    for _onset, _duration, description in items:
        counts[description] = counts.get(description, 0) + 1

    events: list[dict[str, Any]] = [
        {
            "onset": round(onset, 4),
            "duration": round(duration, 4),
            "description": description,
            "source": "stim" if description.startswith(STIM_DESC_PREFIX) else "annotation",
        }
        for onset, duration, description in items[:cap]
    ]
    return events, counts
