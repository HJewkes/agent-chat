import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { CODEX_WAKE_CAPPED } from '../broker/codex-wake-cap.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { SocketServer } from '../broker/socket.js'
import { HUMAN, type ClientMessage, type DeliveredMessage, type ServerMessage } from '../protocol.js'

/**
 * CC-1545: `agent-chat codex run --wake-cap` tells the session's spawner, through the
 * broker, that it is holding records. Pids, hosts and names are synthetic.
 */

const HOST = 'example-host'
const CODEX_PID = 71_002
const tmpDirs: string[] = []

interface Wire {
  conn: Conn
  frames: ServerMessage[]
}

function makeServer(): { core: BrokerCore; server: SocketServer; wire: () => Wire } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-wake-cap-'))
  tmpDirs.push(dir)
  const core = new BrokerCore(
    (conn, message) => {
      ;(conn as unknown as { write: (s: string) => void }).write(
        JSON.stringify({ t: 'deliver', message }) + '\n',
      )
    },
    { events: new EventLog(path.join(dir, 'events.db')), registry: new Registry<Conn>() },
  )
  const wire = (): Wire => {
    const frames: ServerMessage[] = []
    const conn = {
      write: (line: string) => frames.push(JSON.parse(line) as ServerMessage),
    } as unknown as Conn
    return { conn, frames }
  }
  return { core, server: new SocketServer(core), wire }
}

const register = (server: SocketServer, conn: Conn, name: string, extra: Partial<ClientMessage> = {}): void =>
  server.handleMessage(conn, {
    t: 'register',
    name,
    workingOn: 'testing',
    cwd: '/tmp',
    pid: 1,
    ...extra,
  } as ClientMessage)

const capped = (cap = 3): ClientMessage => ({ t: 'codex_wake_capped', hostPid: CODEX_PID, host: HOST, cap })

const lastResult = (wire: Wire) => wire.frames.at(-1) as Extract<ServerMessage, { t: 'send_result' }>

const deliveries = (frames: ServerMessage[]): DeliveredMessage[] =>
  frames.filter((f): f is Extract<ServerMessage, { t: 'deliver' }> => f.t === 'deliver').map(f => f.message)

const noticeRows = (core: BrokerCore) =>
  core.events.since(0, 200).filter(row => row.meta.event === CODEX_WAKE_CAPPED)

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('a codex run wake cap', () => {
  it('reaches the agent that spawned the session, naming the session and its cap', () => {
    // Catches: a notice sent to the human, or to nobody, when an agent spawned the session.
    const { core, server, wire } = makeServer()
    const coord = wire()
    const codex = wire()
    const cli = wire()
    register(server, coord.conn, 'coord')
    core.append({ kind: 'agent_spawned', actor: 'coord', target: 'scout', msgId: 'a1', body: 'work' })
    register(server, codex.conn, 'scout', { agentId: 'a1', hostPid: CODEX_PID, host: HOST })

    server.handleMessage(cli.conn, capped())

    expect(lastResult(cli)).toMatchObject({ ok: true, recipients: ['coord'] })
    const [line] = deliveries(coord.frames)
    expect(line).toMatchObject({ from: 'agent-chat', event: CODEX_WAKE_CAPPED })
    expect(line?.text).toContain('scout reached its Codex wake cap of 3')
    expect(deliveries(codex.frames)).toEqual([])
  })

  it('goes to the human queue as a notice for a session the human started', () => {
    const { core, server, wire } = makeServer()
    const codex = wire()
    const cli = wire()
    register(server, codex.conn, 'scout', {
      sessionId: `codex:${CODEX_PID}@${HOST}`,
      hostPid: CODEX_PID,
      host: HOST,
    })

    server.handleMessage(cli.conn, capped(2))

    expect(lastResult(cli)).toMatchObject({ ok: true, recipients: [HUMAN] })
    const rows = noticeRows(core)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'notice', target: HUMAN, meta: { agent: 'scout', cap: '2' } })
  })

  it('is refused from a registered session, so no peer can write a spawner notice', () => {
    const { core, server, wire } = makeServer()
    const codex = wire()
    const peer = wire()
    register(server, codex.conn, 'scout', { hostPid: CODEX_PID, host: HOST })
    register(server, peer.conn, 'mallory')

    server.handleMessage(peer.conn, capped())

    expect(lastResult(peer).ok).toBe(false)
    expect(noticeRows(core)).toEqual([])
  })

  it('matches the machine as well as the pid', () => {
    const { core, server, wire } = makeServer()
    const codex = wire()
    const cli = wire()
    register(server, codex.conn, 'scout', { hostPid: CODEX_PID, host: 'other-host' })

    server.handleMessage(cli.conn, capped())

    expect(lastResult(cli)).toMatchObject({ ok: false })
    expect(noticeRows(core)).toEqual([])
  })
})
