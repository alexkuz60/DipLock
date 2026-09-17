"""Загрузка EDF: санитизация имени и потоковая запись с контролем размера (F10, A1).

Загрузка — единственное место API, которое пишет пользовательские данные на
диск, поэтому правила здесь жёсткие:

* имя превращается в basename и чистится от небезопасных символов — ``../``,
  Windows-пути и абсолютные пути не должны вывести запись за ``upload_dir``;
* файл читается чанками, размер проверяется **до** записи чанка на диск: иначе
  «защита» отдавала бы 200 МБ мусора и только потом ошибку;
* каждый запрос получает свой uuid-каталог, и при любой ошибке он удаляется —
  частичный файл не остаётся.

Отпечаток содержимого (sha256) считается в том же проходе по чанкам и нужен
только дедупу записей просмотра; ``/analyze`` и ``/jobs`` его не заказывают —
они удаляют файл сразу после чтения.
"""
import asyncio
import hashlib
import os
import re
import shutil
import uuid

from fastapi import HTTPException, UploadFile

from app.core.config import settings

# Максимальный размер загружаемого EDF (200 МБ)
MAX_UPLOAD_SIZE = 200 * 1024 * 1024
_UPLOAD_CHUNK = 1024 * 1024

# Имя загрузки: только basename и безопасные символы (F10 — защита от "../" и
# абсолютных путей, которые вывели бы запись за пределы upload_dir).
_UNSAFE_NAME_RE = re.compile(r"[^A-Za-z0-9._+-]+")
_MAX_NAME_LEN = 128


def safe_edf_name(filename: str | None) -> str:
    """Санитизация имени загружаемого файла (F10).

    Отбрасывает каталоги (в т.ч. ``../`` и Windows-пути), заменяет небезопасные
    символы, требует суффикс ``.edf``.
    """
    raw_name = (filename or "").replace("\\", "/").strip()
    base = os.path.basename(raw_name) or "recording.edf"
    base = _UNSAFE_NAME_RE.sub("_", base)[:_MAX_NAME_LEN]
    if not base.lower().endswith(".edf"):
        raise HTTPException(status_code=400, detail="Поддерживаются только файлы .edf")
    return base


async def save_upload(
    file: UploadFile, safe_name: str, with_digest: bool = False,
) -> tuple[str, str, str | None]:
    """Сохраняет загрузку в отдельный каталог с контролем размера (F10).

    Возвращает ``(путь_к_файлу, каталог_загрузки, sha256)``; каталог удаляет
    вызывающий код (в ``finally``) — при ошибке/413 частичный файл не остаётся
    на диске.
    """
    upload_dir = os.path.join(settings.upload_dir, str(uuid.uuid4()))
    os.makedirs(upload_dir, exist_ok=True)
    tmp_path = os.path.join(upload_dir, safe_name)

    size = 0
    digest = hashlib.sha256() if with_digest else None
    try:
        # Файл открывается, пишется и закрывается в рабочем потоке: event-loop не
        # должен ждать диск ни на открытии, ни на чанке (ASYNC230, F10).
        out = await asyncio.to_thread(open, tmp_path, "wb")
        try:
            while chunk := await file.read(_UPLOAD_CHUNK):
                size += len(chunk)
                if size > MAX_UPLOAD_SIZE:
                    raise HTTPException(
                        status_code=413,
                        detail=f"Файл слишком большой (макс {MAX_UPLOAD_SIZE // (1024 * 1024)} МБ)",
                    )
                if digest is not None:
                    digest.update(chunk)
                await asyncio.to_thread(out.write, chunk)
        finally:
            await asyncio.to_thread(out.close)
    except BaseException:
        shutil.rmtree(upload_dir, ignore_errors=True)
        raise
    finally:
        await file.close()
    return tmp_path, upload_dir, digest.hexdigest() if digest is not None else None
