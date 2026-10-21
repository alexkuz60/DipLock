"""VAMP-анализ аудио микса через Sonic Annotator (C4DM QMUL) — тональность, темп, сегменты.

Единственная точка запуска внешнего инструмента в проекте: ``sonic-annotator``
прогоняет зафиксированные transform-файлы (``vamp/transforms/*.n3``) по WAV и
отдаёт CSV-таблицу признаков. Здесь три признака:

* **Key Detector** — тональность сегмента (код 1…24 + метка) → ``key_track``;
  потребитель — вращение звезды «Эмо» (``docs/rules/neuromusic.md`` §«Эмо»,
  «Вращение звезды»);
* **Tempo and Beat Tracker** (вывод ``tempo``, «locked tempo estimates») →
  ``tempo_track`` ``[{t_sec, bpm}]``; потребитель — темп-коррекция радара
  «Эмо» (там же, «Темп-коррекция»);
* **Segmenter** (вывод ``segmentation``, «ЕмоЛаб», моно 32 кГц) →
  ``segment_track`` ``[{t_sec, segment_type, name}]``; потребитель —
  визуально-слуховой контроль анализа (таблица сегментов в «Опциях»,
  вертикали с метками имён A, B, C… поверх волны и на «Эмограмме»),
  ``docs/rules/emolab.md``; в расчётах пока не участвует.

Инварианты (ловушки 09.10.2026):

* GPL-бинарь запускается **отдельным процессом** (subprocess) — лицензия MIT
  проекта не смешивается с GPL инструмента;
* ``VAMP_PATH`` передаётся **всегда явно**: дефолтный поиск плагинов
  статической AppImage-сборки 1.7 падает с «buffer overflow detected»;
* инструмент недоступен/упал/не уложился в таймаут → ``None`` (best-effort),
  расчёт никогда не падает и не блокирует рендер/отдачу кадров;
* тяжёлый вызов — синхронный, вызывающая сторона обязана выносить его из
  event loop (``asyncio.to_thread`` / job-очередь, правило «Async»).
"""
import contextlib
import csv
import io
import logging
import math
import os
import subprocess
import tempfile
from typing import Any

from app.core.config import Settings, settings

logger = logging.getLogger(__name__)

# Источник трека тональности в контракте emo.json (``key_source``).
KEY_SOURCE = "vamp:qm-vamp-plugins:qm-keydetector:key"

# Источник трека темпа в контракте emo.json (``tempo_source``).
TEMPO_SOURCE = "vamp:qm-vamp-plugins:qm-tempotracker:tempo"

# Источник трека сегментов в контракте emo.json (``segment_source``).
SEGMENTER_SOURCE = "vamp:qm-vamp-plugins:qm-segmenter:segmentation"

# Transform-файл Key Detector внутри ``settings.vamp_transforms_dir``.
KEY_TRANSFORM_NAME = "qm-keydetector-key.n3"

# Тот же Key Detector для входа 32000 Гц («ЕмоЛаб», моно-файл анализа):
# плагин требует step/block 16384 при 32 кГц (в 32768/32768 он не инициализируется
# — «differ from required»); фиксированный rate 32000 страхует от входа другой
# частоты. Рендер «Нейромузыки» идёт общим трансформом выше (мастер 48 кГц).
KEY_TRANSFORM_NAME_32K = "qm-keydetector-key-32k.n3"

# Transform-файл Tempo and Beat Tracker (вывод ``tempo``) — там же.
TEMPO_TRANSFORM_NAME = "qm-tempotracker-tempo.n3"

# Transform-файл Segmenter (QM Vamp Plugins) для моно-файла 32000 Гц «ЕмоЛаб»:
# делит трек на последовательность однородных сегментов. Ловушка: плагин
# диктует step/block своей частоты и отвергает другие («supplied step size …
# differs from required …»): при 32 кГц требуются step 6400 (= 0.2 с) и
# block 19200 (= 3 × step). Параметры по умолчанию изменены в трансформе
# (постановка владельца 21.10.2026): nSegmentTypes = 8 (дефолт 10),
# neighbourhoodLimit = 2 с («Minimum segment duration», дефолт 4 с).
SEGMENTER_TRANSFORM_NAME_32K = "qm-segmenter-segmentation-32k.n3"

# Коды тональности QM Key Detector: 1…12 — мажор (C=1 … B=12),
# 13…24 — минор (Cm=13 … Bm=24). Вне диапазона — мусорная строка CSV.
KEY_CODE_MIN = 1
KEY_CODE_MAX = 24

# Типы сегментов QM Segmenter: 1…12 (диапазон параметра nSegmentTypes).
# Имя сегмента — метка плагина (A, B, …: тип 1 → A, 2 → B, …); пустая метка
# достраивается буквой по типу.
SEGMENT_TYPE_MIN = 1
SEGMENT_TYPE_MAX = 12

# Таймаут прогона, с: мастер реального рендера — десятки МБ WAV, Key Detector
# укладывается в секунды, запас — на медленный диск/CI.
VAMP_TIMEOUT_S = 300.0


def _vamp_env(cfg: Settings) -> dict[str, str]:
    """Окружение процесса: ``VAMP_PATH`` всегда явно (см. ловушку модуля)."""
    env = dict(os.environ)
    env["VAMP_PATH"] = cfg.vamp_path or os.path.expanduser("~/vamp")
    return env


def _run_transform(blob: bytes, transform_name: str, cfg: Settings) -> str | None:
    """WAV в байтах → CSV-вывод transform-файла Sonic Annotator либо ``None``.

    ``None`` — sonic-annotator/transform недоступны, процесс упал или не
    уложился в ``VAMP_TIMEOUT_S``: вызывающая сторона оставляет свой трек
    пустым (best-effort, расчёт никогда не падает). Байты WAV пишутся во
    временный файл — инструмент читает только файлы; файл удаляется всегда.
    """
    cfg = cfg or settings
    binary = cfg.sonic_annotator_bin
    if not binary or not os.path.isfile(binary):
        logger.debug("Sonic Annotator не найден (%s) — %s пропущен", binary, transform_name)
        return None
    transform = os.path.join(cfg.vamp_transforms_dir, transform_name)
    if not os.path.isfile(transform):
        logger.warning("Transform %s не найден — %s пропущен", transform, transform_name)
        return None
    tmp_path = ""
    try:
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            tmp.write(blob)
            tmp_path = tmp.name
        result = subprocess.run(  # noqa: S603 — список аргументов фиксирован, без shell
            [binary, "-t", transform, tmp_path, "-w", "csv", "--csv-stdout"],
            capture_output=True,
            text=True,
            timeout=VAMP_TIMEOUT_S,
            env=_vamp_env(cfg),
            check=False,
        )
    except FileNotFoundError:
        logger.warning("Sonic Annotator не запустился (%s) — %s пропущен", binary, transform_name)
        return None
    except subprocess.TimeoutExpired:
        logger.warning(
            "Sonic Annotator не уложился в %.0f с — %s пропущен", VAMP_TIMEOUT_S, transform_name,
        )
        return None
    finally:
        if tmp_path:
            with contextlib.suppress(OSError):
                os.unlink(tmp_path)
    if result.returncode != 0:
        logger.warning(
            "Sonic Annotator rc=%s — %s пропущен: %s",
            result.returncode, transform_name, result.stderr.strip()[-200:],
        )
        return None
    return result.stdout


def parse_key_csv(text: str) -> list[dict[str, Any]]:
    """CSV Sonic Annotator → сегменты ``[{t_sec, key_code, label}]``.

    Формат строки (райтер ``csv``, ``--csv-stdout``): ``[имя_файла,] время,
    код, "метка"`` — колонка имени присутствует, но пустая во всех строках,
    кроме первой. Метка может быть составной («Eb / D# minor») — источник
    истины для вращения **числовой код** (1…24), метка — справочно. Строки
    с некорректным кодом/временем пропускаются; пустой/чужой CSV → пустой
    список (``None`` зарезервирован под «инструмент недоступен»).
    """
    segments: list[dict[str, Any]] = []
    for row in csv.reader(io.StringIO(text)):
        if len(row) == 4:
            time_s, code_s, label = row[1], row[2], row[3]
        elif len(row) == 3:
            time_s, code_s, label = row[0], row[1], row[2]
        else:
            continue
        try:
            t_sec = float(time_s)
            code = int(float(code_s))
        except ValueError:
            continue
        if not (KEY_CODE_MIN <= code <= KEY_CODE_MAX):
            continue
        segments.append(
            {"t_sec": round(t_sec, 6), "key_code": code, "label": label.strip()},
        )
    return segments


def key_track_from_wav(
    blob: bytes,
    cfg: Settings | None = None,
    transform_name: str = KEY_TRANSFORM_NAME,
) -> list[dict[str, Any]] | None:
    """Тональность микса: WAV в байтах → сегменты ``key_track`` либо ``None``.

    ``transform_name`` — transform-файл Key Detector: по умолчанию общий
    (рендер «Нейромузыки», мастер 48 кГц); для моно-файла 32000 Гц «ЕмоЛаб»
    передаётся :data:`KEY_TRANSFORM_NAME_32K` (step/block 16384 — требование
    плагина при 32 кГц). ``None`` — инструмент недоступен (см. ``_run_transform``):
    вызывающая сторона оставляет вращение звезды нулевым (кадры «Эмо» без ``key_track``).
    """
    text = _run_transform(blob, transform_name, cfg or settings)
    if text is None:
        return None
    return parse_key_csv(text)


def parse_tempo_csv(text: str) -> list[dict[str, Any]]:
    """CSV Sonic Annotator → оценки темпа ``[{t_sec, bpm}]``.

    Формат строки (райтер ``csv``, ``--csv-stdout``) — как у Key Detector:
    ``[имя_файла,] время, значение, [метка]``; вывод ``tempo`` плагина Tempo
    and Beat Tracker — «locked tempo estimates» (в bpm), по одной оценке на
    строку, метка справочная («120,19 bpm»). Строки с некорректным
    временем/неположительным bpm пропускаются; пустой CSV → пустой список
    (``None`` зарезервирован под «инструмент недоступен»).
    """
    estimates: list[dict[str, Any]] = []
    for row in csv.reader(io.StringIO(text)):
        if len(row) == 4:
            time_s, bpm_s = row[1], row[2]
        elif len(row) == 3:
            time_s, bpm_s = row[0], row[1]
        else:
            continue
        try:
            t_sec = float(time_s)
            bpm = float(bpm_s)
        except ValueError:
            continue
        if not (bpm > 0.0) or not math.isfinite(bpm) or not math.isfinite(t_sec):
            continue
        estimates.append({"t_sec": round(t_sec, 6), "bpm": round(bpm, 3)})
    return estimates


def tempo_track_from_wav(blob: bytes, cfg: Settings | None = None) -> list[dict[str, Any]] | None:
    """Темп микса: WAV в байтах → оценки ``tempo_track`` либо ``None``.

    ``None`` — инструмент недоступен (см. ``_run_transform``): вызывающая
    сторона оставляет темп-коррекцию нулевой (кадры «Эмо» без ``tempo_track``).
    """
    text = _run_transform(blob, TEMPO_TRANSFORM_NAME, cfg or settings)
    if text is None:
        return None
    return parse_tempo_csv(text)


def parse_segmenter_csv(text: str) -> list[dict[str, Any]]:
    """CSV Sonic Annotator → сегменты трека ``[{t_sec, segment_type, name}]``.

    Формат строки (райтер ``csv``, ``--csv-stdout``) у вывода с длительностью
    (Structural Segment): ``[имя_файла,] начало, длительность, тип, "имя"`` —
    колонка имени файла присутствует, но пустая во всех строках, кроме первой
    (как у Key Detector). Тип — целое 1…12, имя — метка плагина (A, B, … по
    типу: 1 → A, 2 → B, …; живой выхлоп — см. ловушку
    ``docs/rules/emolab.md``); пустая метка достраивается буквой по типу.
    Строки с некорректным временем/длительностью/типом пропускаются;
    пустой/чужой CSV → пустой список (``None`` зарезервирован под
    «инструмент недоступен»).
    """
    segments: list[dict[str, Any]] = []
    for row in csv.reader(io.StringIO(text)):
        if len(row) == 5:
            time_s, duration_s, type_s, label = row[1], row[2], row[3], row[4]
        elif len(row) == 4:
            time_s, duration_s, type_s, label = row
        elif len(row) == 3:
            time_s, duration_s, type_s, label = row[0], row[1], row[2], ""
        else:
            continue
        try:
            t_sec = float(time_s)
            duration = float(duration_s)
            segment_type = int(float(type_s))
        except ValueError:
            continue
        if not (duration > 0.0) or not math.isfinite(t_sec) or not math.isfinite(duration):
            continue
        if not (SEGMENT_TYPE_MIN <= segment_type <= SEGMENT_TYPE_MAX):
            continue
        name = label.strip() or chr(ord("A") + segment_type - 1)
        segments.append(
            {"t_sec": round(t_sec, 6), "segment_type": segment_type, "name": name},
        )
    return segments


def segment_track_from_wav(
    blob: bytes,
    cfg: Settings | None = None,
    transform_name: str = SEGMENTER_TRANSFORM_NAME_32K,
) -> list[dict[str, Any]] | None:
    """Сегментация трека: WAV в байтах → сегменты ``segment_track`` либо ``None``.

    ``transform_name`` — transform-файл Segmenter (по умолчанию для моно-файла
    32000 Гц «ЕмоЛаб»: step/block 6400/19200 — требование плагина при 32 кГц,
    параметры `nSegmentTypes` = 8 и `neighbourhoodLimit` = 2 с). ``None`` —
    инструмент недоступен (см. ``_run_transform``): вызывающая сторона
    оставляет сегменты пустыми (таблица/линии в UI без данных).
    """
    text = _run_transform(blob, transform_name, cfg or settings)
    if text is None:
        return None
    return parse_segmenter_csv(text)