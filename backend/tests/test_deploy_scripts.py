"""Стражи деплоя (18.11.2026): скрипты и конфиги `deploy/` не расходятся с ВМ.

Проверки повторяют статические критерии приёмки: синтаксис bash, отсутствие
удалённого в MNE 1.13 вызова, открытый `/health`, ротация логов и пароль
`check.sh` только из окружения.
"""
import shutil
import subprocess
from pathlib import Path

_REPO = Path(__file__).resolve().parents[2]
_DEPLOY = _REPO / "deploy"


def test_deploy_scripts_are_valid_bash() -> None:
    """Все `deploy/*.sh` проходят `bash -n` (синтаксис без выполнения)."""
    scripts = sorted(_DEPLOY.glob("*.sh"))
    assert scripts, "в deploy/ нет скриптов"
    bash = shutil.which("bash") or "/bin/bash"
    for script in scripts:
        result = subprocess.run(  # noqa: S603 — список аргументов фиксирован, без shell
            [bash, "-n", str(script)], capture_output=True, text=True, check=False
        )
        assert result.returncode == 0, f"{script.name}: {result.stderr}"


def test_no_removed_mne_fsaverage_call() -> None:
    """Удалённый в MNE 1.13 вызов не вернулся в скрипты и README."""
    pattern = "fsaverage" + ".data_path"
    files = [*_DEPLOY.glob("*.sh"), _DEPLOY / "README.md", _REPO / "README.md"]
    offenders = [
        path.name
        for path in files
        if path.is_file() and pattern in path.read_text(encoding="utf-8")
    ]
    assert not offenders, f"вызов удалён в MNE 1.13: {offenders}"


def test_health_is_open_in_nginx() -> None:
    """`/health` открыт без basic auth и проксируется в приложение."""
    text = (_DEPLOY / "nginx.conf").read_text(encoding="utf-8")
    assert "location = /health" in text, "нет отдельного location для /health"
    block = text.split("location = /health", 1)[1].split("}", 1)[0]
    assert "auth_basic off;" in block, "/health остался под basic auth"
    assert "proxy_pass" in block, "/health без proxy_pass отдаст 404 из root"


def test_logrotate_config_present() -> None:
    """Ротация `server.log` — `copytruncate`: файл держит uvicorn."""
    text = (_DEPLOY / "logrotate-diplock").read_text(encoding="utf-8")
    assert "data/logs/*.log" in text
    assert "copytruncate" in text


def test_check_script_takes_password_from_env() -> None:
    """Пароль проверок — из env, не аргументом (аргументы видны в `ps`)."""
    text = (_DEPLOY / "check.sh").read_text(encoding="utf-8")
    assert "DIPLOCK_CHECK_PASSWORD" in text
