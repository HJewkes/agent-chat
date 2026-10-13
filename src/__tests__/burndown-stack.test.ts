import { describe, expect, it } from 'vitest'
import { readySlices, type Claim, type Ledger } from '../agents/burndown/ledger.js'
import type { ShepherdRow } from '../agents/burndown/shepherd.js'
import { STACK_MAX_DEPTH, stackable, stackReady } from '../agents/burndown/stack.js'
import { TickConfigSchema } from '../agents/burndown/source.js'
import { holdClass, parseShepherdRows } from '../shepherd-client.js'

/** CC-1158 slice a: a queued slice stacks on its one unmerged parent once that parent is a D3 base. */

const AT = '2026-10-01T12:00:00.000Z'
const REPO = 'example-org/example-repo'
const prUrl = (n: number): string => `https://github.com/${REPO}/pull/${n}`

const claim = (slice: string, over: Partial<Claim> = {}): Claim => ({
  taskId: 'T-1',
  initiative: 'demo',
  spawnedAt: AT,
  phaseAt: AT,
  phase: 'queued',
  slice,
  ...over,
})

const shepherding = (slice: string, pr: number, over: Partial<Claim> = {}): Claim =>
  claim(slice, { phase: 'shepherding', pr: prUrl(pr), agentName: `bd-t-1-${slice}`, ...over })

const row = (pr: number, over: Partial<ShepherdRow> = {}): ShepherdRow => ({
  repo: REPO,
  pr,
  runId: `run-${pr}`,
  phase: 'review',
  headSha: 'abc1234',
  stalled: null,
  held: null,
  branch: `agent-chat/bd-t-1-${pr}`,
  ...over,
})

const ledgerOf = (...claims: Claim[]): Ledger => ({ version: 1, claims })

/** Parent `a` shepherding PR 10, child `b` queued on it. */
const PARENT = shepherding('a', 10)
const CHILD = claim('b', { dependsOn: ['a'] })
const ROWS = [row(10)]

describe('stackable', () => {
  it('admits a parent that is registered, first-CI green and unheld, naming its PR and branch', () => {
    const ledger = ledgerOf(PARENT, CHILD)

    const on = stackable(CHILD, 'a', ledger, ROWS)

    expect(on).toEqual({ taskId: 'T-1', slice: 'a', pr: prUrl(10), branch: 'agent-chat/bd-t-1-10' })
  })

  it.each([
    [
      'g10-adversary',
      row(10, { phase: 'awaiting-approval', held: { reason: 'g10-adversary: word "gate"; T-1' } }),
    ],
    ['g10-review', row(10, { held: { reason: 'g10-review: diff over the line limit' } })],
    ['no-reviewer', row(10, { phase: 'merging', held: { reason: 'no-reviewer: none free; T-9' } })],
  ])('admits a CI-green parent held %s, waiting on review', (_label, parentRow) => {
    const ledger = ledgerOf(PARENT, CHILD)

    const on = stackable(CHILD, 'a', ledger, [parentRow])

    expect(on?.pr).toBe(prUrl(10))
  })

  it.each([
    ['owner-held', row(10, { phase: 'awaiting-approval', held: { reason: 'owner: wait for a decision' } })],
    ['park-held', row(10, { held: { reason: 'park: agent parked; T-9' } })],
    ['held stalled', row(10, { held: { reason: 'stalled: no fixer; T-9' } })],
    ['held in an unknown class', row(10, { held: { reason: 'later-class: something new' } })],
    ['held with no class', row(10, { held: { reason: 'owner hold' } })],
    [
      'held for review but still fixing',
      row(10, { phase: 'fixing', held: { reason: 'g10-review: big diff' } }),
    ],
    ['stack-frozen', row(10, { stackFrozen: true })],
    [
      'held for review and stack-frozen',
      row(10, { held: { reason: 'g10-review: big diff' }, stackFrozen: true }),
    ],
    ['first CI pending', row(10, { phase: 'ci' })],
    ['fixing a red CI', row(10, { phase: 'fixing' })],
    ['stalled', row(10, { stalled: { reason: 'no fixer' } })],
  ])('refuses a parent whose run is %s', (_label, parentRow) => {
    const ledger = ledgerOf(PARENT, CHILD)

    expect(stackable(CHILD, 'a', ledger, [parentRow])).toBeUndefined()
  })

  it('admits a parent whose Shepherd reports stackFrozen false', () => {
    expect(stackable(CHILD, 'a', ledgerOf(PARENT, CHILD), [row(10, { stackFrozen: false })])).toBeDefined()
  })

  it('refuses a parent Shepherd has not registered', () => {
    expect(stackable(CHILD, 'a', ledgerOf(PARENT, CHILD), [])).toBeUndefined()
  })

  it('refuses a parent that is not yet shepherding a PR', () => {
    const implementing = claim('a', { phase: 'implementing', agentName: 'bd-t-1-a' })

    expect(stackable(CHILD, 'a', ledgerOf(implementing, CHILD), ROWS)).toBeUndefined()
  })

  it(`refuses depth ${STACK_MAX_DEPTH + 1}: a parent itself stacked on an unmerged claim`, () => {
    const grandparent = shepherding('a', 10)
    const parent = shepherding('b', 11, {
      dependsOn: ['a'],
      stackedOn: { taskId: 'T-1', slice: 'a', pr: prUrl(10), branch: 'agent-chat/bd-t-1-a' },
    })
    const child = claim('c', { dependsOn: ['b'] })
    const ledger = ledgerOf(grandparent, parent, child)

    expect(stackable(child, 'b', ledger, [row(10), row(11)])).toBeUndefined()
  })

  it('does not count a merged ancestor toward the depth', () => {
    const grandparent = claim('a', { phase: 'done', pr: prUrl(10) })
    const parent = shepherding('b', 11, {
      dependsOn: ['a'],
      stackedOn: { taskId: 'T-1', slice: 'a', pr: prUrl(10), branch: 'agent-chat/bd-t-1-a' },
    })
    const child = claim('c', { dependsOn: ['b'] })
    const ledger = ledgerOf(grandparent, parent, child)

    expect(stackable(child, 'b', ledger, [row(11)])?.pr).toBe(prUrl(11))
  })
})

describe('holdClass', () => {
  it('is the reason text before the first colon', () => {
    expect(holdClass({ held: { reason: 'g10-review: a: b' } })).toBe('g10-review')
  })

  it('is undefined for an unheld run or a reason with no colon', () => {
    expect(holdClass({ held: null })).toBeUndefined()
    expect(holdClass({})).toBeUndefined()
    expect(holdClass({ held: { reason: 'owner hold' } })).toBeUndefined()
  })
})

describe('parseShepherdRows stackFrozen', () => {
  it('reads stackFrozen when Shepherd sends it and leaves it absent on an older Shepherd', () => {
    const base = { repo: REPO, runId: 'r', phase: 'review', headSha: null, stalled: null }
    const json = JSON.stringify([
      { ...base, pr: 1, stackFrozen: true },
      { ...base, pr: 2 },
    ])

    const rows = parseShepherdRows(json, () => undefined)

    expect(rows?.map(r => r.stackFrozen)).toEqual([true, undefined])
  })
})

describe('readySlices with a stack predicate', () => {
  it('returns a slice with one unmet admitted dependency, carrying stackedOn', () => {
    const ledger = ledgerOf(PARENT, CHILD)

    const ready = readySlices(ledger, new Map(), (c, dep) => stackable(c, dep, ledger, ROWS))

    expect(ready.map(c => [c.slice, c.stackedOn?.pr])).toEqual([['b', prUrl(10)]])
  })

  it('never stacks a slice with two unmet dependencies', () => {
    const other = shepherding('c', 12)
    const child = claim('d', { dependsOn: ['a', 'c'] })
    const ledger = ledgerOf(PARENT, other, child)

    const ready = readySlices(ledger, new Map(), (c, dep) => stackable(c, dep, ledger, [row(10), row(12)]))

    expect(ready).toEqual([])
  })
})

describe('stackReady by stack.mode', () => {
  const merged = claim('x', { phase: 'done' })
  const free = claim('y', { dependsOn: ['x'] })
  const ledger = ledgerOf(PARENT, CHILD, merged, free)

  it('off returns exactly what readySlices returns today, stacking nothing', () => {
    const { ready, notes } = stackReady('off', ledger, new Map(), ROWS)

    expect(ready).toEqual(readySlices(ledger))
    expect(ready.map(c => c.slice)).toEqual(['y'])
    expect(notes).toEqual([])
  })

  it('shadow notes the would-stack slice but dispatches only what off does', () => {
    const { ready, notes } = stackReady('shadow', ledger, new Map(), ROWS)

    expect(ready).toEqual(readySlices(ledger))
    expect(notes).toEqual([`would stack T-1 b on a ${prUrl(10)}`])
  })

  it('on admits the stacked slice beside the free one', () => {
    const { ready } = stackReady('on', ledger, new Map(), ROWS)

    expect(ready.map(c => [c.slice, c.stackedOn?.slice])).toEqual([
      ['b', 'a'],
      ['y', undefined],
    ])
  })

  it('a held task stays out under on', () => {
    const { ready } = stackReady('on', ledger, new Map([['T-1', 'backoff']]), ROWS)

    expect(ready).toEqual([])
  })
})

describe('TickConfig stack', () => {
  it('defaults stack.mode to off', () => {
    expect(TickConfigSchema.parse({}).stack).toEqual({ mode: 'off' })
  })

  it('refuses an unknown mode', () => {
    expect(TickConfigSchema.safeParse({ stack: { mode: 'always' } }).success).toBe(false)
  })
})
