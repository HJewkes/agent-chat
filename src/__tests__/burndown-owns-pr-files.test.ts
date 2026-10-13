import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { advance, applyActions } from '../agents/burndown/advance.js'
import { EMPTY_LEDGER, readLedger, writeLedger, type Claim, type Ledger } from '../agents/burndown/ledger.js'
import { observe, type Roster } from '../agents/burndown/observe.js'
import type { PlanFile } from '../agents/burndown/seed-slices.js'
import { unstallSlice, type UnstallPorts } from '../cli/verbs/burndown-unstall.js'
import type { AgentIdentity } from '../protocol.js'

/** CC-1232: a parked worktree no longer hides an outside-owns stall; the PR's files and the plan's owns decide. */

const NOW = new Date('2026-10-13T12:00:00.000Z')
const EARLIER = '2026-10-13T09:00:00.000Z'
const WORKTREE = '/nowhere/bd-cc-1-a'
const PR_FILES = ['src/a.ts', 'src/b.ts']

const implementing = (patch: Partial<Claim> = {}): Claim => ({
  taskId: 'CC-1',
  initiative: 'demo',
  slice: 'a',
  dependsOn: [],
  owns: ['src/a.ts'],
  agentId: 'bd-cc-1-a',
  agentName: 'bd-cc-1-a',
  spawned: ['bd-cc-1-a'],
  spawnedAt: EARLIER,
  phase: 'implementing',
  phaseAt: EARLIER,
  worktree: WORKTREE,
  pr: 'o/r#41',
  ...patch,
})

const planText = (owns: string[]): string =>
  [
    '```burndown-slices',
    JSON.stringify([{ n: 'a', title: 'slice a', points: 1, doneWhen: 'a is done', dependsOn: [], owns }]),
    '```',
  ].join('\n')

const planOwning = (owns: string[]): PlanFile => ({ path: '/plans/CC-1-plan.md', text: planText(owns) })

const exited: Roster = {
  agents: [
    {
      agentId: 'bd-cc-1-a',
      name: 'bd-cc-1-a',
      state: 'exited',
      spawnedAt: 1,
      cwd: WORKTREE,
      sessionId: 's',
      configDir: '',
    } as AgentIdentity,
  ],
}

interface Reads {
  prFiles?: string[] | undefined
  plan?: string | undefined
}

/** Observe then advance, as the tick does, with the worktree parked (its changed files unreadable). */
async function tick(ledger: Ledger, reads: Reads = {}): Promise<Ledger> {
  const held = ledger.claims.filter(c => c.phase !== 'done')
  const { observations } = await observe(held, exited, {
    finalText: () => 'Status: DONE\nPR: https://github.com/o/r/pull/41',
    inboxSince: async () => [],
    root: '/nowhere',
    diff: () => ({ reviewable: true }) as never,
    changedFiles: () => undefined,
    prFiles: () => reads.prFiles,
    readFile: () => reads.plan,
    shepherdRows: () => [],
    landed: () => true,
    spendCap: () => undefined,
    progress: () => 'unreadable',
    activity: () => ({ ok: false, reason: 'stub' }) as never,
  })
  return applyActions(ledger, advance(held, observations, NOW), NOW)
}

describe('burndown owns read with a parked worktree (CC-1232)', () => {
  it('stalls outside-owns from the PR files when the worktree is gone', async () => {
    const after = await tick({ ...EMPTY_LEDGER, claims: [implementing()] }, { prFiles: PR_FILES })

    expect(after.claims[0]).toMatchObject({ stallCode: 'outside-owns' })
    expect(after.claims[0]?.stalledReason).toContain('src/b.ts')
  })

  it('keeps the claim unstalled when neither the worktree nor the PR files can be read', async () => {
    const after = await tick({ ...EMPTY_LEDGER, claims: [implementing()] }, { prFiles: undefined })

    expect(after.claims[0]?.stallCode).toBeUndefined()
  })

  it('keeps an existing stall when the PR file list cannot be read', async () => {
    const stalled = (await tick({ ...EMPTY_LEDGER, claims: [implementing()] }, { prFiles: PR_FILES })).claims
    const after = await tick({ ...EMPTY_LEDGER, claims: stalled }, { plan: planText(PR_FILES) })

    expect(after.claims[0]).toMatchObject({ stallCode: 'outside-owns' })
  })

  it('clears the stall in the tick when the plan now owns every PR file, and keeps the widened owns', async () => {
    const stalled = (await tick({ ...EMPTY_LEDGER, claims: [implementing()] }, { prFiles: PR_FILES })).claims
    const cleared = await tick(
      { ...EMPTY_LEDGER, claims: stalled },
      { prFiles: PR_FILES, plan: planText(PR_FILES) },
    )
    const next = await tick(cleared, { prFiles: PR_FILES })

    expect(cleared.claims[0]?.stallCode).toBeUndefined()
    expect(cleared.claims[0]?.owns).toEqual(PR_FILES)
    expect(next.claims[0]?.stallCode).toBeUndefined()
  })

  it('keeps the stall when the plan still leaves a PR file outside', async () => {
    const stalled = (await tick({ ...EMPTY_LEDGER, claims: [implementing()] }, { prFiles: PR_FILES })).claims
    const after = await tick(
      { ...EMPTY_LEDGER, claims: stalled },
      { prFiles: PR_FILES, plan: planText(['src/a.ts', 'src/c.ts']) },
    )

    expect(after.claims[0]).toMatchObject({ stallCode: 'outside-owns' })
  })
})

describe('burndown unstall with a parked worktree (CC-1232)', () => {
  let home: string
  const saved = process.env.AGENT_CHAT_HOME
  const file = () => path.join(home, 'burndown.json')
  const ports = (owns: string[], prFiles: string[] | undefined): UnstallPorts => ({
    plan: () => planOwning(owns),
    changedFiles: () => undefined,
    prFiles: () => prFiles,
  })
  const stalledClaim = (): Claim =>
    implementing({ stalledReason: 'PR touches src/b.ts', stalledClass: 'stalled', stallCode: 'outside-owns' })

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-1232-'))
    process.env.AGENT_CHAT_HOME = home
    writeLedger(file(), { ...EMPTY_LEDGER, claims: [stalledClaim()] })
  })

  afterEach(() => {
    if (saved === undefined) delete process.env.AGENT_CHAT_HOME
    else process.env.AGENT_CHAT_HOME = saved
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('clears the stall from the PR files when the worktree is gone', async () => {
    const report = await unstallSlice('CC-1', 'a', ports(PR_FILES, PR_FILES))

    expect(report.ok).toBe(true)
    expect(readLedger(file()).claims[0]).toEqual(implementing({ owns: PR_FILES }))
  })

  it('refuses while the PR still touches a file outside the plan owns', async () => {
    const report = await unstallSlice('CC-1', 'a', ports(['src/a.ts'], PR_FILES))

    expect(report).toMatchObject({ ok: false, errors: [expect.stringContaining('src/b.ts')] })
    expect(readLedger(file()).claims[0]).toEqual(stalledClaim())
  })

  it('refuses and writes nothing when neither the worktree nor the PR files can be read', async () => {
    const report = await unstallSlice('CC-1', 'a', ports(PR_FILES, undefined))

    expect(report).toMatchObject({ ok: false, errors: [expect.stringContaining('PR')] })
    expect(readLedger(file()).claims[0]).toEqual(stalledClaim())
  })
})
