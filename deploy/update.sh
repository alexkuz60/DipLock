#!/bin/bash
# Обновление §8 deploy/README.md одной командой: код → зависимости → UI →
# перезапуск → проверки. Схема БД поднимается при старте (init_db → alembic
# до head в lifespan), ручной `alembic upgrade` не нужен.
# Запуск: ./deploy/update.sh [--dry-run]
set -euo pipefail

REPO_DIR="${DIPLOCK_REPO:-/srv/diplock/repo}"
DRY=0
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY=1
fi

run() {
  if (( DRY )); then
    printf '+ %s\n' "$*"
  else
    "$@"
  fi
}

cd "$REPO_DIR"
run git pull --ff-only
run backend/venv/bin/pip install -r backend/requirements.txt
run npm --prefix frontend ci
run npm --prefix frontend run build
run sudo systemctl restart diplock
run ./deploy/check.sh
