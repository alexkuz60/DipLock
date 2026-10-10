/**
 * Подмена fetch для тестов UI: отдаёт фикстуры бэкенда по путям API.
 */
import { vi } from 'vitest'
import {
  calcJobFixture,
  compareResultFixture,
  dipoleRefineResultFixture,
  dipoleScanResultFixture,
  eloretaResultFixture,
  evokedResultFixture,
  filterResponseFixture,
  groupAggregateFixture,
  groupRunSummaryFixture,
  initStatusFixture,
  llmProbeFixture,
  llmRouterFixture,
  localResourceFixture,
  mainsFixture,
  metaFixture,
  preprocessJobFixture,
  preprocessResultFixture,
  recordingFixture,
  reportHtmlOutFixture,
  reportResultFixture,
  bundleResultFixture,
  sessionsFixture,
  spectrogramResultFixture,
  spectrumResultFixture,
} from './fixtures'
import { encodeSignalBlob } from './signalBlob'
import { spectrogramBlobFixture } from './spectrogramBlob'
import type {
  CompareResult,
  ContourSlice,
  DipoleRefineResult,
  DipoleScanResult,
  EloretaResult,
  EvokedResult,
  FilterResponse,
  BundleResult,
  GroupAggregateOut,
  GroupAnalysisSummary,
  InitStatus,
  JobStatus,
  LlmProbeResult,
  LlmRouter,
  LocalResource,
  MainsResponse,
  MetaResponse,
  PreprocessResult,
  PreprocessStage,
  RecordingMeta,
  ReportHtmlOut,
  ReportResult,
  SessionSummary,
  SpectrogramResult,
  SpectrumResult,
} from '@/shared/api/types'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** 202-ответ запуска задачи расчёта (срез 3.4): id задачи и адреса поллинга. */
function calcJobCreated(
  jobId: string,
  kind: 'spectrum' | 'dipoles' | 'spectrogram' | 'dipole_refine' | 'evoked' | 'report' | 'bundle' | 'eloreta',
): Record<string, string> {
  return {
    job_id: jobId,
    status: 'queued',
    poll_url: `/api/v1/jobs/${jobId}`,
    result_url: `/api/v1/recordings/${recordingFixture.recording_id}/${kind}/${jobId}`,
  }
}

/**
 * Сигналы записи для мока: 3 канала, 10 с, огибающая 100 точек (уровень ×1).
 * Формат — тот же контейнер, что отдаёт бэкенд (см. `signalBlob.ts`).
 */
export function signalsFixtureResponse(
  channels: string[] = recordingFixture.channels ?? [],
): Response {
  const nPoints = 100
  const body = encodeSignalBlob(
    {
      recording_id: recordingFixture.recording_id,
      level: 1,
      channels,
      sfreq: nPoints / recordingFixture.duration_sec,
      duration_sec: recordingFixture.duration_sec,
      n_points: nPoints,
      decimated: true,
      dtype: 'float32',
      byte_order: 'little',
      layout: 'channel-major',
    },
    channels.map((name, index) => ({
      name,
      min: Array.from({ length: nPoints }, (_, i) => -20 - index + Math.sin(i / 5)),
      max: Array.from({ length: nPoints }, (_, i) => 20 + index - Math.sin(i / 5)),
    })),
  )
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'application/octet-stream', ETag: '"mock-signals"' },
  })
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
}

export type MockApiOptions = {
  initStatus?: InitStatus
  meta?: MetaResponse
  /** Паспорт записи для GET /recordings/{id} */
  recording?: RecordingMeta
  /** Смоделировать недоступность сервера (500 на /init-status) */
  initStatusFails?: boolean
  /** Локальный ресурс для GET /resource (по умолчанию — рабочий GPU) */
  localResource?: LocalResource
  /** Ответ PUT /resource (например «CuPy не установлен», HTTP 409) */
  localResourceFail?: string
  /** Состояние модельного роутера ИИ для GET/PUT /llm-router */
  llmRouter?: LlmRouter
  /** Результат probe /llm-router/probe (например, ошибка провайдера) */
  llmProbe?: LlmProbeResult
  /** Смоделировать отказ сигналов записи (например 404 после TTL) */
  signalsFail?: boolean
  /** Стадия предподготовки, если запрос её не указал (срез 2.7) */
  preprocessStage?: PreprocessStage
  /** Явный результат стадии (иначе — фикстура под запрошенную стадию) */
  preprocessResult?: PreprocessResult
  /** Статус задачи предподготовки: failed имитирует ошибку стадии */
  preprocessJob?: JobStatus
  /** Смоделировать отказ запуска стадии (404 записи) */
  preprocessStartFails?: boolean
  /** Явный результат ERP-усреднения (шаг 2.7); иначе — фикстура */
  evokedResult?: EvokedResult
  /** Статус задачи расчёта раздела «Диполи» (спектр и диполи) — для поллинга */
  calcJob?: JobStatus
  /** Явный результат спектра по диапазонам */
  spectrumResult?: SpectrumResult
  /** Явный результат быстрого расчёта диполей */
  dipoleScanResult?: DipoleScanResult
  /** Явный результат точного уточнения эпохи (кнопка «Уточнить…») */
  dipoleRefineResult?: DipoleRefineResult
  /** Явный результат eLORETA (остаток B9); иначе — фикстура */
  eloretaResult?: EloretaResult
  /** Явный результат спектрограммы («ЭЭГ») */
  spectrogramResult?: SpectrogramResult
  /** Статус задачи спектрограммы (поллинг) */
  spectrogramJob?: JobStatus
  /** Явный результат автоотчёта (раздел «Итоги») */
  reportResult?: ReportResult
  /** Результат задачи пакета сессии (`GET …/bundle/{job_id}`) */
  bundleResult?: BundleResult
  /** Метаданные отчёта группового анализа (`GET …/report`, Тип 1/Тип 2) */
  reportHtml?: ReportHtmlOut
  /** Текст ошибки сборки отчёта (404: прогона нет в БД) */
  groupReportFails?: string
  /** Результат дифференциального анализа (`GET /compare/{id}`) */
  compareResult?: CompareResult
  /** Текст ошибки запуска сравнения (400 с текстом шлюза пары) */
  compareStartFails?: string
  /** Агрегат группы (`POST /group/aggregate`); по умолчанию — фикстура */
  groupAggregate?: GroupAggregateOut
  /** Текст ошибки агрегата (400: неизвестная полоса / пустая выборка) */
  groupAggregateFails?: string
  /** История прогонов (`GET /group/analyses`); по умолчанию пусто */
  groupRuns?: GroupAnalysisSummary[]
  /** Деталь прогона (`GET /group/analyses/{id}`) */
  groupRunDetail?: { run: GroupAnalysisSummary; aggregate: GroupAggregateOut }
  /** Строки `GET /sessions` — кандидаты выбора пары */
  sessions?: { total: number; items: SessionSummary[] }
  /** АЧХ фильтра (`GET /filter-response`, шаг 2.5) */
  filterResponse?: FilterResponse
  /** Сигнал сетевого фона (`GET /recordings/{id}/mains`) */
  mains?: MainsResponse
  /** Смоделировать отказ запуска расчёта (404 записи) */
  calcStartFails?: boolean
  /**
   * Контуры атласа для `GET /surface/contours/{plane}/{mm}` (срез 3.9).
   * По умолчанию их нет: раздел честно рисует условные фигуры, а тест, которому
   * нужны реальные контуры, передаёт срез явно.
   */
  contours?: ContourSlice
  /** Смоделировать отказ перезапуска бэкенда (409: --reload / не лаунчер / задачи) */
  restartFail?: string
  /** История задач для `GET /jobs?limit=` (подтверждение перезапуска) */
  jobs?: JobStatus[]
}

export function mockApiFetch(options: MockApiOptions = {}) {
  // Мок «помнит» стадию из POST: результат GET должен соответствовать запросу
  let requestedStage: PreprocessStage = options.preprocessStage ?? 'artifacts'

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input)
    const method = init?.method ?? 'GET'

    if (url.includes('/init-status')) {
      if (options.initStatusFails) {
        return jsonResponse({ detail: 'Сервис недоступен' }, 500)
      }
      return jsonResponse(options.initStatus ?? initStatusFixture)
    }
    if (url.includes('/resource')) {
      if (method === 'PUT') {
        if (options.localResourceFail) {
          return jsonResponse({ detail: options.localResourceFail }, 409)
        }
        const body = JSON.parse(String(init?.body ?? '{}')) as { use_cuda?: boolean }
        const current = options.localResource ?? localResourceFixture
        return jsonResponse({ ...current, use_cuda: body.use_cuda ?? false })
      }
      return jsonResponse(options.localResource ?? localResourceFixture)
    }
    if (url.includes('/server/restart')) {
      if (options.restartFail) {
        return jsonResponse({ detail: options.restartFail }, 409)
      }
      return jsonResponse(
        {
          restarting: true,
          restart_after_sec: 0.5,
          server_started_at: initStatusFixture.code.server_started_at,
        },
        202,
      )
    }
    if (url.includes('/bundle')) {
      // Пакет сессии (4.6): POST → задача, GET результата → zip_url, zip → 404
      if (method === 'POST') {
        if (options.calcStartFails) {
          return jsonResponse({ detail: 'Запись не найдена или уже удалена' }, 404)
        }
        return jsonResponse(calcJobCreated('job-bundle-1', 'bundle'), 202)
      }
      if (url.endsWith('/zip')) {
        return new Response(new Uint8Array([80, 75, 3, 4]), {
          status: 200,
          headers: { 'Content-Type': 'application/zip', ETag: '"mock-bundle"' },
        })
      }
      return jsonResponse(
        options.bundleResult
          ?? bundleResultFixture({
            zip_url: `/api/v1/recordings/${recordingFixture.recording_id}/bundle/job-bundle-1/zip`,
          }),
      )
    }
    if (url.includes('/dipoles.csv')) {
      return new Response('session_id,epoch_id\r\n', {
        status: 200,
        headers: { 'Content-Type': 'text/csv' },
      })
    }
    if (url.includes('/preprocess')) {
      if (method === 'POST') {
        const form = init?.body as FormData | undefined
        const stage = form?.get('stage')
        if (stage) requestedStage = String(stage) as PreprocessStage
        if (options.preprocessStartFails) {
          return jsonResponse({ detail: 'Запись не найдена или уже удалена' }, 404)
        }
        return jsonResponse(
          {
            job_id: preprocessJobFixture.job_id,
            status: preprocessJobFixture.status,
            poll_url: `/api/v1/jobs/${preprocessJobFixture.job_id}`,
            result_url: `/api/v1/recordings/${recordingFixture.recording_id}/preprocess/${preprocessJobFixture.job_id}`,
          },
          202,
        )
      }
      return jsonResponse(
        options.preprocessResult ?? preprocessResultFixture(requestedStage),
      )
    }
    if (url.includes('/spectrogram')) {
      // Ветка идёт раньше `/spectrum`: подстрока `spectrogram` содержит `spectrum`,
      // и разбор спектра перехватил бы запросы спектрограммы
      if (url.includes('/grid.bin')) {
        return new Response(spectrogramBlobFixture(), {
          status: 200,
          headers: { 'Content-Type': 'application/octet-stream', ETag: '"mock-spectrogram"' },
        })
      }
      if (method === 'POST') {
        if (options.calcStartFails) {
          return jsonResponse({ detail: 'Запись не найдена или уже удалена' }, 404)
        }
        return jsonResponse(calcJobCreated('job-spec-1', 'spectrogram'), 202)
      }
      return jsonResponse(options.spectrogramResult ?? spectrogramResultFixture())
    }
    if (url.includes('/spectrum')) {
      if (url.includes('/topomap/')) {
        // Картинку топокарты в jsdom никто не декодирует — важно лишь, что URL живой
        return new Response(new Uint8Array([137, 80, 78, 71]), {
          status: 200,
          headers: { 'Content-Type': 'image/png', ETag: '"mock-topomap"' },
        })
      }
      if (method === 'POST') {
        if (options.calcStartFails) {
          return jsonResponse({ detail: 'Запись не найдена или уже удалена' }, 404)
        }
        return jsonResponse(calcJobCreated(calcJobFixture.job_id, 'spectrum'), 202)
      }
      return jsonResponse(options.spectrumResult ?? spectrumResultFixture())
    }
    if (url.includes('/dipole_refine')) {
      if (method === 'POST') {
        if (options.calcStartFails) {
          return jsonResponse({ detail: 'Запись не найдена или уже удалена' }, 404)
        }
        return jsonResponse(calcJobCreated(calcJobFixture.job_id, 'dipole_refine'), 202)
      }
      return jsonResponse(options.dipoleRefineResult ?? dipoleRefineResultFixture())
    }
    // eLORETA (остаток B9): пик/ROI эпохи. Ветка строго по `/eloreta` —
    // подстрока не пересекается с `/dipole_refine` и `/dipoles`.
    if (url.includes('/eloreta')) {
      if (method === 'POST') {
        if (options.calcStartFails) {
          return jsonResponse({ detail: 'Запись не найдена или уже удалена' }, 404)
        }
        return jsonResponse(calcJobCreated(calcJobFixture.job_id, 'eloreta'), 202)
      }
      return jsonResponse(options.eloretaResult ?? eloretaResultFixture())
    }
    if (url.includes('/dipoles')) {
      if (method === 'POST') {
        if (options.calcStartFails) {
          return jsonResponse({ detail: 'Запись не найдена или уже удалена' }, 404)
        }
        return jsonResponse(calcJobCreated(calcJobFixture.job_id, 'dipoles'), 202)
      }
      return jsonResponse(options.dipoleScanResult ?? dipoleScanResultFixture())
    }
    // Отчёты группового анализа в «Итогах» (Тип 1/Тип 2): метаданные ленивой
    // сборки. Ветка строго по хвосту `/report` — иначе её перехватывает
    // общая ветка автоотчёта записи ниже (подстрока `/report` в URL).
    if (/\/compare\/[^/]+\/report$/.test(url)) {
      const jobId = url.split('/').filter(Boolean).at(-2) ?? 'job-compare-1'
      return jsonResponse(
        options.reportHtml
          ?? reportHtmlOutFixture({
            title: 'Сравнение: Покой ↔ Деятельность',
            html_url: `/api/v1/compare/${jobId}/report/html`,
          }),
      )
    }
    if (/\/group\/analyses\/\d+\/report$/.test(url)) {
      if (options.groupReportFails) {
        return jsonResponse({ detail: options.groupReportFails }, 404)
      }
      const runId = url.split('/').filter(Boolean).at(-2) ?? '7'
      return jsonResponse(
        options.reportHtml
          ?? reportHtmlOutFixture({
            title: 'Группа: покой vs деятельность (полоса alpha)',
            html_url: `/api/v1/group/analyses/${runId}/report/html`,
          }),
      )
    }
    if (url.includes('/report')) {
      // Автоотчёт (раздел «Итоги»): 202 + задача, результат — агрегаты;
      // HTML-ассет в тестах никто не запрашивает (iframe в jsdom не грузит src)
      if (method === 'POST') {
        if (options.calcStartFails) {
          return jsonResponse({ detail: 'Запись не найдена или уже удалена' }, 404)
        }
        return jsonResponse(calcJobCreated('job-report-1', 'report'), 202)
      }
      if (url.endsWith('/html')) {
        return new Response('<html><body>Автоотчёт</body></html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        })
      }
      return jsonResponse(options.reportResult ?? reportResultFixture())
    }
    if (url.includes('/evoked')) {
      // ERP-усреднение (шаг 2.7): 202 + задача, результат — усреднённая волна
      if (method === 'POST') {
        return jsonResponse(calcJobCreated('job-evoked-1', 'evoked'), 202)
      }
      return jsonResponse(options.evokedResult ?? evokedResultFixture())
    }
    if (url.includes('/compare/topomap/')) {
      // PNG карты разности: в тестах возвращаем JSON — компонент картинку не читает,
      // а наличие URL проверяется по строке результата
      return jsonResponse({ detail: 'PNG не мокается в jsdom' }, 404)
    }
    if (url.includes('/compare')) {
      // Дифференциальный анализ (B9): POST → 202, GET результата → CompareResult
      if (method === 'POST') {
        if (options.compareStartFails) {
          return jsonResponse({ detail: options.compareStartFails }, 400)
        }
        return jsonResponse(
          {
            job_id: 'job-compare-1',
            status: 'queued',
            poll_url: '/api/v1/jobs/job-compare-1',
            result_url: '/api/v1/compare/job-compare-1',
          },
          202,
        )
      }
      return jsonResponse(options.compareResult ?? compareResultFixture())
    }
    if (url.includes('/group/aggregate')) {
      // Живой агрегат группы: синхронный JSON, 400 с текстом шлюза
      if (options.groupAggregateFails) {
        return jsonResponse({ detail: options.groupAggregateFails }, 400)
      }
      return jsonResponse(options.groupAggregate ?? groupAggregateFixture())
    }
    if (/\/group\/analyses\/\d+/.test(url)) {
      // Деталь прогона: паспорт + свежий пересчёт сервера
      const detail = options.groupRunDetail ?? {
        run: groupRunSummaryFixture(),
        aggregate: options.groupAggregate ?? groupAggregateFixture(),
      }
      if (detail.run.id === Number(url.split('/').pop())) {
        return jsonResponse(detail)
      }
      return jsonResponse({ detail: 'Прогон не найден' }, 404)
    }
    if (url.includes('/group/analyses')) {
      // История прогонов: POST → 201 паспорт, GET → страница
      if (method === 'POST') {
        if (options.groupAggregateFails) {
          return jsonResponse({ detail: options.groupAggregateFails }, 400)
        }
        return jsonResponse(groupRunSummaryFixture({ id: 99 }), 201)
      }
      const items = options.groupRuns ?? []
      return jsonResponse({ total: items.length, items })
    }
    if (url.includes('/sessions')) {
      return jsonResponse(options.sessions ?? sessionsFixture)
    }
    if (url.includes('/jobs?')) {
      // История задач (для подтверждения перезапуска): по умолчанию пусто
      return jsonResponse(options.jobs ?? [])
    }
    if (url.includes('/jobs/')) {
      return jsonResponse(
        options.spectrogramJob ?? options.calcJob ?? options.preprocessJob ?? preprocessJobFixture,
      )
    }
    if (url.includes('/signals')) {
      if (options.signalsFail) {
        return jsonResponse({ detail: 'Запись не найдена или уже удалена' }, 404)
      }
      return signalsFixtureResponse()
    }
    if (url.includes('/surface/contours')) {
      // Контуров по умолчанию нет: раздел показывает, что ассет недоступен, и
      // рисует условные фигуры — как в браузере без fsaverage.
      if (!options.contours) {
        return jsonResponse({ detail: 'Нет мока для контуров' }, 404)
      }
      // Мок отвечает срезом запрошенной плоскости: иначе счётчики меток в разделе
      // были бы завышены втрое (один и тот же фикстурный срез на три запроса).
      const match = /\/surface\/contours\/([a-z]+)\/(-?\d+(?:\.\d+)?)/.exec(url)
      const plane = match?.[1] ?? 'axial'
      const onSlice = plane === options.contours.plane
      return jsonResponse({
        ...options.contours,
        plane,
        structures: onSlice ? options.contours.structures : [],
        areas: onSlice ? options.contours.areas : [],
      })
    }
    if (url.includes('/filter-response')) {
      return jsonResponse(options.filterResponse ?? filterResponseFixture())
    }
    if (url.includes('/mains')) {
      // Раньше общей ветки `/recordings/`: URL mains её содержит
      return jsonResponse(options.mains ?? mainsFixture())
    }
    if (url.includes('/llm-router/probe')) {
      // Проверка связи: по умолчанию успех, ошибка — через options.llmProbe
      return jsonResponse(options.llmProbe ?? llmProbeFixture())
    }
    if (url.includes('/llm-router')) {
      // PUT возвращает присланное состояние (сервер его и сохраняет)
      return jsonResponse(options.llmRouter ?? llmRouterFixture())
    }
    if (url.includes('/meta')) {
      return jsonResponse(options.meta ?? metaFixture)
    }
    if (url.includes('/recordings/')) {
      return jsonResponse(options.recording ?? recordingFixture)
    }
    return jsonResponse({ detail: `Нет мока для ${url}` }, 404)
  })

  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}
