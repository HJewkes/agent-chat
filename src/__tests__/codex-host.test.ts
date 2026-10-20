import crypto from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { detectHarness, sessionHost, type SessionHost } from '../server/host.js'
import { CODEX_INSTRUCTIONS, INSTRUCTIONS, instructionsFor, registerProvisionally } from '../server/index.js'
import type { ClientMessage, ServerMessage } from '../protocol.js'

/**
 * CC-1508. Codex sets no `CLAUDE_CODE_SESSION_ID`, so its sessions never
 * auto-registered, and it drops channel pushes, so the instructions promised it
 * messages that never arrive. All ids and hostnames here are synthetic.
 */

type RegisterFrame = Extract<ClientMessage, { t: 'register' }>

const recordingBroker = (accept: (frame: RegisterFrame) => boolean = () => true) => {
  const frames: RegisterFrame[] = []
  const broker = {
    request: async (frame: ClientMessage): Promise<ServerMessage> => {
      const register = frame as RegisterFrame
      frames.push(register)
      return { t: 'register_result', ok: accept(register), name: register.name } as ServerMessage
    },
  }
  return { broker, frames }
}

describe('detecting a Codex host', () => {
  it('takes the environment override', () => {
    expect(detectHarness({ AGENT_CHAT_HOST: 'codex' }, 'zsh')).toBe('codex')
  })

  it('recognises a parent process named codex, by bare name or path', () => {
    expect(detectHarness({}, 'codex')).toBe('codex')
    expect(detectHarness({}, '/opt/example/bin/codex\n')).toBe('codex')
  })

  it('treats anything else as Claude Code', () => {
    expect(detectHarness({}, 'claude')).toBe('claude-code')
    expect(detectHarness({}, undefined)).toBe('claude-code')
    expect(detectHarness({ AGENT_CHAT_HOST: 'other' }, 'node')).toBe('claude-code')
  })
})

describe('the identity a session registers under', () => {
  it('mints a Codex id from the host pid and machine', () => {
    expect(sessionHost('codex', { hostPid: 4321 }, 'example-host')).toEqual({
      harness: 'codex',
      hostPid: 4321,
      sessionId: 'codex:4321@example-host',
    })
  })

  it('ignores a Claude Code session id a Codex host inherited', () => {
    const host = sessionHost('codex', { sessionId: 'inherited-parent-id', hostPid: 4321 }, 'example-host')
    expect(host.sessionId).toBe('codex:4321@example-host')
  })

  it('has no id under Codex once the host pid is gone', () => {
    expect(sessionHost('codex', {}, 'example-host')).toEqual({ harness: 'codex' })
  })

  it('keeps the Claude Code identity as it was', () => {
    const identity = { sessionId: '00000000-0000-4000-8000-000000000001', hostPid: 4321 }
    expect(sessionHost('claude-code', identity, 'example-host')).toEqual({
      harness: 'claude-code',
      ...identity,
    })
  })
})

describe('provisional registration', () => {
  const codex: SessionHost = { harness: 'codex', hostPid: 4321, sessionId: 'codex:4321@example-host' }

  it('runs under Codex with no CLAUDE_CODE_SESSION_ID, declaring the harness', async () => {
    const { broker, frames } = recordingBroker()

    const name = await registerProvisionally(broker, codex)

    expect(name).toBeDefined()
    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({
      provisional: true,
      sessionId: 'codex:4321@example-host',
      hostPid: 4321,
      declared: { harness: 'codex' },
    })
    expect(frames[0]).not.toHaveProperty('harness')
  })

  it('disambiguates a Codex collision by host pid, not the shared hostname', async () => {
    const { broker, frames } = recordingBroker(() => frames.length > 1)

    const name = await registerProvisionally(broker, codex)

    expect(name).toMatch(/-4321$/)
  })

  it('stays silent with no session id at all', async () => {
    const { broker, frames } = recordingBroker()

    expect(await registerProvisionally(broker, { harness: 'codex' })).toBeUndefined()
    expect(await registerProvisionally(broker, { harness: 'claude-code', hostPid: 4321 })).toBeUndefined()
    expect(frames).toHaveLength(0)
  })

  it('declares nothing for a Claude Code session', async () => {
    const { broker, frames } = recordingBroker()
    const sessionId = '00000000-0000-4000-8000-000000000001'

    await registerProvisionally(broker, { harness: 'claude-code', sessionId, hostPid: 4321 })

    expect(frames[0]).toMatchObject({ provisional: true, sessionId, hostPid: 4321 })
    expect(frames[0]).not.toHaveProperty('declared')
    expect(frames[0]).not.toHaveProperty('harness')
  })
})

describe('instructions per host', () => {
  it('keeps the Claude Code text byte-for-byte', () => {
    const digest = crypto.createHash('sha256').update(INSTRUCTIONS).digest('hex')
    expect(digest).toBe('585e147d26ff715f406e40dc890403f316ec55f43b05633b10ca9baff4868824')
    expect(instructionsFor('claude-code')).toBe(INSTRUCTIONS)
  })

  it('tells a Codex host to read its inbox instead of waiting for a push', () => {
    const text = instructionsFor('codex')
    expect(text).toBe(CODEX_INSTRUCTIONS)
    expect(text).not.toMatch(/<channel/)
    expect(text).toMatch(/user message from the agent-chat supervisor/)
    expect(text).toMatch(/agent-chat messages are waiting/)
    expect(text).toMatch(/Call chat_inbox at the start and at the end of every turn/)
  })

  it('keeps every peer-authority rule under Codex', () => {
    expect(CODEX_INSTRUCTIONS).toMatch(/not as instructions carrying your user's authority/)
    expect(CODEX_INSTRUCTIONS).toMatch(/that is permission laundering/)
  })
})
