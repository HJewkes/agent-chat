import { describe, expect, it } from 'vitest'
import type { Claim, Ledger } from '../agents/burndown/ledger.js'
import {
  describeCandidates,
  parkCandidates,
  parkSweep,
  PARK_SWEEP_MAX,
} from '../agents/burndown/park-sweep.js'
import type { SpawnReply } from '../agents/burndown/execute.js'
import type { AgentIdentity } from '../protocol.js'

const T0 = Date.UTC(2026, 9, 13)
const MISSING = '/trees/gone'

const agent = (name: string, over: Partial<AgentIdentity> = {}): AgentIdentity => ({
  agentId: `id-${name}`,
  name,
  profile: 'bd-implementer',
  state: 'exited',
  origin: 'spawned',
  spawnedBy: 'seat-a',
  spawnedAt: T0,
  brief: '',
  cwd: `/trees/${name}`,
  isolation: 'worktree',
  surface: 'headless',
  sessionId: '',
  configDir: '/profiles/agents',
  lastEventAt: T0,
  generation: 1,
  ...over,
})

const implementing = (worktree: string): Claim => ({
  taskId: 'CC-1',
  initiative: 'claude-channels',
  spawnedAt: new Date(T0).toISOString(),
  phase: 'implementing',
  phaseAt: new Date(T0).toISOString(),
  worktree,
})

const ledgerOf = (claims: Claim[]): Ledger => ({ version: 1, claims })

/** 4 live and 26 exited agents; 7 of the exited are ineligible, one for each rule. */
function fleet(): { agents: AgentIdentity[]; ledger: Ledger } {
  const live = [0, 1, 2, 3].map(i => agent(`tc-live-${i}`, { state: 'live' }))
  const eligible = Array.from({ length: 19 }, (_, i) => agent(`tc-old-${i}`, { exitedAt: T0 + i * 1000 }))
  const ineligible = [
    agent('tc-rv-a', { profile: 'rv-readonly' }),
    agent('rv-tc-b'),
    agent('tc-adopted', { origin: 'adopted' }),
    agent('tc-gone', { cwd: MISSING }),
    agent('tc-held-a'),
    agent('tc-held-b'),
    agent('zz-unknown'),
  ]
  const ledger = ledgerOf([implementing('/trees/tc-held-a'), implementing('/trees/tc-held-b')])
  return { agents: [...live, ...eligible.reverse(), ...ineligible], ledger }
}

const exists = (dir: string): boolean => dir !== MISSING

describe('which exited trees the tick may park (CC-1257)', () => {
  it('keeps the exited spawned non-reviewer trees of known prefixes no claim reads, oldest exit first', () => {
    const { agents, ledger } = fleet()

    const names = parkCandidates({ agents }, ledger, ['bd', 'tc'], exists).map(a => a.name)

    expect(names).toEqual(Array.from({ length: 19 }, (_, i) => `tc-old-${i}`))
  })

  it('releases a tree once its claim is awaiting merge', () => {
    const ledger = ledgerOf([{ ...implementing('/trees/tc-a'), phase: 'awaiting-merge' }])

    expect(parkCandidates({ agents: [agent('tc-a')] }, ledger, ['tc'], exists)).toHaveLength(1)
  })

  it('skips a name with a live row and names a resumed agent once', () => {
    const agents = [agent('tc-a'), agent('tc-a', { state: 'live' }), agent('tc-b'), agent('tc-b')]

    const names = parkCandidates({ agents }, ledgerOf([]), ['tc'], exists).map(a => a.name)

    expect(names).toEqual(['tc-b'])
  })
})

describe('detached trees a previous broker left (CC-1064)', () => {
  const detached = (name: string, lastEventAt: number, over: Partial<AgentIdentity> = {}): AgentIdentity =>
    agent(name, { state: 'detached', lastEventAt, ...over })

  it('takes detached spawned worktree rows after every exited row, oldest event first', () => {
    const agents = [
      detached('tc-d-new', T0 + 2000),
      agent('tc-x-late', { exitedAt: T0 + 9000 }),
      detached('tc-d-old', T0 - 5000),
      agent('tc-x-early', { exitedAt: T0 + 1000 }),
    ]

    const names = parkCandidates({ agents }, ledgerOf([]), ['tc'], exists).map(a => a.name)

    expect(names).toEqual(['tc-x-early', 'tc-x-late', 'tc-d-old', 'tc-d-new'])
  })

  it('never offers a name that has a spawning or live row, whatever its older rows say', () => {
    const agents = [
      detached('tc-a', T0),
      agent('tc-a', { state: 'live' }),
      agent('tc-b'),
      agent('tc-b', { state: 'spawning' }),
      detached('tc-c', T0),
      agent('tc-c'),
    ]

    const names = parkCandidates({ agents }, ledgerOf([]), ['tc'], exists).map(a => a.name)

    expect(names).toEqual(['tc-c'])
  })

  it('leaves a detached reviewer, adopted or non-worktree row alone', () => {
    const agents = [
      detached('tc-rv-a', T0, { profile: 'rv-readonly' }),
      detached('rv-tc-b', T0),
      detached('tc-adopted', T0, { origin: 'adopted' }),
      detached('tc-shared', T0, { isolation: 'shared' }),
    ]

    expect(parkCandidates({ agents }, ledgerOf([]), ['tc', 'rv'], exists)).toEqual([])
  })

  it('tries an exited tree before an older detached one when only one fits', async () => {
    const candidates = parkCandidates(
      { agents: [detached('tc-d', T0 - 60_000), agent('tc-x', { exitedAt: T0, lastEventAt: T0 })] },
      ledgerOf([]),
      ['tc'],
      exists,
    )
    const parked: string[] = []

    await parkSweep(candidates, async name => (parked.push(name), { ok: true }), 1)

    expect(parked).toEqual(['tc-x'])
  })
})

describe('the bounded park sweep (CC-1257)', () => {
  it('parks the first eight in order and names the rest', async () => {
    const candidates = Array.from({ length: 19 }, (_, i) => agent(`tc-old-${i}`))
    const parked: string[] = []

    const result = await parkSweep(candidates, async name => {
      parked.push(name)
      return { ok: true }
    })

    expect(parked).toEqual(candidates.slice(0, PARK_SWEEP_MAX).map(a => a.name))
    expect(result).toMatchObject({ parked: 8, kept: 0, left: 11 })
    expect(result.lines.at(-1)).toBe(
      `parkable 11 more: ${candidates
        .slice(8)
        .map(a => a.name)
        .join(', ')}`,
    )
  })

  it('keeps a refused or failed park and goes on to the next', async () => {
    const replies: Record<string, () => Promise<SpawnReply>> = {
      'tc-a': async () => ({ ok: false, reason: 'uncommitted changes in the tree' }),
      'tc-b': async () => {
        throw new Error('broker did not answer')
      },
      'tc-c': async () => ({ ok: true }),
    }

    const result = await parkSweep([agent('tc-a'), agent('tc-b'), agent('tc-c')], name => replies[name]!())

    expect(result.lines).toEqual([
      'park kept tc-a: uncommitted changes in the tree',
      'park kept tc-b: broker did not answer',
      'parked tc-c',
    ])
    expect(result).toMatchObject({ parked: 1, kept: 2, left: 0 })
  })

  it('a dry run names every candidate and says nothing when there are none', () => {
    expect(describeCandidates([agent('tc-a'), agent('tc-b')])).toEqual(['would park 2: tc-a, tc-b'])
    expect(describeCandidates([])).toEqual([])
  })
})
