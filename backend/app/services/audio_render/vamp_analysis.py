"""VAMP-анализ аудио микса через Sonic Annotator (C4DM QMUL) — трек тональности.

Единственная точка запуска внешнего инструмента в проекте: ``sonic-annotator``
прогоняет зафиксированный transform-файл (``vamp/transforms/*.n3``) по WAV и
отдаёт CSV-таблицу признаков. Здесь — только **Key Detector** (тональность
сегмента: код 1…24 + метка), потребитель — вращение звезды «Эмо»
(``docs/rules/neuromusic.md`` §«Эмо», «Вращение звезды»).

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
import os
import subprocess
import tempfile
from typing import Any

from app.core.config import Settings, settings

logger = logging.getLogger(__name__)

# Источник трека тональности в контракте emo.json (``key_source``).
KEY_SOURCE = "vamp:qm-vamp-plugins:qm-keydetector:key"

# Transform-файл Key Detector внутри ``settings.vamp_transforms_dir``.
KEY_TRANSFORM_NAME = "qm-keydetector-key.n3"

# Коды тональности QM Key Detector: 1…12 — мажор (C=1 … B=12),
# 13…24 — минор (Cm=13 … Bm=24). Вне диапазона — мусорная строка CSV.
KEY_CODE_MIN = 1
KEY_CODE_MAX = 24

# Таймаут прогона, с: мастер реального рендера — десятки МБ WAV, Key Detector
# укладывается в секунды, запас — на медленный диск/CI.
VAMP_TIMEOUT_S = 300.0


def _vamp_env(cfg: Settings) -> dict[str, str]:
    """Окружение процесса: ``VAMP_PATH`` всегда явно (см. ловушку модуля)."""
    env = dict(os.environ)
    env["VAMP_PATH"] = cfg.vamp_path or os.path.expanduser("~/vamp")
    return env


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


def key_track_from_wav(blob: bytes, cfg: Settings | None = None) -> list[dict[str, Any]] | None:
    """Тональность микса: WAV в байтах → сегменты ``key_track`` либо ``None``.

    ``None`` — sonic-annotator/transform недоступны, процесс упал или не
    уложился в ``VAMP_TIMEOUT_S``: вызывающая сторона оставляет вращение
    звезды нулевым (кадры «Эмо» без ``key_track``). Байты WAV пишутся во
    временный файл — инструмент читает только файлы; файл удаляется всегда.
    """
    cfg = cfg or settings
    binary = cfg.sonic_annotator_bin
    if not binary or not os.path.isfile(binary):
        logger.debug("Sonic Annotator не найден (%s) — key_track пропущен", binary)
        return None
    transform = os.path.join(cfg.vamp_transforms_dir, KEY_TRANSFORM_NAME)
    if not os.path.isfile(transform):
        logger.warning("Transform %s не найден — key_track пропущен", transform)
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
        logger.warning("Sonic Annotator не запустился (%s) — key_track пропущен", binary)
        return None
    except subprocess.TimeoutExpired:
        logger.warning("Sonic Annotator не уложился в %.0f с — key_track пропущен", VAMP_TIMEOUT_S)
        return None
    finally:
        if tmp_path:
            with contextlib.suppress(OSError):
                os.unlink(tmp_path)
    if result.returncode != 0:
        logger.warning(
            "Sonic Annotator rc=%s — key_track пропущен: %s",
            result.returncode, result.stderr.strip()[-200:],
        )
        return None
    return parse_key_csv(result.stdout)