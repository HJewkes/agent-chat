import { describe, expect, it } from 'vitest'
import type { BrokerClient } from '../client/broker-client.js'
import { collisionView, planBrokerReads } from '../cli/port-reads.js'
import { seatBrokerReads } from '../cli/verbs/burndown.js'
import { TICK_INTERVAL_SECONDS } from '../agents/burndown/tick-status.js'
import type { AgentIdentity, ClientMessage, ServerMessage } from '../protocol.js'

const NOW = 1_800_000_000_000

const row = (name: string, state: AgentIdentity['state'], exitedAt?: number): AgentIdentity =>
  ({
    agentId: `id-${name}`,
    name,
    state,
    spawnedAt: NOW - 60_000,
    ...(exitedAt === undefined ? {} : { exitedAt }),
  }) as AgentIdentity

const AGENTS = [
  row('live-a', 'live'),
  row('just-gone', 'exited', NOW - 1_000),
  row('long-gone', 'exited', NOW - TICK_INTERVAL_SECONDS * 2000),
]
const SLOTS = { used: 1, cap: 4 }

function answer(frame: ClientMessage): ServerMessage {
  if (frame.t === 'agents')
    return { t: 'agents_result', agents: AGENTS, slots: SLOTS } as unknown as ServerMessage
  return {
    t: 'list_result',
    sessions: [{ name: 'human-session' }],
    claims: [
      { kind: 'files', owner: 'live-a', repoPath: '/repo', patterns: ['src/a.ts'] },
      { kind: 'task', owner: 'live-a', repoPath: '/repo', patterns: ['CC-1'] },
    ],
  } as unknown as ServerMessage
}

/** A broker that records every frame it is sent; `fail` makes each request reject. */
function fakeClient(fail = false): { client: BrokerClient; sent: ClientMessage[]; closed: () => boolean } {
  const sent: ClientMessage[] = []
  let closed = false
  const client = {
    connect: async () => undefined,
    close: () => {
      closed = true
    },
    request: async (frame: ClientMessage) => {
      sent.push(frame)
      if (fail) throw new Error('agents_result timed out')
      return answer(frame)
    },
  } as unknown as BrokerClient
  return { client, sent, closed: () => closed }
}

describe('the seat plan reads the broker once', () => {
  it('sends one live agents frame and one list frame, with no retired read', async () => {
    const { client, sent } = fakeClient()

    await planBrokerReads(client, NOW)

    expect(sent).toEqual([{ t: 'agents' }, { t: 'list' }])
  })

  it('serves the roster and the same view collisionView gives from that one read', async () => {
    const { client } = fakeClient()

    const { view, roster } = await planBrokerReads(client, NOW)

    expect(roster).toEqual({ agents: AGENTS, slots: SLOTS })
    expect(view).toEqual(await collisionView(fakeClient().client, NOW))
    expect(view).toEqual({
      names: ['live-a', 'human-session'],
      recentlyExited: ['just-gone'],
      claims: [{ owner: 'live-a', repo: '/repo', patterns: ['src/a.ts'] }],
    })
  })

  it('seatBrokerReads sends no includeRetired frame and closes its connection', async () => {
    const { client, sent, closed } = fakeClient()

    const { roster } = await seatBrokerReads(client)

    expect(roster?.agents).toEqual(AGENTS)
    expect(sent.some(f => f.t === 'agents' && 'includeRetired' in f)).toBe(false)
    expect(closed()).toBe(true)
  })

  it('gives neither view nor roster when the broker read fails', async () => {
    const { client } = fakeClient(true)

    const reads = await seatBrokerReads(client)

    expect(reads).toEqual({ view: undefined, roster: undefined })
  })
})
