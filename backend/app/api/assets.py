"""Отдача кэшируемых ассетов: один помощник ETag/304 на все ассеты (A2, этап 3).

До этого модуля условия ``304`` и заголовки собирались вручную в каждом
эндпоинте, и ассеты расходились мелочами: где-то ``Cache-Control`` был
``public``, где-то ``private``, где-то ETag дописывался составным вручную.
Класс ошибок, который не видно глазами, поэтому теперь единственный вход —
``asset_response``.

Ассеты делятся по владельцу данных:

* ``public`` — статические данные FreeSurfer (меш, индексы Бродмана, срез МРТ,
  контуры атласа): версия одна на сборку файлов, кэшировать можно долго;
* ``private`` — производные конкретной записи (пирамида сигналов, топокарта,
  сетка спектрограммы): запись живёт по TTL реестра, поэтому и кэш короткий.

Версию ассета считает сервис (``*_version``/``asset_version``): клиент кэширует
по URL + ETag, сам ответ отдаётся готовыми байтами из дискового кэша.
"""
import os
from collections.abc import Mapping
from typing import Literal

from fastapi import Response

# Заголовки кэша: статичные данные ассетов FreeSurfer меняются вместе с файлами
# MNE, производные записи — вместе с самой записью (её TTL по умолчанию 24 ч).
CACHE_PUBLIC_WEEK = "public, max-age=604800"
CACHE_PUBLIC_DAY = "public, max-age=86400"
CACHE_PRIVATE_DAY = "private, max-age=86400"
CACHE_PRIVATE_HOUR = "private, max-age=3600"


def normalize_etag(value: str) -> str:
    """Нормализует значение ETag: снимает ``W/`` и кавычки.

    Сравнивать теги строками нельзя: клиент вправе прислать ``W/"v1"``, и это
    тот же ассет, что ``"v1"``. Оставляем только «тело» версии.
    """
    value = value.strip()
    if value.startswith("W/"):
        value = value[2:]
    return value.strip().strip('"')


def etag_matches(if_none_match: str | None, version: str) -> bool:
    """Проверяет ``If-None-Match`` против версии ассета.

    Заголовок — список тегов через запятую, поэтому сравниваем по частям, а не
    подстрокой (подстрочный поиск считал бы ``"v1"`` совпавшим в ``"v10"``).
    ``*`` — «любая существующая версия» (ассет уже известен клиенту) → 304.
    """
    if not if_none_match:
        return False
    candidates = [part.strip() for part in if_none_match.split(",") if part.strip()]
    if "*" in candidates:
        return True
    target = normalize_etag(version)
    return any(normalize_etag(part) == target for part in candidates)


def asset_response(
    data: bytes,
    version: str,
    *,
    if_none_match: str | None = None,
    media_type: str = "application/json",
    cache_control: str = CACHE_PUBLIC_DAY,
    headers: Mapping[str, str] | None = None,
) -> Response:
    """Отдаёт ассет: ``200`` с телом и ETag либо ``304`` без тела (F6, A2).

    ``version`` передаётся без кавычек — ETag собирается здесь, чтобы все ассеты
    отвечали одинаково. ``headers`` — дополнительные заголовки ассета (``X-…``);
    они попадают и в ``304``: клиент видит те же метаданные, что и в ``200``.
    """
    response_headers: dict[str, str] = {
        "ETag": f'"{version}"',
        "Cache-Control": cache_control,
    }
    if headers:
        response_headers.update(headers)

    if etag_matches(if_none_match, version):
        return Response(status_code=304, headers=response_headers)
    return Response(content=data, media_type=media_type, headers=response_headers)


def _parse_byte_range(header: str | None, size: int) -> tuple[int, int] | Literal["unsatisfiable"] | None:
    """Разбирает ``Range`` в границы ``[start, end]`` включительно.

    ``None`` — заголовка нет, он не наш или многодиапазонный (отдаём файл
    целиком, как разрешает RFC 9110); ``"unsatisfiable"`` — диапазон за
    пределами файла (ответ ``416``).
    """
    if not header:
        return None
    unit, _, spec = header.partition("=")
    if unit.strip().lower() != "bytes" or not spec.strip():
        return None
    if "," in spec:  # многодиапазонный ответ не собираем: 200 целиком
        return None
    start_text, _, end_text = spec.strip().partition("-")
    start_text, end_text = start_text.strip(), end_text.strip()
    if not start_text:  # bytes=-N: последние N байт
        if not end_text.isdigit() or int(end_text) == 0:
            return None
        return max(0, size - int(end_text)), size - 1
    if not start_text.isdigit():
        return None
    start = int(start_text)
    if start >= size:
        return "unsatisfiable"
    if not end_text:
        return start, size - 1
    if not end_text.isdigit() or int(end_text) < start:
        return None
    return start, min(int(end_text), size - 1)


def byte_range_response(
    data: bytes,
    *,
    media_type: str = "audio/wav",
    range_header: str | None = None,
    headers: Mapping[str, str] | None = None,
) -> Response:
    """Отдаёт байты с поддержкой ``Range``: ``206`` куском, ``416`` за пределами.

    Большой WAV (мастер рендера — десятки мегабайт) одним ответом не доходит
    до браузера через облачный ingress, поэтому клиент качает его кусками
    (``neuromusicPlayer.loadBuffer``). ``Accept-Ranges: bytes`` стоит и в
    ``200``: по нему клиент понимает, что куски поддержаны. ``headers`` —
    дополнительные заголовки ответа (например ``Content-Disposition``).
    """
    size = len(data)
    base = {"Accept-Ranges": "bytes", **(headers or {})}
    span = _parse_byte_range(range_header, size)
    if span is None:
        return Response(content=data, media_type=media_type, headers=base)
    if span == "unsatisfiable":
        return Response(
            status_code=416,
            headers={**base, "Content-Range": f"bytes */{size}"},
        )
    start, end = span
    return Response(
        status_code=206,
        content=data[start : end + 1],
        media_type=media_type,
        headers={**base, "Content-Range": f"bytes {start}-{end}/{size}"},
    )


def file_range_response(
    path: str,
    *,
    media_type: str = "audio/wav",
    range_header: str | None = None,
    headers: Mapping[str, str] | None = None,
) -> Response:
    """Отдаёт файл с поддержкой ``Range``, читая с диска только нужный срез.

    Замена :func:`byte_range_response` для больших WAV: прежний помощник
    получал байты целиком и резал копию в памяти, поэтому мастер на 35 МБ
    читался столько раз, сколько кусков просил плеер (4 МиБ × 4 потока).
    Здесь файл открывается, ``seek`` и читается только запрошенный диапазон.
    """
    size = os.path.getsize(path)
    base = {"Accept-Ranges": "bytes", **(headers or {})}
    span = _parse_byte_range(range_header, size)
    if span == "unsatisfiable":
        return Response(
            status_code=416,
            headers={**base, "Content-Range": f"bytes */{size}"},
        )
    if span is None:
        start, end, status = 0, size - 1, 200
    else:
        start, end = span
        status = 206
    with open(path, "rb") as handle:
        handle.seek(start)
        chunk = handle.read(end - start + 1)
    response_headers = dict(base)
    if status == 206:
        response_headers["Content-Range"] = f"bytes {start}-{end}/{size}"
    return Response(
        status_code=status, content=chunk, media_type=media_type, headers=response_headers,
    )
