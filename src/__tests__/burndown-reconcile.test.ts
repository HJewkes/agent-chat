import { describe, expect, it } from 'vitest'
import { advance, applyActions, claimKey, type Action, type Observation } from '../agents/burndown/advance.js'
import { EMPTY_LEDGER, type Claim, type Ledger } from '../agents/burndown/ledger.js'
import { reconciledLines, reconciledText, reconcileReasons } from '../agents/burndown/reconcile.js'
import type { ShepherdRow } from '../agents/burndown/shepherd.js'

/** CC-982 a: a held claim whose task is done, or whose PR merged, finishes by its own (task, slice) and says why. */

const NOW = new Date('2026-10-14T12:00:00.000Z')
const EARLIER = '2026-10-14T09:00:00.000Z'

const exited = (name: string): Observation['agent'] => ({ id: name, state: 'exited' })

const sliceA: Claim = {
  taskId: 'X-1',
  slice: 'a',
  initiative: 'demo',
  agentId: 'bd-x-1-a',
  agentName: 'bd-x-1-a',
  spawned: ['bd-x-1-a'],
  spawnedAt: EARLIER,
  phase: 'implementing',
  phaseAt: EARLIER,
  stalledReason: 'no final report',
  stalledClass: 'failed',
}

const queuedSlice = (n: string): Claim => ({
  taskId: 'X-1',
  slice: n,
  initiative: 'demo',
  spawnedAt: EARLIER,
  phase: 'queued',
  phaseAt: EARLIER,
  dependsOn: ['a'],
})

const whole: Claim = {
  taskId: 'X-2',
  initiative: 'demo',
  agentId: 'bd-x-2',
  agentName: 'bd-x-2',
  spawned: ['bd-x-2'],
  spawnedAt: EARLIER,
  phase: 'implementing',
  phaseAt: EARLIER,
  stalledReason: 'BLOCKED: waiting on the owner',
  stalledClass: 'failed',
}

const LEDGER: Ledger = { ...EMPTY_LEDGER, claims: [sliceA, queuedSlice('b'), queuedSlice('c'), whole] }

const row = (patch: Partial<ShepherdRow> = {}): ShepherdRow => ({
  repo: 'o/r',
  pr: 5,
  runId: 'run-5',
  phase: 'post-merge',
  headSha: 'h5',
  stalled: null,
  implementer: 'bd-x-1-a',
  ...patch,
})

const taskDone: Observation = { agent: exited('bd-x-2'), taskStatus: 'done', prState: { kind: 'none' } }

const actionsFor = (claims: Claim[], observations: Map<string, Observation>): Action[] =>
  advance(claims, observations, NOW)

const keysOf = (actions: Action[]): string[] => [
  ...new Set(actions.flatMap(a => ('key' in a ? [claimKey(a.key)] : []))),
]

const finishes = (actions: Action[], key: string): boolean =>
  actions.some(a => a.kind === 'update' && claimKey(a.key) === key && a.patch.phase === 'done')

describe('reconciling a merged slice', () => {
  it('finishes and retires slice a alone when its PR merged, leaving queued b and c untouched', () => {
    const obs = new Map([
      ['X-1#a', { agent: exited('bd-x-1-a'), prState: { kind: 'merged' as const, pr: 'o/r#5', head: 'h5' } }],
    ])

    const actions = actionsFor(LEDGER.claims.slice(0, 3), obs)

    expect(keysOf(actions)).toEqual(['X-1#a'])
    expect(finishes(actions, 'X-1#a')).toBe(true)
    expect(actions).toContainEqual({
      kind: 'retire',
      key: { taskId: 'X-1', slice: 'a' },
      names: ['bd-x-1-a'],
    })
    expect(reconcileReasons(LEDGER.claims, actions, obs).get('X-1#a')).toBe('o/r#5 merged')
  })
})

describe('reconciling a claim whose task is done', () => {
  it('finishes and retires a stalled claim whose agent exited with no PR or Shepherd run', () => {
    const obs = new Map([['X-2#', taskDone]])

    const actions = actionsFor([whole], obs)

    expect(finishes(actions, 'X-2#')).toBe(true)
    expect(actions).toContainEqual({
      kind: 'retire',
      key: { taskId: 'X-2', slice: undefined },
      names: ['bd-x-2'],
    })
    expect(reconcileReasons([whole], actions, obs).get('X-2#')).toBe('task status done')
  })

  it('finishes a planning claim with no PR recorded when no PR read covers its phase', () => {
    const planning: Claim = { ...whole, phase: 'planning' }
    const obs = new Map([['X-2#', { agent: exited('bd-x-2'), taskStatus: 'done' }]])

    expect(finishes(actionsFor([planning], obs), 'X-2#')).toBe(true)
  })

  it.each<[string, Observation]>([
    ['its agent is still running', { ...taskDone, agent: { id: 'bd-x-2', state: 'running' } }],
    ['the PR read is unreadable', { ...taskDone, prState: 'unreadable' }],
    ['the PR is open', { ...taskDone, prState: { kind: 'open', pr: 'o/r#7' } }],
    ['the PR was not read', { agent: exited('bd-x-2'), taskStatus: 'done' }],
    ['a Shepherd run is open', { ...taskDone, shepherd: { row: row({ phase: 'ci-wait', pr: 7 }) } }],
    ['the task status was not read', { agent: exited('bd-x-2'), prState: { kind: 'none' } }],
    ['the task is open', { ...taskDone, taskStatus: 'open' }],
  ])('keeps the claim when %s', (_why, observation) => {
    const actions = actionsFor([whole], new Map([['X-2#', observation]]))

    expect(finishes(actions, 'X-2#')).toBe(false)
    expect(actions.some(a => a.kind === 'retire')).toBe(false)
  })

  it('keeps a claim with a respawn pending', () => {
    const respawning: Claim = { ...whole, respawn: { code: 'spawn-never-landed', occurrence: EARLIER } }

    expect(actionsFor([respawning], new Map([['X-2#', taskDone]]))).toEqual([])
  })

  it('leaves a queued slice of a done task alone, even one that names an exited agent', () => {
    const named: Claim = { ...queuedSlice('b'), agentName: 'bd-x-1-b' }
    const obs = new Map([['X-1#b', { ...taskDone, agent: exited('bd-x-1-b') }]])

    expect(actionsFor([named], obs)).toEqual([])
  })
})

describe('reconcile reasons', () => {
  it('gives an ordinary Shepherd landing no reason', () => {
    const shepherding: Claim = { ...whole, phase: 'shepherding', pr: 'o/r#5', stalledReason: undefined }
    const obs = new Map([['X-2#', { shepherd: { row: row() } }]])

    const actions = actionsFor([shepherding], obs)

    expect(finishes(actions, 'X-2#')).toBe(true)
    expect(reconcileReasons([shepherding], actions, obs).size).toBe(0)
  })

  it('names the PR for a stalled shepherding claim whether GitHub or Shepherd reads the merge', () => {
    const stalled: Claim = { ...whole, phase: 'shepherding', pr: 'o/r#5' }
    const both = { shepherd: { row: row() }, prState: { kind: 'merged' as const, pr: 'o/r#5', head: 'h5' } }
    const reasonOf = (obs: Observation): string | undefined => {
      const observations = new Map([['X-2#', obs]])
      return reconcileReasons([stalled], actionsFor([stalled], observations), observations).get('X-2#')
    }

    expect(reasonOf(both)).toBe('o/r#5 merged')
    expect(reasonOf({ shepherd: both.shepherd })).toBe('o/r#5 merged (Shepherd)')
  })

  it('names a release by its reason', () => {
    const release: Action = {
      kind: 'release',
      key: { taskId: 'X-2' },
      requeue: false,
      reason: 'stack-broken',
      names: [],
    }

    expect(reconcileReasons([whole], [release], new Map()).get('X-2#')).toBe('released: stack-broken')
  })
})

describe('reconciled lines', () => {
  const obs = new Map([['X-2#', taskDone]])
  const actions = actionsFor([whole], obs)
  const reasons = reconcileReasons(LEDGER.claims, actions, obs)

  it('emits one line for a claim the written ledger no longer holds', () => {
    const after = applyActions(LEDGER, actions, NOW)

    expect(reconciledLines(LEDGER, after, reasons).map(reconciledText)).toEqual([
      'reconciled X-2#: task status done',
    ])
  })

  it('emits nothing when the ledger write did not apply', () => {
    expect(reconciledLines(LEDGER, LEDGER, reasons)).toEqual([])
  })
})
