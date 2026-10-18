import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { hostChannelStatus } from '../broker/host-channels.js'
import { Registry } from '../broker/registry.js'
import { SocketServer } from '../broker/socket.js'
import type { BrokerClient } from '../client/broker-client.js'
import { logPath } from '../paths.js'
import type { ClientMessage, ServerMessage } from '../protocol.js'
import { ToolHandler } from '../server/tools.js'

/**
 * CC-1455: a `claude -p` host drops every channel push, so a send to it must not read as
 * delivered, to the sender or in the route row. Every name here is synthetic.
 */

const HEADLESS = 'claude -p --output-format stream-json --verbose --channels plugin:agent-chat@local'
const PROMPT_HOLDS_P = 'claude --channels plugin:agent-chat@local -- -p'
const INTERACTIVE = 'claude --channels plugin:agent-chat@local'

type SendResult = Extract<ServerMessage, { t: 'send_result' }>
interface Joined {
  conn: Conn
  frames: ServerMessage[]
}

let dir: string
let core: BrokerCore
let server: SocketServer
const argvByPid = new Map<number, string>()

function join(name: string, argv: string): Joined {
  const hostPid = 1000 + argvByPid.size
  argvByPid.set(hostPid, argv)
  const frames: ServerMessage[] = []
  const conn = { write: (line: string) => frames.push(JSON.parse(line) as ServerMessage) } as unknown as Conn
  server.handleMessage(conn, { t: 'register', name, workingOn: 'testing', cwd: '/tmp', pid: 1, hostPid })
  return { conn, frames }
}

function send(from: Joined, to: string | string[]): SendResult {
  server.handleMessage(from.conn, { t: 'send', to, text: 'stand down' })
  return from.frames.filter((f): f is SendResult => f.t === 'send_result').at(-1) as SendResult
}

const routeRow = (msgId: string | undefined): Record<string, unknown> | undefined =>
  fs
    .readFileSync(logPath(), 'utf8')
    .split('\n')
    .filter(line => line !== '')
    .map(line => JSON.parse(line) as Record<string, unknown>)
    .find(row => row.event === 'route' && row.msgId === msgId)

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-print-route-'))
  argvByPid.clear()
  const registry = new Registry<Conn>(Date.now, pid =>
    hostChannelStatus(pid, 'agent-chat', p => argvByPid.get(p)),
  )
  core = new BrokerCore(() => undefined, { events: new EventLog(path.join(dir, 'events.db')), registry })
  server = new SocketServer(core)
})

afterEach(() => {
  server.close()
  core.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('a send to a print-mode host', () => {
  it('reports headless_no_channel and logs the route as not delivered', () => {
    const coord = join('coord', INTERACTIVE)
    join('scout', HEADLESS)

    const result = send(coord, 'scout')

    expect(result.ok).toBe(true)
    expect(result.results).toEqual([
      expect.objectContaining({ name: 'scout', status: 'headless_no_channel' }),
    ])
    expect(routeRow(result.msgId)).toMatchObject({ delivered: false, reason: 'headless_no_channel' })
  })

  it('still reads as delivered when the -p sits in the prompt after --', () => {
    const coord = join('coord', INTERACTIVE)
    join('scout', PROMPT_HOLDS_P)

    const result = send(coord, 'scout')

    expect(result.results).toEqual([{ name: 'scout', status: 'delivered' }])
    expect(routeRow(result.msgId)).toMatchObject({ delivered: true })
    expect(routeRow(result.msgId)).not.toHaveProperty('reason')
  })

  it('lists a status per recipient of a multicast and names only the print one unwoken', () => {
    const coord = join('coord', INTERACTIVE)
    join('seat-x', INTERACTIVE)
    join('scout', HEADLESS)

    const result = send(coord, ['seat-x', 'scout'])

    expect(result.results).toEqual([
      { name: 'seat-x', status: 'delivered' },
      expect.objectContaining({ name: 'scout', status: 'headless_no_channel' }),
    ])
    expect(routeRow(result.msgId)).toMatchObject({ delivered: true, unwoken: ['scout'] })
  })
})

describe('chat_send wording for a print-mode recipient', () => {
  const handlerReplying = (reply: Partial<SendResult>) => {
    const broker = {
      request: async (_: ClientMessage) => ({ t: 'send_result', ok: true, msgId: 'm1', ...reply }),
    } as unknown as BrokerClient
    return new ToolHandler(broker, 'coord')
  }
  const textOf = (result: { content: { text: string }[] }): string => result.content[0]!.text

  it('names only the print recipient of a multicast NOT SEEN', async () => {
    const handler = handlerReplying({
      recipients: ['seat-x', 'scout'],
      results: [
        { name: 'seat-x', status: 'delivered' },
        { name: 'scout', status: 'headless_no_channel' },
      ],
    })

    const text = textOf(await handler.handle('chat_send', { to: ['seat-x', 'scout'], text: 'stand down' }))

    expect(text).toMatch(/Delivered to seat-x \(msg_id m1\)/)
    expect(text).toMatch(/NOT SEEN: scout —/)
    expect(text).not.toMatch(/NOT SEEN: [^—]*seat-x/)
  })

  it('does not call a single print-mode send delivered', async () => {
    const handler = handlerReplying({
      recipients: ['scout'],
      results: [{ name: 'scout', status: 'headless_no_channel' }],
    })

    const text = textOf(await handler.handle('chat_send', { to: 'scout', text: 'stand down' }))

    expect(text).toMatch(/^NOT SEEN: "scout"/)
    expect(text).not.toMatch(/Delivered/)
  })
})
