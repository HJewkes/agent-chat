import { describe, expect, it } from 'vitest'
import { advance, applyActions } from '../agents/burndown/advance.js'
import type { RunResult } from '../agents/burndown/exec.js'
import { EMPTY_LEDGER, type Claim, type Ledger } from '../agents/burndown/ledger.js'
import { observe, type Roster } from '../agents/burndown/observe.js'
import { claimPrReader, type RepoPull } from '../agents/burndown/pr-state.js'
import type { AgentIdentity } from '../protocol.js'

/** CC-1054: the tick lets go of a claim whose PR merged, or whose agent is gone and left no PR, as seats did by hand. */

const NOW = new Date('2026-10-11T12:00:00.000Z')
const EARLIER = '2026-10-11T09:00:00.000Z'

const claim = (patch: Partial<Claim> = {}): Claim => ({
  taskId: 'CC-1',
  initiative: 'demo',
  agentId: 'a1',
  agentName: 'bd-cc-1-a',
  spawned: ['bd-cc-1-a'],
  spawnedAt: EARLIER,
  phase: 'implementing',
  phaseAt: EARLIER,
  slice: 'a',
  worktree: '/nowhere/wt-a',
  stalledReason: 'outside-owns: PR touches x.ts outside its slice owns',
  stalledClass: 'stalled',
  stallCode: 'outside-owns',
  ...patch,
})

const pull = (patch: Partial<RepoPull> = {}): RepoPull => ({
  number: 9,
  state: 'closed',
  mergedAt: '2026-10-11T11:00:00Z',
  branch: 'agent-chat/bd-cc-1-a',
  headSha: 'h9',
  ...patch,
})

const agent = (name: string, state: AgentIdentity['state']): AgentIdentity =>
  ({
    agentId: name,
    name,
    state,
    spawnedAt: 1,
    cwd: '/nowhere',
    sessionId: 's',
    configDir: '',
  }) as AgentIdentity

interface FakeGh {
  calls: string[][]
  exec: (bin: string, args: string[]) => RunResult
}

/** `git remote` answers o/r; `gh api` lists `pulls`, or fails when `pulls` is undefined. */
function fakeGh(pulls: RepoPull[] | undefined): FakeGh {
  const calls: string[][] = []
  const exec = (bin: string, args: string[]): RunResult => {
    calls.push([bin, ...args])
    if (bin === 'git') return { status: 0, stdout: 'https://github.com/o/r.git\n' }
    if (pulls === undefined) return { status: 1, stdout: '', stderr: 'HTTP 502' }
    return { status: 0, stdout: pulls.map(p => JSON.stringify(p)).join('\n') }
  }
  return { calls, exec }
}

/** Observe then advance and apply, as the tick does, with only the gh reader live. */
async function tick(ledger: Ledger, gh: FakeGh, roster: Roster, reviewable = false): Promise<Ledger> {
  const held = ledger.claims.filter(c => c.phase !== 'done')
  const { observations } = await observe(held, roster, {
    inboxSince: async () => [],
    root: '/nowhere',
    shepherdRows: () => [],
    finalText: () => undefined,
    diff: () => ({ reviewable, reason: 'stub' }),
    spendCap: () => undefined,
    progress: () => 'unreadable',
    activity: () => ({ ok: false, reason: 'stub' }) as never,
    prState: claimPrReader(gh.exec),
  })
  return applyActions(ledger, advance(held, observations, NOW), NOW)
}

const exited: Roster = { agents: [agent('bd-cc-1-a', 'exited')] }

describe('the tick settles a claim on what GitHub says (CC-1054)', () => {
  it('finishes a stalled claim with no PR link whose branch PR merged', async () => {
    const ledger = { ...EMPTY_LEDGER, claims: [claim()] }

    const after = await tick(ledger, fakeGh([pull()]), exited)

    expect(after.claims).toEqual([
      expect.objectContaining({ phase: 'done', pr: 'o/r#9', prHead: 'h9', stalledReason: undefined }),
    ])
  })

  it('releases a stalled slice whose agent retired and left no PR', async () => {
    const ledger = {
      ...EMPTY_LEDGER,
      claims: [claim({ stallCode: undefined, stalledReason: 'no final report' })],
    }

    const after = await tick(ledger, fakeGh([]), { agents: [agent('bd-cc-1-a', 'retired')] })

    expect(after.claims).toEqual([])
    expect(after.slicesReleased).toEqual({ 'CC-1': ['a'] })
  })

  it('keeps a stalled claim whose agent left commits but no PR, for the owner', async () => {
    const ledger = { ...EMPTY_LEDGER, claims: [claim()] }

    const after = await tick(ledger, fakeGh([]), exited, true)

    expect(after).toEqual(ledger)
  })

  it('leaves a claim alone while its PR is open, for Shepherd', async () => {
    const ledger = { ...EMPTY_LEDGER, claims: [claim()] }

    const after = await tick(ledger, fakeGh([pull({ state: 'open', mergedAt: null })]), exited)

    expect(after).toEqual(ledger)
  })

  it('changes nothing when gh fails', async () => {
    const ledger = { ...EMPTY_LEDGER, claims: [claim()] }

    const after = await tick(ledger, fakeGh(undefined), exited)

    expect(after).toEqual(ledger)
  })

  it("never finishes a claim on an earlier dispatch's PR merged on the same branch", async () => {
    const ledger = { ...EMPTY_LEDGER, claims: [claim({ stalledReason: undefined, stallCode: undefined })] }
    const roster = { agents: [agent('bd-cc-1-a', 'live')] }

    const after = await tick(ledger, fakeGh([pull({ mergedAt: '2026-10-10T08:00:00Z' })]), roster)

    expect(after).toEqual(ledger)
  })

  it('releases nothing when a full page of PRs may hide an open one', async () => {
    const page = Array.from({ length: 100 }, (_, i) => pull({ number: 100 + i, branch: `other-${i}` }))
    const ledger = { ...EMPTY_LEDGER, claims: [claim()] }

    const after = await tick(ledger, fakeGh(page), exited)

    expect(after).toEqual(ledger)
  })

  it('reads each repo once per tick however many claims share it', async () => {
    const gh = fakeGh([])
    const b = claim({ slice: 'b', agentName: 'bd-cc-1-b', spawned: ['bd-cc-1-b'], worktree: '/nowhere/wt-b' })
    const roster = { agents: [agent('bd-cc-1-a', 'live'), agent('bd-cc-1-b', 'live')] }

    await tick({ ...EMPTY_LEDGER, claims: [claim(), b] }, gh, roster)

    expect(gh.calls.filter(([bin]) => bin === 'gh')).toHaveLength(1)
  })
})
