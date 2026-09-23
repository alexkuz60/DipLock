# Артефакты ЭЭГ: каталог видов, правило BAD_, QC и MNE-only-очистка

> Правило поиска, чисел QC и базового удаления артефактов. Источник критериев —
> PDF «Артефакты ЭЭГ» и стратегия `docs/strategy/01-signal-quality.md`.

## Каталог видов (11) и правило BAD_

`ArtifactKind` (`schemas/analysis.py`) = `ARTIFACT_KINDS` (`shared/lib/artifacts.ts`) =
ключи `artifact_types` (открытый словарь `dict[str, int]` — новый детектор не ломает контракт):

| reject-виды (роняют эпохи) | информационные (зоны UI/QC, эпоху не трогают) |
|---|---|
| `zscore_outlier`, `peak_to_peak`, `flat_line`, `clipping`, `break`, `electrode_pop` | `muscle_emg`, `line_noise`, `ocular`, `ecg`, `ica_eog` |

**Правило BAD_** (`artifact_detector.EPOCH_REJECT_KINDS`, докстринг модуля):
аннотации с префиксом `BAD_` (и только reject-виды) попадают в raw и роняют эпохи
через `reject_by_annotation` (N6). Информационные виды в аннотации **не попадают
вовсе** — инвариант держит `test_bad_rule_annotations_only_reject_kinds`.
Добавили вид — пополнили `ANNOTATION_DESC` (только если reject) и каталоги выше.

## Детекторы (MNE/NumPy/SciPy only, без новых зависимостей)

* `zscore_outlier` — robust z (медиана/MAD, M11): выброс не тянет порог за собой;
* `peak_to_peak` — размах в окне 2 с (геометрия зоны историческая — центр окна);
* `flat_line` / `clipping` — размах в окне `flat_line_window_ms` < порога: у края
  диапазона канала (доля отсчётов у rails ≥ `clipping_share`) — клиппинг, иначе —
  плоская линия (PDF: «эпизоды клиппинга» отделены от «нулевой активности»);
* `break` — NaN/inf-участки длиннее `break_min_duration_ms`;
* `electrode_pop` — ступенька ≥ `pop_step_uv` с возвратом ≤ 0.5 с;
* `muscle_emg` — `mne.preprocessing.annotate_muscle_zscore` **по каналу** (MNE
  усредняет z-power по монтажу и пропускает локальный всплеск); короче
  `muscle_min_duration_ms` — не эпизод;
* `line_noise` — свой Welch-PSD: канал помечается по **основной** гармонике
  50/60 Гц (пик/фон ≥ `line_noise_ratio`), зоны — по загрязнённым гармоникам
  1…4; `stats["line_noise_level"]` — максимальное отношение пик/фон (QC);
* `ocular` — медленные волны Fp1/Fp2 (прокси EOG), robust z сглаженного 200 мс;
* `ecg` — QRS-пики T7/T8 (5–20 Гц), ритм подтверждается по IBI;
* `ica_eog` — `run_ica` стадии `artifacts` **ищет** EOG-компоненты (счётчик
  `by_type.ica_eog` — их число, для остальных видов счётчик = числу зон).

Пороги — из `core/config.py` (в `/meta` → `artifact_thresholds`); стадия передаёт
детектору копию конфига со своими значениями (`preprocess._detect`).

## Числа QC (стадия `artifacts`)

`qc_summary`: `good_data_percent` (100 − средняя по каналам доля времени в зонах
`QC_TIME_KINDS`; `ica_eog`/`line_noise` не считаются временем), `artifact_share_by_kind`,
`line_noise_level`, `bad_channels` (авто: robust z «шумности» канала + мёртвые
константы, `find_bad_channels`). Панель — плашки в легенде артефактов; авто-список
bad-каналов кнопкой подставляется в опцию интерполяции.

## Очистка (стадия `filter`, MNE-only)

Параметры очистки — стадия `filter` (`PreprocessParams`/форма): `notch_harmonics`,
`bad_channels`, `interpolate_bads`, `clean_method: none | ica | ssp`,
`ica_n_components` (0 — auto). Золотой порядок (`services/artifact_cleaner.py`,
PDF «используйте интерполяцию после поиска плохих каналов и до ICA/SSP»):

1. гармоники notch (50/60 → 100/150/200/240 Гц);
2. пометка bad-каналов; 3. **их интерполяция**;
4. `ica.apply` (удаление EOG/ECG-компонент, прокси T7/T8; отчёт — сколько и какие)
   либо SSP (`compute_proj_eog`, **экспериментально**, UI предупреждает: проекторы
   необратимы). Отчёт «до/после» — p95 |x| по монтажу (`CleanReportOut`).

Вне скоупа: ASR (`asrpy`), `autoreject`, `mne-icalabel` (N12/N13) — новые
зависимости не добавляем.

## Границы и кэш

* Очистка входит в ключ кэша подготовленного сигнала (`CleanSpec`, N5/A4):
  очищенный сигнал кэшируется отдельно, стадии `artifacts`/`epochs` с теми же
  параметрами получают его же.
* Спектр, спектрограмма и быстрый расчёт диполей вызывают `prepared_raw` **без**
  `clean` — они считаются на неочищенном подготовленном сигнале (граница задокументирована,
  расширение — отдельная задача).
* MNE API дрейфует: `annotate_muscle_zscore` в MNE 1.13 отдаёт **кортеж**
  (аннотации, scores), `ICA(random_state=...)` — именованный аргумент (см. также
  `docs/rules/safety.md`).

Тесты: `test_artifact_detector.py` (детекторы, BAD_, bad-каналы, QC),
`test_artifact_cleaner.py` (порядок очистки, отчёты), `test_preprocess.py`
(интеграция стадий), `test_api_params.py` (валидация формы).