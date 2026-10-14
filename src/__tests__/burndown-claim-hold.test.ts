import { describe, expect, it } from 'vitest'
import { claimHold, holdsSlot, roleOf, STALL_AGED_MS, stallAgeMs } from '../agents/burndown/claim-hold.js'
import type { Claim } from '../agents/burndown/ledger.js'

const claim = (patch: Partial<Claim> = {}): Claim => ({
  taskId: 'T-1',
  initiative: 'init',
  agentName: 'bd-t-1',
  spawnedAt: '2026-10-14T08:00:00.000Z',
  phase: 'implementing',
  phaseAt: '2026-10-14T08:00:00.000Z',
  ...patch,
})

const STALE = { class: 'retry-spent', proposed: 'release', since: '2026-10-14T09:00:00.000Z' } as const
const alive = () => true
const gone = () => false

describe('claimHold with a roster', () => {
  it('holds a lane and its task while its agent may run', () => {
    expect(claimHold(claim(), alive)).toBe('lane + task')
  })

  it('holds only its task once its agent is gone', () => {
    expect(claimHold(claim(), gone)).toBe('task')
  })

  it('holds only its task in a phase with no role, even with a live agent', () => {
    expect(claimHold(claim({ phase: 'awaiting-merge' }), alive)).toBe('task')
    expect(claimHold(claim({ phase: 'shepherding' }), alive)).toBe('task')
  })

  it('keeps its lane while a ladder respawn is pending for a gone agent', () => {
    const respawning = claim({
      respawn: { code: 'spawn-never-landed', occurrence: '2026-10-14T08:00:00.000Z' },
    })
    expect(claimHold(respawning, gone)).toBe('lane + task')
  })
})

describe('claimHold with no roster', () => {
  it('holds only its task when the claim was classified stale', () => {
    expect(claimHold(claim({ stalledReason: 'x', stale: STALE }))).toBe('task')
  })

  it('holds a lane and its task when the claim is not stale', () => {
    expect(claimHold(claim({ stalledReason: 'x' }))).toBe('lane + task')
  })

  it('keeps its lane when a respawn began after the stale classification', () => {
    const respawning = claim({
      stale: STALE,
      respawn: { code: 'spawn-never-landed', occurrence: '2026-10-14T08:00:00.000Z' },
    })
    expect(claimHold(respawning)).toBe('lane + task')
  })
})

describe('roleOf and holdsSlot moved from seat-plan', () => {
  it('counts a spawning claim toward the role it lands in', () => {
    expect(roleOf(claim({ phase: 'spawning', nextPhase: 'reviewing' }))).toBe('reviewers')
    expect(roleOf(claim({ phase: 'spawning' }))).toBeUndefined()
  })

  it('holds a slot while spawning or with no roster, regardless of liveness', () => {
    expect(holdsSlot(claim({ phase: 'spawning' }), gone)).toBe(true)
    expect(holdsSlot(claim(), undefined)).toBe(true)
    expect(holdsSlot(claim(), gone)).toBe(false)
  })
})

describe('stallAgeMs', () => {
  const now = new Date('2026-10-14T12:00:00.000Z')

  it('measures from stalledAt when the stall recorded it', () => {
    expect(stallAgeMs(claim({ stalledAt: '2026-10-14T09:00:00.000Z' }), now)).toBe(3 * 60 * 60 * 1000)
  })

  it('falls back to phaseAt for a stall from before stalledAt', () => {
    expect(stallAgeMs(claim(), now)).toBe(4 * 60 * 60 * 1000)
  })

  it('names two hours as the aged threshold', () => {
    expect(STALL_AGED_MS).toBe(2 * 60 * 60 * 1000)
  })
})
