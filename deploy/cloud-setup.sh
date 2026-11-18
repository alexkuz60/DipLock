#!/bin/bash
# Идемпотентная подготовка облачной среды DipLock (этапы 2-4 deploy/README.md).
# Запуск: ./deploy/cloud-setup.sh  (apt — через sudo, venv/npm — от пользователя).
set -euo pipefail

REPO_DIR="${DIPLOCK_REPO:-/srv/diplock/repo}"
PYTHON="${DIPLOCK_PYTHON:-python3.12}"

if [[ ! -d "$REPO_DIR/backend" ]]; then
  echo "Нет $REPO_DIR/backend — сначала склонируйте репозиторий" >&2
  exit 1
fi

SUDO=""
if [[ "$(id -u)" -ne 0 ]]; then
  SUDO="sudo"
fi

echo "== Пакеты =="
$SUDO apt-get update
$SUDO apt-get install -y python3.12-venv python3.12-dev build-essential \
  nginx apache2-utils curl jq sqlite3 rsync libsndfile1

echo "== Python venv =="
if [[ ! -x "$REPO_DIR/backend/venv/bin/python" ]]; then
  "$PYTHON" -m venv "$REPO_DIR/backend/venv"
fi
"$REPO_DIR/backend/venv/bin/pip" install --upgrade pip
"$REPO_DIR/backend/venv/bin/pip" install -r "$REPO_DIR/backend/requirements.txt"

echo "== FSAverage =="
# MNE 1.13 убрал старый загрузчик mne.datasets.fsaverage — загрузка через
# fetch_fsaverage, аргумент обязан быть Path (внутри вызывается .expanduser()).
# Каталог — тот же, что settings.subjects_dir: SUBJECTS_DIR из окружения, иначе
# ~/mne_data/MNE-fsaverage-data. Шаг идёт раньше backend/.env (README §2 и §4),
# поэтому env запуска — единственный источник пути.
"$REPO_DIR/backend/venv/bin/python" -c \
  "from pathlib import Path; import os; import mne; \
mne.datasets.fetch_fsaverage(subjects_dir=Path(os.environ.get('SUBJECTS_DIR') or Path.home() / 'mne_data' / 'MNE-fsaverage-data'))"

echo "== UI =="
if command -v npm >/dev/null 2>&1; then
  (cd "$REPO_DIR/frontend" && npm ci && npm run build)
else
  echo "npm не найден — установите Node 22 и повторите сборку UI" >&2
  exit 1
fi

echo "Готово. Дальше: backend/.env, nginx, systemd — deploy/README.md"
