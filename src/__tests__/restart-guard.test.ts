import { describe, expect, it } from 'vitest'
import { ATTACH_CEILING_MS } from '../agents/supervisor.js'
import type { BrokerClient } from '../client/broker-client.js'
import { brokerSource, guardRestart, type BlockerSource } from '../cli/restart-guard.js'
import type { AgentIdentity, AgentLifecycle, ClientMessage, QueueItem, ServerMessage } from '../protocol.js'

const NOW = 1_000_000_000

const agent = (name: string, state: AgentLifecycle, ageMs = 1_000): AgentIdentity => ({
  agentId: `id-${name}`,
  name,
  profile: 'implementer',
  state,
  origin: 'spawned',
  spawnedBy: 'coordinator',
  spawnedAt: NOW - ageMs,
  brief: '',
  cwd: '/tmp',
  isolation: 'none',
  surface: 'headless',
  sessionId: '',
  lastEventAt: NOW - ageMs,
  generation: 1,
})

const item = (kind: QueueItem['kind'], from: string, text: string): QueueItem => ({
  msgId: `m-${from}`,
  kind,
  from,
  text,
  at: NOW,
  meta: {},
})

const source = (agents: AgentIdentity[]): BlockerSource => ({
  agents: async () => agents,
})

/** A broker socket that answers both the agents and the human-queue reads. */
const fakeBroker = (agents: AgentIdentity[], queue: QueueItem[]): BrokerClient =>
  ({
    request: async (message: ClientMessage): Promise<ServerMessage> =>
      message.t === 'agents'
        ? ({ t: 'agents_result', agents } as ServerMessage)
        : ({ t: 'queue_result', items: queue } as ServerMessage),
  }) as unknown as BrokerClient

describe('service restart guard', () => {
  it('refuses while an agent is mid-spawn and names it', async () => {
    const refusal = await guardRestart(
      'restart',
      source([agent('cc-new', 'spawning'), agent('cc-old', 'live')]),
      { now: NOW },
    )

    expect(refusal).toContain('refusing to restart')
    expect(refusal).toContain('mid-spawn: cc-new')
    expect(refusal).not.toContain('cc-old')
    expect(refusal).toContain('Use --force to restart anyway.')
  })

  it('goes ahead while an ask to the human is unanswered, since the ask survives the restart', async () => {
    const broker = fakeBroker(
      [agent('cc-worker', 'live')],
      [item('question', 'cc-worker', 'Merge the PR now?')],
    )

    expect(await guardRestart('restart', brokerSource(broker), { now: NOW })).toBeNull()
    expect(await guardRestart('stop', brokerSource(broker), { now: NOW })).toBeNull()
  })

  it('goes ahead with --force even when work is in flight', async () => {
    const busy = source([agent('cc-new', 'spawning')])

    expect(await guardRestart('restart', busy, { force: true, now: NOW })).toBeNull()
  })

  it('goes ahead when nothing is pending', async () => {
    const quiet = source([agent('cc-live', 'live'), agent('cc-done', 'exited')])

    expect(await guardRestart('restart', quiet, { now: NOW })).toBeNull()
  })

  it('ignores a spawn orphaned past the attach ceiling, since no live wait remains to lose', async () => {
    const orphan = source([agent('cc-ghost', 'spawning', ATTACH_CEILING_MS + 1)])

    expect(await guardRestart('restart', orphan, { now: NOW })).toBeNull()
  })

  it('names the verb it refuses so stop reads correctly', async () => {
    const refusal = await guardRestart('stop', source([agent('cc-new', 'spawning')]), { now: NOW })

    expect(refusal).toMatch(/^refusing to stop/)
    expect(refusal).toContain('Use --force to stop anyway.')
  })
})

describe('service restart guard when the broker does not answer (CC-1182)', () => {
  const timedOut = (frame: string) => async (): Promise<never> => {
    throw new Error(`broker did not answer ${frame}`)
  }

  it('refuses, naming agents_result and its own timeout, when the agents read times out', async () => {
    const refusal = await guardRestart('stop', { agents: timedOut('agents_result') })

    expect(refusal).toMatch(/^refusing to stop:/)
    expect(refusal).toContain(
      'the broker did not answer agents_result within 30s; the broker was not touched',
    )
  })
})
