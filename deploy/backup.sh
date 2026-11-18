#!/bin/bash
# Снимок данных DipLock для восстановления на чистой ВМ (deploy/README.md §10).
# Живую SQLite-базу копируем только через `.backup`: cp WAL-базы неконсистентен.
# Запуск: ./deploy/backup.sh   (расписание — cron, B2: решает владелец)
# Переменные: DIPLOCK_REPO, DIPLOCK_BACKUP_DIR, DIPLOCK_BACKUP_KEEP.
set -euo pipefail

REPO_DIR="${DIPLOCK_REPO:-/srv/diplock/repo}"
BACKUP_DIR="${DIPLOCK_BACKUP_DIR:-$REPO_DIR/data/backups}"
KEEP="${DIPLOCK_BACKUP_KEEP:-7}"
STAMP="$(date +%Y%m%d-%H%M%S)"
DB="$REPO_DIR/data/diplock.db"
DB_SNAPSHOT="$BACKUP_DIR/diplock-$STAMP.db"
ARCHIVE="$BACKUP_DIR/diplock-$STAMP.tar.gz"

command -v sqlite3 >/dev/null 2>&1 || { echo "нет sqlite3 — установите пакет sqlite3" >&2; exit 1; }
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

# 1. База: только .backup — консистентный снимок WAL-базы на живой системе.
if [[ -f "$DB" ]]; then
  sqlite3 "$DB" ".backup '$DB_SNAPSHOT'"
  chmod 600 "$DB_SNAPSHOT"
  echo "БД: $(basename "$DB_SNAPSHOT") $(du -h "$DB_SNAPSHOT" | cut -f1) integrity=$(sqlite3 "$DB_SNAPSHOT" 'PRAGMA integrity_check;')"
else
  echo "БД не найдена: $DB (снимок пропущен)" >&2
fi

# 2. Данные и секреты: архив только из существующих путей.
ITEMS=()
for item in data/edf data/results backend/.env data/llm_router.json; do
  if [[ -e "$REPO_DIR/$item" ]]; then
    ITEMS+=("$item")
  fi
done
if (( ${#ITEMS[@]} )); then
  tar -czf "$ARCHIVE" -C "$REPO_DIR" "${ITEMS[@]}"
  chmod 600 "$ARCHIVE"   # внутри backend/.env и data/llm_router.json
  echo "Архив: $(basename "$ARCHIVE") $(du -h "$ARCHIVE" | cut -f1) путей=${#ITEMS[@]}"
else
  echo "нечего архивировать: нет data/edf, data/results, backend/.env, data/llm_router.json" >&2
fi

# 3. Ротация: последние KEEP снимков каждого вида.
for pattern in 'diplock-*.db' 'diplock-*.tar.gz'; do
  mapfile -t files < <(ls -1t "$BACKUP_DIR"/$pattern 2>/dev/null || true)
  for old in "${files[@]:KEEP}"; do
    rm -f -- "$old"
    echo "удалён старый: $(basename "$old")"
  done
done
