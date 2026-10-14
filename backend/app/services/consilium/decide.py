"""Общий слой решающего классификатора (Jev, маршрут ``decide``).

Совместно используется триажем досье (§5.2) и разметкой Jev (§5.3):
маршрут decide модельного роутера должен быть назначен и включён — иначе
честный 400 с подсказкой для UI; числовые поля типизированных ответов
читаются строго без достройки (пробел остаётся пробелом).
"""

from typing import Any

from app.schemas.consilium import ConsiliumSnapshot
from app.services import llm_router
from app.services.consilium import rounds, store


def dossier_state(snapshot: ConsiliumSnapshot) -> tuple[str, list[str]]:
    """State решающего классификатора: вопрос дела и дайджест снимка.

    Дайджест переиспользуется из раундов (``rounds.build_digest``): контекст
    без ``use_with_advisers`` не уходит наружу, сокращения подписаны.
    """
    digest, warnings = rounds.build_digest(snapshot)
    return f"Вопрос исследования: {snapshot.question}\n\nДосье:\n{digest}", warnings


async def decide_target() -> str:
    """Маршрут decide роутера: подпись строки результата; без маршрута — честный 400."""
    state = await llm_router.get_state()
    provider_id = state.routes.get("decide")
    if not provider_id:
        raise store.ConsiliumError(
            400,
            "Маршрут решающего классификатора не назначен — настройте модельный "
            "роутер в разделе «Настройки» (protocol=systemone)",
        )
    provider = next((item for item in state.providers if item.id == provider_id), None)
    if provider is None:
        raise store.ConsiliumError(400, "Провайдер маршрута не найден — проверьте модельный роутер")
    if not provider.enabled:
        raise store.ConsiliumError(400, "Провайдер маршрута выключен — включите его в настройках")
    return f"{provider.id}/{provider.model}"


def number(item: dict[str, Any] | None, key: str) -> float | None:
    """Числовое поле решения; отсутствующее/не-число — None, не достраиваем."""
    if not isinstance(item, dict):
        return None
    value = item.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def in_range(value: float | None, low: float, high: float) -> float | None:
    """Значение вне честных границ шкалы не сохраняется — предупреждение выше."""
    if value is None or not (low <= value <= high):
        return None
    return value