"""Экспорт OpenAPI-спецификации DipLock в JSON для генерации TS-типов UI (4.2).

Выгрузка лежит в ``frontend/src/shared/api/openapi.json`` и коммитится:
из неё фронтенд генерирует ``schema.d.ts`` (``cd frontend && npm run gen:api``),
а свежесть самого JSON ловит страж
``tests/test_api_contract.py::test_openapi_json_is_up_to_date`` — изменили
Pydantic-схему или роуты, но не перегенерировали — упал pytest.

Запуск из каталога backend/::

    venv/bin/python -m scripts.export_openapi            # запись в frontend/…
    venv/bin/python -m scripts.export_openapi out.json   # свой путь
"""
import argparse
import json
from pathlib import Path

# Каталог репозитория: scripts/ → backend/ → корень.
_REPO_ROOT = Path(__file__).resolve().parents[2]
_DEFAULT_OUT = _REPO_ROOT / "frontend" / "src" / "shared" / "api" / "openapi.json"


def main() -> None:
    """Пишет ``app.openapi()`` в JSON-файл (аргумент или путь по умолчанию)."""
    parser = argparse.ArgumentParser(description="Экспорт OpenAPI DipLock в JSON")
    parser.add_argument(
        "out",
        nargs="?",
        type=Path,
        default=_DEFAULT_OUT,
        help=f"куда записать (по умолчанию {_DEFAULT_OUT})",
    )
    args = parser.parse_args()

    # Импорт приложения — тяжёлый (MNE), поэтому после разбора аргументов:
    # --help работает без ожидания загрузки научного стека.
    from app.main import app

    spec = app.openapi()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        json.dumps(spec, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"OpenAPI → {args.out} ({len(spec.get('paths', {}))} путей)")


if __name__ == "__main__":
    main()
