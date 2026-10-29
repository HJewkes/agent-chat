import { describe, expect, it } from 'vitest'
import { joinShadow, renderJoin, type ShadowRow, type Turn } from '../agents/seats/seat-watch-join.js'

const shadow = (seat: string, at: string, decision: ShadowRow['decision']): ShadowRow => ({
  seat,
  at,
  decision,
})

const turn = (seat: string, ts: string, over: Partial<Turn> = {}): Turn => ({
  seat,
  ts,
  trig: 'fallback-wake',
  usd: 1,
  ...over,
})

describe('seat-watch join', () => {
  const rows = [
    shadow('seat-a', '2026-01-05T10:00:00Z', 'wake'),
    shadow('seat-a', '2026-01-05T10:15:00Z', 'skip'),
    shadow('seat-b', '2026-01-05T10:00:00Z', 'skip'),
  ]

  it('fills the confusion matrix from the newest row before each gated turn', () => {
    const turns = [
      turn('seat-a', '2026-01-05T10:05:00Z', { state_change: true }),
      turn('seat-a', '2026-01-05T10:20:00Z', { outcome: 'log-only', usd: 0.5 }),
      turn('seat-b', '2026-01-05T10:10:00Z', { outcome: 'dispatch', usd: 2 }),
      turn('seat-b', '2026-01-05T10:11:00Z', { trig: 'worker-report', state_change: true }),
    ]

    const report = joinShadow(rows, turns)

    expect(report.matrix).toEqual({ tp: 1, fn: 1, fp: 0, tn: 1 })
    expect(report.recall).toBe(0.5)
    expect(report.avoided).toEqual({ wakes: 2, usd: 2.5, missedUsd: 2 })
  })

  it('counts a gated turn with no row in the window before it as unmatched', () => {
    const report = joinShadow(rows, [
      turn('seat-a', '2026-01-05T11:00:00Z'),
      turn('seat-c', '2026-01-05T10:01:00Z'),
    ])

    expect(report.unmatched).toBe(2)
    expect(report.matched).toBe(0)
    expect(report.recall).toBeNull()
  })

  it('prints recall against the 95% target', () => {
    const report = joinShadow(rows, [turn('seat-a', '2026-01-05T10:05:00Z', { state_change: true })])

    expect(renderJoin(report)).toContain('recall on state-changing wakes: 100.0% (target 95%)')
  })
})
