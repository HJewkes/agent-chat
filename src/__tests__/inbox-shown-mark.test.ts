import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { SocketServer } from '../broker/socket.js'
import { recordShown } from '../cli/verbs/inbox-hook.js'
import type { ServerMessage } from '../protocol.js'

/** CC-1486: chat_inbox replays the log; a message the inbox hook showed comes back marked, never dropped. Synthetic names only. */

let dir: string
let core: BrokerCore
let server: SocketServer

function join(name: string): { conn: Conn; frames: ServerMessage[] } {
  const frames: ServerMessage[] = []
  const conn = { write: (line: string) => frames.push(JSON.parse(line) as ServerMessage) } as unknown as Conn
  server.handleMessage(conn, { t: 'register', name, workingOn: 'testing', cwd: '/tmp', pid: 1 })
  return { conn, frames }
}

const sendTo = (from: ReturnType<typeof join>, to: string): string => {
  server.handleMessage(from.conn, { t: 'send', to, text: 'note' })
  const res = from.frames.filter(f => f.t === 'send_result').at(-1) as Extract<
    ServerMessage,
    { t: 'send_result' }
  >
  return res.msgId as string
}

const replay = (reader: ReturnType<typeof join>) => {
  server.handleMessage(reader.conn, { t: 'inbox', limit: 10 })
  const res = reader.frames.filter(f => f.t === 'inbox_result').at(-1) as Extract<
    ServerMessage,
    { t: 'inbox_result' }
  >
  return res.messages
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-inbox-shown-'))
  vi.stubEnv('AGENT_CHAT_HOME', dir)
  core = new BrokerCore(() => undefined, {
    events: new EventLog(path.join(dir, 'events.db')),
    registry: new Registry<Conn>(Date.now),
  })
  server = new SocketServer(core)
})

afterEach(() => {
  server.close()
  core.close()
  vi.unstubAllEnvs()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('chat_inbox after an inbox-hook drain', () => {
  it('marks the shown message and leaves an unshown one unmarked', () => {
    // Arrange
    const coord = join('coord')
    const scout = join('scout')
    const first = sendTo(coord, 'scout')
    const second = sendTo(coord, 'scout')
    recordShown(core.events, 'scout', '{}', [first])

    // Act
    const messages = replay(scout)

    // Assert
    expect(messages.map(m => [m.msgId, m.shown])).toEqual([
      [first, true],
      [second, undefined],
    ])
  })
})
