import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { advance, applyActions, claimKey, type Action, type Observation } from '../agents/burndown/advance.js'
import { EMPTY_LEDGER, type Claim } from '../agents/burndown/ledger.js'
import { observe, type CheckoutPr, type ObserveDeps } from '../agents/burndown/observe.js'
import type { ShepherdRow } from '../agents/burndown/shepherd.js'
import type { AgentIdentity } from '../protocol.js'

/** CC-1329: an exited implementer whose PR is known only from its open Shepherd run is fenced on that PR's files. */

const NOW = new Date('2026-10-14T12:00:00.000Z')
const EARLIER = '2026-10-14T11:00:00.000Z'
const PR = 'https://github.com/o/r/pull/9'
const OUTSIDE = 'src/other/x.ts'
/** Another open PR holding the outside file, so the adjudicator escalates rather than amends. */
const COLLIDING: CheckoutPr = { number: 7, branch: 'other', files: () => [OUTSIDE] }

const agentRow = { agentId: 'a1', name: 'bd-cc-1', state: 'exited', spawnedAt: 1 } as AgentIdentity

const claim = (patch: Partial<Claim> = {}): Claim => ({
  taskId: 'CC-1',
  initiative: 'demo',
  slice: 'a',
  agentId: 'a1',
  agentName: 'bd-cc-1',
  spawned: ['bd-cc-1'],
  worktree: '/nowhere/.worktrees/bd-cc-1',
  spawnedAt: EARLIER,
  phase: 'implementing',
  phaseAt: EARLIER,
  owns: ['src/a.ts'],
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
  branch: 'agent-chat/bd-cc-1',
  ...patch,
})

const counting = (files: string[] | undefined) => {
  const calls: string[] = []
  return { calls, prFiles: (pr: string) => (calls.push(pr), files) }
}

const deps = (over: Partial<ObserveDeps>, rows: ShepherdRow[] = [run()]): ObserveDeps => ({
  root: '/active-work',
  inboxSince: async () => [],
  finalText: () => 'Status: unknown',
  diff: () => ({ reviewable: false, reason: 'clean and level' }),
  changedFiles: () => [],
  exitedWork: () => null,
  shepherdRows: () => rows,
  openPrs: () => [COLLIDING],
  landed: () => true,
  spendCap: () => undefined,
  ...over,
})

async function tick(
  c: Claim,
  d: ObserveDeps,
): Promise<{ obs: Observation; actions: Action[]; after: Claim[] }> {
  const obs = (await observe([c], { agents: [agentRow] }, d)).observations.get(claimKey(c)) ?? {}
  const actions = advance([c], new Map([[claimKey(c), obs]]), NOW)
  return { obs, actions, after: applyActions({ ...EMPTY_LEDGER, claims: [c] }, actions, NOW).claims }
}

const kinds = (actions: Action[]): Action['kind'][] => actions.map(a => a.kind)

describe('an exited implementer whose PR is known only from its open Shepherd run (CC-1329)', () => {
  it.each([
    ['a silent exit', 'Status: unknown'],
    ['a DONE report with no PR line', 'Status: DONE'],
  ])(
    'stalls %s outside-owns with no register when the run PR touches a file outside owns',
    async (_c, text) => {
      const { calls, prFiles } = counting(['src/a.ts', OUTSIDE])

      const { obs, actions, after } = await tick(claim(), deps({ finalText: () => text, prFiles }))

      expect(calls).toEqual(['o/r#9'])
      expect(obs.owned).toMatchObject({ outside: [OUTSIDE] })
      expect(kinds(actions)).not.toContain('register')
      expect(after).toEqual([expect.objectContaining({ phase: 'implementing', stallCode: 'outside-owns' })])
    },
  )

  it('stalls a silent exit whose reset worktree has no PR of its own on GitHub', async () => {
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'run-pr-owns-'))
    try {
      const { obs, after } = await tick(
        claim({ worktree }),
        deps({ exitedWork: () => ({ openPr: null, ahead: 0 }), prFiles: () => ['src/a.ts', OUTSIDE] }),
      )

      expect(obs.exitedWork).toEqual({ openPr: null, ahead: 0 })
      expect(after).toEqual([expect.objectContaining({ phase: 'implementing', stallCode: 'outside-owns' })])
    } finally {
      fs.rmSync(worktree, { recursive: true, force: true })
    }
  })

  it('moves to shepherding on the open run when its PR stays inside owns', async () => {
    const { after } = await tick(claim(), deps({ prFiles: () => ['src/a.ts'] }))

    expect(after).toEqual([expect.objectContaining({ phase: 'shepherding', pr: 'o/r#9' })])
  })

  it('reads no PR files for an ended run', async () => {
    const { calls, prFiles } = counting(['src/a.ts', OUTSIDE])

    const { after } = await tick(claim({ pr: undefined }), deps({ prFiles }, [run({ phase: 'failed' })]))

    expect(calls).toEqual([])
    expect(after[0]?.stallCode).not.toBe('outside-owns')
  })

  it('reads the PR files once when the claim records its PR', async () => {
    const { calls, prFiles } = counting(['src/a.ts'])

    await tick(claim({ pr: PR }), deps({ finalText: () => 'Status: DONE', prFiles }))

    expect(calls).toEqual([PR])
  })

  it('waits when the run PR files are unreadable', async () => {
    const { obs, actions } = await tick(claim(), deps({ prFiles: () => undefined }))

    expect(obs.owned).toBe('unreadable')
    expect(actions).toEqual([])
  })

  it('amends rather than escalates when the only other open PR holding the file is the run PR on a foreign branch', async () => {
    const self: CheckoutPr = { number: 9, branch: 'hand-made', files: () => [OUTSIDE] }

    const { obs, after } = await tick(
      claim(),
      deps({ prFiles: () => [OUTSIDE], openPrs: () => [self] }, [run({ branch: 'hand-made' })]),
    )

    expect(obs.owned).toEqual({ outside: [OUTSIDE], adjudicated: { kind: 'amend', files: [OUTSIDE] } })
    expect(after).toEqual([expect.objectContaining({ phase: 'shepherding', owns: ['src/a.ts', OUTSIDE] })])
  })
})
