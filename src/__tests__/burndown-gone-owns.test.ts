import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { advance, applyActions, type Action } from '../agents/burndown/advance.js'
import { EMPTY_LEDGER, type Claim, type Ledger } from '../agents/burndown/ledger.js'
import { observe, type CheckoutPr, type ObserveDeps } from '../agents/burndown/observe.js'
import type { ShepherdRow } from '../agents/burndown/shepherd.js'

/** CC-1254: an implementer whose row left a complete roster is fenced on its owns before Shepherd takes its PR. */

const NOW = new Date('2026-10-14T12:00:00.000Z')
const RECENT = '2026-10-14T11:55:00.000Z'
const OUTSIDE_FILE = 'src/other/x.ts'
const COLLIDING: CheckoutPr = { number: 7, branch: 'other', files: () => [OUTSIDE_FILE] }

const implementing = (patch: Partial<Claim> = {}): Claim => ({
  taskId: 'CC-1',
  initiative: 'demo',
  slice: 'a',
  dependsOn: [],
  owns: ['src/a.ts'],
  agentId: 'bd-cc-1',
  agentName: 'bd-cc-1',
  spawned: ['bd-cc-1'],
  spawnedAt: RECENT,
  phase: 'implementing',
  phaseAt: RECENT,
  pr: 'o/r#9',
  ...patch,
})

const run = (patch: Partial<ShepherdRow> = {}): ShepherdRow => ({
  repo: 'o/r',
  pr: 9,
  runId: 'run-9',
  phase: 'ci',
  headSha: 'h9',
  stalled: null,
  implementer: 'bd-cc-1',
  ...patch,
})

interface Tick {
  ledger: Ledger
  actions: Action[]
  owned: unknown
}

/** Observe with the agent's row gone from a complete roster, then advance, as the tick does. */
async function tick(claim: Claim, deps: Partial<ObserveDeps>, rows: ShepherdRow[] = [run()]): Promise<Tick> {
  const { observations } = await observe(
    [claim],
    { agents: [] },
    {
      inboxSince: async () => [],
      root: '/nowhere',
      shepherdRows: () => rows,
      openPrs: () => [COLLIDING],
      changedFiles: () => [],
      readFile: () => undefined,
      landed: () => true,
      spendCap: () => undefined,
      progress: () => 'unreadable',
      activity: () => ({ ok: false, reason: 'stub' }) as never,
      ...deps,
    },
  )
  const actions = advance([claim], observations, NOW)
  const owned = [...observations.values()][0]?.owned
  return { ledger: applyActions({ ...EMPTY_LEDGER, claims: [claim] }, actions, NOW), actions, owned }
}

const kinds = (actions: Action[]): string[] => actions.map(a => a.kind)

describe('an implementer whose row is gone while Shepherd holds an open run', () => {
  it('stalls outside-owns with no register when the PR touches a file outside owns', async () => {
    const { ledger, actions } = await tick(implementing(), { prFiles: () => ['src/a.ts', OUTSIDE_FILE] })

    expect(kinds(actions)).not.toContain('register')
    expect(ledger.claims[0]).toMatchObject({ phase: 'implementing', stallCode: 'outside-owns' })
    expect(ledger.claims[0]?.stalledReason).toContain(OUTSIDE_FILE)
  })

  it('moves to shepherding on the open run when the PR is inside owns', async () => {
    const { ledger } = await tick(implementing(), { prFiles: () => ['src/a.ts'] })

    expect(ledger.claims[0]).toMatchObject({ phase: 'shepherding', pr: 'o/r#9' })
    expect(ledger.claims[0]?.stallCode).toBeUndefined()
  })

  it("reads the open run's PR when the claim has none recorded", async () => {
    const prFiles = vi.fn(() => [OUTSIDE_FILE])

    const { ledger, actions } = await tick(implementing({ pr: undefined }), { prFiles })

    expect(prFiles).toHaveBeenCalledWith('o/r#9')
    expect(kinds(actions)).not.toContain('register')
    expect(ledger.claims[0]).toMatchObject({ stallCode: 'outside-owns' })
  })

  it('waits with the claim unchanged when the PR files are unreadable', async () => {
    const claim = implementing()

    const { ledger, actions, owned } = await tick(claim, { prFiles: () => undefined })

    expect(owned).toBe('unreadable')
    expect(actions).toEqual([])
    expect(ledger.claims[0]).toEqual(claim)
  })

  it('stalls on a committed branch file outside owns when the PR itself is clean', async () => {
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'gone-owns-'))
    try {
      const { ledger, actions } = await tick(implementing({ worktree }), {
        changedFiles: () => [OUTSIDE_FILE],
        prFiles: () => ['src/a.ts'],
      })

      expect(kinds(actions)).not.toContain('register')
      expect(ledger.claims[0]).toMatchObject({ stallCode: 'outside-owns' })
    } finally {
      fs.rmSync(worktree, { recursive: true, force: true })
    }
  })

  it('waits when the branch files of an existing worktree are unreadable', async () => {
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'gone-owns-'))
    try {
      const { actions, owned } = await tick(implementing({ worktree }), {
        changedFiles: () => undefined,
        prFiles: () => ['src/a.ts'],
      })

      expect(owned).toBe('unreadable')
      expect(actions).toEqual([])
    } finally {
      fs.rmSync(worktree, { recursive: true, force: true })
    }
  })
})

describe('a gone implementer the owns read skips', () => {
  it('reads no PR for a claim that owns nothing and hands off as before', async () => {
    const prFiles = vi.fn(() => [OUTSIDE_FILE])

    const { ledger } = await tick(implementing({ owns: undefined }), { prFiles })

    expect(prFiles).not.toHaveBeenCalled()
    expect(ledger.claims[0]).toMatchObject({ phase: 'shepherding', pr: 'o/r#9' })
  })

  it('reads no PR when the Shepherd run has ended', async () => {
    const prFiles = vi.fn(() => [OUTSIDE_FILE])

    await tick(implementing(), { prFiles }, [run({ phase: 'failed' })])

    expect(prFiles).not.toHaveBeenCalled()
  })
})
