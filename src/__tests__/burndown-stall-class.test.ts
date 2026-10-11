import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { advance, claimKey, type Action, type Observation } from '../agents/burndown/advance.js'
import type { Initiative } from '../agents/burndown/eligibility.js'
import type { ExceptionClass } from '../agents/burndown/exception.js'
import { execute, spawnFrame, type Step } from '../agents/burndown/execute.js'
import type { Claim, Ledger } from '../agents/burndown/ledger.js'
import { parseReport } from '../agents/burndown/report.js'
import type { ShepherdRow } from '../agents/burndown/shepherd.js'
import { stepsForActions, type StepContext } from '../agents/burndown/steps.js'

/** CC-648 review nit, carried by CC-649: every stall site, and the class it records, in one table. */

const NOW = new Date('2026-09-28T12:00:00.000Z')
const HOUR_AGO = '2026-09-28T11:00:00.000Z'
const FIVE_HOURS_AGO = '2026-09-28T07:00:00.000Z'
const WORKTREE = '/repo/.worktrees/bd-cc-1'
const exited = { id: 'a1', state: 'exited' as const }

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

const shepherdRow = (phase: ShepherdRow['phase']): ShepherdRow => ({
  repo: 'o/r',
  pr: 9,
  runId: 'run-9',
  phase,
  headSha: 'h9',
  stalled: null,
})

const classOfUpdate = (actions: readonly Action[]): ExceptionClass | undefined =>
  actions.flatMap(a =>
    a.kind === 'update' && a.patch.stalledReason !== undefined ? [a.patch.stalledClass] : [],
  )[0]

const ADVANCE_SITES: [string, Claim, Observation, ExceptionClass][] = [
  ['a spawn whose row never landed', claim({ phase: 'spawning', agentId: undefined }), {}, 'stalled'],
  ['a phase past its timeout', claim({ phaseAt: FIVE_HOURS_AGO }), {}, 'stalled'],
  ['a planner that left no slices', claim({ phase: 'planning' }), { agent: exited }, 'failed'],
  ['a BLOCKED worker', claim(), { agent: exited, report: parseReport('Status: BLOCKED') }, 'failed'],
  ['a worker with no final report', claim(), { agent: exited }, 'failed'],
  [
    'a second failed review',
    claim({ phase: 'reviewing', reviewRound: 1 }),
    { agent: exited, report: parseReport('Verdict: CHANGES') },
    'failed',
  ],
  ['a merge phase with no PR', claim({ phase: 'shepherding' }), { shepherd: {} }, 'failed'],
  [
    'a Shepherd run that ended without merging',
    claim({ phase: 'shepherding', pr: 'https://github.com/o/r/pull/9' }),
    { shepherd: { row: shepherdRow('failed') } },
    'failed',
  ],
  [
    'a PR Shepherd cannot name',
    claim(),
    { agent: exited, report: parseReport('Status: DONE\nPR: https://example.invalid/9') },
    'failed',
  ],
  [
    'a successor with no worktree to adopt',
    claim({ phase: 'parked', questionId: 'q1', worktree: undefined }),
    { inbox: [{ msgId: 'm1', from: 'human', text: 'yes', inReplyTo: 'q1' }] },
    'failed',
  ],
]

const initiative = (patch: Partial<Initiative> = {}): Initiative => ({
  slug: 'demo',
  state: 'focused',
  autonomy: { mode: 'burndown', lanes: 1, accounts: ['a'], grants: [], repo: '/repo' },
  ...patch,
})

function context(patch: Partial<StepContext> = {}): StepContext {
  return {
    now: NOW,
    root: '/aw',
    initiatives: new Map([['demo', initiative()]]),
    tasks: new Map([['demo', [{ id: 'CC-1', title: 'one', doneWhen: 'tests pass', tags: [] }]]]),
    reportTo: 'coord',
    repoFacts: () => ({ defaultBranch: 'main' }),
    account: () => ({ account: 'a' }),
    configDir: account => `/accounts/${account}`,
    trust: () => undefined,
    taskText: () => 'id: CC-1\n',
    readFile: () => undefined,
    running: () => false,
    ...patch,
  }
}

const reviewer: Action = { kind: 'spawn', key: { taskId: 'CC-1' }, role: 'reviewer', name: 'bd-cc-1-r0' }

const classOfSteps = (steps: readonly Step[]): ExceptionClass | undefined =>
  classOfUpdate(steps.flatMap(s => (s.kind === 'ledger' ? s.actions : [])))

const STEP_SITES: [string, Claim[], Partial<StepContext>, ExceptionClass][] = [
  ['a spawn for a claim no longer held', [], {}, 'gate-trip'],
  ['an initiative no longer opted in', [claim()], { initiatives: new Map() }, 'gate-trip'],
  ['a seat no longer in the config', [claim({ seat: 'gone' })], { seat: () => undefined }, 'gate-trip'],
  [
    'an initiative with no repo',
    [claim()],
    { initiatives: new Map([['demo', { slug: 'demo', state: 'focused' }]]) },
    'gate-trip',
  ],
  ['a claim with no worktree', [claim({ worktree: undefined })], {}, 'failed'],
  ['a trust refusal', [claim()], { trust: () => 'not trusted' }, 'gate-trip'],
  ['a brief whose task file is gone', [claim()], { taskText: () => undefined }, 'failed'],
]

describe('every stall site records its exception class', () => {
  it.each(ADVANCE_SITES.map(([site, ...rest]) => [`${site} records ${rest[2]}`, ...rest] as const))(
    'advance: %s',
    (_site, c, obs, cls) => {
      const actions = advance([c], new Map([[claimKey(c), obs]]), NOW)

      expect(classOfUpdate(actions)).toBe(cls)
    },
  )

  it.each(STEP_SITES.map(([site, ...rest]) => [`${site} records ${rest[2]}`, ...rest] as const))(
    'steps: %s',
    (_site, claims, patch, cls) => {
      const ledger: Ledger = { version: 1, claims }

      const resolved = stepsForActions([reviewer], ledger, context(patch), 1)

      expect(classOfSteps(resolved.steps)).toBe(cls)
    },
  )

  describe('execute', () => {
    let dir: string
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stall-class-'))
    })
    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true })
    })

    const deps = (patch: Partial<Parameters<typeof execute>[2]> = {}): Parameters<typeof execute>[2] => ({
      ledgerFile: path.join(dir, 'ledger.json'),
      spawn: async () => ({ ok: true }),
      retire: async () => ({ ok: true }),
      register: () => ({ ok: true }),
      log: () => {},
      now: NOW,
      ...patch,
    })

    it('a spawn refused three times with unchanged facts records failed', async () => {
      const spawning = claim({ phase: 'spawning', agentName: 'bd-cc-1-r0' })
      const frame = spawnFrame({
        name: 'bd-cc-1-r0',
        profile: 'bd-reviewer',
        brief: 'b',
        cwd: WORKTREE,
        configDir: '/accounts/a',
        initiative: 'demo',
        taskId: 'CC-1',
      })
      const step: Step = { kind: 'spawn', key: { taskId: 'CC-1' }, frame }

      let ledger: Ledger = { version: 1, claims: [spawning] }
      for (let tick = 0; tick < 3; tick++)
        ledger = (await execute([step], ledger, deps({ spawn: async () => ({ ok: false }) }))).ledger

      expect(ledger.claims[0]?.stalledClass).toBe('failed')
    })

    it('a Shepherd refusal three times with unchanged facts records gate-trip', async () => {
      const registration = { target: { repo: 'o/r', pr: 9 }, task: 'demo/CC-1', implementer: 'bd-cc-1' }
      const step: Step = { kind: 'register', key: { taskId: 'CC-1' }, registration }
      const refused = deps({ register: () => ({ ok: false, refused: true, reason: 'denyRepos' }) })

      let ledger: Ledger = { version: 1, claims: [claim({ phase: 'shepherding' })] }
      for (let tick = 0; tick < 3; tick++) ledger = (await execute([step], ledger, refused)).ledger

      expect(ledger.claims[0]?.stalledClass).toBe('gate-trip')
    })
  })
})
