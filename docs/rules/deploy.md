# Публикация в Abacus AI Cloud

> Пошаговая инструкция — `deploy/README.md`. Здесь схема, инварианты и то, что
> меняется в коде. Локальный запуск (`./start.sh`, `127.0.0.1:8000`) не меняется.

## Схема

```
Интернет → HTTPS https://<id>.abacusai.cloud (TLS облака)
  → nginx: basic auth, client_max_body_size 210m, proxy_read_timeout 3600s
  → uvicorn 127.0.0.1:8000 (--workers 1, без --reload)
  → FastAPI: /api/v1/*, /ui/*, /health, /init-status
Постоянный диск: /srv/diplock/{repo,data}, ~/mne_data (fsaverage)
```

## Инварианты

- **Один воркер.** Реестр задач живёт в памяти, БД — SQLite, обход сирот
  выполняется при старте. `--workers > 1` разъедет историю задач и сирот.
- **Аутентификация — на nginx.** В приложении её нет: basic auth обязателен,
  иначе публичный URL отдаёт EDF, историю и журнал с путями. Файл паролей
  должен принадлежать пользователю nginx (`root:ubuntu` в облаке), иначе 500.
- **`listen 80 default_server` — у блока DipLock.** Ingress облака не передаёт
  `Host`, поэтому `server_name` не совпадает; у блока «READY» в
  `/etc/nginx/nginx.conf` `default_server` нужно снять.
- **Абсолютные пути.** `DATABASE_URL`, `UPLOAD_DIR`, `RESULTS_DIR`, `CACHE_DIR`,
  `ANALYTICS_DB_PATH`, `SERVER_PID_FILE` — на постоянном диске. Для SQLite —
  четыре слэша: `sqlite+aiosqlite:////srv/...`.
- **Данные раньше старта.** Сначала `data/edf` и `data/results`, потом первый
  запуск: иначе `sweep_orphans`/`drop_orphan_rows` удалят строки как сирот.
- **`data/cache` не переносится** — пересоздаётся, квота `CACHE_QUOTA_MB`.
- **`ENABLE_DOCS=false`** в облаке: `/docs` и `/openapi.json` не отдаются.
- **PID-файл и перезапуск.** `start.sh` пишет PID uvicorn; systemd `Type=forking`
  + `PIDFile` сохраняют кнопку «Перезапустить бэкенд» (`os.execv`, PID не меняется).

## Что меняется в коде

- `start.sh` — `DIPLOCK_HOST`, `DIPLOCK_NO_BROWSER`, `--workers 1`,
  `--proxy-headers`, health всегда на loopback.
- `backend/app/core/config.py` — `enable_docs` (дефолт `true`).
- `backend/app/main.py` — `_docs_kwargs(settings)` для `FastAPI(...)`;
  `init-status.api.docs_url` пустой при выключенной документации; проверка
  fsaverage только по `settings.subjects_dir` (без хардкода `~/mne_data`).
- `deploy/` — `nginx.conf`, `diplock.service`, `cloud-setup.sh`, `README.md`.
- `backend/.env.example` — закомментированный cloud-блок.

## Проверка

```bash
curl -fsS https://<id>.abacusai.cloud/health
curl -fsS -u diplock:<pass> https://<id>.abacusai.cloud/init-status \
  | jq '{status, checks, sources, stale: .code.stale}'
curl -fsS -u diplock:<pass> -o /dev/null -w '%{http_code}\n' \
  https://<id>.abacusai.cloud/ui/
```

Ожидаемо: `checks` все `ready`, `sources.bem`/`sources.transform` не `missing`,
`code.stale=false`, `/ui/` → 200, загрузка EDF → 201, задача → `done`.
