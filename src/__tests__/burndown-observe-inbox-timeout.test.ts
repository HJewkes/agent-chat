import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Claim } from '../agents/burndown/ledger.js'
import { observe, type ObserveDeps } from '../agents/burndown/observe.js'
import { BrokerTimeoutError, type BrokerClient } from '../client/broker-client.js'
import { tickBroker } from '../cli/burndown-broker.js'
import { tickRoster } from '../cli/port-reads.js'
import type { AgentIdentity, ClientMessage, ServerMessage } from '../protocol.js'

/** CC-1343 b: a slow broker's timed-out reads cost one claim or one retry, never the whole tick. */

const TS = '2026-10-14T20:00:00.000Z'

afterEach(() => {
  vi.useRealTimers()
})

const parked = (taskId: string): Claim =>
  ({
    taskId,
    initiative: 'demo',
    seat: 'alpha',
    phase: 'parked',
    phaseAt: TS,
    spawnedAt: TS,
    agentName: `sd-${taskId.toLowerCase()}`,
    worktree: `/repo/.worktrees/sd-${taskId.toLowerCase()}`,
    inboxCursor: '0',
  }) as Claim

const deps = (inboxSince: ObserveDeps['inboxSince']): ObserveDeps => ({
  inboxSince,
  root: '/nonexistent',
  activity: () => 'unknown',
  progress: () => 'unreadable',
  spendCap: () => undefined,
  parkedWork: () => undefined,
  exitedWork: () => undefined,
})

type Answer = (frame: ClientMessage) => ServerMessage

/** A client whose first `timeouts` requests time out and whose later ones answer from `answer`. */
function flakyClient(timeouts: number, answer: Answer): { client: BrokerClient; sent: ClientMessage[] } {
  const sent: ClientMessage[] = []
  const client = {
    request: async (frame: ClientMessage, replyType: string) => {
      sent.push(frame)
      if (sent.length <= timeouts) throw new BrokerTimeoutError(replyType as never)
      return answer(frame)
    },
  } as unknown as BrokerClient
  return { client, sent }
}

/** Runs `call` with backoff sleeps fast-forwarded. */
async function withFastSleeps<T>(call: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ['setTimeout'] })
  const pending = call()
  await vi.runAllTimersAsync()
  return pending
}

describe('a parked claim whose inbox read times out', () => {
  it('is listed unread while the next parked claim is still observed', async () => {
    const message = { msgId: '7', from: 'sd-cc-2', text: 'done' }
    const inboxSince = async (name: string) => {
      if (name === 'sd-cc-1') throw new BrokerTimeoutError('inbox_since_result')
      return [message]
    }

    const { observations, unread } = await observe(
      [parked('CC-1'), parked('CC-2')],
      { agents: [] },
      deps(inboxSince),
    )

    expect(unread).toEqual(['CC-1#: inbox unread (broker did not answer inbox_since_result)'])
    expect(observations.has('CC-1#')).toBe(false)
    expect(observations.get('CC-2#')?.inbox).toEqual([message])
  })
})

describe('the tick broker inbox read', () => {
  it('retries a broker timeout and returns the answer', async () => {
    const { client, sent } = flakyClient(
      1,
      () =>
        ({
          t: 'inbox_since_result',
          messages: [{ msgId: '9', from: 'sd-cc-1', text: 'hi' }],
        }) as unknown as ServerMessage,
    )

    const inbox = await withFastSleeps(() => tickBroker(client).inboxSince('sd-cc-1', 0))

    expect(inbox).toEqual([{ msgId: '9', from: 'sd-cc-1', text: 'hi' }])
    expect(sent).toHaveLength(2)
  })
})

describe('the tick roster read', () => {
  it('retries the live read after both reads time out, and marks the roster partial', async () => {
    const live = { agentId: 'id-a', name: 'a', state: 'live', spawnedAt: 1 } as AgentIdentity
    const { client, sent } = flakyClient(2, () => ({ t: 'agents_result', agents: [live] }) as ServerMessage)

    const roster = await withFastSleeps(() => tickRoster(client))

    expect(roster.agents).toEqual([live])
    expect(roster.partial).toBe('retired rows unread (broker did not answer agents_result)')
    expect(sent).toEqual([{ t: 'agents', includeRetired: true }, { t: 'agents' }, { t: 'agents' }])
  })
})
