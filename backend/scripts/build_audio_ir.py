"""Прогрев кэша IR «Нейромузыки» (docs/rules/spatial-audio.md).

Генерирует все пресеты импульсных характеристик в ``cache_dir/ir/``, чтобы
первый запрос плеера не платил за расчёт (~10 мс на пресет — ленивая генерация
в роуте тоже работает, скрипт лишь убирает этот хвост из первого клика).

Запуск из каталога backend/:

    venv/bin/python -m scripts.build_audio_ir
"""
from app.services.audio_ir import cache_dir, warm_cache


def main() -> None:
    """Генерирует все пресеты и печатает, что легло в кэш."""
    ids = warm_cache()
    print(f"IR-пресеты в кэше {cache_dir()}:")
    for preset_id in ids:
        print(f"  - {preset_id}.wav")


if __name__ == "__main__":
    main()
