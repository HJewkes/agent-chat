import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { advance, applyActions, type Action } from '../agents/burndown/advance.js'
import { EMPTY_LEDGER, readLedger, writeLedger, type Claim, type Ledger } from '../agents/burndown/ledger.js'
import { observe, type Roster } from '../agents/burndown/observe.js'
import type { PlanFile } from '../agents/burndown/seed-slices.js'
import type { ShepherdRow } from '../agents/burndown/shepherd.js'
import { unstallSlice, type UnstallPorts } from '../cli/verbs/burndown-unstall.js'
import type { AgentIdentity } from '../protocol.js'

/** CC-1141: unstall reloads a slice's owns from its fixed plan and clears an outside-owns stall in place. */

const NOW = new Date('2026-10-12T12:00:00.000Z')
const EARLIER = '2026-10-12T09:00:00.000Z'
const WORKTREE = '/nowhere/tc-cc-1-a'
const BRANCH_FILES = ['src/a.ts', 'src/b.ts']

const implementing = (patch: Partial<Claim> = {}): Claim => ({
  taskId: 'CC-1',
  initiative: 'demo',
  slice: 'a',
  dependsOn: [],
  owns: ['src/a.ts'],
  agentId: 'tc-cc-1-a',
  agentName: 'tc-cc-1-a',
  spawned: ['tc-cc-1-a'],
  spawnedAt: EARLIER,
  phase: 'implementing',
  phaseAt: EARLIER,
  worktree: WORKTREE,
  pr: 'o/r#41',
  ...patch,
})

const planOwning = (owns: string[]): PlanFile => ({
  path: '/plans/CC-1-plan.md',
  text: [
    '```burndown-slices',
    JSON.stringify([{ n: 'a', title: 'slice a', points: 1, doneWhen: 'a is done', dependsOn: [], owns }]),
    '```',
  ].join('\n'),
})

const ports = (plan: PlanFile, files: string[] | undefined): UnstallPorts => ({
  plan: () => plan,
  changedFiles: () => files,
})

const exited: Roster = {
  agents: [
    {
      agentId: 'tc-cc-1-a',
      name: 'tc-cc-1-a',
      state: 'exited',
      spawnedAt: 1,
      cwd: WORKTREE,
      sessionId: 's',
      configDir: '',
    } as AgentIdentity,
  ],
}

const mergedRun: ShepherdRow = {
  repo: 'o/r',
  pr: 41,
  runId: 'run-41',
  phase: 'post-merge',
  headSha: 'h41',
  stalled: null,
  implementer: 'tc-cc-1-a',
}

/** Observe then advance, as the tick does, with the branch's changed files and Shepherd stubbed. */
async function tick(
  ledger: Ledger,
  rows: ShepherdRow[] = [],
): Promise<{ ledger: Ledger; actions: Action[] }> {
  const held = ledger.claims.filter(c => c.phase !== 'done')
  const { observations } = await observe(held, exited, {
    finalText: () => 'Status: DONE\nPR: https://github.com/o/r/pull/41',
    inboxSince: async () => [],
    root: '/nowhere',
    diff: () => ({ reviewable: true }) as never,
    changedFiles: () => BRANCH_FILES,
    shepherdRows: () => rows,
    landed: () => true,
    spendCap: () => undefined,
    progress: () => 'unreadable',
    activity: () => ({ ok: false, reason: 'stub' }) as never,
  })
  const actions = advance(held, observations, NOW)
  return { ledger: applyActions(ledger, actions, NOW), actions }
}

describe('burndown unstall (CC-1141)', () => {
  let home: string
  const saved = process.env.AGENT_CHAT_HOME
  const file = () => path.join(home, 'burndown.json')

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-1141-'))
    process.env.AGENT_CHAT_HOME = home
  })

  afterEach(() => {
    if (saved === undefined) delete process.env.AGENT_CHAT_HOME
    else process.env.AGENT_CHAT_HOME = saved
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('clears an outside-owns stall after a plan fix, hands the PR to the implementer, and finishes on merge', async () => {
    const parked = (await tick({ ...EMPTY_LEDGER, claims: [implementing()] })).ledger
    writeLedger(file(), parked)

    const report = await unstallSlice('CC-1', 'a', ports(planOwning(BRANCH_FILES), BRANCH_FILES))
    const handed = await tick(readLedger(file()))
    const merged = await tick(handed.ledger, [mergedRun])

    expect(parked.claims[0]).toMatchObject({ stallCode: 'outside-owns' })
    expect(report.ok).toBe(true)
    expect(readLedger(file()).claims[0]).toEqual(implementing({ owns: BRANCH_FILES }))
    expect(handed.actions).toContainEqual(
      expect.objectContaining({
        kind: 'register',
        registration: expect.objectContaining({ implementer: 'tc-cc-1-a' }),
      }),
    )
    expect(handed.actions.filter(a => a.kind === 'retire')).toEqual([])
    expect(merged.ledger.claims[0]).toMatchObject({ phase: 'done', agentName: 'tc-cc-1-a' })
  })

  it('refuses while a file is still outside the new owns, and writes nothing', async () => {
    const parked = (await tick({ ...EMPTY_LEDGER, claims: [implementing()] })).ledger
    writeLedger(file(), parked)

    const report = await unstallSlice('CC-1', 'a', ports(planOwning(['src/a.ts', 'src/c.ts']), BRANCH_FILES))

    expect(report).toMatchObject({ ok: false, errors: [expect.stringContaining('src/b.ts')] })
    expect(readLedger(file())).toEqual(parked)
  })

  it('refuses a claim stalled for another code and names it', async () => {
    const timedOut = implementing({
      stalledReason: 'late',
      stalledClass: 'stalled',
      stallCode: 'phase-timeout',
    })
    writeLedger(file(), { ...EMPTY_LEDGER, claims: [timedOut] })

    const report = await unstallSlice('CC-1', 'a', ports(planOwning(BRANCH_FILES), BRANCH_FILES))

    expect(report).toMatchObject({ ok: false, errors: [expect.stringContaining('phase-timeout')] })
    expect(readLedger(file()).claims).toEqual([timedOut])
  })

  it('refuses when the worktree cannot be read, rather than reading it as nothing outside', async () => {
    const parked = (await tick({ ...EMPTY_LEDGER, claims: [implementing()] })).ledger
    writeLedger(file(), parked)

    const report = await unstallSlice('CC-1', 'a', ports(planOwning(BRANCH_FILES), undefined))

    expect(report).toMatchObject({ ok: false, errors: [expect.stringContaining('release instead')] })
    expect(readLedger(file())).toEqual(parked)
  })

  it('refuses a slice with no held claim', async () => {
    writeLedger(file(), EMPTY_LEDGER)

    const report = await unstallSlice('CC-1', 'a', ports(planOwning(BRANCH_FILES), BRANCH_FILES))

    expect(report).toMatchObject({ ok: false, errors: ['no held claim on CC-1 slice a'] })
  })
})
