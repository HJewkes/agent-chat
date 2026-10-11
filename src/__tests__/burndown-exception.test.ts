import { describe, expect, it } from 'vitest'
import { classOf, routeOf } from '../agents/burndown/exception.js'
import type { Claim } from '../agents/burndown/ledger.js'

/** CC-648: the exception classes and the route dial. */

const ALL_TRIAGE = { stalled: 'triage', failed: 'triage' } as const
const OWNER = { stalled: 'owner', failed: 'owner' } as const

const claim = (patch: Partial<Claim> = {}): Claim => ({
  taskId: 'CC-1',
  initiative: 'demo',
  spawnedAt: '2026-09-28T11:00:00.000Z',
  phase: 'implementing',
  phaseAt: '2026-09-28T11:00:00.000Z',
  ...patch,
})

describe('routeOf', () => {
  it('sends a gate-trip to the owner even with every dial at triage and triage ready', () => {
    expect(routeOf('gate-trip', ALL_TRIAGE, true).route).toBe('owner')
  })

  it('sends a legacy claim with a stall reason and no class to the owner with every dial at triage', () => {
    const legacy = claim({ stalledReason: 'implementing past its timeout' })

    expect(routeOf(classOf(legacy), ALL_TRIAGE, true).route).toBe('owner')
  })

  it('sends a class whose dial is triage to triage when triage is ready', () => {
    expect(routeOf('failed', { stalled: 'owner', failed: 'triage' }, true)).toEqual({ route: 'triage' })
  })

  it('falls back to the owner with a reason when the dial is triage but triage is not ready', () => {
    expect(routeOf('stalled', ALL_TRIAGE, false)).toEqual({
      route: 'owner',
      reason: 'triage is not ready',
    })
  })

  it('keeps a class whose dial is owner with the owner', () => {
    expect(routeOf('failed', OWNER, true).route).toBe('owner')
  })
})

describe('classOf', () => {
  it('reads the class a stall recorded', () => {
    expect(classOf(claim({ stalledReason: 'x', stalledClass: 'failed' }))).toBe('failed')
  })
})
