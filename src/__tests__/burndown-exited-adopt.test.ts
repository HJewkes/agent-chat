import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { advance, applyActions, claimKey, type Action, type Observation } from '../agents/burndown/advance.js'
import { successorAfterExit, SUCCESSOR_BRIEF_MAX_BYTES, type TaskBrief } from '../agents/burndown/brief.js'
import type { RunResult } from '../agents/burndown/exec.js'
import { readExitedWork, type ExitedWork } from '../agents/burndown/exited-adopt.js'
import { EMPTY_LEDGER, type Claim } from '../agents/burndown/ledger.js'
import { observe, type ObserveDeps } from '../agents/burndown/observe.js'
import { parseReport } from '../agents/burndown/report.js'
import type { AgentIdentity } from '../protocol.js'

/** CC-673: an implementer that exits with no status line is adopted from what git and GitHub show. */

const NOW = new Date('2026-10-09T12:00:00.000Z')
const EARLIER = '2026-10-09T11:00:00.000Z'
const WORKTREE = '/repo/.worktrees/bd-cc-1'
const PR = 'https://github.com/o/r/pull/9'

const claim = (patch: Partial<Claim> = {}): Claim => ({
  taskId: 'CC-1',
  initiative: 'demo',
  agentId: 'a1',
  agentName: 'bd-cc-1',
  spawned: ['bd-cc-1'],
  worktree: WORKTREE,
  spawnedAt: EARLIER,
  phase: 'implementing',
  phaseAt: EARLIER,
  ...patch,
})

const silentExit = (
  work: ExitedWork,
  diff = { reviewable: true, reason: '2 commit(s) ahead' },
): Observation => ({
  agent: { id: 'a1', state: 'exited' },
  exitedWork: work,
  diff,
})

function step(c: Claim, obs: Observation): { actions: Action[]; after: Claim[] } {
  const actions = advance([c], new Map([[claimKey(c), obs]]), NOW)
  return { actions, after: applyActions({ ...EMPTY_LEDGER, claims: [c] }, actions, NOW).claims }
}

const kinds = (actions: Action[]): Action['kind'][] => actions.map(a => a.kind)

describe('exited-agent adoption', () => {
  it('sends a silent exit with an open PR on its branch to shepherding', () => {
    const { actions, after } = step(claim(), silentExit({ openPr: PR, ahead: 2 }))

    expect(actions).toContainEqual(
      expect.objectContaining({
        kind: 'register',
        registration: { target: { repo: 'o/r', pr: 9 }, task: 'demo/CC-1', implementer: 'bd-cc-1' },
      }),
    )
    expect(kinds(actions)).not.toContain('spawn')
    expect(after).toEqual([expect.objectContaining({ phase: 'shepherding', pr: PR })])
  })

  it('respawns a silent exit with commits ahead and no PR once, with a resume brief context', () => {
    const { actions, after } = step(claim(), silentExit({ openPr: null, ahead: 2 }))

    expect(actions.filter(a => a.kind === 'spawn')).toEqual([
      expect.objectContaining({
        role: 'successor',
        name: 'bd-cc-1-s1',
        predecessor: 'bd-cc-1',
        worktree: WORKTREE,
        context: { kind: 'resume', ahead: 2 },
      }),
    ])
    expect(after).toEqual([
      expect.objectContaining({ phase: 'spawning', nextPhase: 'implementing', resumed: true, attempt: 1 }),
    ])
  })

  it('never resumes a claim twice: a second silent exit goes to review, not another successor', () => {
    const resumed = claim({
      agentName: 'bd-cc-1-s1',
      spawned: ['bd-cc-1', 'bd-cc-1-s1'],
      attempt: 1,
      resumed: true,
    })

    const { actions, after } = step(resumed, silentExit({ openPr: null, ahead: 3 }))

    expect(actions.filter(a => a.kind === 'spawn')).toEqual([expect.objectContaining({ role: 'reviewer' })])
    expect(after).toEqual([expect.objectContaining({ nextPhase: 'reviewing', resumed: true })])
  })

  it('stalls a second silent exit with nothing reviewable rather than resuming again', () => {
    const resumed = claim({ attempt: 1, resumed: true })

    const { actions, after } = step(
      resumed,
      silentExit({ openPr: null, ahead: 0 }, { reviewable: false, reason: 'clean and level' }),
    )

    expect(kinds(actions)).toEqual(['update'])
    expect(after).toEqual([
      expect.objectContaining({ phase: 'implementing', stalledReason: 'no final report' }),
    ])
  })

  it.each([
    ['an open PR', { openPr: PR, ahead: 1 }],
    ['commits ahead', { openPr: null, ahead: 1 }],
    ['neither', { openPr: null, ahead: 0 }],
  ])('keeps the claim held after a silent exit with %s', (_case, work) => {
    const { actions, after } = step(claim(), silentExit(work, { reviewable: false, reason: 'none' }))

    expect(kinds(actions)).not.toContain('release')
    expect(after).toHaveLength(1)
    expect(after[0]?.phase).not.toBe('queued')
    expect(after[0]?.phase).not.toBe('done')
  })

  it('still parks an over-budget claim whose exited work is unreadable', () => {
    const { after } = step(claim({ seat: 'seat-t' }), {
      agent: { id: 'a1', state: 'exited' },
      exitedWork: 'unreadable',
      spend: { claim: { usd: 30, tokens: 1, agents: 1, unknown: [] }, cap: 20 },
    })

    expect(after).toEqual([expect.objectContaining({ phase: 'implementing', stallCode: 'budget' })])
  })

  it('leaves a worker that reported a status to its report', () => {
    const { actions } = step(claim(), {
      ...silentExit({ openPr: PR, ahead: 2 }),
      report: parseReport('Status: DONE_WITH_CONCERNS'),
    })

    expect(actions.filter(a => a.kind === 'spawn')).toEqual([expect.objectContaining({ role: 'reviewer' })])
    expect(kinds(actions)).not.toContain('register')
  })
})

describe('observe reads exited work only for a silent exit', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-exited-')))
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  const row = { agentId: 'a1', name: 'bd-cc-1', state: 'exited', spawnedAt: 1 } as AgentIdentity
  const deps = (over: Partial<ObserveDeps>): ObserveDeps => ({
    root: '/active-work',
    inboxSince: async () => [],
    diff: () => ({ reviewable: true, reason: '1 commit(s) ahead' }),
    ...over,
  })

  it('records the open PR and commits ahead when the agent left no final text', async () => {
    const c = claim({ worktree: dir })
    const work = { openPr: null, ahead: 1 }

    const { observations } = await observe(
      [c],
      { agents: [row] },
      deps({ finalText: () => undefined, exitedWork: () => work }),
    )

    expect(observations.get(claimKey(c))?.exitedWork).toEqual(work)
  })

  it('marks the work unreadable when the PR or commit read fails, so the claim waits a tick', async () => {
    const c = claim({ worktree: dir })

    const { observations } = await observe(
      [c],
      { agents: [row] },
      deps({ finalText: () => 'I ran out of context', exitedWork: () => undefined }),
    )
    const obs = observations.get(claimKey(c)) ?? {}

    expect(obs.exitedWork).toBe('unreadable')
    expect(step(c, obs).actions).toEqual([])
  })

  it('does not read GitHub for a worker whose report has a status', async () => {
    const c = claim({ worktree: dir })
    let reads = 0

    await observe(
      [c],
      { agents: [row] },
      deps({ finalText: () => 'Status: BLOCKED', exitedWork: () => ((reads += 1), undefined) }),
    )

    expect(reads).toBe(0)
  })
})

describe('readExitedWork', () => {
  const runner =
    (gh: RunResult) =>
    (bin: string, args: string[]): RunResult => {
      if (bin === 'gh') return gh
      if (args.includes('--verify'))
        return { status: args.at(-1) === 'origin/HEAD^{commit}' ? 0 : 1, stdout: '' }
      if (args[0] === 'rev-list') return { status: 0, stdout: '2\n' }
      if (args[0] === 'rev-parse') return { status: 0, stdout: 'agent-chat/bd-cc-1\n' }
      return { status: 0, stdout: 'git@github.com:o/r.git\n' }
    }

  it('reads the open PR url and the commits ahead', () => {
    expect(readExitedWork(WORKTREE, runner({ status: 0, stdout: `${PR}\n` }))).toEqual({
      openPr: PR,
      ahead: 2,
    })
  })

  it('reads no open PR as null', () => {
    expect(readExitedWork(WORKTREE, runner({ status: 0, stdout: '\n' }))).toEqual({ openPr: null, ahead: 2 })
  })

  it('gives undefined when GitHub cannot be read, never "no PR"', () => {
    expect(readExitedWork(WORKTREE, runner({ status: 1, stdout: '' }))).toBeUndefined()
  })
})

describe('resume brief', () => {
  const task: TaskBrief = {
    reportTo: 'coord',
    configDir: '/cfg',
    defaultBranch: 'main',
    initiative: 'demo',
    initiativeDir: '/aw/demo',
    taskId: 'CC-1',
    taskYml: 'id: CC-1',
    doneWhen: 'it sings',
    grants: [],
  }

  it('names the commits left, the single resume and the done condition within budget', () => {
    const brief = successorAfterExit(task, 3)

    expect(brief).toContain('left 3 commit(s)')
    expect(brief).toContain('no further successor')
    expect(brief).toContain('Done when: it sings')
    expect(Buffer.byteLength(brief)).toBeLessThanOrEqual(SUCCESSOR_BRIEF_MAX_BYTES)
  })
})
