/**
 * Диалог «Паспорт» раздела EDF: просмотр и правка метаданных сессии.
 *
 * Паспорт — данные для БД (таблица `sessions`), а не для EDF-файла: правка не
 * меняет исходник, не делает запросов и не запускает обработку. Пока анализ не
 * запущен, значения живут в состоянии раздела (`edfRecording.passport`).
 *
 * Правка идёт в черновик: в стор значения уходят только по кнопке «Сохранить»,
 * поэтому «Отмена»/Esc действительно ничего не меняют.
 */
import { X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useEdfRecording, type SessionPassport } from '@/shared/state/edfRecording'
import { Button } from '@/shared/ui/Button'
import { FieldRow } from '@/shared/ui/FieldRow'
import { InfoRow } from '@/shared/ui/StateViews'

export type SessionPassportDialogProps = {
  open: boolean
  onClose: () => void
}

const INPUT_CLASS =
  'w-full rounded-lg border border-border bg-bg-2 px-2.5 py-1.5 text-sm text-fg-0 placeholder:text-fg-2'

const FIELDS: { key: keyof SessionPassport; label: string; hint?: string; textarea?: boolean }[] = [
  { key: 'title', label: 'Сессия', hint: 'Название или код — по нему сессия ищется в групповом анализе' },
  { key: 'subject', label: 'Испытуемый', hint: 'Имя или обезличенный код испытуемого' },
  { key: 'recordedOn', label: 'Дата записи' },
  { key: 'notes', label: 'Заметки', textarea: true },
]

export function SessionPassportDialog({ open, onClose }: SessionPassportDialogProps) {
  const recording = useEdfRecording((state) => state.recording)
  const passport = useEdfRecording((state) => state.passport)
  const setPassport = useEdfRecording((state) => state.setPassport)
  const [draft, setDraft] = useState<SessionPassport>(passport)
  const firstFieldRef = useRef<HTMLInputElement>(null)

  // Открытие: черновик — из сохранённого паспорта, фокус в первое поле
  useEffect(() => {
    if (!open) return
    setDraft(passport)
    firstFieldRef.current?.focus()
  }, [open, passport])

  useEffect(() => {
    if (!open) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  if (!open) return null

  function save() {
    setPassport(draft)
    onClose()
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-bg-0/70 p-6"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="edf-passport-title"
        className="max-h-full w-full max-w-xl overflow-y-auto rounded-xl border border-border bg-bg-1 p-5 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <h2 id="edf-passport-title" className="text-lg font-semibold text-fg-0">
            Паспорт сессии
          </h2>
          <Button
            variant="ghost"
            className="ml-auto px-2 py-1"
            aria-label="Закрыть паспорт"
            icon={<X className="size-4" />}
            onClick={onClose}
          >
            Закрыть
          </Button>
        </div>

        <p className="mt-1 text-sm text-fg-2">
          EDF-файл — исходник: правка паспорта его не меняет. Значения — метаданные для БД, они
          попадут в таблицу сессий при запуске анализа.
        </p>

        <div className="mt-3 rounded-lg border border-border bg-bg-2 px-3 py-2">
          <InfoRow label="Файл" value={recording?.filename ?? 'не загружен'} mono />
          <InfoRow label="Каналов" value={recording?.n_channels ?? null} />
          <InfoRow label="Частота дискретизации" value={recording ? `${recording.sfreq} Гц` : null} mono />
          <InfoRow label="Длина сессии" value={recording ? `${recording.duration_sec} с` : null} mono />
          <InfoRow
            label="Единицы"
            value={
              recording
                ? recording.units_autoscaled
                  ? 'µV (авто-пересчёт)'
                  : (recording.edf_units ?? 'из файла')
                : null
            }
          />
        </div>

        <div className="mt-3">
          {FIELDS.map((field, index) => (
            <FieldRow key={field.key} label={field.label} htmlFor={`passport-${field.key}`} hint={field.hint}>
              {field.textarea ? (
                <textarea
                  id={`passport-${field.key}`}
                  rows={3}
                  className={INPUT_CLASS}
                  value={draft[field.key]}
                  placeholder="Условия записи, особенности монтажа…"
                  onChange={(event) => setDraft({ ...draft, [field.key]: event.target.value })}
                />
              ) : (
                <input
                  id={`passport-${field.key}`}
                  ref={index === 0 ? firstFieldRef : undefined}
                  type={field.key === 'recordedOn' ? 'date' : 'text'}
                  className={INPUT_CLASS}
                  value={draft[field.key]}
                  onChange={(event) => setDraft({ ...draft, [field.key]: event.target.value })}
                />
              )}
            </FieldRow>
          ))}
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button variant="primary" onClick={save}>
            Сохранить
          </Button>
        </div>
      </div>
    </div>
  )
}
