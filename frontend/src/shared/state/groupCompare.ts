/**
 * Состояние «Сравнения двух записей» (дифференциальный анализ, B9): пара,
 * ярлыки условий, состояние задачи и результат.
 *
 * Правило разделов то же, что в EDF/«Итогах» (`docs/ui.md`): правка параметра
 * **ничего не запускает** — сравнение стартует только кнопкой в тулс-хедере
 * (`POST /compare`). Параметры спектра (фильтр, notch, референс, длина эпохи)
 * берутся из формы EDF — обе стороны пары обязаны обрабатываться одинаково,
 * иначе дельты не определены; событийная нарезка отбрасывается (сравнение
 * режет эпохи фиксированной длиной, как автоотчёт).
 *
 * Кандидаты записей — `GET /sessions` (санкционированный вход: листинга записей
 * в API нет). Персистятся только ярлыки условий (текст пользователя); пара,
 * задача и результат — состояние сессии: после перезагрузки нужно запускать
 * заново.
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { api, apiErrorText } from '@/shared/api/client'
import type { CompareResult, JobStatus } from '@/shared/api/types'
import { cancelRemoteJob, createRunToken, isCancelled, waitForJob } from '@/shared/lib/jobPolling'
import { useEdfParams } from '@/shared/state/edfParams'
import { buildPreprocessForm } from '@/shared/state/edfRecording'

/** Токен запуска: новый расчёт/сброс делают ответ прежней задачи чужим. */
const runToken = createRunToken()

/** Задача «только поставлена»: поллинг ещё не дал ни одного опроса. */
function pendingJob(): JobStatus {
  return {
    job_id: '',
    kind: 'compare',
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
 * Форма задачи сравнения: две записи + ярлыки + параметры спектра из формы
 * EDF (зеркало спектральной формы, `create_spectrum_job`). Поля очистки и
 * порогов сюда не попадают — сравнение считает PSD, а не стадии.
 */
function buildCompareForm(
  recordingIdA: string,
  recordingIdB: string,
  labelA: string,
  labelB: string,
  psdMethod: string,
): FormData {
  const params = useEdfParams.getState().params
  const form = buildPreprocessForm('epochs', params)
  for (const key of [
    'stage', 'epoch_mode', 'event_id', 'epoch_pre_ms', 'epoch_post_ms',
    'z_threshold', 'pp_threshold_uv', 'flat_line_uv', 'flat_line_ms', 'run_ica',
    'notch_harmonics', 'bad_channels', 'interpolate_bads', 'clean_method',
    'ica_n_components', 'exclude_zone_ids',
  ]) {
    form.delete(key)
  }
  form.set('recording_id_a', recordingIdA)
  form.set('recording_id_b', recordingIdB)
  form.set('label_a', labelA)
  form.set('label_b', labelB)
  form.set('psd_method', psdMethod)
  return form
}

export type GroupCompareState = {
  /** Запись A (первая сторона пары, например «покой») — null, если не выбрана */
  recordingIdA: string | null
  /** Запись B (вторая сторона, например «деятельность») */
  recordingIdB: string | null
  /** Ярлык условия A (персистится — текст пользователя) */
  labelA: string
  /** Ярлык условия B */
  labelB: string
  /** Метод PSD: welch | multitaper */
  psdMethod: string
  /** Идущая задача (поллинг) — null, когда расчёта нет */
  job: JobStatus | null
  /** id созданной задачи — для отмены до первого опроса (3.2) */
  jobId: string | null
  result: CompareResult | null
  error: string | null
  setRecordingA: (id: string | null) => void
  setRecordingB: (id: string | null) => void
  setLabelA: (value: string) => void
  setLabelB: (value: string) => void
  setPsdMethod: (value: string) => void
  /** Сравнение по кнопке (202 + поллинг + результат) */
  run: () => Promise<void>
  /** Отмена идущего расчёта (3.2): DELETE на сервере + локальный статус */
  cancel: () => void
  /** Сброс пары, задачи и результата (закрытие раздела) — ярлыки остаются */
  reset: () => void
}

export const useGroupCompare = create<GroupCompareState>()(
  persist(
    (set, get) => ({
      recordingIdA: null,
      recordingIdB: null,
      labelA: 'Покой',
      labelB: 'Деятельность',
      psdMethod: 'welch',
      job: null,
      jobId: null,
      result: null,
      error: null,

      setRecordingA: (id) => set({ recordingIdA: id, result: null }),
      setRecordingB: (id) => set({ recordingIdB: id, result: null }),
      setLabelA: (value) => set({ labelA: value }),
      setLabelB: (value) => set({ labelB: value }),
      setPsdMethod: (value) => set({ psdMethod: value }),

      run: async () => {
        const { recordingIdA, recordingIdB, labelA, labelB, psdMethod } = get()
        if (!recordingIdA || !recordingIdB) {
          set({ error: 'Выберите обе записи пары (A и B)' })
          return
        }
        if (recordingIdA === recordingIdB) {
          set({ error: 'Сравнивать нужно две разные записи' })
          return
        }
        const token = runToken.next()
        const isCurrent = () => runToken.isCurrent(token)
        set({ job: pendingJob(), jobId: null, error: null, result: null })
        try {
          const created = await api.compare.start(
            buildCompareForm(recordingIdA, recordingIdB, labelA, labelB, psdMethod),
          )
          if (!isCurrent()) return
          // id задачи сразу после 202: отмена работает и до первого опроса (3.2)
          set({ jobId: created.job_id, job: { ...pendingJob(), job_id: created.job_id } })
          await waitForJob(created.job_id, isCurrent, (status) => set({ job: status }))
          if (!isCurrent()) return
          const result = await api.compare.result(created.job_id)
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
      name: 'diplock.group-compare',
      // Персистятся только ярлыки условий: пара и результат — состояние сессии
      partialize: (state) => ({ labelA: state.labelA, labelB: state.labelB }),
    },
  ),
)


