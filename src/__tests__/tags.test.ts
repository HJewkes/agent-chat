import { describe, expect, it } from 'vitest'
import { ToolHandler } from '../server/tools.js'
import type { BrokerClient } from '../client/broker-client.js'
import type { ClientMessage, ServerMessage, SessionInfo } from '../protocol.js'

/**
 * CC-13 at the tool boundary — where a tag stops being an idea and becomes a
 * write into a peer's presence and a line in every peer's chat_list.
 *
 * Two things are under test here rather than in the registry: that the caps are
 * REJECTED at the boundary (so the model learns the shape rather than believing
 * it applied something it did not), and that the rendering keeps a self-declared
 * tag visibly apart from one a peer applied.
 */

/** Captures the frame a tool handler put on the wire, which is what is under test. */
function recordingBroker(reply: ServerMessage): { broker: BrokerClient; sent: ClientMessage[] } {
  const sent: ClientMessage[] = []
  const broker = {
    request: async (message: ClientMessage) => {
      sent.push(message)
      return reply
    },
  } as unknown as BrokerClient
  return { broker, sent }
}

const textOf = (result: { content: { text: string }[] }): string => result.content[0]!.text

const tagged: ServerMessage = { t: 'tag_result', ok: true, subject: 'cc-relay', tags: [] }

/** A handler that already believes it is registered, which every tag path requires. */
const handlerFor = (reply: ServerMessage) => {
  const { broker, sent } = recordingBroker(reply)
  return { handler: new ToolHandler(broker, undefined, 'cc-relay'), sent }
}

describe('chat_tag validates before it writes into a peer', () => {
  it('carries a well-formed add through to the tag frame', async () => {
    const { handler, sent } = handlerFor(tagged)

    await handler.handle('chat_tag', { target: 'cc2-relay', add: ['owner:docs'] })

    expect(sent[0]).toEqual({ t: 'tag', target: 'cc2-relay', add: ['owner:docs'] })
  })

  it('tags the caller when no target is named, so `by` has nothing to aim at', async () => {
    const { handler, sent } = handlerFor(tagged)

    await handler.handle('chat_tag', { add: ['owner:src'] })

    expect(sent[0]).toEqual({ t: 'tag', add: ['owner:src'] })
  })

  it('rejects an over-long tag rather than truncating one into a different label', async () => {
    const { handler } = handlerFor(tagged)

    await expect(handler.handle('chat_tag', { add: ['x'.repeat(33)] })).rejects.toThrow(/33 characters/)
  })

  it('rejects characters a tag may not use, naming the ones it may', async () => {
    const { handler } = handlerFor(tagged)

    await expect(handler.handle('chat_tag', { add: ['owner of src'] })).rejects.toThrow(
      /letters, digits, and _ : \. -/,
    )
  })

  it('rejects more tags in one call than a session may hold at all', async () => {
    const { handler } = handlerFor(tagged)
    const seventeen = Array.from({ length: 17 }, (_, i) => `t${i}`)

    await expect(handler.handle('chat_tag', { add: seventeen })).rejects.toThrow(/at most 16 tags/)
  })

  it('says a peer was not notified, because a tag must not lengthen its turn', async () => {
    const { handler } = handlerFor({
      t: 'tag_result',
      ok: true,
      subject: 'cc2-relay',
      tags: [{ tag: 'owner:docs', by: 'cc-relay', at: Date.now() }],
    })

    const out = textOf(await handler.handle('chat_tag', { target: 'cc2-relay', add: ['owner:docs'] }))

    expect(out).toContain('not notified')
    expect(out).toContain('not a grant')
  })
})

describe('chat_send to_tag is a separate address, never a spelling of to', () => {
  const sent = { t: 'send_result', ok: true, msgId: 'm1', recipients: ['bob'], results: [] } as ServerMessage

  it('puts a tag on its own field so a session named like a tag stays unambiguous', async () => {
    const { handler, sent: frames } = handlerFor(sent)

    await handler.handle('chat_send', { to_tag: 'owner:src', text: 'rebase first' })

    expect(frames[0]).toEqual({ t: 'send', toTag: 'owner:src', text: 'rebase first' })
  })

  it('refuses a call that names both, rather than guessing which one was meant', async () => {
    const { handler } = handlerFor(sent)

    await expect(handler.handle('chat_send', { to: 'bob', to_tag: 'owner:src', text: 'hi' })).rejects.toThrow(
      /not both/,
    )
  })

  it('still requires a recipient when neither is given', async () => {
    const { handler } = handlerFor(sent)

    await expect(handler.handle('chat_send', { text: 'hi' })).rejects.toThrow(/to is required/)
  })

  it('reports per recipient, since the sender never named who would get it', async () => {
    const { handler } = handlerFor({
      t: 'send_result',
      ok: true,
      msgId: 'm1',
      recipients: ['bob', 'carol'],
      results: [
        { name: 'bob', status: 'delivered' },
        { name: 'carol', status: 'held' },
      ],
    })

    const out = textOf(await handler.handle('chat_send', { to_tag: 'owner:src', text: 'rebase first' }))

    expect(out).toContain('Tag "owner:src"')
    expect(out).toContain('Delivered to bob, carol')
    expect(out).toContain('held in the inbox of carol')
  })
})

describe('chat_list renders tags with who applied them', () => {
  const session = (over: Partial<SessionInfo>): SessionInfo => ({
    name: 'cc-relay',
    workingOn: 'narrowing broadcast fanout',
    cwd: '/repo',
    status: 'working',
    dnd: false,
    idleMs: 12_000,
    registeredAt: 0,
    ...over,
  })

  const render = async (sessions: SessionInfo[]): Promise<string> => {
    const handler = new ToolHandler(recordingBroker({ t: 'list_result', sessions }).broker)
    return textOf(await handler.handle('chat_list', {}))
  }

  /**
   * The distinction is the whole feature: "I say I own src" and "cc-main says I
   * own src" are different claims, and a reader that cannot tell them apart
   * learns to trust both equally.
   */
  it('marks a peer-applied tag with its applier and age, and a self-applied one as self', async () => {
    const out = await render([
      session({
        tags: [
          { tag: 'owner:src', by: 'cc-main', at: Date.now() - 4 * 60_000 },
          { tag: 'stale', by: 'self', at: Date.now() },
        ],
      }),
    ])

    expect(out).toContain('tags: owner:src (by cc-main, 4m ago), stale (self)')
  })

  it('renders a session carrying no tags exactly as it did before CC-13', async () => {
    const out = await render([session({})])

    expect(out).not.toContain('tags:')
    expect(out).toContain('- cc-relay [working, idle 12s] — narrowing broadcast fanout\n    /repo')
  })

  it('keeps the tags line beside the declared line, both marked as claims', async () => {
    const out = await render([
      session({
        declared: { role: 'implementer' },
        tags: [{ tag: 'owner:src', by: 'self', at: Date.now() }],
      }),
    ])

    expect(out).toContain('tags: owner:src (self)')
    expect(out).toContain('declared: role=implementer   (self-reported)')
  })
})
