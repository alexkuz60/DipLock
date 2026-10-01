/**
 * Состояние раздела «Итоги»: параметры пакета, состояние задачи автоотчёта и
 * результат.
 *
 * Правило разделов то же, что в EDF/«Диполях» (`docs/ui.md`): правка параметра
 * **ничего не запускает** — отчёт собирается только кнопкой в тулс-хедере
 * (`POST /recordings/{id}/report`). Форма запроса повторяет стадии EDF
 * (`buildPreprocessForm`): часть 1 обязана пересказывать те же числа, что видит
 * пользователь в EDF (фильтр, пороги детекторов, очистка, длина эпохи). Поля
 * событийной нарезки отбрасываются — сквозной отчёт режет эпохи только
 * фиксированной длиной (решение среза, `docs/ui/summary.md`).
 *
 * Персистятся параметры пакета (полосы, шаг сетки): результат относится к
 * записи и после перезагрузки страницы бессмыслен. Результат и идущая задача
 * сбрасываются при закрытии/смене записи — за этим следит `SummarySection`
 * (сравнение `result.recording_id` с текущей записью), а `reset()` здесь же
 * глушит устаревший поллинг (сдвиг токена).
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { api, apiErrorText } from '@/shared/api/client'
import type { JobStatus, ReportResult } from '@/shared/api/types'
import { clamp } from '@/shared/lib/calcFilter'
import { GRID_MM_RANGE } from '@/shared/lib/dipoleCalcModel'
import { cancelRemoteJob, createRunToken, isCancelled, waitForJob } from '@/shared/lib/jobPolling'
import { useEdfParams } from '@/shared/state/edfParams'
import { buildPreprocessForm } from '@/shared/state/edfRecording'

/** Токен запуска: новый сбор/сброс/закрытие записи делают ответ прежней задачи чужим. */
const runToken = createRunToken()

/** Задача «только поставлена»: поллинг ещё не дал ни одного опроса. */
function pendingJob(): JobStatus {
  return {
    job_id: '',
    kind: 'report',
    status: 'running',
    stage: 'queued',
    progress: 0,
    message: 'В очереди',
    epochs_done: 0,
    epochs_total: 0,
    created_at: new Date().toISOString(),
  }
}

/**
 * Форма задачи автоотчёта: стадии EDF (фильтр/пороги/очистка/длина эпохи)
 * + поля пакета (`bands`, `grid_mm`). Событийная нарезка убирается — отчёт
 * её не поддерживает, и молча взять её из формы EDF нельзя.
 */
function buildReportForm(bandKeys: string[] | null, gridMm: number): FormData {
  const params = useEdfParams.getState().params
  const form = buildPreprocessForm('epochs', params)
  form.delete('stage')
  form.delete('epoch_mode')
  form.delete('event_id')
  form.delete('epoch_pre_ms')
  form.delete('epoch_post_ms')
  if (bandKeys) form.set('bands', bandKeys.join(','))
  else form.delete('bands')
  form.set('grid_mm', String(gridMm))
  return form
}

export type SummaryReportState = {
  /** Ключи полос пакета: `null` — все полосы из `/meta` (дефолт) */
  bandKeys: string[] | null
  /** Шаг объёмной сетки поиска, мм (2…20) */
  gridMm: number
  /** Идущая задача (поллинг) — `null`, когда расчёта нет */
  job: JobStatus | null
  /** id созданной задачи — для отмены до первого опроса (3.2) */
  jobId: string | null
  result: ReportResult | null
  error: string | null
  /** Явный набор полос (`null` — «все») */
  setBandKeys: (keys: string[] | null) => void
  /** Переключение полосы: `null` («все») при первом клике раскрывается в список */
  toggleBand: (key: string, allKeys: string[]) => void
  setGridMm: (value: number) => void
  /** Сборка отчёта по кнопке (202 + поллинг + результат) */
  run: (recordingId: string | null) => Promise<void>
  /** Отмена идущей сборки (3.2): DELETE на сервере + локальный статус */
  cancel: () => void
  /** Сброс результата и задачи (закрытие/смена записи) — параметры остаются */
  reset: () => void
}

export const useSummaryReport = create<SummaryReportState>()(
  persist(
    (set, get) => ({
      bandKeys: null,
      gridMm: 7,
      job: null,
      jobId: null,
      result: null,
      error: null,

      setBandKeys: (bandKeys) => set({ bandKeys }),

      toggleBand: (key, allKeys) =>
        set((state) => {
          const current = state.bandKeys ?? allKeys
          const next = current.includes(key)
            ? current.filter((item) => item !== key)
            : [...current, key]
          return { bandKeys: next }
        }),

      setGridMm: (value) => set({ gridMm: clamp(value, GRID_MM_RANGE) }),

      run: async (recordingId) => {
        if (!recordingId) return
        const { bandKeys, gridMm } = get()
        if (bandKeys && bandKeys.length === 0) {
          set({ error: 'Выберите хотя бы одну полосу пакета' })
          return
        }
        const token = runToken.next()
        const isCurrent = () => runToken.isCurrent(token)
        set({ job: pendingJob(), jobId: null, error: null })
        try {
          const created = await api.report.start(recordingId, buildReportForm(bandKeys, gridMm))
          if (!isCurrent()) return
          // id задачи сразу после 202: отмена работает и до первого опроса (3.2)
          set({ jobId: created.job_id, job: { ...pendingJob(), job_id: created.job_id } })
          await waitForJob(created.job_id, isCurrent, (status) => set({ job: status }))
          if (!isCurrent()) return
          const result = await api.report.result(recordingId, created.job_id)
          if (!isCurrent()) return
          set({ result, error: null })
        } catch (error) {
          if (isCancelled(error) || !isCurrent()) return
          const text = apiErrorText(error)
          set({
            job: {
              ...(get().job ?? pendingJob()),
              status: 'failed',
              stage: 'failed',
              message: text,
              error: text,
            },
            error: text,
          })
        }
      },

      cancel: () => {
        const { jobId, job } = get()
        if (jobId) {
          cancelRemoteJob(jobId, runToken)
        } else {
          // Запрос на создание ещё в полёте: глушим только локальное ожидание
          runToken.cancel()
        }
        if (job) set({ job: { ...job, status: 'cancelled', message: 'Отменена' } })
        set({ jobId: null })
      },

      reset: () => {
        runToken.cancel()
        set({ job: null, jobId: null, result: null, error: null })
      },
    }),
    {
      name: 'diplock.summary',
      // Параметры пакета — настройки расчёта: их переживает перезагрузка,
      // результат и задача — нет (они относятся к записи)
      partialize: (state) => ({ bandKeys: state.bandKeys, gridMm: state.gridMm }),
    },
  ),
)
