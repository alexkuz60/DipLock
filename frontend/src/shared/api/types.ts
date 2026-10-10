/**
 * Типы контракта API DipLock.
 *
 * Источник истины — Pydantic-схемы бэкенда (`backend/app/schemas/`): они
 * попадают в OpenAPI, из выгрузки `openapi.json` генерируется `schema.d.ts`
 * (`cd frontend && npm run gen:api`; саму выгрузку обновляет
 * `backend/venv/bin/python -m scripts.export_openapi`, свежесть обоих файлов
 * ловят тесты). Большинство типов здесь — алиасы `components['schemas']` с
 * привычными UI именами (сервер часто именует иначе: `ChannelQc` ←
 * `ChannelQcOut`); полностью ручными остаются только типы, которых в API нет
 * (состояние UI и сырой dict `/init-status`).
 */
import type { components } from './schema'

type Schemas = components['schemas']

/** Основание Консилиума: серверный контракт, UI появится отдельным срезом. */
export type ConsiliumCase = Schemas['ConsiliumCaseOut']
export type ConsiliumCaseCreate = Schemas['ConsiliumCaseCreate']
export type ConsiliumCaseUpdate = Schemas['ConsiliumCaseUpdate']
export type ConsiliumCasesPage = Schemas['ConsiliumCasesPage']
export type ConsiliumContext = Schemas['ConsiliumContextOut']
export type ConsiliumContextCreate = Schemas['ConsiliumContextCreate']
export type ConsiliumContextUpdate = Schemas['ConsiliumContextUpdate']
export type ConsiliumContextPage = Schemas['ConsiliumContextPage']
export type ConsiliumMessage = Schemas['ConsiliumMessageOut']
export type ConsiliumMessageCreate = Schemas['ConsiliumMessageCreate']
export type ConsiliumMessageUpdate = Schemas['ConsiliumMessageUpdate']
export type ConsiliumMessagesPage = Schemas['ConsiliumMessagesPage']
export type ConsiliumDeletionPreview = Schemas['ConsiliumDeletionPreview']

/** Статусы фоновой задачи: поле `status` схемы `JobStatus` */
export type JobState = Schemas['JobStatus']['status']

export type TrajectoryPoint = Schemas['TrajectoryPoint']

export type DipoleFit = Schemas['DipoleFit']

export type BestFitDipole = Schemas['BestFitDipole']

/** Одна эпоха нарезки: окно, флаг отбраковки и мощности по диапазонам (F21) */
export type EpochSummary = Schemas['EpochSummary']

/** «Нейромузыка»: запуск рендера (202) и его статус для прогресс-бара */
export type AudioRenderStart = Schemas['AudioRenderStart']
export type AudioRenderStatus = Schemas['AudioRenderStatus']
/** Вариант рендера: «Экспресс» (7 треков L/C/R) ↔ «Монтаж» (4 ряда × полосы) */
export type AudioRenderVariant = 'express' | 'montage'
/** «Нейромузыка»: 3D-bake (spatial-audio, п.3) — запуск и статус запекания */
export type AudioBakeStart = Schemas['AudioBakeStart']
export type AudioBakeStatus = Schemas['AudioBakeStatus']
/** «Нейромузыка»: кадры радара «Эмо» — 7 лучей по кадрам спектра микса */
export type AudioEmo = Schemas['AudioEmoOut']
export type AudioEmoFrame = Schemas['AudioEmoFrame']
export type AudioKeySegment = Schemas['AudioKeySegment']

/** Оценка темпа микса (VAMP Tempo and Beat Tracker, `tempo_track` кадров «Эмо») */
export type AudioTempoSegment = Schemas['AudioTempoSegment']

/** «Нейромузыка»: каталог IR-пресетов реверберации и один пресет (spatial-audio) */
export type AudioIrCatalog = Schemas['AudioIrCatalogOut']
export type AudioIrPreset = Schemas['AudioIrPresetOut']

export type ArtifactKind = import('@/shared/lib/artifacts').ArtifactKind

/** Счётчики артефактов по типам (ключи — `ArtifactKind`, их может стать больше) */
export type ArtifactTypes = Partial<Record<import('@/shared/lib/artifacts').ArtifactKind, number>>

/** Стадия предподготовки записи (срез 2.7) — совпадает с `RecalcStage` в UI */
export type PreprocessStage = 'filter' | 'artifacts' | 'epochs'

/**
 * Слой видимости треков вьюера (`GET /recordings/{id}/signals?layer=`, шаг 2
 * плана «слои видимости»): `raw` — сырая пирамида (N14), `cleaned` —
 * подготовленный сигнал расчётов, `diff` — вклад очистки (без очистки − с
 * очисткой) на подготовленной базе, `band` — персист подготовленного массива
 * по именованной полосе `band_key` (Фаза B).
 */
export type SignalLayer = 'raw' | 'cleaned' | 'diff' | 'band'

/**
 * Параметры подготовленной базы слоёв `cleaned`/`diff`: плоская проекция
 * формы стадии «Фильтр и референс» в query (те же имена, что у `/preprocess`).
 * Для `raw` не передаются — сырой слой параметров не читает. Слой `band`
 * берёт только `band_key` (+ notch/референс): числовая полоса и опции
 * очистки с ним несовместны — сервер отвечает 400 (Фаза B).
 */
export type SignalsPrepQuery = {
  band_min?: number
  band_max?: number
  /** Ключ полосы для слоя `band`: один из `freq_bands`/`functional_bands` */
  band_key?: string
  notch_hz?: number
  /** Каналы референса через запятую; без них сервер считает average */
  reference_channels?: string
  notch_harmonics?: number
  /** Плохие каналы через запятую («C3,T7») */
  bad_channels?: string
  interpolate_bads?: boolean
  clean_method?: string
  ica_n_components?: number
  /** Отменённые зоны вклада чистки через запятую («clean-1, clean-2», шаг 2) */
  exclude_zone_ids?: string
}

export type ArtifactZoneOut = Schemas['ArtifactZoneOut']

export type EpochRejectOut = Schemas['EpochRejectOut']

/** QC-строка канала (шаг 0.4 + расширение 2.2): зоны, SNR, мёртвый канал */
export type ChannelQc = Schemas['ChannelQcOut']

export type CleanReport = Schemas['CleanReportOut']

export type HeartRateOut = Schemas['HeartRateOut']

export type PreprocessResult = Schemas['PreprocessResult']

export type FilterResponse = Schemas['FilterResponseOut']

export type MainsResponse = Schemas['MainsOut']

export type SpectrumBandOut = Schemas['SpectrumBandOut']

export type SpectrumPeakOut = Schemas['SpectrumPeakOut']

export type SpectrumResult = Schemas['SpectrumResult']

/**
 * Дифференциальный анализ двух записей (B9, задача «Сравнение»): дельты по
 * полосам (B − A), статистика кластерного теста MNE и ссылки на карты разности.
 */
export type CompareResult = Schemas['CompareResult']

export type CompareBand = Schemas['CompareBandOut']

export type CompareCluster = Schemas['CompareClusterOut']

// — Групповой анализ (остаток 4.7, Фаза 5): агрегаты «BA × сессии» —

/** Вход `POST /group/aggregate`: выборка записей + групповые фильтры §3.5 */
export type GroupAggregateIn = Schemas['GroupAggregateIn']

/** Результат `POST /group/aggregate`: строки словарей × колонки-записи */
export type GroupAggregateOut = Schemas['GroupAggregateOut']

/** Вход `POST /group/analyses`: тот же снимок + подпись истории */
export type GroupAnalysisCreateIn = Schemas['GroupAnalysisCreateIn']

/** Строка истории прогонов (`GET /group/analyses`) */
export type GroupAnalysisSummary = Schemas['GroupAnalysisSummaryOut']

/** Прогон: паспорт + свежий пересчёт (`GET /group/analyses/{id}`) */
export type GroupAnalysisDetail = Schemas['GroupAnalysisDetailOut']

/** Страница истории прогонов */
export type GroupAnalysesPage = Schemas['GroupAnalysesPage']

/** Строка агрегата (структура или поле Бродмана) с ячейками по записям */
export type GroupRow = Schemas['GroupRowOut']

/** Колонка тепловой карты: запись-участник и её прогон */
export type GroupParticipant = Schemas['GroupParticipantOut']


export type DipoleScanPoint = Schemas['DipoleScanPointOut']

export type DipoleScanResult = Schemas['DipoleScanResult']

export type DipoleRefineResult = Schemas['DipoleRefineResult']
export type EloretaResult = Schemas['EloretaResult']

/** Виртуальный канал «ЭЭГ» из паспорта записи (микс групп 10-20) */
export type RecordingMix = Schemas['ChannelMixOut']

export type RecordingEvent = Schemas['RecordingEvent']

export type RecordingMeta = Schemas['RecordingMeta']

/** Строка списка сессий (`GET /sessions`, 4.7) — кандидат выбора пары сравнения */
export type SessionSummary = Schemas['SessionSummaryOut']

/** Страница списка сессий (`GET /sessions`) */
export type SessionsPage = Schemas['SessionsPageOut']

export type PipelineInfo = Schemas['PipelineInfo']

export type SurfaceRef = Schemas['SurfaceRef']

export type EvokedResult = Schemas['EvokedResult']

export type AnalyzeResponse = Schemas['AnalyzeResponse']

export type JobCreated = Schemas['JobCreated']

export type JobStatus = Schemas['JobStatus']

export type ArtifactThresholds = Schemas['ArtifactThresholds']

export type MetaResponse = Schemas['MetaResponse']

/**
 * Локальный ресурс (`GET/PUT /api/v1/resource`): автоопределение GPU сервера
 * и тумблер «Использовать GPU» (источник истины — MNE-конфиг сервера, см.
 * `backend/app/services/gpu.py`).
 */
export type LocalResource = Schemas['LocalResourceOut']

export type MriSliceRef = Schemas['MriSliceRef']

/** Ссылка на тома fsaverage для 3D-вида Niivue — схема `MriVolumeRef` */
export type MriVolumeRef = Schemas['MriVolumeRef']

export type ContoursRef = Schemas['ContoursRef']

export type ContourShape = Schemas['ContourShapeOut']

export type ContourSlice = Schemas['ContourSliceOut']

/**
 * Результат расчёта спектрограммы канала (`GET /recordings/{id}/spectrogram/{job}`).
 *
 * Считается STFT по одному каналу («ЭЭГ»): числа сетки приезжают отдельным
 * бинарным контейнером (`grid_url`), а в JSON — метаданные и оси. Палитра, окно
 * дБ и сглаживание — параметры просмотра, сетку они не пересчитывают.
 */
export type SpectrogramResult = Schemas['SpectrogramResult']

/** 202-ответ POST /server/restart: перезапуск бэкенда запланирован */
export type ServerRestart = Schemas['ServerRestartOut']

/**
 * Пакет сессии (`kind=bundle`, 4.6): zip в дисковом кэше, `zip_url` —
 * скачивание; `sig` — входной отпечаток сборки (он же ETag ассета).
 */
export type BundleResult = Schemas['BundleResult']

/**
 * Run manifest задачи (`GET /jobs/{id}/manifest`, 4.6): версии среды,
 * отпечатки ассетов и параметры прогона рядом с результатом.
 */
export type RunManifest = Schemas['RunManifestOut']

/**
 * Сквозной автоотчёт («Итоги», `GET /recordings/{id}/report/{job}`): агрегаты
 * QC/эпох и по каждой полосе пакета; сам HTML — отдельный ассет `html_url`.
 */
export type ReportResult = Schemas['ReportResult']

/**
 * Метаданные HTML-отчёта «Итогов» по готовому результату (Тип 1 «Сравнение»,
 * Тип 2 «Группа»): ленивая сборка документа, ссылка и версия ассета.
 */
export type ReportHtmlOut = Schemas['ReportHtmlOut']

/** Агрегаты одной полосы пакета в части 2 отчёта */
export type ReportBandSummary = Schemas['ReportBandSummaryOut']

/**
 * ROI-агрегат пакета (4.5): строки ROI × полосы + полушария. GOF и порог
 * «надёжной точки» — только внутри полосы (принцип 3 docs/rules/dipoles.md).
 */
export type RoiAggregate = Schemas['RoiAggregateOut']

/** Строка ROI-агрегата (структура или поле Бродмана) */
export type RoiRow = Schemas['RoiRowOut']

/** Ячейка ROI × полоса (числа своей полосы) */
export type RoiBandCell = Schemas['RoiBandCellOut']

/** Статусы проверок готовности (GET /init-status) */
export type CheckStatus = 'ready' | 'pending' | 'loading' | 'error' | 'unknown'

/**
 * `/init-status` — пока «сырой» dict без response_model (main.py), поэтому
 * тип остаётся ручным и не покрыт генерацией из OpenAPI.
 */
export type InitStatus = {
  checks: Record<string, CheckStatus>
  status: 'ready' | 'pending'
  versions: Record<string, string | null>
  /** Свежесть кода бэкенда: `stale` = исходники новее старта процесса (сервер не обновлён) */
  code: { code_mtime: string; server_started_at: string; stale: boolean }
  ui: { built: boolean; url: string; legacy_url: string }
  paths: {
    subjects_dir: string
    fsaverage_trans: string
    upload_dir: string
    results_dir: string
    cache_dir: string
  }
  /**
   * Занятость кэша записей (N40/4.6): −1 — не посчиталось (честно, не «ноль»).
   * **Опционально**: `/init-status` — «сырой» dict, и бэкенд, запущенный до N40
   * (без перезагрузки), поля не отдаёт — UI обязан это переживать, а не падать
   * (случай 04.10.2026: краш `data.cache is undefined` на живом прогона).
   */
  cache?: { usage_bytes: number; units: number; quota_bytes: number }
  api: { prefix: string; docs_url: string; meta_url: string }
}

/** Человекочитаемые подписи проверок для раздела «Состояние сервера» */
export const CHECK_TITLES: Record<string, string> = {
  mne: 'MNE-Python',
  config: 'Конфигурация',
  database: 'База данных',
  fsaverage: 'Данные FSAverage',
  transform: 'Transform (MRI ↔ head)',
  bem: 'BEM-модель головы',
}

