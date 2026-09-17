/**
 * Тесты каналов раздела «ЭЭГ» (`shared/lib/eegChannels.ts`, срез 5+).
 *
 * Проверяется то, что видит пользователь: список каналов с виртуальными миксами,
 * подпись микса, откат «сохранённого» канала, которого в записи нет, и полоса
 * трека для микса (среднее огибающих группы — пирамида отдаёт её по электродам).
 */
import { describe, expect, it } from 'vitest'
import type { SignalFrame } from './signalFrame'
import {
  MIX_PREFIX,
  channelFrame,
  channelLabel,
  channelOptions,
  channelSourceChannels,
  isMixChannel,
  resolveChannel,
} from './eegChannels'
import { recordingFixture } from '@/test/fixtures'

/** Кадр из трёх электродов по три корзины: арифметика среднего проверяема в уме. */
function frameFixture(): SignalFrame {
  return {
    sourceId: 'rec-1',
    channels: ['Fp1', 'Fp2', 'F3'],
    durationSec: 3,
    times: new Float32Array([1, 2, 3]),
    min: {
      Fp1: new Float32Array([-1, -2, -3]),
      Fp2: new Float32Array([-3, -4, -5]),
      F3: new Float32Array([-5, -6, -7]),
    },
    max: {
      Fp1: new Float32Array([1, 2, 3]),
      Fp2: new Float32Array([3, 4, 5]),
      F3: new Float32Array([5, 6, 7]),
    },
    decimated: true,
    level: 1,
  }
}

describe('каналы раздела «ЭЭГ»', () => {
  it('ставит электроды первыми, миксы — в конец и с явной подписью', () => {
    const options = channelOptions(recordingFixture)

    expect(options.slice(0, 3).map((option) => option.value)).toEqual(['Fp1', 'Fp2', 'F3'])
    const mix = options.find((option) => option.value === `${MIX_PREFIX}frontal`)
    expect(mix?.label).toBe('Микс: Лобные')
    // Порядок миксов — как в паспорте (все → полушария → области)
    expect(options.at(-1)?.value).toBe(`${MIX_PREFIX}occipital`)
  })

  it('без записи показывает каналы демо-кадра: миксы считать не из чего', () => {
    const options = channelOptions(null, ['Fp1', 'Fp2'])

    expect(options).toEqual([
      { value: 'Fp1', label: 'Fp1' },
      { value: 'Fp2', label: 'Fp2' },
    ])
  })

  it('откатывает сохранённый канал, которого нет в записи, на первый доступный', () => {
    expect(resolveChannel(recordingFixture, [], 'F4')).toBe('F4')
    expect(resolveChannel(recordingFixture, [], `${MIX_PREFIX}occipital`)).toBe(
      `${MIX_PREFIX}occipital`,
    )
    // Микс чужой записи: сервер не посчитает такую группу — берём первый канал
    expect(resolveChannel(recordingFixture, [], `${MIX_PREFIX}unknown`)).toBe('Fp1')
    expect(resolveChannel(recordingFixture, [], null)).toBe('Fp1')
    expect(resolveChannel(null, ['C3'], null)).toBe('C3')
    expect(resolveChannel(null, [], null)).toBe('')
  })

  it('подписывает микс по-русски, а электрод — как есть', () => {
    expect(channelLabel(recordingFixture, `${MIX_PREFIX}temporal`)).toBe('Микс: Височные')
    expect(channelLabel(recordingFixture, 'Fp1')).toBe('Fp1')
    expect(isMixChannel(`${MIX_PREFIX}all`)).toBe(true)
    expect(isMixChannel('Fp1')).toBe(false)
  })

  it('за миксом стоят каналы группы, за электродом — он сам', () => {
    expect(channelSourceChannels(recordingFixture, `${MIX_PREFIX}occipital`)).toEqual([
      'O1',
      'O2',
      'Oz',
    ])
    expect(channelSourceChannels(recordingFixture, 'C3')).toEqual(['C3'])
    expect(channelSourceChannels(null, 'C3')).toEqual(['C3'])
  })

  it('усредняет огибающую микса и не трогает кадр обычного канала', () => {
    const frame = frameFixture()

    // Электрод: тот же объект — компонент трека не должен перерисовываться зря
    expect(channelFrame(frame, 'Fp1', ['Fp1'])).toBe(frame)

    const mix = channelFrame(frame, `${MIX_PREFIX}frontal`, ['Fp1', 'Fp2', 'F3'])
    expect(Array.from(mix.min[`${MIX_PREFIX}frontal`] as Float32Array)).toEqual([-3, -4, -5])
    expect(Array.from(mix.max[`${MIX_PREFIX}frontal`] as Float32Array)).toEqual([3, 4, 5])
    // Кадр записи не мутируется: его читают и другие половины раздела
    expect(Array.from(frame.min.Fp1 as Float32Array)).toEqual([-1, -2, -3])
  })

  it('не подменяет кадр, если каналов микса в нём нет', () => {
    const frame = frameFixture()

    expect(channelFrame(frame, `${MIX_PREFIX}occipital`, ['O1', 'O2'])).toBe(frame)
    expect(channelFrame(frame, `${MIX_PREFIX}parietal`, [])).toBe(frame)
  })
})
