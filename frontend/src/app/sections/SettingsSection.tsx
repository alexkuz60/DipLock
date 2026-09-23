/**
 * Настройки приложения: интерфейс (масштаб шрифта, плотность списков) и
 * параметры расчёта (только чтение — источник истины `backend/.env`).
 */
import { useQuery } from '@tanstack/react-query'
import { RotateCcw } from 'lucide-react'
import { api } from '@/shared/api/client'
import {
  applyUiPreferences,
  useUiStore,
  type Density,
  type FontScale,
} from '@/shared/state/uiStore'
import { Button } from '@/shared/ui/Button'
import { cx } from '@/shared/ui/cx'
import { Panel } from '@/shared/ui/Panel'
import { InfoRow, LoadingBlock } from '@/shared/ui/StateViews'

const FONT_SCALES: { value: FontScale; label: string; hint: string }[] = [
  { value: 'normal', label: 'Обычный', hint: '16 px' },
  { value: 'large', label: 'Крупный', hint: '18 px' },
  { value: 'xlarge', label: 'Очень крупный', hint: '20 px' },
]

const DENSITIES: { value: Density; label: string; hint: string }[] = [
  { value: 'normal', label: 'Обычная', hint: 'стандартные отступы' },
  { value: 'compact', label: 'Плотная', hint: 'больше строк на экране' },
]

function ChoiceRow<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string
  options: { value: T; label: string; hint: string }[]
  value: T
  onChange: (next: T) => void
}) {
  return (
    <div className="ui-list-row flex items-center gap-3 py-2">
      <span className="w-32 shrink-0 text-sm text-fg-2">{label}</span>
      <div className="flex gap-2">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            title={option.hint}
            aria-pressed={value === option.value}
            onClick={() => onChange(option.value)}
            className={cx(
              'rounded-lg border px-3 py-1.5 text-sm transition-colors',
              value === option.value
                ? 'border-accent/60 bg-accent-soft text-fg-0'
                : 'border-border bg-bg-2 text-fg-1 hover:bg-bg-3 hover:text-fg-0',
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  )
}

export function SettingsSection() {
  const fontScale = useUiStore((state) => state.fontScale)
  const density = useUiStore((state) => state.density)
  const setFontScale = useUiStore((state) => state.setFontScale)
  const setDensity = useUiStore((state) => state.setDensity)
  const resetUiState = useUiStore((state) => state.resetUiState)

  const meta = useQuery({
    queryKey: ['meta'],
    queryFn: ({ signal }) => api.meta(signal),
    staleTime: 60_000,
    retry: false,
  })

  return (
    <div className="grid max-w-4xl grid-cols-1 gap-4 p-4">
      <Panel title="Интерфейс" hint="Настройки сохраняются в localStorage браузера">
        <ChoiceRow
          label="Масштаб текста"
          options={FONT_SCALES}
          value={fontScale}
          onChange={(next) => {
            setFontScale(next)
            applyUiPreferences(next, density)
          }}
        />
        <ChoiceRow
          label="Плотность"
          options={DENSITIES}
          value={density}
          onChange={(next) => {
            setDensity(next)
            applyUiPreferences(fontScale, next)
          }}
        />
        <div className="ui-list-row flex items-center gap-3 py-2">
          <span className="w-32 shrink-0 text-sm text-fg-2">Состояние панелей</span>
          <Button
            icon={<RotateCcw className="size-4" />}
            onClick={() => resetUiState()}
          >
            Сбросить раскладку разделов
          </Button>
        </div>
      </Panel>

      <Panel
        title="Параметры расчёта"
        hint="Значения задаются в backend/.env и применяются ко всем расчётам. Редактирование из UI не предусмотрено: конфигурация должна иметь один источник истины (сервер/Docker)."
      >
        {meta.isPending ? <LoadingBlock /> : null}
        {meta.data ? (
          <>
            <InfoRow label="Диапазоны, Гц" value={JSON.stringify(meta.data.freq_bands)} mono />
            <InfoRow label="Длины эпох, мс" value={meta.data.epoch_lengths_ms.join(', ')} mono />
            <InfoRow label="decim фитинга" value={meta.data.dipole_fit_decim} mono />
            <InfoRow label="max эпох" value={meta.data.dipole_fit_max_epochs} mono />
            <InfoRow label="z-порог артефактов" value={meta.data.artifact_thresholds.z_score_threshold} mono />
            <InfoRow
              label="peak-to-peak, мкВ"
              value={meta.data.artifact_thresholds.peak_to_peak_threshold_uv}
              mono
            />
            <InfoRow label="параллельных задач" value={meta.data.max_concurrent_jobs} mono />
          </>
        ) : null}
      </Panel>

      <Panel title="Данные и окружение">
        {meta.data ? (
          <>
            <InfoRow label="subjects_dir" value={meta.data.subjects_dir} mono />
            <InfoRow label="trans" value={meta.data.fsaverage_trans} mono />
            <InfoRow label="upload_dir" value={meta.data.upload_dir} mono />
            <InfoRow label="results_dir" value={meta.data.results_dir} mono />
            <InfoRow label="cache_dir" value={meta.data.cache_dir} mono />
            <InfoRow label="surface version" value={meta.data.surface_version} mono />
            <InfoRow label="БД" value={meta.data.database_backend} mono />
          </>
        ) : null}
      </Panel>
    </div>
  )
}
