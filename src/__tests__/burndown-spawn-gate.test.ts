import { describe, expect, it } from 'vitest'
import { advance, applyActions, claimKey, type Action } from '../agents/burndown/advance.js'
import type { Initiative } from '../agents/burndown/eligibility.js'
import { ladderActions } from '../agents/burndown/ladder.js'
import type { Claim, Ledger } from '../agents/burndown/ledger.js'
import { stepsForActions, type StepContext } from '../agents/burndown/steps.js'

/** CC-660 E1 review 2: spawn resolution refuses a spawn on a claim the same tick stalls or whose agent still runs. */

const NOW = new Date('2026-09-28T12:00:00.000Z')
const HOUR_AGO = '2026-09-28T11:00:00.000Z'
const WORKTREE = '/repo/.worktrees/bd-cc-1'

const claim = (patch: Partial<Claim> = {}): Claim => ({
  taskId: 'CC-1',
  initiative: 'demo',
  agentId: 'a1',
  agentName: 'bd-cc-1',
  spawned: ['bd-cc-1'],
  worktree: WORKTREE,
  spawnedAt: HOUR_AGO,
  phase: 'implementing',
  phaseAt: HOUR_AGO,
  ...patch,
})

const initiative: Initiative = {
  slug: 'demo',
  state: 'focused',
  autonomy: { mode: 'burndown', lanes: 1, accounts: ['a'], grants: [], repo: '/repo' },
}

const context = (running: (name: string) => boolean = () => false): StepContext => ({
  now: NOW,
  root: '/aw',
  initiatives: new Map([['demo', initiative]]),
  tasks: new Map([['demo', [{ id: 'CC-1', title: 'one', doneWhen: 'tests pass', tags: [] }]]]),
  reportTo: 'coord',
  repoFacts: () => ({ defaultBranch: 'main' }),
  account: () => ({ account: 'a' }),
  configDir: account => `/accounts/${account}`,
  trust: () => undefined,
  taskText: () => 'id: CC-1\n',
  readFile: () => undefined,
  running,
})

const ledgerActions = (steps: ReturnType<typeof stepsForActions>['steps']): Action[] =>
  steps.flatMap(s => (s.kind === 'ledger' ? s.actions : []))

describe('the spawn gate', () => {
  it('a marked claim parked for budget in the same tick gets no successor', () => {
    const marked = claim({ respawn: { code: 'phase-timeout', occurrence: HOUR_AGO } })
    const ledger: Ledger = { version: 1, claims: [marked] }
    const spend = { claim: { usd: 50, tokens: 1, agents: 1, unknown: [] }, cap: 10 }
    const advanced = advance([marked], new Map([[claimKey(marked), { spend }]]), NOW)
    const deps = { enabled: true, diffSummary: () => '', live: () => false, now: NOW }
    const laddered = ladderActions(advanced, [marked], ledger, deps)

    const resolved = stepsForActions(laddered.actions, ledger, context(), 1)

    const after = applyActions(ledger, ledgerActions(resolved.steps), NOW).claims[0]
    expect(resolved.steps.map(s => s.kind)).toEqual(['ledger', 'retire'])
    expect(after).toMatchObject({ stallCode: 'budget', phase: 'implementing', agentName: 'bd-cc-1' })
    expect(after?.attempt).toBeUndefined()
    expect(resolved.deferred).toEqual(['CC-1#: spawn of bd-cc-1-s1 refused: claim stalls this tick'])
  })

  it('a reviewer for a claim whose agent still runs waits, and the claim keeps its phase', () => {
    const ledger: Ledger = { version: 1, claims: [claim()] }
    const actions: Action[] = [
      { kind: 'update', key: { taskId: 'CC-1' }, patch: { phase: 'spawning', agentName: 'bd-cc-1-r0' } },
      { kind: 'spawn', key: { taskId: 'CC-1' }, role: 'reviewer', name: 'bd-cc-1-r0' },
    ]

    const resolved = stepsForActions(
      actions,
      ledger,
      context(name => name === 'bd-cc-1'),
      1,
    )

    expect(resolved.steps).toEqual([])
    expect(resolved.deferred).toEqual(['CC-1#: spawn of bd-cc-1-r0 refused: bd-cc-1 still running'])
  })

  it('a reviewer for a claim whose agent has exited spawns', () => {
    const ledger: Ledger = { version: 1, claims: [claim()] }
    const actions: Action[] = [
      { kind: 'update', key: { taskId: 'CC-1' }, patch: { phase: 'spawning', agentName: 'bd-cc-1-r0' } },
      { kind: 'spawn', key: { taskId: 'CC-1' }, role: 'reviewer', name: 'bd-cc-1-r0' },
    ]

    const resolved = stepsForActions(actions, ledger, context(), 1)

    expect(resolved.steps.map(s => s.kind)).toEqual(['ledger', 'spawn'])
    expect(resolved.spawns).toBe(1)
  })
})
