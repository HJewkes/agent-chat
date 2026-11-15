import { describe, expect, it } from 'vitest'
import { diffNames, gateStep, type GateState } from '../agents/seats/wake-gate.js'

const MIN = 60_000
const maxQuietMs = 120 * MIN
const seeded = (fp: Record<string, string>, lastEmitAtMs = 0): GateState => ({ fp, lastEmitAtMs })

describe('wake gate', () => {
  it('stays silent on the first poll, which only seeds state', () => {
    const fp = { 'repo@main': 'aaa' }

    const step = gateStep({ prev: undefined, fp, nowMs: 5 * MIN, maxQuietMs })

    expect(step.emit).toBeUndefined()
    expect(step.state).toEqual({ fp, lastEmitAtMs: 5 * MIN })
  })

  it('stays silent while the fingerprint is unchanged within max-quiet', () => {
    const fp = { 'repo@main': 'aaa', '/runs/state.json': '100:4' }

    const steps = [20, 40, 60, 80, 100, 119].map(m =>
      gateStep({ prev: seeded(fp), fp: { ...fp }, nowMs: m * MIN, maxQuietMs }),
    )

    expect(steps.map(s => s.emit)).toEqual(Array(6).fill(undefined))
  })

  it('emits one line naming only the key that changed', () => {
    const prev = seeded({ 'repo@main': 'aaa', '/runs/state.json': '100:4' })

    const step = gateStep({
      prev,
      fp: { 'repo@main': 'bbb', '/runs/state.json': '100:4' },
      nowMs: 20 * MIN,
      maxQuietMs,
    })

    expect(step.emit).toBe('changed: repo@main aaa -> bbb')
    expect(step.state.lastEmitAtMs).toBe(20 * MIN)
  })

  it('emits one quiet line after max-quiet and restarts the quiet clock', () => {
    const fp = { 'repo@main': 'aaa' }

    const quiet = gateStep({ prev: seeded(fp), fp, nowMs: 120 * MIN, maxQuietMs })
    const after = gateStep({ prev: quiet.state, fp, nowMs: 140 * MIN, maxQuietMs })

    expect(quiet.emit).toBe('quiet: nothing changed in 120 min')
    expect(after.emit).toBeUndefined()
  })

  it('counts a watched path that disappears as a change', () => {
    const prev = seeded({ '/runs/state.json': '100:4' })

    const step = gateStep({ prev, fp: { '/runs/state.json': 'absent' }, nowMs: MIN, maxQuietMs })

    expect(step.emit).toBe('changed: /runs/state.json 100:4 -> absent')
  })

  it('names keys that were added or removed', () => {
    expect(diffNames({ a: '1', b: '2' }, { b: '2', c: '3' })).toEqual(['a', 'c'])
  })
})
