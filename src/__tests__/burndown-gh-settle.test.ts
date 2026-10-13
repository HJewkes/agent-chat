import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { advance, applyActions } from '../agents/burndown/advance.js'
import type { RunResult } from '../agents/burndown/exec.js'
import { EMPTY_LEDGER, type Claim, type Ledger } from '../agents/burndown/ledger.js'
import { observe, type Roster } from '../agents/burndown/observe.js'
import { claimPrReader, claimPrState, readRepoPulls, type RepoPull } from '../agents/burndown/pr-state.js'
import type { AgentIdentity } from '../protocol.js'

/** CC-1054: the tick finishes a claim whose PR merged, which seats released by hand; a claim with no PR stays put. */

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
  closedAt: '2026-10-11T11:00:00Z',
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
async function tick(ledger: Ledger, gh: FakeGh, roster: Roster): Promise<Ledger> {
  const held = ledger.claims.filter(c => c.phase !== 'done')
  const { observations } = await observe(held, roster, {
    inboxSince: async () => [],
    root: '/nowhere',
    shepherdRows: () => [],
    finalText: () => undefined,
    diff: () => ({ reviewable: false, reason: 'stub' }),
    spendCap: () => undefined,
    progress: () => 'unreadable',
    activity: () => ({ ok: false, reason: 'stub' }) as never,
    prState: claimPrReader(gh.exec),
  })
  return applyActions(ledger, advance(held, observations, NOW), NOW)
}

const exited: Roster = { agents: [agent('bd-cc-1-a', 'exited')] }

/** CC-1150 b: a held claim whose agent is gone only gains its stale class; nothing releases or finishes it. */
const staleOnly = (c: Claim, cls: string): Claim => ({ ...c, stale: expect.objectContaining({ class: cls }) })

describe('the tick settles a claim on what GitHub says (CC-1054)', () => {
  it('finishes a stalled claim with no PR link whose branch PR merged', async () => {
    const ledger = { ...EMPTY_LEDGER, claims: [claim()] }

    const after = await tick(ledger, fakeGh([pull()]), exited)

    expect(after.claims).toEqual([
      expect.objectContaining({ phase: 'done', pr: 'o/r#9', prHead: 'h9', stalledReason: undefined }),
    ])
  })

  it('finishes a whole-task claim parked on budget whose recorded PR merged', async () => {
    const parked = claim({
      slice: undefined,
      pr: 'o/r#9',
      stallCode: 'budget',
      stalledReason: 'budget: spent $9 of $8',
    })

    const after = await tick({ ...EMPTY_LEDGER, claims: [parked] }, fakeGh([pull()]), exited)

    expect(after.claims).toEqual([expect.objectContaining({ phase: 'done', pr: 'o/r#9' })])
  })

  it.each([
    ['budget', 'other'],
    ['retry-spent', 'retry-spent'],
  ] as const)(
    'keeps a %s park whose agent retired and left no PR, for the ladder and the owner',
    async (code, cls) => {
      const parked = claim({ stallCode: code, stalledReason: `${code}: parked`, stalledClass: 'failed' })
      const ledger = { ...EMPTY_LEDGER, claims: [parked] }

      const after = await tick(ledger, fakeGh([]), { agents: [agent('bd-cc-1-a', 'retired')] })

      expect(after).toEqual({ ...ledger, claims: [staleOnly(parked, cls)] })
    },
  )

  it('leaves a claim alone while its PR is open, for Shepherd', async () => {
    const ledger = { ...EMPTY_LEDGER, claims: [claim()] }

    const after = await tick(ledger, fakeGh([pull({ state: 'open', mergedAt: null })]), exited)

    expect(after).toEqual({ ...ledger, claims: [staleOnly(claim(), 'outside-owns')] })
  })

  it('changes nothing when gh fails', async () => {
    const ledger = { ...EMPTY_LEDGER, claims: [claim()] }

    const after = await tick(ledger, fakeGh(undefined), exited)

    expect(after).toEqual({ ...ledger, claims: [staleOnly(claim(), 'outside-owns')] })
  })

  it("never finishes a claim on an earlier dispatch's PR merged on the same branch", async () => {
    const ledger = { ...EMPTY_LEDGER, claims: [claim({ stalledReason: undefined, stallCode: undefined })] }
    const roster = { agents: [agent('bd-cc-1-a', 'live')] }

    const after = await tick(ledger, fakeGh([pull({ mergedAt: '2026-10-10T08:00:00Z' })]), roster)

    expect(after).toEqual(ledger)
  })

  it('reads a full page with no PR of the claim as could-not-tell, a short one as no PR', () => {
    const page = Array.from({ length: 100 }, (_, i) => pull({ number: 100 + i, branch: `other-${i}` }))

    const full = claimPrState(claim(), 'o/r', { pulls: page, complete: false })
    const short = claimPrState(claim(), 'o/r', { pulls: page.slice(1), complete: true })

    expect(full).toBeUndefined()
    expect(short).toEqual({ kind: 'none' })
  })

  it('reads each repo once per tick however many claims share it', async () => {
    const gh = fakeGh([])
    const b = claim({ slice: 'b', agentName: 'bd-cc-1-b', spawned: ['bd-cc-1-b'], worktree: '/nowhere/wt-b' })
    const roster = { agents: [agent('bd-cc-1-a', 'live'), agent('bd-cc-1-b', 'live')] }

    await tick({ ...EMPTY_LEDGER, claims: [claim(), b] }, gh, roster)

    expect(gh.calls.filter(([bin]) => bin === 'gh')).toHaveLength(1)
  })
})

describe('the tick finishes a shepherding claim on a merged PR (CC-1074)', () => {
  const shepherding = (patch: Partial<Claim> = {}): Claim =>
    claim({
      phase: 'shepherding',
      pr: 'o/r#9',
      stalledReason: undefined,
      stalledClass: undefined,
      stallCode: undefined,
      ...patch,
    })

  it('finishes a shepherding claim whose PR merged when Shepherd holds no row for it', async () => {
    const after = await tick({ ...EMPTY_LEDGER, claims: [shepherding()] }, fakeGh([pull()]), exited)

    expect(after.claims).toEqual([expect.objectContaining({ phase: 'done', pr: 'o/r#9', prHead: 'h9' })])
  })

  it('leaves a shepherding claim alone while its PR is open', async () => {
    const ledger = { ...EMPTY_LEDGER, claims: [shepherding()] }

    const after = await tick(ledger, fakeGh([pull({ state: 'open', mergedAt: null })]), exited)

    expect(after).toEqual(ledger)
  })

  it('reads the origin of the checkout above a parked worktree', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-settle-'))
    const gh = fakeGh([pull()])
    const parked = claim({ worktree: path.join(repo, '.worktrees', 'bd-cc-1-a') })

    const state = claimPrReader(gh.exec)(parked)

    expect(gh.calls[0]).toEqual(['git', '-C', repo, 'remote', 'get-url', 'origin'])
    expect(state).toEqual({ kind: 'merged', pr: 'o/r#9', head: 'h9' })
    fs.rmSync(repo, { recursive: true })
  })
})

/** CC-1150: Shepherd unreadable must not pin a claim whose PR GitHub reports merged. */
describe('the tick settles a shepherding claim while Shepherd is unreadable (CC-1150)', () => {
  const shepherding = (): Claim =>
    claim({ phase: 'shepherding', pr: 'o/r#9', stalledReason: undefined, stallCode: undefined })
  const observeWith = (prState: ReturnType<typeof claimPrReader>) =>
    observe([shepherding()], exited, {
      inboxSince: async () => [],
      root: '/nowhere',
      shepherdRows: () => undefined,
      finalText: () => undefined,
      spendCap: () => undefined,
      prState,
    })

  it('records the merged PR state and finishes the claim', async () => {
    const { observations, unread } = await observeWith(claimPrReader(fakeGh([pull()]).exec))

    expect(unread).toEqual([])
    const obs = [...observations.values()]
    expect(obs).toEqual([{ prState: { kind: 'merged', pr: 'o/r#9', head: 'h9' } }])
    expect(advance([shepherding()], observations, NOW)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'update', patch: expect.objectContaining({ phase: 'done' }) }),
        expect.objectContaining({ kind: 'retire' }),
      ]),
    )
  })

  it.each([
    ['an open PR', fakeGh([pull({ state: 'open', mergedAt: null })])],
    ['a failed GitHub read', fakeGh(undefined)],
  ])('keeps the claim unread on %s', async (_name, gh) => {
    const { observations, unread } = await observeWith(claimPrReader(gh.exec))

    expect(observations.size).toBe(0)
    expect(unread).toEqual([expect.stringContaining("could not read Shepherd's status")])
  })
})

describe('claimPrState tells a closed PR from none (CC-1150)', () => {
  const closed = pull({ state: 'closed', mergedAt: null, closedAt: '2026-10-12T09:30:00Z' })

  it('reports a recorded PR closed unmerged as closed, with its close time (CC-1230)', () => {
    const found = claimPrState(claim({ pr: 'o/r#9' }), 'o/r', { pulls: [closed], complete: true })

    expect(found).toEqual({ kind: 'closed', pr: 'o/r#9', at: '2026-10-12T09:30:00Z' })
  })

  it('omits the close time when GitHub gave none', () => {
    const found = claimPrState(claim({ pr: 'o/r#9' }), 'o/r', {
      pulls: [{ ...closed, closedAt: null }],
      complete: true,
    })

    expect(found).toEqual({ kind: 'closed', pr: 'o/r#9' })
  })

  it('leaves open and merged results without a close time', () => {
    const open = pull({ state: 'open', mergedAt: null, closedAt: null })
    const merged = pull({ closedAt: '2026-10-11T11:00:00Z' })

    expect(claimPrState(claim({ pr: 'o/r#9' }), 'o/r', { pulls: [open], complete: true })).toEqual({
      kind: 'open',
      pr: 'o/r#9',
    })
    expect(claimPrState(claim({ pr: 'o/r#9' }), 'o/r', { pulls: [merged], complete: true })).toEqual({
      kind: 'merged',
      pr: 'o/r#9',
      head: 'h9',
    })
  })

  it('reports a branch-only closed pull as none', () => {
    const found = claimPrState(claim({ pr: undefined }), 'o/r', { pulls: [closed], complete: true })

    expect(found).toEqual({ kind: 'none' })
  })
})

describe('readRepoPulls carries closed_at (CC-1230)', () => {
  it('asks GitHub for closed_at and keeps it on the pull', () => {
    const gh = fakeGh([pull({ state: 'closed', mergedAt: null, closedAt: '2026-10-12T09:30:00Z' })])

    const read = readRepoPulls('o/r', gh.exec)

    expect(gh.calls[0]).toContain(
      '.[] | {number, state, mergedAt: .merged_at, closedAt: .closed_at, branch: .head.ref, headSha: .head.sha}',
    )
    expect(read?.pulls[0]?.closedAt).toBe('2026-10-12T09:30:00Z')
  })

  it('reads a pull without closed_at as null', () => {
    const { closedAt: _omitted, ...open } = pull({ state: 'open', mergedAt: null })
    const gh = { exec: (): RunResult => ({ status: 0, stdout: JSON.stringify(open) }) }

    expect(readRepoPulls('o/r', gh.exec)?.pulls[0]?.closedAt).toBeNull()
  })
})
