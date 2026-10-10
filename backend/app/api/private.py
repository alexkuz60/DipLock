"""Приватные HTTP-ответы: без HTTP-кэша и без эха чувствительного ввода в 422.

Общий помощник роутеров с чувствительными данными (Консилиум, модельный
роутер ИИ): ошибка формы не должна возвращать `input`/`ctx` (там может быть
ключ API или текст добровольца), а ответы не кэшируются промежуточными
кэшами. Копипаста класса запрещена — берите `PrivateRoute` отсюда.
"""

from collections.abc import Callable, Coroutine
from typing import Any

from fastapi import Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute


class PrivateRoute(APIRoute):
    """Ошибка формы не эхо-передаёт чувствительный текст и не кэшируется."""

    def get_route_handler(self) -> Callable[[Request], Coroutine[Any, Any, Response]]:
        """Сохраняет обычный контракт ошибок loc/msg/type без input и ctx."""
        original = super().get_route_handler()

        async def handle(request: Request) -> Response:
            try:
                return await original(request)
            except RequestValidationError as exc:
                return JSONResponse(
                    status_code=422,
                    content={"detail": [
                        {key: error[key] for key in ("loc", "msg", "type")}
                        for error in exc.errors()
                    ]},
                    headers={"Cache-Control": "private, no-store"},
                )

        return handle