import { describe, expect, it } from 'vitest'
import { taskRefusal, type Task } from '../agents/burndown/eligibility.js'
import { publishOnlyProblem } from '../agents/burndown/ops.js'
import { planOrder } from '../agents/burndown/plan-order.js'
import { scoreAll, type ScoredTask, type ScoringDefaults } from '../agents/burndown/score.js'

/** CC-987 b: only a publish-only ops:publish task waits on the release grant; a mixed one is a brief problem. */

const RELEASE = ['release-through-ci']

const task = (id: string, doneWhen: string, tags: string[]): Task => ({
  id,
  title: `Do ${id}`,
  status: 'open',
  priority: 1,
  estimate: 1,
  doneWhen,
  tags,
})

const refuse = (t: Task, grants: string[] = []) => taskRefusal(t, grants, new Set())

describe('publishOnlyProblem', () => {
  it.each([
    ['one package', 'Publish @t/coordinator at 0.9.0.'],
    ['a v-prefixed version', 'publish agent-chat at v1.2.0'],
    ['a short package list', 'Publish @t/a, @t/b and @t/c at 2.0.0.'],
  ])('accepts %s at a version', (_name, doneWhen) => {
    expect(publishOnlyProblem(doneWhen)).toBeUndefined()
  })

  it.each([
    ['empty', ''],
    ['no publish', 'The widget renders at 1.0.0.'],
    ['no version', 'publish the release'],
    ['another op', 'Publish @t/x at 1.0.0 and deploy the site.'],
    ['a semicolon step', 'Add the flag; publish 0.9.0.'],
    ['a comma step', 'Add the flag, publish @t/x at 0.9.0.'],
    ['a then step', 'Add the --foo flag to the CLI, then publish @t/x at 1.0.0.'],
    ['a trailing condition', 'X and publish @t/x at 1.0.0 once CI is green'],
    ['a step on its own line', 'Add flag.\nPublish @t/x at 1.0.0.'],
  ])('rejects a done_when with %s', (_name, doneWhen) => {
    expect(publishOnlyProblem(doneWhen)).toContain('publish <package> at <version>')
  })
})

describe('the dispatch gate on an ops:publish task', () => {
  it('holds a publish-only task on the release grant, and dispatches it with the grant', () => {
    const publish = task('P-1', 'Publish @t/coordinator at 0.9.0.', ['ops:publish'])

    expect(refuse(publish)?.kind).toBe('needs-grant')
    expect(refuse(publish, RELEASE)).toBeUndefined()
  })

  it.each([
    ['without', [], 'Add the flag; publish 0.9.0.'],
    ['with', RELEASE, 'Add the flag; publish 0.9.0.'],
    ['with', RELEASE, 'Add the --foo flag to the CLI, then publish @t/x at 1.0.0.'],
    ['with', RELEASE, 'X and publish @t/x at 1.0.0 once CI is green'],
    ['with', RELEASE, 'Add flag.\nPublish @t/x at 1.0.0.'],
    ['with', RELEASE, 'Add the flag, publish @t/x at 0.9.0.'],
  ])(
    'refuses a mixed publish as ops-unresolved naming the split, %s the grant: %j',
    (_name, grants, doneWhen) => {
      const mixed = task('P-2', doneWhen, ['ops:publish'])

      const refusal = refuse(mixed, grants)

      expect(refusal?.kind).toBe('ops-unresolved')
      expect(refusal?.reason).toContain('dep:')
      expect(refusal?.reason).toContain('publish <package> at <version>')
    },
  )

  it('refuses a publish with no version as ops-unresolved', () => {
    expect(refuse(task('P-3', 'publish the release', ['ops:publish']), RELEASE)?.kind).toBe('ops-unresolved')
  })

  it('leaves a consumer task to the dep: edge on its open publish task', () => {
    const consumer = task('C-1', 'The app reads the new export; unit tests cover it.', ['dep:P-1'])
    const scored = (id: string, tags: string[]): ScoredTask => ({
      id,
      title: `Do ${id}`,
      priority: 3,
      severity: 'medium',
      estimate: 2,
      done_when: 'unit tests cover it',
      tags,
      updated: '2026-09-20',
      slug: 'north',
    })
    const tasks = [scored('P-1', ['ops:publish']), scored('C-1', ['dep:P-1'])]
    const { rows } = scoreAll(tasks, { north: 1 }, DEFAULTS, { tags: [] }, [], TODAY)

    const { order, refused } = planOrder({ rows, tasks, defaults: DEFAULTS, n: 10, today: TODAY })

    expect(refuse(consumer)).toBeUndefined()
    expect(order.map(row => row.id)).toEqual(['P-1'])
    expect(refused).toEqual({ 'dep-blocked': 1 })
  })
})

const TODAY = '2026-10-12'
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
