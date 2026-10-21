/**
 * Панель «Опции раздела» «ЕмоЛаб»: паспорт открытого аудиотрека и параметры
 * анализа (правка владельца 21.10.2026): под строкой «Карта аккордов» —
 * **таблица аккордов** (время, аккорд, тип (минор/мажор) из `key_track` VAMP
 * Key Detector), параметр **«Динамический диапазон»** шкалы лучей звезды
 * (−96…0 / −60…0 / −40…0 дБ) и под строкой «Карта темпа» — чекбокс значений
 * темпа при расчёте лучей звезды; под строкой «Сегментер» — **таблица
 * сегментов** (время, имя сегмента A, B, C… из `segment_track` VAMP
 * Segmenter — визуально-слуховой контроль, в расчётах не участвует).
 * Прочие инфо-строки параметров (частота моно-файла, окно FFT, сдвиг, лучи
 * полигона, скорость плеера) убраны.
 *
 * Собственные опции раздела (набор маркеров аффективного фона, привязка к
 * стадиям препроцессинга) — отдельным срезом после уточнения постановки
 * (владелец, 20.10.2026).
 */
import type { AudioEmoSegment, AudioKeySegment } from '@/shared/api/types'
import { formatTime } from '@/shared/lib/waveformView'
import { useEmoLab } from '@/shared/state/emolab'
import { Panel } from '@/shared/ui/Panel'
import { CheckboxRow } from '@/shared/ui/CheckboxRow'
import { SelectField, type SelectOption } from '@/shared/ui/SelectField'

/**
 * Варианты динамического диапазона шкалы лучей звезды: окно `[−N … 0]` дБ →
 * `[0 … 100]` % R. −60 — шкала контракта (`db_floor` кадров «Эмо»).
 */
const DB_RANGE_OPTIONS: SelectOption<string>[] = [
  { value: '96', label: '−96…0 дБ' },
  { value: '60', label: '−60…0 дБ' },
  { value: '40', label: '−40…0 дБ' },
]

/** Строка read-параметра (как в заглушках: `ui-list-row` без контрола). */
function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="ui-list-row flex items-baseline justify-between gap-2 py-1">
      <span className="text-fg-2">{label}</span>
      <span className="text-right tabular-nums text-fg-1">{value}</span>
    </div>
  )
}

/**
 * Аккорд сегмента карты: метка QM Key Detector без слова лада
 * («C major» → «C», составная «Eb / D# minor» → «Eb / D#»); пустая метка —
 * код тональности.
 */
function chordName(segment: AudioKeySegment): string {
  const name = segment.label.replace(/\s+(major|minor)$/i, '').trim()
  return name || `код ${segment.key_code}`
}

/**
 * Тип аккорда (минор/мажор): код QM 1…12 — мажор, 13…24 — минор
 * (`AudioKeySegment`; код — источник вращения звезды), код вне 1…24 —
 * по метке, иначе прочерк.
 */
function chordType(segment: AudioKeySegment): string {
  const code = segment.key_code
  if (Number.isFinite(code) && code >= 1 && code <= 24) return code <= 12 ? 'мажор' : 'минор'
  if (/minor/i.test(segment.label)) return 'минор'
  if (/major/i.test(segment.label)) return 'мажор'
  return '—'
}

/** Таблица аккордов карты VAMP Key Detector: время, аккорд, тип (минор/мажор). */
function ChordTable({ keyTrack }: { keyTrack: readonly AudioKeySegment[] | null }) {
  if (!keyTrack || keyTrack.length === 0) {
    return (
      <p className="ui-list-row py-1 text-sm text-fg-2">
        Нет данных — карта аккордов не рассчитана (VAMP Key Detector недоступен)
      </p>
    )
  }
  return (
    <div className="mt-1 max-h-44 overflow-y-auto rounded-lg border border-border">
      <table className="w-full text-sm">
        <caption className="sr-only">
          Карта аккордов: время, аккорд, тип (минор/мажор)
        </caption>
        <thead className="sticky top-0 bg-bg-2">
          <tr className="text-fg-2">
            <th className="px-2 py-1 text-left font-medium">Время</th>
            <th className="px-2 py-1 text-left font-medium">Аккорд</th>
            <th className="px-2 py-1 text-left font-medium">Тип (минор/мажор)</th>
          </tr>
        </thead>
        <tbody>
          {keyTrack.map((segment, index) => (
            <tr key={`${segment.t_sec}-${index}`} className="border-t border-border">
              <td className="px-2 py-1 tabular-nums text-fg-1">
                {formatTime(segment.t_sec, true)}
              </td>
              <td className="px-2 py-1 text-fg-0">{chordName(segment)}</td>
              <td className="px-2 py-1 text-fg-1">{chordType(segment)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Таблица сегментов трека VAMP Segmenter: время, имя сегмента (A, B, C…). */
function SegmentTable({ segmentTrack }: { segmentTrack: readonly AudioEmoSegment[] | null }) {
  if (!segmentTrack || segmentTrack.length === 0) {
    return (
      <p className="ui-list-row py-1 text-sm text-fg-2">
        Нет данных — сегменты не рассчитаны (VAMP Segmenter недоступен)
      </p>
    )
  }
  return (
    <div className="mt-1 max-h-44 overflow-y-auto rounded-lg border border-border">
      <table className="w-full text-sm">
        <caption className="sr-only">
          Сегменты трека: время, имя сегмента (A, B, C…)
        </caption>
        <thead className="sticky top-0 bg-bg-2">
          <tr className="text-fg-2">
            <th className="px-2 py-1 text-left font-medium">Время</th>
            <th className="px-2 py-1 text-left font-medium">Имя сегмента</th>
          </tr>
        </thead>
        <tbody>
          {segmentTrack.map((segment, index) => (
            <tr key={`${segment.t_sec}-${index}`} className="border-t border-border">
              <td className="px-2 py-1 tabular-nums text-fg-1">
                {formatTime(segment.t_sec, true)}
              </td>
              <td className="px-2 py-1 text-fg-0">{segment.name}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function EmoLabPanel() {
  const filename = useEmoLab((state) => state.filename)
  const durationSec = useEmoLab((state) => state.durationSec)
  const status = useEmoLab((state) => state.status)
  const cached = useEmoLab((state) => state.cached)
  const emo = useEmoLab((state) => state.emo)
  const dbRangeDb = useEmoLab((state) => state.dbRangeDb)
  const setDbRangeDb = useEmoLab((state) => state.setDbRangeDb)
  const tempoRays = useEmoLab((state) => state.tempoRays)
  const setTempoRays = useEmoLab((state) => state.setTempoRays)

  return (
    <>
      <Panel title="Аудиотрек" hint="Паспорт открытого внешнего аудиофайла">
        {filename ? (
          <>
            <InfoRow label="Файл" value={filename} />
            <InfoRow
              label="Длительность"
              value={durationSec ? formatTime(durationSec, false) : '—'}
            />
            <InfoRow label="Источник" value="Файл пользователя (wav/mp3)" />
            <InfoRow
              label="Анализ"
              value={
                status?.status === 'succeeded'
                  ? cached
                    ? 'Готово (из кэша)'
                    : 'Готово'
                  : status?.status === 'failed'
                    ? `Ошибка: ${status.error ?? 'причина неизвестна'}`
                    : `${status?.stage ?? 'Загрузка…'} (${Math.round((status?.pct ?? 0) * 100)} %)`
              }
            />
          </>
        ) : (
          <p className="ui-list-row py-1 text-sm text-fg-2">
            Трек не открыт — нажмите «Открыть аудио» в шапке раздела
          </p>
        )}
      </Panel>
      <Panel title="Параметры анализа" hint="Шкала лучей звезды и карты VAMP (Соник Аннотатор)">
        <InfoRow label="Карта аккордов" value="VAMP Key Detector" />
        <ChordTable keyTrack={emo?.key_track ?? null} />
        <SelectField
          label="Динамический диапазон"
          value={String(dbRangeDb)}
          options={DB_RANGE_OPTIONS}
          onChange={(value) => setDbRangeDb(Number(value))}
          hint="Окно шкалы лучей звезды, дБ (0 дБ = глобальный максимум счётчиков)"
        />
        <InfoRow label="Карта темпа" value="VAMP Tempo and Beat Tracker" />
        <CheckboxRow
          label="Учитывать темп при расчёте лучей звезды"
          checked={tempoRays}
          onChange={setTempoRays}
          hint="Выкл — радиусы вершин без темп-коррекции значений VAMP"
        />
        <InfoRow label="Сегментер" value="VAMP Segmenter" />
        <SegmentTable segmentTrack={emo?.segment_track ?? null} />
        <p className="mt-2 text-xs text-fg-2">
          Опции раздела (окно анализа, набор маркеров аффективного фона, привязка к
          стадиям препроцессинга) появятся отдельным срезом.
        </p>
      </Panel>
    </>
  )
}