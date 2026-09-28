#!/bin/bash
# Единый лаунчер DipLock: старт сервера + открытие UI в браузере.
#
# Подкоманды (по умолчанию — start):
#   ./start.sh            # поднять сервер (если уже поднят — только открыть UI)
#   ./start.sh stop       # остановить сервер по PID-файлу
#   ./start.sh status     # жив ли процесс и что отвечает /health
#
# Режим рабочий: uvicorn БЕЗ --reload (ярлык с рабочего стола, не dev-цикл).
# Правки backend видны в API только после ./start.sh stop && ./start.sh —
# признак устаревшего процесса: init-status.code.stale=true (см. AGENTS.md).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$ROOT/backend"
UVICORN="$BACKEND_DIR/venv/bin/uvicorn"
LOG_DIR="$ROOT/data/logs"
LOG_FILE="$LOG_DIR/server.log"
PID_FILE="$LOG_DIR/server.pid"
PORT="${DIPLOCK_PORT:-8000}"
BASE_URL="http://127.0.0.1:$PORT"
UI_URL="$BASE_URL/ui/"
HEALTH_TIMEOUT="${DIPLOCK_HEALTH_TIMEOUT:-30}"

# Жив ли процесс из PID-файла (проверка и pid, и что это наш uvicorn).
server_pid() {
  [[ -f "$PID_FILE" ]] || return 1
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null || return 1
  echo "$pid"
}

# Отвечает ли сервер на /health.
server_healthy() {
  curl -sf -m 2 "$BASE_URL/health" >/dev/null 2>&1
}

open_ui() {
  if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$UI_URL" >/dev/null 2>&1 || true
  else
    echo "xdg-open не найден — откройте вручную: $UI_URL"
  fi
}

cmd_start() {
  # Сервер уже жив — просто открываем UI (идемпотентный повторный клик).
  if server_pid >/dev/null && server_healthy; then
    echo "Сервер уже запущен (PID $(server_pid)), открываю $UI_URL"
    open_ui
    return 0
  fi
  # Мёртвый PID-файл (kill -9 / перезагрузка) — убираем.
  if [[ -f "$PID_FILE" ]] && ! server_pid >/dev/null; then
    echo "Устаревший PID-файл удалён: $PID_FILE"
    rm -f "$PID_FILE"
  fi

  if [[ ! -x "$UVICORN" ]]; then
    echo "Не найден $UVICORN" >&2
    echo "Создайте окружение: cd backend && python -m venv venv && venv/bin/pip install -r requirements.txt" >&2
    exit 1
  fi
  if [[ ! -f "$BACKEND_DIR/app/static/ui/index.html" ]]; then
    echo "ВНИМАНИЕ: сборка UI отсутствует (backend/app/static/ui) —" >&2
    echo "сначала выполните: cd frontend && npm install && npm run build" >&2
  fi

  mkdir -p "$LOG_DIR"
  echo "Старт uvicorn на $BASE_URL (лог: $LOG_FILE)"
  # Запуск из backend/ — там лежат .env и рабочие пути кэшей/БД.
  (
    cd "$BACKEND_DIR"
    nohup "$UVICORN" app.main:app --host 127.0.0.1 --port "$PORT" \
      >>"$LOG_FILE" 2>&1 &
    echo $! >"$PID_FILE"
  )

  # Ждём /health, затем открываем UI.
  local waited=0
  until server_healthy; do
    if ! server_pid >/dev/null; then
      echo "Сервер упал при старте — последние строки лога:" >&2
      tail -n 20 "$LOG_FILE" >&2 || true
      rm -f "$PID_FILE"
      exit 1
    fi
    if (( waited >= HEALTH_TIMEOUT )); then
      echo "Сервер не ответил за $HEALTH_TIMEOUT с — проверьте лог: $LOG_FILE" >&2
      exit 1
    fi
    sleep 1
    ((waited++)) || true
  done
  echo "Сервер готов (PID $(server_pid)), открываю $UI_URL"
  open_ui
}

cmd_stop() {
  local pid
  if ! pid="$(server_pid)"; then
    [[ -f "$PID_FILE" ]] && rm -f "$PID_FILE"
    echo "Сервер не запущен."
    return 0
  fi
  echo "Останавливаю сервер (PID $pid)…"
  kill "$pid" 2>/dev/null || true
  local waited=0
  while kill -0 "$pid" 2>/dev/null; do
    if (( waited >= 10 )); then
      echo "Процесс не завершился за 10 с — SIGKILL."
      kill -9 "$pid" 2>/dev/null || true
      break
    fi
    sleep 1
    ((waited++)) || true
  done
  rm -f "$PID_FILE"
  echo "Сервер остановлен."
}

cmd_status() {
  local pid
  if pid="$(server_pid)"; then
    echo "Процесс: жив (PID $pid)"
  else
    echo "Процесс: не запущен"
    return 0
  fi
  if server_healthy; then
    echo "Health:  $BASE_URL/health — ок"
    local init
    init="$(curl -sf -m 5 "$BASE_URL/init-status" 2>/dev/null | head -c 400 || true)"
    [[ -n "$init" ]] && echo "Init:    $init"
  else
    echo "Health:  $BASE_URL/health — нет ответа (сервер стартует или завис)"
  fi
  echo "UI:      $UI_URL"
  echo "Лог:     $LOG_FILE"
}

case "${1:-start}" in
  start)  cmd_start ;;
  stop)   cmd_stop ;;
  status) cmd_status ;;
  *)
    echo "Использование: $0 [start|stop|status]" >&2
    exit 2
    ;;
esac
