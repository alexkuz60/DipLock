/** Паспорт исследования: изменения считаются черновиком до явного сохранения. */
import { useState } from 'react'
import type {
  ConsiliumCase,
  ConsiliumCaseCreate,
  ConsiliumCaseUpdate,
  ConsiliumRecording,
} from '@/shared/api/types'
import { Button } from '@/shared/ui/Button'
import { CheckboxRow } from '@/shared/ui/CheckboxRow'
import { SelectField } from '@/shared/ui/SelectField'
import { TextField } from '@/shared/ui/TextField'
import { TextArea } from './common'
import { directions } from './options'

export function CaseForm({
  current,
  recordings,
  pending,
  onSave,
  onCancel,
}: {
  current?: ConsiliumCase
  recordings: ConsiliumRecording[]
  pending: boolean
  onSave: (payload: ConsiliumCaseCreate | ConsiliumCaseUpdate) => void
  onCancel: () => void
}) {
  const [title, setTitle] = useState(current?.title ?? '')
  const [question, setQuestion] = useState(current?.question ?? '')
  const [codes, setCodes] = useState(current?.subject_codes?.join(', ') ?? '')
  const [direction, setDirection] = useState<ConsiliumCase['direction']>(
    current?.direction ?? 'other',
  )
  const [recordingIds, setRecordingIds] = useState<string[]>(current?.recording_ids ?? [])
  const allRecordings = [
    ...recordings,
    ...(current?.recording_ids ?? [])
      .filter((id) => !recordings.some((recording) => recording.id === id))
      .map((id) => ({ id, filename: 'Источник недоступен', sfreq: null, duration_sec: null })),
  ]

  function save() {
    const payload: ConsiliumCaseCreate = {
      request_id: crypto.randomUUID(),
      title: title.trim(),
      question: question.trim(),
      direction,
      subject_codes: codes
        .split(',')
        .map((code) => code.trim())
        .filter(Boolean),
      recording_ids: recordingIds,
    }
    onSave(
      current ? { ...payload, expected_version: current.version, status: current.status } : payload,
    )
  }

  return (
    <section
      aria-label="Паспорт исследования"
      className="space-y-3 rounded-xl border border-border p-4"
    >
      <TextField
        label="Название исследования"
        value={title}
        onChange={setTitle}
        disabled={pending}
      />
      <TextArea
        label="Исследовательский вопрос"
        value={question}
        onChange={setQuestion}
        disabled={pending}
      />
      <SelectField
        label="Направление"
        value={direction}
        onChange={setDirection}
        options={[...directions]}
        disabled={pending}
      />
      <TextField
        label="Коды добровольцев"
        hint="Обезличенные коды через запятую, без ФИО"
        value={codes}
        onChange={setCodes}
        disabled={pending}
      />
      <fieldset disabled={pending}>
        <legend className="text-sm text-fg-2">Связанные записи</legend>
        {allRecordings.length ? (
          allRecordings.map((recording) => (
            <CheckboxRow
              key={recording.id}
              label={`${recording.filename ?? recording.id} · ${recording.id}`}
              checked={recordingIds.includes(recording.id)}
              onChange={(checked) =>
                setRecordingIds(
                  checked
                    ? [...recordingIds, recording.id]
                    : recordingIds.filter((id) => id !== recording.id),
                )
              }
            />
          ))
        ) : (
          <p className="text-sm text-fg-2">
            Можно начать с вопроса и рассказа, а запись связать позднее.
          </p>
        )}
      </fieldset>
      <div className="flex gap-2">
        <Button
          variant="primary"
          disabled={pending || !title.trim() || !question.trim()}
          onClick={save}
        >
          {current ? 'Сохранить паспорт' : 'Создать исследование'}
        </Button>
        <Button disabled={pending} onClick={onCancel}>
          Отмена
        </Button>
      </div>
    </section>
  )
}
