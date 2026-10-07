import { describe, expect, it } from 'vitest'
import { planOrder, type PlanOrderInput } from '../agents/burndown/plan-order.js'
import { renderScored, scoredPlan } from '../agents/burndown/score-render.js'
import { scoreAll, type ScoredTask, type ScoringDefaults } from '../agents/burndown/score.js'

/** CC-644: the plan refuses self, missing and cyclic `dep:` edges and blocks dependents of a failed upstream, naming ids. */

const DEFAULTS: ScoringDefaults = {
  kind_weights: { security: 1.0, product: 1.0, correctness: 0.9, platform: 0.8, docs: 0.5, nit: 0.35 },
  share_caps: { product: 0.2, docs: 0.1, nit: 0.1 },
  initiative_decay: 0.85,
  score_terms: { severity: 0.4, priority_pct: 0.3, unblocks: 0.2, staleness: 0.1 },
  severity: { critical: 1.0, high: 0.7, medium: 0.4, low: 0.15, unset: 0.3 },
  readiness: { ready: 1.0, untriaged: 0.6, blocked: 0.25 },
  size: { le3: 1.0, le8: 0.9, gt8: 0.75 },
  stop_short_factor: 0.8,
}
const WEIGHTS = { north: 1.0 }
const TODAY = '2026-10-03'

function task(id: string, tags: string[] = []): ScoredTask {
  return {
    id,
    title: `Normalize the schema for ${id}`,
    priority: 3,
    severity: 'medium',
    estimate: 2,
    done_when: 'The change is merged.',
    tags,
    updated: '2026-09-20',
    slug: 'north',
  }
}

function inputFor(tasks: ScoredTask[], extra: Partial<PlanOrderInput> = {}): PlanOrderInput {
  const { rows } = scoreAll(tasks, WEIGHTS, DEFAULTS, { tags: [] }, [], TODAY)
  return { rows, tasks, defaults: DEFAULTS, n: 10, today: TODAY, ...extra }
}

const ids = (order: readonly { id: string }[]) => order.map(row => row.id).sort()

describe('planOrder dep: edge refusals', () => {
  it('refuses a self edge and names the task', () => {
    const tasks = [task('SE-1', ['dep:SE-1']), task('SE-2')]

    const { order, edgeLines } = planOrder(inputFor(tasks))

    expect(ids(order)).toEqual(['SE-2'])
    expect(edgeLines).toEqual(['self-dep SE-1'])
  })

  it('refuses a dep: on a missing task and names both ids', () => {
    const tasks = [task('MD-1', ['dep:MD-99']), task('MD-2')]

    const { order, edgeLines } = planOrder(inputFor(tasks))

    expect(ids(order)).toEqual(['MD-2'])
    expect(edgeLines).toEqual(['unknown-dep MD-1 -> MD-99'])
  })

  it('refuses a 2-cycle and names its ids in order', () => {
    const tasks = [task('C2-1', ['dep:C2-2']), task('C2-2', ['dep:C2-1']), task('C2-3')]

    const { order, edgeLines } = planOrder(inputFor(tasks))

    expect(ids(order)).toEqual(['C2-3'])
    expect(edgeLines).toEqual(['cycle C2-1 -> C2-2 -> C2-1'])
  })

  it('refuses a 3-cycle and names its ids in dependency order, not input order', () => {
    const tasks = [task('C3-1', ['dep:C3-3']), task('C3-2', ['dep:C3-1']), task('C3-3', ['dep:C3-2'])]

    const { order, edgeLines } = planOrder(inputFor(tasks))

    expect(order).toEqual([])
    expect(edgeLines).toEqual(['cycle C3-1 -> C3-3 -> C3-2 -> C3-1'])
  })

  it('prints the refusals in the burndown plan output', () => {
    const tasks = [task('RP-1', ['dep:RP-1']), task('RP-2')]
    const plan = scoredPlan({
      tasks,
      weights: WEIGHTS,
      defaults: DEFAULTS,
      exclusions: { tags: [] },
      hardStops: [],
      today: TODAY,
      top: 5,
    })

    expect(renderScored(plan)).toContain('self-dep RP-1')
  })
})

describe('planOrder failed upstreams', () => {
  it('blocks a direct and a transitive dependent with the root named, and still plans an unrelated task', () => {
    const tasks = [task('FU-1'), task('FU-2', ['dep:FU-1']), task('FU-3', ['dep:FU-2']), task('FU-4')]

    const { order, refused, edgeLines } = planOrder(
      inputFor(tasks, { failedUpstreams: { 'FU-1': 'stalled' } }),
    )

    expect(ids(order)).toEqual(['FU-1', 'FU-4'])
    expect(refused['upstream-failed']).toBe(2)
    expect(edgeLines).toEqual([
      'blocked FU-2: upstream FU-1 failed (stalled)',
      'blocked FU-3: upstream FU-1 failed (stalled) via FU-2',
    ])
  })
})

describe('planOrder with a clean dep: graph', () => {
  it('has no edge lines and keeps the order of a plain dep chain', () => {
    const tasks = [task('OK-1'), task('OK-2', ['dep:OK-1']), task('OK-3')]

    const { order, refused, edgeLines } = planOrder(inputFor(tasks))

    expect(ids(order)).toEqual(['OK-1', 'OK-3'])
    expect(refused).toEqual({ 'dep-blocked': 1 })
    expect(edgeLines).toEqual([])
  })
})
