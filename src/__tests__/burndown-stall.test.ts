import { describe, expect, it } from 'vitest'
import { classify } from '../agents/burndown/stall.js'

const MIN = 60_000
const START = Date.parse('2026-10-03T10:00:00.000Z')
const iso = (ms: number): string => new Date(ms).toISOString()
const claim = { phaseAt: iso(START) }
const row = { spawnedAt: START }
const LAST = START + MIN
const at = (offset: number): Date => new Date(LAST + offset)

describe('classifying a claimed agent', () => {
  it('reads idle only once the last progress is more than 5 min old', () => {
    const activity = { lastAt: iso(LAST) }

    expect(classify(activity, claim, row, at(5 * MIN))).toEqual({ state: 'working' })
    expect(classify(activity, claim, row, at(5 * MIN + 1))).toEqual({ state: 'stalled', reason: 'idle' })
  })

  it('gives a Bash call 15 min and any other tool 5 min', () => {
    const pending = (tool: string) => ({ lastAt: iso(LAST), pending: { tool, at: iso(LAST) } })

    expect(classify(pending('Bash'), claim, row, at(12 * MIN))).toEqual({ state: 'working' })
    expect(classify(pending('Bash'), claim, row, at(16 * MIN))).toEqual({
      state: 'stalled',
      reason: 'slow-tool',
    })
    expect(classify(pending('Write'), claim, row, at(6 * MIN))).toEqual({
      state: 'stalled',
      reason: 'slow-tool',
    })
  })

  it('reads an unreadable transcript as unknown and a long-missing one as silent', () => {
    const late = new Date(START + 60 * MIN)

    expect(classify('unreadable', claim, row, late)).toEqual({ state: 'unknown' })
    expect(classify('unknown', claim, row, late)).toEqual({ state: 'unknown' })
    expect(classify('missing', claim, row, new Date(START + 5 * MIN))).toEqual({ state: 'working' })
    expect(classify('missing', claim, row, new Date(START + 5 * MIN + 1))).toEqual({
      state: 'stalled',
      reason: 'silent',
    })
  })

  it('measures silence from the later of the phase start and the spawn', () => {
    const respawned = { spawnedAt: START + 10 * MIN }
    const beforeRespawn = { lastAt: iso(LAST) }

    expect(classify(beforeRespawn, claim, respawned, new Date(START + 14 * MIN))).toEqual({
      state: 'working',
    })
    expect(classify(beforeRespawn, claim, respawned, new Date(START + 16 * MIN))).toEqual({
      state: 'stalled',
      reason: 'silent',
    })
  })

  it('reads work at exactly the claim start as silent only past 5 min, with an empty activity', () => {
    expect(classify({ lastAt: iso(START) }, claim, row, new Date(START + 5 * MIN))).toEqual({
      state: 'working',
    })
    expect(classify({ lastAt: iso(START) }, claim, row, new Date(START + 5 * MIN + 1))).toEqual({
      state: 'stalled',
      reason: 'silent',
    })
    expect(classify({}, claim, row, new Date(START + 5 * MIN + 1))).toEqual({
      state: 'stalled',
      reason: 'silent',
    })
  })

  it('treats the exact slow-tool boundaries as still working', () => {
    const pending = (tool: string) => ({ lastAt: iso(LAST), pending: { tool, at: iso(LAST) } })

    expect(classify(pending('Bash'), claim, row, at(15 * MIN))).toEqual({ state: 'working' })
    expect(classify(pending('Monitor'), claim, row, at(15 * MIN + 1))).toEqual({
      state: 'stalled',
      reason: 'slow-tool',
    })
    expect(classify(pending('Write'), claim, row, at(5 * MIN))).toEqual({ state: 'working' })
    expect(classify(pending('Write'), claim, row, at(5 * MIN + 1))).toEqual({
      state: 'stalled',
      reason: 'slow-tool',
    })
  })

  it('falls back to the spawn time when phaseAt is invalid and reads unknown when both are', () => {
    const late = new Date(START + 5 * MIN + 1)

    expect(classify({}, { phaseAt: 'not a date' }, row, late)).toEqual({ state: 'stalled', reason: 'silent' })
    expect(classify({}, { phaseAt: 'not a date' }, { spawnedAt: Number.NaN }, late)).toEqual({
      state: 'unknown',
    })
  })
})
