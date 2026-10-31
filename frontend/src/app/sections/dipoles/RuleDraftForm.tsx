/**
 * Форма «Черновик правила из профиля» (Т5): кандидаты условий без авто-вердикта.
 *
 * Источник — признаки пробы (`POST /hypotheses/probe-context`) текущей записи
 * и активной полосы: шаблон берёт только измеренное, пороги — округлённые
 * наблюдения. `min_share` не заполняется — проверка остаётся `descriptive`.
 * Сохранение в библиотеку — по кнопке (Т4), правило правится исследователем.
 */
import { useState } from 'react'
import {
  draftRule,
  probeContext,
  saveHypothesis,
} from '@/shared/api/hypotheses'
import { apiErrorText } from '@/shared/api/client'
import type { HypothesisCondition, HypothesisSave } from '@/shared/api/types'
import { useEdfRecording } from '@/shared/state/edfRecording'
import { Button } from '@/shared/ui/Button'
import { TextField } from '@/shared/ui/TextField'

function conditionLabel(condition: HypothesisCondition): string {
  return `${condition.feature} ${condition.op} ${condition.value}`
}

export function RuleDraftForm({ bandKey }: { bandKey: string | null }) {
  const recording = useEdfRecording((state) => state.recording)
  const recordingId = recording?.recording_id ?? null
  const [label, setLabel] = useState('')
  const [draft, setDraft] = useState<HypothesisSave | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedNote, setSavedNote] = useState<string | null>(null)

  async function makeDraft() {
    if (!recordingId || !bandKey) return
    setBusy(true)
    setError(null)
    setSavedNote(null)
    try {
      const context = await probeContext([recordingId], bandKey)
      const profile = context.records[0]?.features ?? {}
      const result = await draftRule({
        features: profile,
        band_key: bandKey,
        recording_ids: [recordingId],
        label: label.trim() || null,
      })
      setDraft(result)
    } catch (cause) {
      setError(apiErrorText(cause))
    } finally {
      setBusy(false)
    }
  }

  async function saveDraft() {
    if (!draft) return
    setBusy(true)
    setError(null)
    try {
      const row = await saveHypothesis(draft)
      setSavedNote(`Сохранено в библиотеку (id ${row.id})`)
    } catch (cause) {
      setError(apiErrorText(cause))
    } finally {
      setBusy(false)
    }
  }

  if (!recordingId || !bandKey) {
    return (
      <p className="mt-2 text-xs text-fg-2" data-testid="rule-draft-empty">
        Черновик правила — после расчёта пакета (нужны запись и активная полоса).
      </p>
    )
  }

  return (
    <div className="mt-3" data-testid="rule-draft-form">
      <p className="text-sm font-medium">Черновик правила из профиля (Т5)</p>
      <p className="mt-1 text-xs text-fg-2">
        Кандидаты условий из измеренных признаков пробы; пороги — округлённые
        наблюдения, <b>не</b> эталон методики. Без порога подтверждения —
        проверка остаётся описательной.
      </p>
      <div className="mt-2">
        <TextField
          label="Имя черновика"
          value={label}
          onChange={setLabel}
          placeholder="например: CCW ≥ 80 % в γ"
        />
      </div>
      <div className="mt-2 flex gap-2">
        <Button onClick={() => void makeDraft()} disabled={busy}>
          {busy ? 'Считаю…' : 'Собрать черновик'}
        </Button>
        {draft ? (
          <Button onClick={() => void saveDraft()} disabled={busy}>
            Сохранить в библиотеку
          </Button>
        ) : null}
      </div>
      {error ? <p className="mt-2 text-sm text-warn">{error}</p> : null}
      {savedNote ? (
        <p className="mt-2 text-sm text-fg-2">{savedNote}</p>
      ) : null}
      {draft ? (
        <ul
          className="mt-2 space-y-1 text-sm text-fg-1"
          data-testid="rule-draft-conditions"
        >
          {draft.conditions.map((condition) => (
            <li key={conditionLabel(condition)} className="tabular-nums">
              {conditionLabel(condition)}
            </li>
          ))}
          <li className="text-xs text-fg-2">
            {`полоса ${draft.band_key} · выборка: ${draft.recording_ids.join(', ')} · min_share не задан`}
          </li>
        </ul>
      ) : null}
    </div>
  )
}
