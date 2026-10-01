import { describe, expect, it } from 'vitest'
import { advance, applyActions, claimKey, type Action, type Observation } from '../agents/burndown/advance.js'
import { EMPTY_LEDGER, type Claim } from '../agents/burndown/ledger.js'
import { worktreeUse } from '../agents/burndown/observe.js'
import { agentNameFor, reviewerNameFor, successorNameFor } from '../agents/burndown/plan.js'
import { parseReport } from '../agents/burndown/report.js'
import { runningImplementers } from '../agents/seats/watchdog.js'

/** Seat identity on burndown claims (CC-246): the claim's prefix names every agent it spawns. */

const NOW = new Date('2026-09-28T12:00:00.000Z')
const EARLIER = '2026-09-28T11:00:00.000Z'

const seatClaim = (patch: Partial<Claim> = {}): Claim => ({
  taskId: 'X-1',
  initiative: 'demo',
  seat: 'seat-a',
  namePrefix: 'tc',
  agentId: 'a1',
  agentName: 'tc-x-1',
  spawned: ['tc-x-1'],
  worktree: '/repo/.worktrees/tc-x-1',
  spawnedAt: EARLIER,
  phase: 'implementing',
  phaseAt: EARLIER,
  ...patch,
})

function step(c: Claim, obs: Observation): { actions: Action[]; after: Claim } {
  const actions = advance([c], new Map([[claimKey(c), obs]]), NOW)
  const [after] = applyActions({ ...EMPTY_LEDGER, claims: [c] }, actions, NOW).claims
  if (after === undefined) throw new Error('no claim after the step')
  return { actions, after }
}

const land = (c: Claim, id: string): Claim => step(c, { agent: { id, state: 'live' } }).after
const exited = { id: 'a1', state: 'exited' as const }
const spawned = (actions: Action[]) => actions.filter(a => a.kind === 'spawn')
const PR = 'https://github.com/o/r/pull/9'
const landed: Observation = {
  shepherd: {
    row: { repo: 'o/r', pr: 9, runId: 'run-1', phase: 'done', headSha: null, stalled: null },
    landed: true,
  },
}

describe('agent names', () => {
  it('default to the bd prefix', () => {
    expect([agentNameFor('X-1'), successorNameFor('X-1', 1), reviewerNameFor('X-1', 0, 'A')]).toEqual([
      'bd-x-1',
      'bd-x-1-s1',
      'bd-x-1-a-r0',
    ])
  })

  it('take a seat prefix', () => {
    expect([agentNameFor('X-1', undefined, 'tc'), successorNameFor('X-1', 1, 'a', 'tc')]).toEqual([
      'tc-x-1',
      'tc-x-1-a-s1',
    ])
  })
})

describe('a tc claim through the phase machine', () => {
  it('spawns tc-x-1-r0, then tc-x-1-s1 from tc-x-1, then tc-x-1-r1, and retires them all', () => {
    const reviewable = { reviewable: true, reason: '1 commit ahead' }
    const first = step(seatClaim(), { agent: exited, report: parseReport('Status: DONE'), diff: reviewable })
    const review = step(land(first.after, 'r0'), {
      agent: exited,
      report: parseReport('Verdict: CHANGES\nMissing a test.'),
    })
    const fixed = step(land(review.after, 's1'), {
      agent: exited,
      report: parseReport('Status: DONE'),
      diff: reviewable,
    })
    const merged = step({ ...fixed.after, phase: 'shepherding', pr: PR }, landed)

    expect([...spawned(first.actions), ...spawned(review.actions), ...spawned(fixed.actions)]).toEqual([
      expect.objectContaining({ role: 'reviewer', name: 'tc-x-1-r0' }),
      expect.objectContaining({ role: 'successor', name: 'tc-x-1-s1', predecessor: 'tc-x-1' }),
      expect.objectContaining({ role: 'reviewer', name: 'tc-x-1-r1' }),
    ])
    expect(merged.actions.filter(a => a.kind === 'retire')).toEqual([
      expect.objectContaining({ names: ['tc-x-1-r1', 'tc-x-1-s1', 'tc-x-1-r0', 'tc-x-1'] }),
    ])
  })

  it("names a second successor's predecessor by the claim's prefix", () => {
    const parked = seatClaim({ phase: 'parked', questionId: 'q1', attempt: 1 })
    const answer = { msgId: 'm1', from: 'human', text: 'use B', inReplyTo: 'q1' }

    const { actions } = step(parked, { inbox: [answer] })

    expect(spawned(actions)).toEqual([
      expect.objectContaining({ name: 'tc-x-1-s2', predecessor: 'tc-x-1-s1' }),
    ])
  })

  it("retires the claim's original agent by prefix even when spawned lost it", () => {
    const { actions } = step(seatClaim({ phase: 'shepherding', spawned: [], pr: PR }), landed)

    expect(actions.filter(a => a.kind === 'retire')).toEqual([expect.objectContaining({ names: ['tc-x-1'] })])
  })
})

describe('worktreeUse ours', () => {
  const config = { maxWorktreesPerRepo: 3, reserveWorktrees: 1 }
  const names = ['bd-x-1', 'tc-x-2', 'tcx-x-3', 'seat-a-x-4', 'other']

  it('counts only bd worktrees by default', () => {
    expect(worktreeUse(names, 10, config).ours).toBe(1)
  })

  it('counts every configured prefix as ours, and a prefix only up to its dash', () => {
    expect(worktreeUse(names, 10, config, ['bd', 'tc', 'seat-a']).ours).toBe(3)
  })
})

describe('runningImplementers with tick-spawned seat agents', () => {
  it('counts an implementer the tick spawned under the seat prefix', () => {
    const seat = { name: 'seat-a', prefix: 'tc' }
    const tickSpawned = {
      name: agentNameFor('X-1', undefined, seat.prefix),
      profile: 'bd-implementer',
      state: 'live',
      spawnedBy: 'burndown-tick',
    }

    expect(runningImplementers([tickSpawned], seat)).toEqual(['tc-x-1'])
  })
})
