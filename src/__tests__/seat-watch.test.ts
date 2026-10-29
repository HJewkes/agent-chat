import { describe, expect, it } from 'vitest'
import type { ShepherdFlight } from '../agents/seats/in-flight-read.js'
import { buildPacket, type PacketInput } from '../agents/seats/seat-watch-packet.js'
import {
  applyRules,
  canonicalJson,
  decisionOf,
  digestDue,
  packetHash,
  type Packet,
} from '../agents/seats/seat-watch.js'
import type { AgentIdentity } from '../protocol.js'

const NOW = Date.parse('2026-01-05T12:00:00Z')
const MIN = 60_000

const agent = (name: string, over: Partial<AgentIdentity> = {}): AgentIdentity => ({
  agentId: `id-${name}`,
  name,
  profile: 'implementer',
  state: 'live',
  origin: 'spawned',
  spawnedBy: 'seat-a',
  spawnedAt: NOW - 60 * MIN,
  brief: '',
  cwd: '/synthetic',
  isolation: 'worktree',
  surface: 'headless',
  sessionId: `s-${name}`,
  generation: 1,
  lastEventAt: NOW - 5 * MIN,
  ...over,
})

const flight = (over: Partial<ShepherdFlight> = {}): ShepherdFlight => ({
  repo: 'example/repo',
  pr: 7,
  branch: 'agent-chat/sa-1',
  runId: 'run-1',
  task: null,
  phase: 'ci',
  headSha: 'abc',
  nextAction: null,
  pendingGate: null,
  gateSince: null,
  implementer: 'sa-1',
  held: false,
  stalled: false,
  ...over,
})

const input = (over: Partial<PacketInput> = {}): PacketInput => ({
  seat: { name: 'seat-a', prefix: 'sa' },
  owners: new Set(['human']),
  operator: 'operator-seat',
  inbox: [],
  roster: [],
  activityAt: new Map(),
  lastWordAt: new Map(),
  flights: [],
  budget: { implementers: 2, cap: 2, stop: null },
  queue: 0,
  dispatcherCovers: false,
  digestDue: false,
  nowMs: NOW,
  ...over,
})

const rulesOf = (packet: Packet, previous?: Packet): string[] => applyRules(packet, previous).map(f => f.rule)

const message = (from: string, body = 'hello') => ({
  from,
  kind: 'message',
  msgId: `m-${from}`,
  ts: NOW - MIN,
  body,
})

describe('seat-watch R1: unread messages', () => {
  it('wakes for an unread message from the owner, the operator or an own agent', () => {
    for (const from of ['human', 'operator-seat', 'sa-3']) {
      const packet = buildPacket(input({ inbox: [message(from)] }))

      expect(rulesOf(packet)).toEqual(['R1'])
    }
  })

  it('stays asleep for a peer coordinator message alone', () => {
    const packet = buildPacket(input({ inbox: [message('seat-b')] }))

    expect(rulesOf(packet)).toEqual([])
    expect(decisionOf(applyRules(packet, undefined))).toBe('skip')
  })
})

describe('seat-watch R2: silent or stalled agents', () => {
  it('wakes for an agent that exited with no report since it spawned', () => {
    const roster = [agent('sa-1', { state: 'exited', exitedAt: NOW - 10 * MIN })]
    const lastWordAt = new Map([['sa-1', NOW - 120 * MIN]])

    expect(rulesOf(buildPacket(input({ roster, lastWordAt })))).toEqual(['R2'])
  })

  it('stays asleep for an exited agent that reported', () => {
    const roster = [agent('sa-1', { state: 'exited', exitedAt: NOW - 10 * MIN })]
    const lastWordAt = new Map([['sa-1', NOW - 11 * MIN]])

    expect(rulesOf(buildPacket(input({ roster, lastWordAt })))).toEqual([])
  })

  it('wakes for an agent quiet over 30 minutes only while it has an open PR', () => {
    const roster = [agent('sa-1', { lastEventAt: NOW - 45 * MIN })]

    expect(rulesOf(buildPacket(input({ roster, flights: [flight()] })))).toEqual(['R2'])
    expect(rulesOf(buildPacket(input({ roster, flights: [] })))).toEqual([])
  })

  it('reads recent activity in events.db as the agent being alive', () => {
    const roster = [agent('sa-1', { lastEventAt: NOW - 45 * MIN })]
    const activityAt = new Map([['sa-1', NOW - 2 * MIN]])

    expect(rulesOf(buildPacket(input({ roster, activityAt, flights: [flight()] })))).toEqual([])
  })
})

describe('seat-watch R3: Shepherd needs the seat', () => {
  const gated = [flight({ pendingGate: 'sh-approve' })]

  it('wakes when a seat run newly opens a gate', () => {
    expect(rulesOf(buildPacket(input({ flights: gated })))).toEqual(['R3'])
  })

  it('stays asleep when the previous pass already saw the same gate', () => {
    const previous = buildPacket(input({ flights: gated }))

    expect(rulesOf(buildPacket(input({ flights: gated })), previous)).toEqual([])
  })

  it('wakes for a fix round whose fixer is not running, not for one whose fixer is', () => {
    const fixing = [flight({ phase: 'fixing' })]

    expect(rulesOf(buildPacket(input({ flights: fixing })))).toEqual(['R3'])
    expect(rulesOf(buildPacket(input({ flights: fixing, roster: [agent('sa-1')] })))).toEqual([])
  })

  it("ignores another seat's run and fires nothing when Shepherd did not answer", () => {
    const other = [flight({ implementer: 'sb-1', branch: 'agent-chat/sb-1', pendingGate: 'sh-approve' })]

    expect(rulesOf(buildPacket(input({ flights: other })))).toEqual([])
    expect(rulesOf(buildPacket(input({ flights: null })))).toEqual([])
  })
})

describe('seat-watch R4: free cap and eligible work', () => {
  const open = { implementers: 1, cap: 3, stop: null }

  it('wakes with a free slot, an open budget and eligible work', () => {
    expect(rulesOf(buildPacket(input({ budget: open, queue: 4 })))).toEqual(['R4'])
  })

  it('stays asleep at cap, with a stop, with no queue, or when the dispatcher covers the seat', () => {
    const cases: Partial<PacketInput>[] = [
      { budget: { implementers: 3, cap: 3, stop: null }, queue: 4 },
      { budget: { ...open, stop: 'seven_day 91% over reserve' }, queue: 4 },
      { budget: open, queue: 0 },
      { budget: open, queue: 4, dispatcherCovers: true },
      { budget: null, queue: 4 },
    ]

    for (const c of cases) expect(rulesOf(buildPacket(input(c)))).toEqual([])
  })
})

describe('seat-watch R5: daily digest slot', () => {
  const at = (h: number, m = 0): Date => new Date(2026, 0, 5, h, m)

  it('is due on the first pass at or after 07:00 local, including after a night with no pass', () => {
    expect(digestDue(at(7, 2), at(6, 47).getTime())).toBe(true)
    expect(digestDue(at(9), new Date(2026, 0, 4, 22).getTime())).toBe(true)
  })

  it("is not due before the slot, again once a pass ran after it, or on a seat's first pass", () => {
    expect(digestDue(at(6, 59), at(6, 44).getTime())).toBe(false)
    expect(digestDue(at(7, 17), at(7, 2).getTime())).toBe(false)
    expect(digestDue(at(9), undefined)).toBe(false)
  })

  it('fires R5 from the packet', () => {
    expect(rulesOf(buildPacket(input({ digestDue: true })))).toEqual(['R5'])
  })
})

describe('seat-watch packet hash', () => {
  it('stays the same across passes with no state change', () => {
    const state = {
      roster: [agent('sa-1')],
      inbox: [message('seat-b')],
      flights: [flight({ phase: 'review' })],
    }
    const first = buildPacket(input({ ...state, nowMs: NOW }))
    const second = buildPacket(input({ ...state, nowMs: NOW + 15 * MIN }))

    expect(packetHash(second)).toBe(packetHash(first))
  })

  it('moves when a message arrives', () => {
    const before = buildPacket(input())
    const after = buildPacket(input({ inbox: [message('human')] }))

    expect(packetHash(after)).not.toBe(packetHash(before))
  })

  it('does not depend on key order', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { f: 1, e: 0 }], c: null } })).toBe(
      canonicalJson({ a: { c: null, d: [2, { e: 0, f: 1 }] }, b: 1 }),
    )
  })
})
