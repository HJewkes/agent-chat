import { describe, expect, it } from 'vitest'
import type { Task } from '../agents/burndown/eligibility.js'
import { addClaim, EMPTY_LEDGER, type Claim } from '../agents/burndown/ledger.js'
import { plan, type PlanInputs } from '../agents/burndown/plan.js'

/** CC-1121 c: the seatless plan path gates a ready slice on its parent task, as the seat path does. */

const NOON = new Date(2026, 9, 12, 12, 0)

const task = (id: string, over: Partial<Task> = {}): Task => ({
  id,
  title: `Do ${id}`,
  status: 'open',
  priority: 3,
  estimate: 1,
  doneWhen: 'unit tests cover the new branch',
  tags: ['brief:ready=2026-10-12'],
  ...over,
})

const sliceClaim = (taskId: string, slice: string, over: Partial<Claim> = {}): Claim => ({
  taskId,
  initiative: 'demo',
  spawnedAt: NOON.toISOString(),
  phase: 'queued',
  phaseAt: NOON.toISOString(),
  slice,
  ...over,
})

/** A merged slice a and a queued slice b behind it for each task id. */
function planOver(tasks: Task[], sliced: string[]): ReturnType<typeof plan> {
  const claims = sliced.flatMap(id => [
    sliceClaim(id, 'a', {
      phase: 'done',
      pr: 'https://github.com/HJewkes/agent-chat/pull/7',
      spawned: [`bd-${id.toLowerCase()}-a`],
    }),
    sliceClaim(id, 'b', { dependsOn: ['a'] }),
  ])
  const inputs: PlanInputs = {
    initiatives: [
      {
        slug: 'demo',
        state: 'focused',
        rank: 1,
        autonomy: { mode: 'burndown', lanes: 1, accounts: ['agents'], grants: [], repo: '/repo' },
      },
    ],
    tasks: new Map([['demo', tasks]]),
    ledger: claims.reduce((l, c) => addClaim(l, c), EMPTY_LEDGER),
    rules: { agents: { reserve_seven_day: 25, ceiling_five_hour: 70 } },
    readings: new Map([['agents', { sevenDay: 40, fiveHour: 10, ageSeconds: 30 }]]),
    gate: { now: NOON },
    trust: () => undefined,
  }
  return plan(inputs)
}

describe('seatless plan: ready slices of a gated parent', () => {
  it('dispatches nothing for a needs-decision parent with brief:ready set after slice a merged', () => {
    const parent = task('DM-1', { tags: ['needs-decision', 'brief:ready=2026-10-12'] })

    const result = planOver([parent], ['DM-1'])

    expect(result.dispatch).toEqual([])
    expect(result.refusals).toContainEqual(
      expect.objectContaining({
        task: 'DM-1',
        kind: 'reserved-tag',
        reason: expect.stringContaining('needs-decision'),
      }),
    )
  })

  it.each<[string, Partial<Task>, string]>([
    ['human-only', { tags: ['human-only'] }, 'reserved-tag'],
    ['blocked', { tags: ['blocked'] }, 'blocked'],
    ['done', { status: 'done' }, 'not-open'],
  ])('holds the slices of a %s parent', (_label, over, kind) => {
    const result = planOver([task('DM-1', over)], ['DM-1'])

    expect(result.dispatch).toEqual([])
    expect(result.refusals).toContainEqual(expect.objectContaining({ task: 'DM-1', kind }))
  })

  it('holds the slices of a parent missing from the task files', () => {
    const result = planOver([], ['DM-1'])

    expect(result.dispatch).toEqual([])
    expect(result.refusals).toEqual([expect.objectContaining({ task: 'DM-1', kind: 'not-open' })])
  })

  it("skips a gated parent's slice and dispatches the next ready slice", () => {
    const tasks = [task('DM-1', { tags: ['needs-decision'] }), task('DM-2')]

    const result = planOver(tasks, ['DM-1', 'DM-2'])

    expect(result.dispatch).toEqual([expect.objectContaining({ task: 'DM-2', slice: 'b' })])
    expect(result.refusals).toEqual([expect.objectContaining({ task: 'DM-1', kind: 'reserved-tag' })])
  })

  it('dispatches slice b of an ungated parent', () => {
    const result = planOver([task('DM-1')], ['DM-1'])

    expect(result.dispatch).toEqual([expect.objectContaining({ task: 'DM-1', slice: 'b' })])
  })
})
