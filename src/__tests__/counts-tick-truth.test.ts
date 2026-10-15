import { describe, expect, it } from 'vitest'
import type { Observation } from '../agents/burndown/advance.js'
import type { Claim, Ledger } from '../agents/burndown/ledger.js'
import { deriveCounts } from '../agents/counts/derive.js'
import {
  driftAlert,
  parseLastTickTruth,
  seatTruth,
  tickSnapshot,
  truthNote,
  type SeatTruth,
  type TickInputs,
} from '../agents/counts/tick-truth.js'
import type { ShepherdRow } from '../shepherd-client.js'

const NOW = new Date('2030-01-01T12:00:00Z')
const MIN = 60_000
const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString()
const SEAT = 'seat-s'

const claim = (taskId: string, extra: Partial<Claim> = {}): Claim => ({
  taskId,
  initiative: 'demo',
  spawnedAt: ago(60 * MIN),
  phase: 'implementing',
  phaseAt: ago(60 * MIN),
  seat: SEAT,
  agentName: `sa-${taskId.toLowerCase()}`,
  ...extra,
})

type Agent = TickInputs['roster']['agents'][number]
const agent = (name: string, state: Agent['state'] = 'live'): Agent => ({
  agentId: `id-${name}`,
  name,
  profile: 'implementer',
  state,
  cwd: `/trees/${name}`,
})

const tasks = (n: number): Claim[] => Array.from({ length: n }, (_, i) => claim(`T-${i + 1}`))

function truthOf(over: Partial<TickInputs> & { claims: Claim[] }): SeatTruth {
  const ledger: Ledger = { version: 1, claims: over.claims }
  const inputs: TickInputs = {
    now: NOW,
    tickMs: 20 * MIN,
    roster: { agents: [] },
    ledger,
    observations: new Map(),
    shepherdRows: [],
    ...over,
  }
  return seatTruth(deriveCounts(tickSnapshot(inputs)), SEAT, ledger)
}

const shepherdRow = (pr: number, phase: ShepherdRow['phase']): ShepherdRow => ({
  repo: 'HJewkes/x',
  pr,
  runId: `run-${pr}`,
  phase,
  headSha: null,
  stalled: null,
})

describe('tick truth: live against ledger per seat', () => {
  it('names every one of 17 ledger claims with no live agent when 3 of 20 implementers are live', () => {
    const live = ['sa-t-1', 'sa-t-2', 'sa-t-3'].map(n => agent(n))

    const truth = truthOf({ claims: tasks(20), roster: { agents: live } })

    expect(truth.roles.implementers).toEqual({ live: 3, ledger: 20 })
    expect(truth.ledgerOnly).toHaveLength(17)
    expect(truth.ledgerOnly.map(e => e.claim)).not.toContain('T-1')
    expect(truth.ledgerOnly.every(e => e.verdict === 'unexplained' && e.why !== undefined)).toBe(true)
    expect(truth.unexplained).toBe(17)
  })

  it('reads an agent missing from a partial roster as unread, not live', () => {
    const agents = [...['sa-t-1', 'sa-t-2', 'sa-t-3'].map(n => agent(n)), agent('sa-t-5', 'retired')]

    const truth = truthOf({ claims: tasks(5), roster: { agents, partial: 'retired rows capped' } })

    expect(truth.roles.implementers).toEqual({ live: 3, ledger: 5 })
    expect(truth.ledgerOnly.find(e => e.claim === 'T-4')?.verdict).toBe('unread')
    expect(truth.unread).toBe(1)
  })

  it('calls a shepherding claim whose PR merged unexplained, and unread when its PR state was unreadable', () => {
    const pr = 'HJewkes/x#5'
    const claims = [claim('T-9', { phase: 'shepherding', pr })]
    const merged = new Map<string, Pick<Observation, 'prState'>>([
      ['T-9#', { prState: { kind: 'merged', pr, head: 'abc' } }],
    ])
    const unreadable = new Map<string, Pick<Observation, 'prState'>>([['T-9#', { prState: 'unreadable' }]])
    const rows = [shepherdRow(5, 'done')]

    const seen = truthOf({ claims, observations: merged, shepherdRows: rows })
    const blind = truthOf({ claims, observations: unreadable, shepherdRows: rows })

    expect(seen.ledgerOnly).toEqual([
      { claim: 'T-9', phase: 'shepherding', pr, verdict: 'unexplained', why: `PR ${pr} is merged` },
    ])
    expect(blind.ledgerOnly[0]?.verdict).toBe('unread')
  })

  it('reads a held PR the tick never observed as unread rather than not open', () => {
    const truth = truthOf({ claims: [claim('T-7', { phase: 'queued', pr: 'HJewkes/x#7' })] })

    expect(truth.ledgerOnly[0]?.verdict).toBe('unread')
  })

  it('prints the note with live, ledger and cap and each ledger-only claim by reason', () => {
    const truth = truthOf({ claims: tasks(2), roster: { agents: [agent('sa-t-1')] } })

    const note = truthNote(SEAT, truth, 4)

    expect(note).toBe(
      'seat seat-s implementers live 1 / ledger 2 / cap 4; ledger-only: T-2 (implementing claim, agent sa-t-2 not live, no disposition)',
    )
    expect(note).not.toContain('MISMATCH')
  })
})

describe('tick truth: drift alert', () => {
  const two = truthOf({ claims: tasks(2) })

  it('stays quiet for an item already told, and names every unexplained item once a new one appears', () => {
    const one = truthOf({ claims: tasks(1) })

    expect(driftAlert(SEAT, one, 4, ['T-1'])).toBeUndefined()
    const alert = driftAlert(SEAT, two, 4, ['T-1'])

    expect(alert?.keys).toEqual(['T-1', 'T-2'])
    expect(alert?.text).toMatch(
      /^lane mismatch seat-s: ledger 2\/4 vs 0 live; unexplained: T-1 \(.+\), T-2 \(.+\); explained: 0$/,
    )
  })

  it('never alerts on escalated or spawning claims', () => {
    const truth = truthOf({
      claims: [
        claim('T-1', { stale: { class: 'outside-owns', proposed: 'release', since: ago(5 * MIN) } }),
        claim('T-2', { phase: 'spawning', nextPhase: 'implementing', phaseAt: ago(MIN) }),
      ],
    })

    expect(truth.ledgerOnly.map(e => e.code)).toEqual(['escalated', 'spawning'])
    expect(driftAlert(SEAT, truth, 4)).toBeUndefined()
  })
})

describe('tick truth: last tick row', () => {
  const truth: SeatTruth = {
    roles: {
      implementers: { live: 2, ledger: 11 },
      reviewers: { live: 0, ledger: 0 },
      planners: { live: 0, ledger: 0 },
    },
    ledgerOnly: [],
    unexplained: 0,
    unread: 0,
  }
  const row = (seats: Record<string, unknown>): string =>
    JSON.stringify({ v: 1, ts: '2030-01-01T14:02:00Z', seats })

  it('returns the truth and implementer cap of each seat in the last row', () => {
    const tail = `${row({})}\n${row({ [SEAT]: { truth, roles: { cap: { implementers: 28 } } } })}\n`

    expect(parseLastTickTruth(tail)).toEqual({
      at: '2030-01-01T14:02:00Z',
      truth: { [SEAT]: truth },
      cap: { [SEAT]: 28 },
    })
  })

  it('returns undefined for an empty tail and a row from before truth, and throws on a truncated line', () => {
    expect(parseLastTickTruth('')).toBeUndefined()
    expect(parseLastTickTruth(row({ [SEAT]: { ready: 1 } }))).toBeUndefined()
    expect(() => parseLastTickTruth('{"v":1,"ts":"2030')).toThrow()
  })
})
