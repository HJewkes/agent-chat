import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { SocketServer } from '../broker/socket.js'
import type { ServerMessage } from '../protocol.js'
import { chatInbox } from '../server/commands/chat-inbox.js'

/** CC-886: `chat_inbox after: <msg_id>` replaces raw sqlite reads of the event log. */
let home: string
let log: EventLog
let server: SocketServer

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-after-'))
  log = new EventLog(path.join(home, 'events.db'))
  const core = new BrokerCore(() => {}, { events: log, registry: new Registry<Conn>() })
  server = new SocketServer(core)
})

afterEach(() => {
  log.close()
  fs.rmSync(home, { recursive: true, force: true })
})

function wireFor(name: string) {
  const frames: ServerMessage[] = []
  const conn = { write: (line: string) => frames.push(JSON.parse(line) as ServerMessage) } as unknown as Conn
  server.handleMessage(conn, { t: 'register', name, workingOn: 'w', cwd: '/tmp', pid: 1 })
  return { conn, frames }
}

const say = (body: string, target = 'alice') =>
  log.append({ kind: 'message', actor: 'bob', target, body, msgId: `m-${body}` })

function inbox(frame: { limit: number; after?: string }) {
  const w = wireFor('alice')
  w.frames.length = 0
  server.handleMessage(w.conn, { t: 'inbox', ...frame })
  return w.frames.find(f => f.t === 'inbox_result') as Extract<ServerMessage, { t: 'inbox_result' }>
}

describe('broker inbox with after', () => {
  it('returns only messages newer than the id, oldest first', () => {
    say('one')
    say('two')
    say('three')

    expect(inbox({ limit: 10, after: 'm-one' }).messages.map(m => m.text)).toEqual(['two', 'three'])
  })

  it('cuts the newest end when after is combined with limit, and says it truncated', () => {
    say('one')
    say('two')
    say('three')
    say('four')

    const res = inbox({ limit: 2, after: 'm-one' })
    expect(res.messages.map(m => m.text)).toEqual(['two', 'three'])
    expect(res.truncated).toBe(true)
  })

  it('does not flag truncation when everything newer fit', () => {
    say('one')
    say('two')

    expect(inbox({ limit: 5, after: 'm-one' }).truncated).toBeFalsy()
  })

  it('reports an unknown id as an error instead of an empty inbox', () => {
    say('one')

    const res = inbox({ limit: 5, after: 'nope' })
    expect(res.error).toMatch(/nope/)
    expect(res.messages).toEqual([])
  })

  it('does not resolve an id that belongs to another session', () => {
    say('secret', 'dave')

    expect(inbox({ limit: 5, after: 'm-secret' }).error).toBeDefined()
  })

  it('keeps the newest-N behaviour when after is absent', () => {
    say('one')
    say('two')
    say('three')

    const res = inbox({ limit: 2 })
    expect(res.messages.map(m => m.text)).toEqual(['two', 'three'])
    expect(res.error).toBeUndefined()
    expect(res.truncated).toBeUndefined()
  })
})

describe('chat_inbox tool', () => {
  const run = (args: object, res: Partial<Extract<ServerMessage, { t: 'inbox_result' }>>) => {
    const sent: unknown[] = []
    const ctx = {
      broker: {
        request: async (frame: unknown) => {
          sent.push(frame)
          return { t: 'inbox_result', messages: [], ...res }
        },
      },
    }
    return { sent, out: chatInbox.run(chatInbox.args.parse(args) as never, ctx as never) }
  }

  it('sends after on the wire and leaves the frame unchanged without it', async () => {
    const withAfter = run({ after: 'm-1' }, {})
    await withAfter.out
    const without = run({}, {})
    await without.out

    expect(withAfter.sent[0]).toMatchObject({ t: 'inbox', after: 'm-1' })
    expect(without.sent[0]).toEqual({ t: 'inbox', limit: 10 })
  })

  it('throws the broker error for an unknown id', async () => {
    await expect(run({ after: 'zzz' }, { error: 'no message zzz in your inbox' }).out).rejects.toThrow(/zzz/)
  })

  it('appends a truncation note', async () => {
    const out = await run(
      { after: 'm-1', limit: 1 },
      {
        truncated: true,
        messages: [{ msgId: 'm-2', from: 'bob', text: 'two', at: 1 } as never],
      },
    ).out
    expect(out).toMatch(/truncated/i)
    expect(out).toContain('after: m-2')
  })

  it('describes the parameter so agents find it', () => {
    expect(JSON.stringify(z.toJSONSchema(chatInbox.args).properties?.after)).toMatch(/msg_id/)
    expect(chatInbox.description).toMatch(/after: <msg_id>/)
  })
})
