/**
 * Панель «Опции раздела» «ЕмоЛаб»: паспорт открытого аудиотрека и параметры
 * анализа (правка владельца 21.10.2026): под строкой «Карта аккордов» —
 * **таблица аккордов** (время, аккорд, тип (минор/мажор) из `key_track` VAMP
 * Key Detector), под строкой «Карта темпа» — чекбокс значений
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
import { SegmentedControl, type SegmentedOption } from '@/shared/ui/SegmentedControl'
import type { RadialScaleKey } from '../neuromusic/radialDbRange'

/** Опции «Закона вращения звезды» (хроматический — дефолт, гармонический). */
const ROTATION_LAW_OPTIONS: SegmentedOption<'chromatic' | 'harmonic'>[] = [
  {
    value: 'chromatic',
    label: 'Хроматический',
    title: 'Полутоны от C мажор / A минор: мажор — против часовой, минор — по часовой',
  },
  {
    value: 'harmonic',
    label: 'Гармонический',
    title: 'Позиция аккорда в квинтово-квартовом круге: смещение в пределах одного сектора',
  },
]

/**
 * Опции «Динамического диапазона» — шкала радиусов вершин/доминанты:
 * дБ-окно −40/−60 (конечная оптимизация после расчёта звезды).
 */
const RADIAL_SCALE_OPTIONS: SegmentedOption<RadialScaleKey>[] = [
  { value: 'db-40', label: '−40 дБ', title: 'Окно −40…0 дБ: тихие значения раздвигаются сильнее' },
  { value: 'db-60', label: '−60 дБ', title: 'Окно −60…0 дБ: дефолт, ближе к шкале контракта' },
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
 * Аккорд сегмента карты: точное имя Chordino как есть («G7», «Dm6», «Ebm6»,
 * «Gaug» — постановка 21.10.2026: в таблицу идут полные названия аккордов);
 * пустая метка — код тональности.
 */
function chordName(segment: AudioKeySegment): string {
  return segment.label.trim() || `код ${segment.key_code}`
}

/**
 * Тип аккорда (минор/мажор): код тональности 1…12 — мажор, 13…24 — минор
 * (`AudioKeySegment`; код — корневая нота + лад, источник вращения звезды),
 * код вне 1…24 — прочерк.
 */
function chordType(segment: AudioKeySegment): string {
  const code = segment.key_code
  if (Number.isFinite(code) && code >= 1 && code <= 24) return code <= 12 ? 'мажор' : 'минор'
  return '—'
}

/** Таблица аккордов карты VAMP Chordino: время, аккорд, тип (минор/мажор). */
function ChordTable({ keyTrack }: { keyTrack: readonly AudioKeySegment[] | null }) {
  if (!keyTrack || keyTrack.length === 0) {
    return (
      <p className="ui-list-row py-1 text-sm text-fg-2">
        Нет данных — карта аккордов не рассчитана (VAMP Chordino недоступен)
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
  const tempoRays = useEmoLab((state) => state.tempoRays)
  const setTempoRays = useEmoLab((state) => state.setTempoRays)
  const rotationLaw = useEmoLab((state) => state.rotationLaw)
  const setRotationLaw = useEmoLab((state) => state.setRotationLaw)
  const radialScale = useEmoLab((state) => state.radialScale)
  const setRadialScale = useEmoLab((state) => state.setRadialScale)

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
        <SegmentedControl
          label="Закон вращения звезды"
          value={rotationLaw}
          onChange={setRotationLaw}
          options={ROTATION_LAW_OPTIONS}
          hint="Хроматический — по полутонам; гармонический — по позиции аккорда в квинтово-квартовом круге"
        />
        <SegmentedControl
          label="Динамический диапазон"
          value={radialScale}
          onChange={setRadialScale}
          options={RADIAL_SCALE_OPTIONS}
          hint="Шкала радиусов вершин и доминанты — конечная оптимизация после расчёта звезды (дБ-окно)"
        />
        <InfoRow label="Карта аккордов" value="VAMP Chordino" />
        <ChordTable keyTrack={emo?.key_track ?? null} />
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