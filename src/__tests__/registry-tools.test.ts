import { describe, expect, it } from 'vitest'
import { EXIT, invokeCommand } from '@titan-design/registry'
import { ToolHandler } from '../server/tools.js'
import { toolDefinition, type ToolContext } from '../server/command.js'
import { chatSend } from '../server/commands/chat-send.js'
import { chatActivity } from '../server/commands/chat-activity.js'
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
