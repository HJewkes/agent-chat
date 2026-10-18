import { describe, expect, it } from 'vitest'
import { invokeCommand } from '@titan-design/registry'
import type { ToolContext } from '../server/command.js'
import { chatSend } from '../server/commands/chat-send.js'
import { describeResume } from '../agents/resume-session.js'
import type { BrokerClient } from '../client/broker-client.js'
import type { ServerMessage } from '../protocol.js'

/** CC-1454: a retry the broker answered from its cache must not read as a second send or launch. */

const answering = (reply: ServerMessage): ToolContext => ({
  warnings: [],
  format: 'human',
  broker: { request: async () => reply } as unknown as BrokerClient,
  registeredName: 'scout',
  session: { name: () => 'scout', fixed: false, adopt: () => undefined },
})

const sendText = async (reply: ServerMessage): Promise<unknown> => {
  const { envelope } = await invokeCommand(chatSend, { to: 'agent-x', text: 'hello' }, answering(reply))
  return envelope
}

describe('chat_send on a deduped reply', () => {
  it('says the retry was not sent again and names the first msg_id', async () => {
    const envelope = await sendText({
      t: 'send_result',
      ok: true,
      msgId: 'ab12cd34',
      recipients: ['agent-x'],
      deduped: true,
    })

    expect(envelope).toMatchObject({ ok: true })
    expect(JSON.stringify(envelope)).toContain(
      'This retry was answered from the first send and not sent again: Delivered to \\"agent-x\\" (msg_id ab12cd34).',
    )
  })

  it('reads a first send as before', async () => {
    const envelope = await sendText({
      t: 'send_result',
      ok: true,
      msgId: 'ab12cd34',
      recipients: ['agent-x'],
    })

    expect(JSON.stringify(envelope)).not.toContain('not sent again')
  })
})

describe('describeResume on a deduped reply', () => {
  it('says the resume already ran and was not launched again', () => {
    const { ok, lines } = describeResume('agent-x', { ok: true, deduped: true })

    expect(ok).toBe(true)
    expect(lines[0]).toBe('This resume already ran; this retry was not launched again.')
  })

  it('leaves a first resume and a refusal unmarked', () => {
    expect(describeResume('agent-x', { ok: true }).lines.join('\n')).not.toContain('not launched again')
    expect(describeResume('agent-x', { ok: false, reason: 'no' }).lines[0]).toBe('Not resumed: no')
  })
})
