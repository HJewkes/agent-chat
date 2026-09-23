import { describe, expect, it } from 'vitest'
import { EXIT, invokeCommand } from '@titan-design/registry'
import { ToolHandler } from '../server/tools.js'
import { toolDefinition, type ToolContext } from '../server/command.js'
import { chatSend } from '../server/commands/chat-send.js'
import { chatActivity } from '../server/commands/chat-activity.js'
import { chatEndorse } from '../server/commands/chat-endorse.js'
import { chatTag } from '../server/commands/chat-tag.js'
import { chatSubscribe } from '../server/commands/subscriptions.js'
import { agentSpawn } from '../server/commands/agent-spawn.js'
import { agentTeleport } from '../server/commands/agent-teleport.js'
import type { BrokerClient } from '../client/broker-client.js'
import type { ClientMessage } from '../protocol.js'

/** A broker that records frames and answers nothing, so any frame at all is a failure. */
function silentBroker(): { broker: BrokerClient; sent: ClientMessage[] } {
  const sent: ClientMessage[] = []
  const broker = {
    request: async (message: ClientMessage) => {
      sent.push(message)
      throw new Error('no frame should reach the broker')
    },
  } as unknown as BrokerClient
  return { broker, sent }
}

const context = (broker: BrokerClient): ToolContext => ({
  warnings: [],
  format: 'human',
  broker,
  registeredName: 'me',
})

/**
 * The bug tools.ts documented at requireString (observed 2026-07-27): a model
 * omitted `text`, `String(undefined)` made it the word "undefined", and a peer
 * was delivered that word. The schema now rejects it before `run` exists.
 */
describe('chat_send refuses a missing message body at the schema boundary', () => {
  it.each([
    ['omitted', { to: 'bob' }],
    ['explicitly undefined', { to: 'bob', text: undefined }],
    ['blank', { to: 'bob', text: '  ' }],
    ['not a string', { to: 'bob', text: 42 }],
  ])('rejects text %s as invalid arguments, not as a failed run', async (_label, args) => {
    const { broker, sent } = silentBroker()

    const { envelope } = await invokeCommand(chatSend, args, context(broker))

    expect(envelope).toEqual({
      ok: false,
      code: EXIT.DATAERR,
      error: 'Invalid arguments: text: text is required and must be a non-empty string',
    })
    expect(sent).toEqual([])
  })

  it('never puts the word "undefined" on the wire through the tool handler', async () => {
    const { broker, sent } = silentBroker()
    const handler = new ToolHandler(broker, undefined, 'me')

    await expect(handler.handle('chat_send', { to: 'bob' })).rejects.toThrow(/text is required/)

    expect(sent).toEqual([])
  })

  it('publishes text as required, so the model is told before it calls', () => {
    expect(toolDefinition(chatSend).inputSchema.required).toEqual(['text'])
  })
})

/** CC-126: the resume reply says whether the conversation came back, on success and refusal alike. */
describe('agent_resume', () => {
  const answering = (reply: Record<string, unknown>): { broker: BrokerClient; sent: ClientMessage[] } => {
    const sent: ClientMessage[] = []
    const broker = {
      request: async (message: ClientMessage) => {
        sent.push(message)
        return { t: 'spawn_result', ...reply }
      },
    } as unknown as BrokerClient
    return { broker, sent }
  }

  it('sends a headless resume frame by name and reports the transcript it found', async () => {
    const { broker, sent } = answering({ ok: true, transcript: { path: '/c/p/s.jsonl', found: true } })

    const reply = await new ToolHandler(broker, undefined, 'me').handle('agent_resume', { name: 'scout' })

    expect(sent).toEqual([{ t: 'resume', name: 'scout' }])
    expect(reply.content[0]?.text).toContain('transcript found: /c/p/s.jsonl')
  })

  it('says plainly when the transcript was missing', async () => {
    const { broker } = answering({
      ok: false,
      reason: "scout's transcript is gone",
      transcript: { path: '/c/p/s.jsonl', found: false },
    })

    const reply = await new ToolHandler(broker, undefined, 'me').handle('agent_resume', { name: 'scout' })

    expect(reply.content[0]?.text).toBe(
      "Not resumed: scout's transcript is gone\nno transcript found at /c/p/s.jsonl",
    )
  })
})

/** CC-106 S2: `name` must reject before any frame, not fall through as `undefined` on the wire. */
describe('chat_activity refuses a missing name at the schema boundary', () => {
  it.each([
    ['omitted', {}],
    ['blank', { name: '  ' }],
    ['not a string', { name: 42 }],
  ])('rejects name %s as invalid arguments, not as a failed run', async (_label, args) => {
    const { broker, sent } = silentBroker()

    const { envelope } = await invokeCommand(chatActivity, args, context(broker))

    expect(envelope).toEqual({
      ok: false,
      code: EXIT.DATAERR,
      error: 'Invalid arguments: name: name is required and must be a non-empty string',
    })
    expect(sent).toEqual([])
  })
})

/** CC-106 S3: a missing `to` must name `to`, not `text`, so the model fixes the right field. */
describe('chat_endorse refuses a missing recipient at the schema boundary', () => {
  it('rejects to omitted as invalid arguments naming to, not as a failed run', async () => {
    const { broker, sent } = silentBroker()

    const { envelope } = await invokeCommand(chatEndorse, { text: 'ship it' }, context(broker))

    expect(envelope).toEqual({
      ok: false,
      code: EXIT.DATAERR,
      error: 'Invalid arguments: to: to is required and must be a non-empty string',
    })
    expect(sent).toEqual([])
  })
})

/** CC-106 S4: a bare string used to be wrapped into a list or ignored; the schema now refuses it by field. */
describe('claims, tags and subscriptions refuse a bare string where a list belongs', () => {
  it.each([
    ['chat_tag add', chatTag, { add: 'owner:src' }, 'add'],
    ['chat_subscribe kinds', chatSubscribe, { scope: 'all', kinds: 'agent_spawned' }, 'kinds'],
  ] as const)('rejects %s before any frame', async (_label, tool, args, field) => {
    const { broker, sent } = silentBroker()

    const { envelope } = await invokeCommand(tool, args, context(broker))

    expect(envelope).toEqual({
      ok: false,
      code: EXIT.DATAERR,
      error: `Invalid arguments: ${field}: Invalid input: expected array, received string`,
    })
    expect(sent).toEqual([])
  })

  it('publishes scope as the only required chat_subscribe field', () => {
    expect(toolDefinition(chatSubscribe).inputSchema.required).toEqual(['scope'])
  })
})

/** CC-106 S6: validation now runs before the registration guard, so a missing field is named even unregistered. */
describe('agent_spawn and agent_teleport refuse a missing required field at the schema boundary', () => {
  it.each([
    ['agent_spawn name', agentSpawn, { profile: 'explorer', brief: 'b' }, 'name'],
    ['agent_teleport handoff', agentTeleport, {}, 'handoff'],
  ] as const)('rejects %s for an unregistered caller before any frame', async (_label, tool, args, field) => {
    const { broker, sent } = silentBroker()

    const { envelope } = await invokeCommand(tool, args, { ...context(broker), registeredName: null })

    expect(envelope).toEqual({
      ok: false,
      code: EXIT.DATAERR,
      error: `Invalid arguments: ${field}: ${field} is required and must be a non-empty string`,
    })
    expect(sent).toEqual([])
  })

  it('publishes name, profile and brief as the required agent_spawn fields', () => {
    expect(toolDefinition(agentSpawn).inputSchema.required).toEqual(['name', 'profile', 'brief'])
  })

  it('rejects a bare-string owns rather than wrapping it into a list', async () => {
    const { broker, sent } = silentBroker()

    const { envelope } = await invokeCommand(
      agentSpawn,
      { name: 'scout', profile: 'explorer', brief: 'b', owns: 'src/**' },
      context(broker),
    )

    expect(envelope).toMatchObject({
      ok: false,
      error: 'Invalid arguments: owns: Invalid input: expected array, received string',
    })
    expect(sent).toEqual([])
  })
})
