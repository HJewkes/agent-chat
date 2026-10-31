import { describe, expect, it } from 'vitest'
import { backoffHeld } from '../agents/burndown/backoff.js'
import {
  briefRefusal,
  isBriefer,
  pickTask,
  profileFor,
  taskRefusal,
  type Task,
} from '../agents/burndown/eligibility.js'
import type { Ledger } from '../agents/burndown/ledger.js'
import { opsNoneTag } from '../agents/burndown/ops.js'

const NOW = new Date('2026-10-01T12:00:00.000Z')

const task = (id: string, priority: number): Task => ({
  id,
  title: `Do ${id}`,
  status: 'open',
  priority,
  estimate: 1,
  doneWhen: 'unit tests cover it',
  tags: [],
})

const ledger: Ledger = { version: 1, claims: [], releases: { 'X-1': { n: 2, at: NOW.toISOString() } } }
const initiative = {
  slug: 'demo',
  autonomy: { mode: 'burndown' as const, lanes: 1, accounts: [], grants: [] },
}

describe('eligibility of a draft task', () => {
  it('refuses a draft-tagged task that has a done_when and accepts the same task untagged', () => {
    const draft = { ...task('D-1', 1), tags: ['draft'] }

    expect(taskRefusal(draft, [], new Set())).toEqual({ kind: 'reserved-tag', reason: 'tagged draft' })
    expect(taskRefusal(task('D-1', 1), [], new Set())).toBeUndefined()
  })
})

describe('eligibility under release backoff', () => {
  it('refuses only the held task and leaves a task with no release record eligible', () => {
    const held = backoffHeld(ledger, NOW)

    expect(taskRefusal(task('X-1', 1), [], new Set(), held)?.kind).toBe('backoff')
    expect(taskRefusal(task('Y-1', 2), [], new Set(), held)).toBeUndefined()
  })

  it('picks the next task when the higher-priority one is held', () => {
    const picked = pickTask(initiative, [task('X-1', 1), task('Y-1', 2)], new Set(), backoffHeld(ledger, NOW))

    expect(picked.task?.id).toBe('Y-1')
    expect(picked.refusals).toEqual([
      expect.objectContaining({
        task: 'X-1',
        kind: 'backoff',
        reason: expect.stringContaining('released 2 times'),
      }),
    ])
  })
})

describe('eligibility under the brief gate (CC-925)', () => {
  const brief = (gate: 'off' | 'shadow' | 'on') => ({ gate, maxAgeDays: 14, now: NOW })
  const tagged = (...tags: string[]): Task => ({ ...task('B-1', 1), tags })

  it('refuses an untagged task as no-brief only when the gate is on', () => {
    expect(taskRefusal(tagged(), [], new Set(), new Map(), brief('on'))?.kind).toBe('no-brief')
    expect(taskRefusal(tagged(), [], new Set(), new Map(), brief('shadow'))).toBeUndefined()
    expect(taskRefusal(tagged(), [], new Set(), new Map(), brief('off'))).toBeUndefined()
    expect(taskRefusal(tagged(), [], new Set())).toBeUndefined()
  })

  it('refuses a brief older than briefMaxAgeDays as brief-stale, and keeps one exactly that old', () => {
    const stale = taskRefusal(tagged('brief:ready=2026-09-16'), [], new Set(), new Map(), brief('on'))

    expect(stale).toEqual({ kind: 'brief-stale', reason: expect.stringContaining('15 days old') })
    expect(
      taskRefusal(tagged('brief:ready=2026-09-17'), [], new Set(), new Map(), brief('on')),
    ).toBeUndefined()
  })

  it('reads a malformed brief:ready tag as no brief', () => {
    expect(briefRefusal(tagged('brief:ready=2026-13-01'), brief('on'))?.kind).toBe('no-brief')
  })

  it('lets an earlier refusal win over the brief gate', () => {
    expect(taskRefusal(tagged(), [], new Set(['B-1']), new Map(), brief('on'))?.kind).toBe('claimed')
  })
})

describe('profileFor (owner decision 186)', () => {
  const sized = (estimate: number, tags: string[] = [], doneWhen = 'x'): Task => ({
    ...task('P-1', 1),
    estimate,
    tags,
    doneWhen,
  })

  it.each([1, 2])(
    'sends an untagged estimate-%s task to sonnet even when done_when names no tests',
    estimate => {
      expect(profileFor(sized(estimate))).toBe('bd-implementer-lite')
    },
  )

  it('(CC-939) sends a brief:wanted task without an estimate to the planner profile', () => {
    const { estimate: _drop, ...bare } = task('P-1', 1)
    const wanted: Task = { ...bare, tags: ['brief:wanted'], doneWhen: 'x' }

    expect(profileFor(wanted)).toBe('bd-planner')
    expect(isBriefer(wanted)).toBe(true)
    expect(isBriefer({ ...wanted, tags: ['brief:wanted', 'brief:proposed=2026-10-10'] })).toBe(false)
  })

  it('sends a non-feature kind to sonnet', () => {
    expect(profileFor(sized(2, ['kind:bug']))).toBe('bd-implementer-lite')
  })

  it('sends an estimate-2 kind:feature task to opus', () => {
    expect(profileFor(sized(2, ['kind:feature']))).toBe('bd-implementer')
  })

  it.each([[[]], [['kind:feature']]])('plans an estimate-3 task with tags %j', tags => {
    expect(profileFor(sized(3, tags))).toBe('bd-planner')
  })
})

describe('dispatch gate on declared ops (CC-974)', () => {
  const withDoneWhen = (doneWhen: string, tags: string[] = []): Task => ({
    ...task('O-1', 1),
    doneWhen,
    tags,
  })
  const refuse = (t: Task, grants: string[] = []) => taskRefusal(t, grants, new Set())

  const subjectMatter = [
    ['a filename', 'probe-deploy.ts drops its isAlive helper; unit tests cover it'],
    ['a fixture name', "the 'Deploy Preview' workflow fixture parses into one job"],
    ['a test scenario', 'an integration test survives a broker restart on a throwaway broker'],
    ['a read-only check', 'the doctor reads the branch protection ruleset and reports drift'],
  ]

  it.each(subjectMatter)('dispatches %s tagged ops:none for its text', (_scenario, doneWhen) => {
    expect(refuse(withDoneWhen(doneWhen, [opsNoneTag(doneWhen)]))).toBeUndefined()
  })

  it.each(subjectMatter)(
    'refuses %s with no tag as ops-unresolved, naming the tag',
    (_scenario, doneWhen) => {
      const refusal = refuse(withDoneWhen(doneWhen))

      expect(refusal?.kind).toBe('ops-unresolved')
      expect(refusal?.reason).toContain(opsNoneTag(doneWhen))
    },
  )

  it('dispatches a ruleset done_when tagged ops:none and refuses it untagged (CC-1154)', () => {
    const doneWhen = 'the tick no longer refuses; update the ruleset docs page'

    expect(refuse(withDoneWhen(doneWhen, [opsNoneTag(doneWhen)]))).toBeUndefined()
    expect(refuse(withDoneWhen(doneWhen))?.kind).toBe('ops-unresolved')
  })

  it('refuses an ops:none tag minted for different text', () => {
    const tag = opsNoneTag('the deploy checkout path is read')

    expect(refuse(withDoneWhen('the deploy checkout path is written', [tag]))?.kind).toBe('ops-unresolved')
  })

  it('refuses a declared human op as needs-human, with or without prose', () => {
    expect(refuse(withDoneWhen('unit tests cover it', ['ops:restart']))).toEqual({
      kind: 'needs-human',
      reason: 'declares ops:restart',
    })
  })

  it.each([
    ['kind:owner', 'owner'],
    ['kind:operator', 'operator'],
  ])('routes a %s task as human-step', (tag, queue) => {
    expect(refuse(withDoneWhen('the owner answers', [tag]))).toEqual({
      kind: 'human-step',
      reason: `routed to the ${queue}, never dispatched`,
    })
  })

  it('needs the release grant for a declared publish, and dispatches it with the grant', () => {
    const publish = withDoneWhen('publish @t/x at 1.2.0', ['ops:publish'])

    expect(refuse(publish)?.kind).toBe('needs-grant')
    expect(refuse(publish)?.reason).toContain('release-through-ci')
    expect(refuse(publish, ['release-through-ci'])).toBeUndefined()
  })

  it.each([
    'Publish @titan-design/registry 0.3.0 through changesets',
    'cut a release of 2.0',
    'the package is published and consumers install it',
  ])('refuses untagged publish wording %j as ops-unresolved', doneWhen => {
    expect(refuse(withDoneWhen(doneWhen), ['release-through-ci'])?.kind).toBe('ops-unresolved')
  })

  it('still reads the merge grant off prose', () => {
    const merge = withDoneWhen('PR merged to main')

    expect(refuse(merge)?.reason).toContain('merge-on-green-approve')
    expect(refuse(merge, ['merge-on-green-approve'])).toBeUndefined()
  })
})
