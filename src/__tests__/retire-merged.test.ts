import { describe, expect, it, vi } from 'vitest'
import type { AgentEventRow } from '../broker/event-store.js'
import type { AgentIdentity } from '../protocol.js'
import { prStateReader, type PrState, type PrStateDeps } from '../agents/isolation/pr-state.js'
import {
  PR_READS_PER_PASS,
  PR_REREAD_MS,
  isWorkerProfile,
  passPrReads,
  retireMerged,
  type MergedRetirePort,
} from '../agents/isolation/retire-merged.js'

/** CC-1678: the broker retires an exited worker once the PR its report names is done. */

const PR = 'acme/widget#7'
const REPORT = `Status: DONE\nPR: ${PR}\nHead: ${'a'.repeat(40)}`
const merged: PrState = { state: 'MERGED', head: { number: 7, headSha: 'a'.repeat(40) } }

const agent = (over: Partial<AgentIdentity> = {}): AgentIdentity => ({
  agentId: 'id-w',
  name: 'w',
  profile: 'bd-implementer',
  state: 'exited',
  origin: 'spawned',
  spawnedBy: 'seat',
  spawnedAt: 1,
  brief: 'b',
  cwd: '/nowhere/w',
  isolation: 'worktree',
  surface: 'headless',
  sessionId: 's',
  lastEventAt: 2,
  generation: 1,
  ...over,
})

const allocated = (tree: string) => (): readonly AgentEventRow[] => [
  {
    kind: 'isolation_allocated',
    ref: 'id-w',
    meta: { strategy: 'worktree', gitRoot: tree, worktree: tree, branch: 'agent-chat/w' },
  } as unknown as AgentEventRow,
]

function makePort(roster: AgentIdentity[], over: Partial<MergedRetirePort> = {}) {
  const retire = vi.fn(async () => ({ ok: true }))
  const park = vi.fn(async () => ({ ok: true }))
  const port: MergedRetirePort = {
    roster: () => roster,
    events: () => [],
    current: id => roster.find(a => a.agentId === id),
    tracked: () => false,
    parking: () => false,
    presence: () => 'none',
    lastReport: () => REPORT,
    treeHold: () => undefined,
    skip: { activeRuns: async () => [], hasOpenPr: async () => false },
    readPr: async () => merged,
    park,
    retire,
    ...over,
  }
  return { port, retire, park }
}

describe('retireMerged', () => {
  it.each(['MERGED', 'CLOSED'] as const)('retires an exited worker whose PR is %s', async state => {
    const { port, retire } = makePort([agent()], { readPr: async () => ({ ...merged, state }) })

    const results = await retireMerged(port)

    expect(retire).toHaveBeenCalledWith('id-w')
    expect(results).toEqual([{ action: 'retired', name: 'w', pr: PR, parked: false }])
  })

  it('keeps a worker whose PR is still open, and reports nothing for it', async () => {
    const { port, retire } = makePort([agent()], { readPr: async () => ({ ...merged, state: 'OPEN' }) })

    expect(await retireMerged(port)).toEqual([])
    expect(retire).not.toHaveBeenCalled()
  })

  it('keeps a worker whose PR state could not be read', async () => {
    const { port, retire } = makePort([agent()], { readPr: async () => undefined })

    await retireMerged(port)

    expect(retire).not.toHaveBeenCalled()
  })

  it('reads no PR for a worker whose report names none', async () => {
    const readPr = vi.fn(async () => merged)
    const { port, retire } = makePort([agent()], { readPr, lastReport: () => 'Status: BLOCKED' })

    await retireMerged(port)

    expect(readPr).not.toHaveBeenCalled()
    expect(retire).not.toHaveBeenCalled()
  })

  it.each([
    ['a coordinator profile', agent({ profile: 'opus-coordinator' })],
    ['a live worker', agent({ state: 'live' })],
    ['a detached worker', agent({ state: 'detached' })],
    ['an adopted session', agent({ origin: 'adopted' })],
  ])('never considers %s', async (_label, row) => {
    const { port, retire } = makePort([row])

    expect(await retireMerged(port)).toEqual([])
    expect(retire).not.toHaveBeenCalled()
  })

  it('keeps a worker another live agent stands in the tree of', async () => {
    const fixer = agent({ agentId: 'id-f', name: 'f', state: 'live', cwd: '/nowhere/w/src' })
    const { port, retire } = makePort([agent(), fixer])

    const [result] = await retireMerged(port)

    expect(retire).not.toHaveBeenCalled()
    expect(result).toMatchObject({ action: 'kept', reason: expect.stringContaining('f is live') })
  })

  it('keeps a worker whose process this broker still tracks', async () => {
    const { port, retire } = makePort([agent()], { tracked: () => true })

    await retireMerged(port)

    expect(retire).not.toHaveBeenCalled()
  })

  it('keeps a worker with another open PR on its branch', async () => {
    const skip = { activeRuns: async () => [], hasOpenPr: async () => true }
    const events = allocated('/nowhere/w')
    const { port, retire } = makePort([agent()], { skip, events })

    await retireMerged(port)

    expect(retire).not.toHaveBeenCalled()
  })

  it('keeps a worker when Shepherd cannot be read', async () => {
    const skip = {
      activeRuns: () => Promise.reject(new Error('down')),
      hasOpenPr: async () => false,
    }
    const { port, retire } = makePort([agent()], { skip })

    await retireMerged(port)

    expect(retire).not.toHaveBeenCalled()
  })

  describe('with a worktree on disk', () => {
    const tree = process.cwd()
    const events = allocated(tree)

    it('parks it with the PR head as backing before retiring', async () => {
      const { port, park, retire } = makePort([agent({ cwd: tree })], { events })

      const [result] = await retireMerged(port)

      expect(park).toHaveBeenCalledWith('id-w', merged.head)
      expect(retire).toHaveBeenCalledWith('id-w')
      expect(result).toMatchObject({ action: 'retired', parked: true })
    })

    it('keeps the worker when park refuses unpushed work', async () => {
      const { port, retire } = makePort([agent({ cwd: tree })], {
        events,
        park: async () => ({ ok: false, reason: 'unpushed commits' }),
      })

      const [result] = await retireMerged(port)

      expect(retire).not.toHaveBeenCalled()
      expect(result).toMatchObject({ action: 'kept', reason: 'unpushed commits' })
    })
  })

  it('does not retire one that came back during the checks', async () => {
    let reads = 0
    const row = agent()
    const { port, retire } = makePort([row], {
      current: () => (++reads === 1 ? { ...row, state: 'live' } : row),
    })

    const [result] = await retireMerged(port)

    expect(retire).not.toHaveBeenCalled()
    expect(result).toMatchObject({ action: 'kept' })
  })

  it('carries on past a retire that throws', async () => {
    const rows = [agent(), agent({ agentId: 'id-x', name: 'x', cwd: '/nowhere/x' })]
    const retire = vi.fn(async (id: string) => {
      if (id === 'id-w') throw new Error('boom')
      return { ok: true }
    })
    const { port } = makePort(rows, { retire })

    const results = await retireMerged(port)

    expect(results.map(r => r.action)).toEqual(['kept', 'retired'])
  })
})

describe('isWorkerProfile', () => {
  it.each(['implementer', 'implementer-lite', 'bd-implementer-lite', 'fable-reviewer', 'opus-adversary'])(
    'takes %s',
    profile => expect(isWorkerProfile(profile)).toBe(true),
  )

  it.each(['opus-coordinator', 'fable-coordinator', 'peer', 'planner', 'decider'])('refuses %s', profile =>
    expect(isWorkerProfile(profile)).toBe(false),
  )
})

describe('passPrReads', () => {
  it('asks once for a PR two agents name, across passes too once it is done', async () => {
    const read = vi.fn(async () => merged)
    const reads = passPrReads(read)

    await reads()(PR)
    await reads()(PR)

    expect(read).toHaveBeenCalledTimes(1)
  })

  it('asks about an open PR again only after the reread window', async () => {
    let now = 0
    const read = vi.fn(async (): Promise<PrState> => ({ ...merged, state: 'OPEN' }))
    const reads = passPrReads(read, () => now)

    await reads()(PR)
    await reads()(PR)
    now = PR_REREAD_MS
    await reads()(PR)

    expect(read).toHaveBeenCalledTimes(2)
  })

  it('stops at the cap for a pass and goes on in the next', async () => {
    const read = vi.fn(async () => merged)
    const reads = passPrReads(read)
    const pass = reads()

    for (let i = 0; i <= PR_READS_PER_PASS; i++) await pass(`acme/widget#${i}`)
    expect(read).toHaveBeenCalledTimes(PR_READS_PER_PASS)

    await reads()(`acme/widget#${PR_READS_PER_PASS}`)
    expect(read).toHaveBeenCalledTimes(PR_READS_PER_PASS + 1)
  })

  it('answers undefined for a failed read and does not repeat it within the window', async () => {
    const read = vi.fn(() => Promise.reject(new Error('gh down')))
    const reads = passPrReads(read, () => 0)

    expect(await reads()(PR)).toBeUndefined()
    await reads()(PR)

    expect(read).toHaveBeenCalledTimes(1)
  })
})

describe('prStateReader', () => {
  const deps = (over: Partial<PrStateDeps> = {}): PrStateDeps => ({
    cooldowns: async () => ({}),
    gh: async () => ({
      exitCode: 0,
      stdout: JSON.stringify({ state: 'MERGED', headRefOid: 'a'.repeat(40) }),
      stderr: '',
      ms: 1,
    }),
    log: () => undefined,
    hit: async () => undefined,
    ...over,
  })

  it('reads the state and head, and logs the call', async () => {
    const log = vi.fn()
    const gh = vi.fn(deps().gh)

    const state = await prStateReader(deps({ gh, log }))(PR)

    expect(state).toEqual(merged)
    expect(gh.mock.calls[0]?.[0]).toEqual([
      'pr',
      'view',
      '7',
      '--repo',
      'acme/widget',
      '--json',
      'state,headRefOid',
    ])
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ caller: 'retire-merged', route: 'pr view' }))
  })

  it('makes no call while the lane cools', async () => {
    const gh = vi.fn(deps().gh)
    const cooldowns = async () => ({ graphql: { until: 9, class: 'secondary' as const } })

    await expect(prStateReader(deps({ gh, cooldowns }))(PR)).rejects.toThrow('cooling')

    expect(gh).not.toHaveBeenCalled()
  })

  it('records a cooldown when a rate limit refuses the call', async () => {
    const hit = vi.fn(async () => undefined)
    const gh = async () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'HTTP 403: You have exceeded a secondary rate limit',
      ms: 1,
    })

    await expect(prStateReader(deps({ gh, hit }))(PR)).rejects.toThrow('exited 1')

    expect(hit).toHaveBeenCalledWith(expect.objectContaining({ lane: 'graphql', class: 'secondary' }))
  })

  it('rejects an answer in a state it does not know', async () => {
    const gh = async () => ({ exitCode: 0, stdout: '{"state":"DRAFT"}', stderr: '', ms: 1 })

    await expect(prStateReader(deps({ gh }))(PR)).rejects.toThrow('known state')
  })
})
