import { describe, expect, it } from 'vitest'
import {
  STRANDED_MAX_AGE_MS,
  STRANDED_MAX_NAMES,
  STRANDED_MAX_PER_NAME,
  StrandedReports,
} from '../broker/stranded-reports.js'
import type { DeliveredMessage } from '../protocol.js'

/** CC-337: the reports a closed connection was never pushed are bounded by age, per name and in total. */

const T0 = 1_000_000
const report = (msgId: string): DeliveredMessage => ({ msgId, from: 'w-a', text: 'Status: DONE', at: 0 })
const ids = (messages: DeliveredMessage[]): string[] => messages.map(m => m.msgId)

describe('stranded reports', () => {
  it('gives a name what it closed on, in order, once', () => {
    const stranded = new StrandedReports()
    stranded.add('coord', [report('a')], T0)
    stranded.add('coord', [report('b'), report('c')], T0)

    expect(ids(stranded.take('coord', T0))).toEqual(['a', 'b', 'c'])
    expect(stranded.take('coord', T0)).toEqual([])
  })

  it('still gives a report stranded exactly the age limit ago', () => {
    const stranded = new StrandedReports()
    stranded.add('coord', [report('a')], T0)

    expect(ids(stranded.take('coord', T0 + STRANDED_MAX_AGE_MS))).toEqual(['a'])
  })

  it('gives nothing stranded longer than the age limit, and keeps the younger ones', () => {
    const stranded = new StrandedReports()
    stranded.add('coord', [report('old')], T0)
    stranded.add('coord', [report('young')], T0 + 1_000)

    expect(ids(stranded.take('coord', T0 + STRANDED_MAX_AGE_MS + 1))).toEqual(['young'])
  })

  it('keeps only the newest reports past the per-name cap', () => {
    const stranded = new StrandedReports()
    const many = Array.from({ length: STRANDED_MAX_PER_NAME + 2 }, (_, i) => report(`id-${i}`))
    stranded.add('coord', many, T0)

    const kept = ids(stranded.take('coord', T0))
    expect(kept).toHaveLength(STRANDED_MAX_PER_NAME)
    expect(kept[0]).toBe('id-2')
    expect(kept.at(-1)).toBe(`id-${STRANDED_MAX_PER_NAME + 1}`)
  })

  it('evicts the name stranded on longest ago once it holds the most names', () => {
    const stranded = new StrandedReports()
    for (let i = 0; i < STRANDED_MAX_NAMES; i++) stranded.add(`name-${i}`, [report(`id-${i}`)], T0)
    stranded.add('name-0', [report('again')], T0)
    stranded.add('newcomer', [report('new')], T0)

    expect(stranded.take('name-1', T0)).toEqual([])
    expect(ids(stranded.take('name-0', T0))).toEqual(['id-0', 'again'])
    expect(ids(stranded.take('newcomer', T0))).toEqual(['new'])
    expect(ids(stranded.take(`name-${STRANDED_MAX_NAMES - 1}`, T0))).toEqual([`id-${STRANDED_MAX_NAMES - 1}`])
  })

  it('records nothing for a connection that closed on nothing', () => {
    const stranded = new StrandedReports()
    for (let i = 0; i < STRANDED_MAX_NAMES; i++) stranded.add(`name-${i}`, [report(`id-${i}`)], T0)
    stranded.add('empty', [], T0)

    expect(ids(stranded.take('name-0', T0))).toEqual(['id-0'])
  })
})
