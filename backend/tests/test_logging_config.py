"""Конфигурация логирования (N29, шаг 0.1): logger.info сервисов слышно.

До исправления root-logger не имел handlers, а эффективный уровень ``app.*``
был WARNING — все ``logger.info`` пропадали (замер 19.09.2026:
``root handlers = []``, уровень 30).
"""
import logging


def test_app_loggers_emit_info_after_main_import(caplog):
    """Импорт app.main настраивает логирование: INFO из app.* доходит до handlers."""
    import app.main  # noqa: F401 — импорт и есть объект проверки

    assert logging.getLogger().handlers, "у root-logger должен быть хотя бы один handler"
    assert logging.getLogger("app").getEffectiveLevel() <= logging.INFO

    service_logger = logging.getLogger("app.services.artifact_detector")
    service_logger.info("INFO-THIS-MUST-BE-VISIBLE")
    assert any(
        "INFO-THIS-MUST-BE-VISIBLE" in record.getMessage() for record in caplog.records
    ), "logger.info из app.* обязан доходить до handlers (N29)"


def test_log_level_comes_from_settings():
    """Уровень логирования — настройка, а не константа в коде."""
    from app.core.config import settings

    assert settings.log_level == "INFO"
    overridden = settings.model_copy(update={"log_level": "DEBUG"})
    assert overridden.log_level == "DEBUG"
