# Публикация DipLock в Abacus AI Cloud

Инструкция для облачной среды Abacus AI (Ubuntu, постоянный диск, публичный
HTTPS-адрес `https://<id>.abacusai.cloud`). Локальный запуск не меняется:
`./start.sh` по-прежнему слушает `127.0.0.1:8000`.

## Схема

```
Интернет
  → HTTPS https://<id>.abacusai.cloud  (TLS облака)
  → nginx: basic auth, client_max_body_size 210m, proxy_read_timeout 3600s
  → uvicorn 127.0.0.1:8000  (--workers 1, без --reload)
  → FastAPI: /api/v1/*, /ui/*, /health, /init-status
Постоянный диск: /srv/diplock/{repo,data}, ~/mne_data (fsaverage)
```

Один воркер обязателен: реестр задач живёт в памяти, БД — SQLite, обход сирот
выполняется при старте. Горизонтальное масштабирование без внешней очереди и
PostgreSQL сломает историю задач.

## 0. Разведка среды

```bash
df -h
python3 --version
ps -p 1 -o comm=
nginx -v && nginx -T 2>/dev/null | head -40
systemctl is-system-running 2>/dev/null || true
free -h && nproc
```

Нужно: Python 3.12, ≥ 3 ГБ свободного места, понятный владелец порта 80/443.
Точный путь конфига nginx в облаке не зафиксирован — ищите через `nginx -T`.

## 1. Код на постоянный диск

```bash
sudo mkdir -p /srv/diplock && sudo chown "$USER":"$USER" /srv/diplock
git clone <repo-url> /srv/diplock/repo
```

Репозиторий должен лежать на постоянном диске: иначе после перезапуска среды
исчезнут код, `.env` и `data/`.

## 2. Пакеты, venv, fsaverage, UI

```bash
cd /srv/diplock/repo
./deploy/cloud-setup.sh
```

Скрипт ставит `python3.12-venv`, `nginx`, `apache2-utils`, `libsndfile1`,
создаёт `backend/venv`, скачивает fsaverage (~762 МБ) и собирает UI в
`backend/app/static/ui`. Node 22 должен быть установлен заранее.

## 3. Данные

Порядок важен: сначала данные, потом первый старт. Иначе `sweep_orphans` и
`drop_orphan_rows` удалят строки и файлы задач как сирот.

С локальной машины при остановленном сервере:

```bash
rsync -av data/edf/ user@cloud:/srv/diplock/repo/data/edf/
rsync -av data/results/ user@cloud:/srv/diplock/repo/data/results/
rsync -av data/backups/ user@cloud:/srv/diplock/repo/data/backups/   # опционально
rsync -av data/analytics.db user@cloud:/srv/diplock/repo/data/analytics.db  # опционально

sqlite3 backend/diplock.db "PRAGMA wal_checkpoint(TRUNCATE);"
rsync -av backend/diplock.db user@cloud:/srv/diplock/repo/data/diplock.db

scp data/llm_router.json user@cloud:/srv/diplock/repo/data/llm_router.json
ssh user@cloud 'chmod 600 /srv/diplock/repo/data/llm_router.json'
```

Не переносить: `data/cache` (пересоздаётся), `data/logs`, `venv`,
`node_modules`, `data/protocols`, личные срезы `audits/`.

VAMP опционален: без `tools/sonic-annotator/sonic-annotator` и `~/vamp`
«ЕмоЛаб»/«Нейромузыка» теряют карты аккордов и темпа, но расчёт не падает.

## 4. `backend/.env`

Скопируйте `backend/.env.example` в `backend/.env` и раскомментируйте
cloud-блок. Минимум:

```dotenv
ENABLE_DOCS=false
DATABASE_URL=sqlite+aiosqlite:////srv/diplock/repo/data/diplock.db
UPLOAD_DIR=/srv/diplock/repo/data/edf
RESULTS_DIR=/srv/diplock/repo/data/results
CACHE_DIR=/srv/diplock/repo/data/cache
ANALYTICS_DB_PATH=/srv/diplock/repo/data/analytics.db
SERVER_PID_FILE=/srv/diplock/repo/data/logs/server.pid
SUBJECTS_DIR=/home/<user>/mne_data/MNE-fsaverage-data
FSAVERAGE_TRANS=/home/<user>/mne_data/MNE-fsaverage-data/fsaverage/bem/fsaverage-trans.fif
CORS_ORIGINS=https://<id>.abacusai.cloud
MAX_CONCURRENT_JOBS=1
PREPARED_SIGNAL_CACHE_SIZE=1
CACHE_QUOTA_MB=4096
DIPOLE_FIT_N_JOBS=1
DIPOLE_REFINE_N_JOBS=1
```

`DATABASE_URL` для SQLite — четыре слэша перед абсолютным путём. Относительные
пути зависят от CWD и после перезапуска среды могут уехать в другое место.

## 5. nginx и basic auth

```bash
sudo htpasswd -c /etc/nginx/.htpasswd diplock
# nginx в облаке работает под `user ubuntu` (nginx.conf, строка 1), не www-data:
sudo chown root:ubuntu /etc/nginx/.htpasswd && sudo chmod 640 /etc/nginx/.htpasswd
sudo cp deploy/nginx.conf /etc/nginx/conf.d/diplock.conf
sudo nginx -t && sudo systemctl reload nginx
```

Две ловушки облачной установки, проверенные 17.11.2026:

- **`default_server`.** В `/etc/nginx/nginx.conf` уже есть `listen 80 default_server`
  с `root /var/www/html` (страница «READY»). Ingress не передаёт заголовок
  `Host`, поэтому совпадения по `server_name` нет и выигрывает этот блок:
  снаружи отдавалось «READY», а `/health` и `/ui/` — 404. Лечение: снять
  `default_server` у блока «READY» (`sed -i '37s/listen 80 default_server;/listen 80;/'`,
  с бэкапом) и поставить его нашему блоку — в `deploy/nginx.conf` он уже стоит.
- **Права `htpasswd`.** При `root:www-data` nginx пишет в `error.log`
  `open() "/etc/nginx/.htpasswd" failed (13: Permission denied)` и отдаёт 500
  на все пути. Владелец должен быть `root:ubuntu`.

Если облачный прокси уже слушает 80/443, добавьте `location` в его `server`
или поднимите этот server на отдельном порту (например, `listen 8080`) и
направьте облачный прокси туда. `client_max_body_size` обязателен: дефолтный
1 МБ сломает загрузку EDF. `proxy_read_timeout` обязателен: дефолтные 60 с
оборвут синхронный `/analyze`.

## 6. Супервизор

systemd:

```bash
sudo cp deploy/diplock.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now diplock
```

`Type=forking` + `PIDFile` сохраняют кнопку «Перезапустить бэкенд»: `start.sh`
пишет PID uvicorn, `server_control` делает `os.execv`, PID не меняется.

Если systemd в среде нет — `supervisord`:

```ini
[program:diplock]
command=/srv/diplock/repo/start.sh start
environment=DIPLOCK_HOST="127.0.0.1",DIPLOCK_PORT="8000",DIPLOCK_NO_BROWSER="1"
autostart=true
autorestart=true
```

Либо `nohup` + `crontab @reboot`:

```bash
DIPLOCK_NO_BROWSER=1 /srv/diplock/repo/start.sh start
```

## 7. Проверка

```bash
curl -fsS https://<id>.abacusai.cloud/health
curl -fsS -u diplock:<pass> https://<id>.abacusai.cloud/init-status \
  | jq '{status, checks, sources, stale: .code.stale, ui}'

curl -fsS -u diplock:<pass> -o /dev/null -w '%{http_code}\n' \
  https://<id>.abacusai.cloud/ui/

curl -fsS -u diplock:<pass> -F "file=@data/edf/test.edf" \
  https://<id>.abacusai.cloud/api/v1/recordings
curl -fsS -u diplock:<pass> -X POST -F "stage=filter" \
  https://<id>.abacusai.cloud/api/v1/recordings/<id>/preprocess
```

Ожидаемо: `checks` все `ready`, `sources.bem`/`sources.transform` не `missing`,
`code.stale=false`, `/ui/` → 200, загрузка → 201, задача доходит до `done`.
После `POST /api/v1/server/restart` (202) меняется
`code.server_started_at`, история задач сохраняется.

## 8. Обновление

```bash
cd /srv/diplock/repo
git pull
backend/venv/bin/pip install -r backend/requirements.txt
(cd frontend && npm ci && npm run build)
sudo systemctl restart diplock
```

Правки backend видны только после перезапуска процесса; признак старого кода —
`init-status.code.stale=true`.

## 9. Ограничения

- Аутентификация — только nginx basic auth; в приложении её нет.
- Один воркер uvicorn; SQLite; без внешней очереди задач.
- 2 vCPU / 8 ГБ по документации SuperComputer; фактические лимиты проверяйте
  в среде. `MAX_CONCURRENT_JOBS=1`, `DIPOLE_*_N_JOBS=1`.
- GPU не ускоряет `mne.fit_dipole`; включайте только после проверки драйверов.
- EDF — персональные данные: basic auth не заменяет правовую оценку и согласие.
- При отмене подписки диск хранится 30 дней — это не бэкап.
