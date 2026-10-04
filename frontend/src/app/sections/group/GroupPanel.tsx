/**
 * Панель «Сравнение двух записей»: выбор пары, ярлыки условий и метод PSD.
 *
 * Панель, как и в остальных разделах, **ничего не запускает** (правило
 * `docs/ui.md`): параметры складываются в стор, расчёт стартует только кнопкой
 * «Сравнить» в тулс-хедере. Кандидаты записей — строки `GET /sessions`
 * (санкционированный вход: листинга записей в API нет), плюс текущая открытая
 * запись, даже если у неё ещё нет сессий. Параметры спектра (фильтр, notch,
 * референс, длина эпохи) — форма EDF: здесь показаны для сверки, правятся в EDF.
 */
import { useQuery } from '@tanstack/react-query'
import { api } from '@/shared/api/client'
import { filterBandText } from '@/shared/lib/calcFilter'
import { useEdfParams } from '@/shared/state/edfParams'
import { filterBandOf, useEdfRecording } from '@/shared/state/edfRecording'
import { useGroupCompare } from '@/shared/state/groupCompare'
import { useGroupRun } from '@/shared/state/groupRun'
import { Panel } from '@/shared/ui/Panel'
import { SegmentedControl } from '@/shared/ui/SegmentedControl'
import { SelectField } from '@/shared/ui/SelectField'
import { TextField } from '@/shared/ui/TextField'
import { compareCandidates } from './candidates'
import { GroupRunPanel } from './GroupRunPanel'

export function GroupPanel() {
  const mode = useGroupRun((state) => state.mode)
  const setMode = useGroupRun((state) => state.setMode)
  const sessions = useQuery({
    queryKey: ['sessions', 200],
    queryFn: ({ signal }) => api.sessions({ limit: 200 }, signal),
  })
  const current = useEdfRecording((state) => state.recording)
  const candidates = compareCandidates(sessions.data?.items ?? [], current)

  const recordingIdA = useGroupCompare((state) => state.recordingIdA)
  const recordingIdB = useGroupCompare((state) => state.recordingIdB)
  const setRecordingA = useGroupCompare((state) => state.setRecordingA)
  const setRecordingB = useGroupCompare((state) => state.setRecordingB)
  const labelA = useGroupCompare((state) => state.labelA)
  const labelB = useGroupCompare((state) => state.labelB)
  const setLabelA = useGroupCompare((state) => state.setLabelA)
  const setLabelB = useGroupCompare((state) => state.setLabelB)
  const psdMethod = useGroupCompare((state) => state.psdMethod)
  const tfrEvent = useGroupCompare((state) => state.tfrEvent)
  const setTfrEvent = useGroupCompare((state) => state.setTfrEvent)
  const setPsdMethod = useGroupCompare((state) => state.setPsdMethod)

  const edfParams = useEdfParams((state) => state.params)
  const options = candidates.map((item) => ({ value: item.id, label: item.label }))
  const empty = [{ value: '', label: '— не выбрана —' }]

  return (
    <>
      <Panel
        title="Режим"
        hint="Пара — дифференциальный анализ двух записей (B9, дельты B − A). Группа — агрегаты «BA × сессии» по выборке N>2 (остаток 4.7)."
      >
        <SegmentedControl
          label="Режим"
          value={mode}
          options={[
            { value: 'pair', label: 'Пара (B − A)' },
            { value: 'group', label: 'Группа (N>2)' },
          ]}
          onChange={setMode}
        />
      </Panel>

      {mode === 'group' ? <GroupRunPanel /> : null}

      {mode === 'group' ? null : (
        <>
      <Panel
        title="Пара записей"
        hint="Дифференциальный анализ (B9): обе стороны обрабатываются одинаково (фильтр, notch, референс и длина эпохи — форма EDF), дельты считаются как B − A. Кандидаты — записи с результатами (GET /sessions) и текущая открытая запись."
      >
        <SelectField
          label="Запись A"
          value={recordingIdA ?? ''}
          options={[...empty, ...options]}
          onChange={(value) => setRecordingA(value || null)}
          hint="Первая сторона пары (например, покой)"
        />
        <TextField
          label="Ярлык A"
          value={labelA}
          onChange={setLabelA}
          placeholder="Покой"
          hint="Подпись условия в результате (до 64 символов)"
        />
        <SelectField
          label="Запись B"
          value={recordingIdB ?? ''}
          options={[...empty, ...options]}
          onChange={(value) => setRecordingB(value || null)}
          hint="Вторая сторона (например, умственная деятельность)"
        />
        <TextField
          label="Ярлык B"
          value={labelB}
          onChange={setLabelB}
          placeholder="Деятельность"
        />
        <SelectField
          label="Метод PSD"
          value={psdMethod}
          options={[
            { value: 'welch', label: 'Welch (окно 256 отсчётов)' },
            { value: 'multitaper', label: 'Multitaper (DPSS, bandwidth 4 Гц)' },
          ]}
          onChange={setPsdMethod}
          hint="N17: multitaper точнее для коротких эпох; входит в отпечаток карт разности"
        />
        <TextField
          label="Событие (TFR/ERDS)"
          value={tfrEvent}
          onChange={setTfrEvent}
          placeholder="например: STIM/5"
          hint="Необязательно: описание события записи — и рядом посчитаются ERDS-карты B − A (окно −500…+1500 мс, baseline −500…−100 мс). Пусто — сравнение чисто спектральное. Событие должно быть в обеих записях."
        />
        {recordingIdA && recordingIdA === recordingIdB ? (
          <p className="mt-2 text-sm text-warn" data-testid="compare-same-recording">
            Сравнивать нужно две разные записи.
          </p>
        ) : null}
      </Panel>

      <Panel
        title="Параметры (форма EDF)"
        hint="Сравнение обязано обработать обе стороны одинаково — ниже текущая форма EDF, она же входит в отпечаток результата. Правится в разделе EDF."
      >
        <ul className="space-y-1 text-sm text-fg-2">
          <li>{`Длина эпохи: ${edfParams.epochLengthMs} мс`}</li>
          <li>{`Фильтр: ${filterBandText(filterBandOf(edfParams))}`}</li>
          <li>{`Notch: ${edfParams.notchHz ? `${edfParams.notchHz} Гц` : 'выключен'}`}</li>
          <li>{`Референс: ${edfParams.reference}`}</li>
        </ul>
        <p className="mt-2 text-sm text-fg-2">
          Событийная нарезка PSD не участвует: спектральное сравнение режет эпохи
          фиксированной длиной; TFR/ERDS-ветка считается отдельно по событию выше.
        </p>
      </Panel>
        </>
      )}
    </>
  )
}
