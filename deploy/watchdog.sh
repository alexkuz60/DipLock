#!/bin/bash
# Сторож доступности (B4): опрашивает /health и пишет в журнал, когда сервис
# не отвечает. Внешний сервис не нужен — cron на самой ВМ; канал оповещения
# подключается переменной DIPLOCK_ALERT_WEBHOOK (POST с текстом в теле).
# Запуск: ./deploy/watchdog.sh   (расписание — cron, пример в deploy/README.md §11)
# Переменные: DIPLOCK_CHECK_URL, DIPLOCK_WATCHDOG_LOG, DIPLOCK_ALERT_WEBHOOK.
set -uo pipefail

BASE="${DIPLOCK_CHECK_URL:-https://diplock.abacusai.cloud}"
LOG="${DIPLOCK_WATCHDOG_LOG:-/srv/diplock/repo/data/logs/watchdog.log}"
HOOK="${DIPLOCK_ALERT_WEBHOOK:-}"
STAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

mkdir -p "$(dirname "$LOG")" 2>/dev/null || true

# Тело ответа читаем целиком: 200 от чужой страницы (READY-заглушка nginx)
# не должен считаться здоровьем приложения.
BODY="$(curl -s --max-time 20 -w '\n%{http_code}' "$BASE/health" 2>/dev/null)"
CODE="${BODY##*$'\n'}"
PAYLOAD="${BODY%$'\n'*}"

if [[ "$CODE" == "200" ]] && grep -q '"status"' <<<"$PAYLOAD"; then
  exit 0
fi

LINE="$STAMP FAIL $BASE/health code=${CODE:-none} body=$(head -c 200 <<<"$PAYLOAD" | tr '\n' ' ')"
echo "$LINE" >>"$LOG"

if [[ -n "$HOOK" ]]; then
  # Текст уходит телом, не в URL: адрес хука не попадает в журнал и в `ps`.
  curl -s --max-time 15 -X POST -H 'Content-Type: text/plain' \
    --data-binary "$LINE" "$HOOK" >/dev/null 2>&1 || true
fi

echo "$LINE" >&2
exit 1
