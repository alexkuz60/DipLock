#!/bin/bash
# Проверки §7 deploy/README.md одной командой.
# Пароль — только из env DIPLOCK_CHECK_PASSWORD: аргумент командной строки
# виден в `ps` и попадает в историю оболочки.
# Переменные: DIPLOCK_CHECK_URL, DIPLOCK_CHECK_USER, DIPLOCK_CHECK_PASSWORD.
set -uo pipefail

BASE="${DIPLOCK_CHECK_URL:-https://diplock.abacusai.cloud}"
USER_NAME="${DIPLOCK_CHECK_USER:-diplock}"
PASS="${DIPLOCK_CHECK_PASSWORD:-}"
FAILED=0

code() { curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$@"; }

expect() { # expect <ожидаемый код> <описание> <аргументы curl...>
  local want="$1" what="$2" got
  shift 2
  got="$(code "$@")"
  if [[ "$got" == "$want" ]]; then
    printf 'OK   %-32s %s\n' "$what" "$got"
  else
    printf 'FAIL %-32s %s (ожидался %s)\n' "$what" "$got" "$want"
    FAILED=1
  fi
}

echo "== $BASE =="
# /health открыт для мониторинга (location = /health, auth_basic off).
expect 200 '/health без пароля' "$BASE/health"
# Всё остальное — под basic auth.
expect 401 '/ui/ без пароля' "$BASE/ui/"
expect 401 '/api/v1/meta без пароля' "$BASE/api/v1/meta"
# Схема API выключена (ENABLE_DOCS=false).
expect 404 '/docs' "$BASE/docs"
expect 404 '/openapi.json' "$BASE/openapi.json"

if [[ -n "$PASS" ]]; then
  expect 200 '/ui/ с паролем' -u "$USER_NAME:$PASS" "$BASE/ui/"
  expect 200 '/api/v1/meta с паролем' -u "$USER_NAME:$PASS" "$BASE/api/v1/meta"
  expect 200 '/init-status с паролем' -u "$USER_NAME:$PASS" "$BASE/init-status"
else
  echo "SKIP проверки с паролем: не задан DIPLOCK_CHECK_PASSWORD"
fi

if (( FAILED )); then
  echo "ИТОГ: есть расхождения"
  exit 1
fi
echo "ИТОГ: все проверки совпали"
