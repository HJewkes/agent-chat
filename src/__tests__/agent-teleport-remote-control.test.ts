import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invokeCommand } from '@titan-design/registry'
import type { ToolContext } from '../server/command.js'
import type { BrokerClient } from '../client/broker-client.js'
import type { ClientMessage } from '../protocol.js'

const argv = vi.hoisted(() => ({
  seen: undefined as boolean | undefined,
  carried: undefined as { channels: string[]; effort?: 'high'; model?: string } | undefined,
  observed: undefined as string | undefined,
}))

vi.mock('../agents/transcript.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../agents/transcript.js')>()),
  observedModel: () => argv.observed,
}))

vi.mock('../broker/host-channels.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../broker/host-channels.js')>()),
  hostRemoteControl: () => argv.seen,
  hostCarriedFlags: () => argv.carried,
}))

const { agentTeleport } = await import('../server/commands/agent-teleport.js')

/**
 * CC-883: a broker on another host cannot read this session's argv, so the MCP process reads its
 * own Claude Code's and says what it saw. The broker still decides; a worker never gets it.
 */
function recordingBroker(): { broker: BrokerClient; sent: ClientMessage[] } {
  const sent: ClientMessage[] = []
  const broker = {
    request: async (message: ClientMessage) => {
      sent.push(message)
      return { t: 'teleport_result', ok: true, name: 'me', agentId: 'a-2' }
    },
  } as unknown as BrokerClient
  return { broker, sent }
}

const context = (broker: BrokerClient): ToolContext => ({
  warnings: [],
  format: 'human',
  broker,
  registeredName: 'me',
  session: { name: () => 'me', fixed: false, adopt: () => undefined },
})

async function teleportFrame(args: Record<string, unknown>): Promise<ClientMessage | undefined> {
  const { broker, sent } = recordingBroker()
  await invokeCommand(agentTeleport, { handoff: 'h', ...args }, context(broker))
  return sent[0]
}

/** CC-951: every frame names this process's OS, so a broker on another host picks the right default surface. */
const frame = { t: 'teleport', handoff: 'h', hostPlatform: process.platform, endsSelf: true }

describe('agent_teleport reports the Remote Control its own session was launched with', () => {
  beforeEach(() => {
    argv.seen = undefined
    argv.carried = undefined
    argv.observed = undefined
  })

  it('tells the broker it saw --remote-control in its Claude Code argv', async () => {
    argv.seen = true
    expect(await teleportFrame({})).toEqual({ ...frame, remoteControlSeen: true })
  })

  it('says nothing when the argv lacks it or cannot be read', async () => {
    argv.seen = false
    expect(await teleportFrame({})).toEqual(frame)
    argv.seen = undefined
    expect(await teleportFrame({})).toEqual(frame)
  })

  it('leaves an explicit remote_control to speak for itself', async () => {
    argv.seen = true
    expect(await teleportFrame({ remote_control: false })).toEqual({ ...frame, remoteControl: false })
  })
})

/** CC-951: the flags a broker on another host cannot read from this session's argv. */
describe('agent_teleport reports the launch flags its own session was launched with', () => {
  beforeEach(() => {
    argv.seen = undefined
    argv.observed = undefined
  })

  it('sends what its argv shows as launchSeen', async () => {
    argv.carried = { channels: ['plugin:voltras-channel@x'], effort: 'high' }
    expect(await teleportFrame({})).toEqual({ ...frame, launchSeen: argv.carried })
  })

  it('sends none when the argv cannot be read', async () => {
    argv.carried = undefined
    expect(await teleportFrame({})).toEqual(frame)
  })
})

/** CC-1166: a broker on another host cannot read this session's transcript, so the model rides on launchSeen. */
describe('agent_teleport reports the model its own session runs on', () => {
  const sessionEnv = process.env.CLAUDE_CODE_SESSION_ID

  beforeEach(() => {
    argv.seen = undefined
    argv.carried = undefined
    argv.observed = undefined
    process.env.CLAUDE_CODE_SESSION_ID = 'session-1'
    return () => {
      if (sessionEnv === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
      else process.env.CLAUDE_CODE_SESSION_ID = sessionEnv
    }
  })

  it('sends the transcript model when the argv names none', async () => {
    argv.carried = { channels: [] }
    argv.observed = 'claude-sonnet-5-5'
    expect(await teleportFrame({})).toEqual({
      ...frame,
      launchSeen: { channels: [], model: 'claude-sonnet-5-5' },
    })
  })

  it('falls back to the argv --model when the transcript shows none', async () => {
    argv.carried = { channels: [], model: 'sonnet' }
    expect(await teleportFrame({})).toEqual({ ...frame, launchSeen: { channels: [], model: 'sonnet' } })
  })

  it('prefers the transcript model over the argv --model, since /model changes it', async () => {
    argv.carried = { channels: [], model: 'sonnet' }
    argv.observed = 'claude-opus-5-5'
    expect(await teleportFrame({})).toEqual({
      ...frame,
      launchSeen: { channels: [], model: 'claude-opus-5-5' },
    })
  })

  it('still sends the transcript model when the argv cannot be read', async () => {
    argv.observed = 'claude-sonnet-5-5'
    expect(await teleportFrame({})).toEqual({
      ...frame,
      launchSeen: { channels: [], model: 'claude-sonnet-5-5' },
    })
  })

  it('reads no transcript without a session id', async () => {
    delete process.env.CLAUDE_CODE_SESSION_ID
    argv.observed = 'claude-sonnet-5-5'
    expect(await teleportFrame({})).toEqual(frame)
  })
})
