import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { SocketServer } from '../broker/socket.js'
import type { ClientMessage, ServerMessage } from '../protocol.js'
import {
  linuxPeerPorts,
  parseStat,
  peerPidFromSs,
  provePeerLocal,
  type PeerPorts,
} from '../broker/peer-locality.js'

/** CC-896 — locality for a session that reported no host comes from the kernel's view of its socket. */

const conn = {} as net.Socket
const HOST_PID = 500

const tree = (procs: Record<number, [number, string]>, peer: number | undefined): PeerPorts => ({
  peerPid: () => peer,
  process: pid => (procs[pid] === undefined ? undefined : { ppid: procs[pid]![0], comm: procs[pid]![1] }),
})

describe('provePeerLocal', () => {
  it('accepts a peer whose parent chain includes the session’s host pid', () => {
    const ports = tree({ 700: [650, 'node'], 650: [HOST_PID, 'sh'], [HOST_PID]: [1, 'claude'] }, 700)

    expect(provePeerLocal(conn, HOST_PID, ports)).toBe(true)
  })

  it('refuses an ssh-forwarded peer, where sshd holds the broker’s end', () => {
    const ports = tree({ 900: [1, 'sshd'] }, 900)

    expect(provePeerLocal(conn, HOST_PID, ports)).toBe(false)
  })

  it('refuses sshd in the chain below the host pid even if the host pid is reached', () => {
    const ports = tree({ 700: [650, 'node'], 650: [HOST_PID, 'sshd-session'] }, 700)

    expect(provePeerLocal(conn, HOST_PID, ports)).toBe(false)
  })

  it('refuses when no peer can be established', () => {
    expect(provePeerLocal(conn, HOST_PID, tree({}, undefined))).toBe(false)
  })

  it('refuses a peer outside the session’s tree', () => {
    const ports = tree({ 700: [650, 'node'], 650: [1, 'zsh'] }, 700)

    expect(provePeerLocal(conn, HOST_PID, ports)).toBe(false)
  })

  it('refuses when the chain cannot be read or loops', () => {
    expect(provePeerLocal(conn, HOST_PID, tree({ 700: [650, 'node'] }, 700))).toBe(false)
    expect(provePeerLocal(conn, HOST_PID, tree({ 700: [650, 'a'], 650: [700, 'b'] }, 700))).toBe(false)
  })

  it('refuses when the session reported no host pid', () => {
    expect(provePeerLocal(conn, undefined, tree({ 700: [HOST_PID, 'node'] }, 700))).toBe(false)
  })
})

describe('parsers', () => {
  it('reads ppid and comm from stat even when comm holds parentheses', () => {
    expect(parseStat('12 (a) b) S 7 12 12 0')).toEqual({ ppid: 7, comm: 'a) b' })
    expect(parseStat('garbage')).toBeUndefined()
  })

  const ss = [
    'u_str ESTAB 0 0 /run/broker.sock 111 * 222',
    'u_str ESTAB 0 0 * 222 * 111 users:(("node",pid=700,fd=9))',
  ].join('\n')

  it('finds the single pid on the peer end of a socket inode', () => {
    expect(peerPidFromSs(ss, '111')).toBe(700)
  })

  it('returns nothing when the peer end is shared by several processes or unknown', () => {
    const shared = ss.replace('pid=700,fd=9))', 'pid=700,fd=9),("node",pid=701,fd=9))')
    expect(peerPidFromSs(shared, '111')).toBeUndefined()
    expect(peerPidFromSs(ss, '999')).toBeUndefined()
  })
})

describe.skipIf(process.platform !== 'linux')('linuxPeerPorts on a real socket', () => {
  it('names this process as the peer of its own client connection', async () => {
    const sock = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ac-peer-')), 's.sock')
    const accepted = new Promise<net.Socket>(resolve => {
      const server = net.createServer(resolve).listen(sock)
      server.unref()
    })
    const client = net.connect(sock)
    const serverSide = await accepted

    expect(linuxPeerPorts.peerPid(serverSide)).toBe(process.pid)

    client.destroy()
    serverSide.destroy()
    fs.rmSync(path.dirname(sock), { recursive: true, force: true })
  })
})

describe('a session that reported no host, asking the broker to end its Claude Code', () => {
  const HOST = 424242
  const setup = (ports: PeerPorts) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-peer-wire-'))
    process.env.AGENT_CHAT_HOME = dir
    const core = new BrokerCore(() => undefined, {
      events: new EventLog(path.join(dir, 'events.db')),
      registry: new Registry<Conn>(),
    })
    const server = new SocketServer(core, {}, undefined, ports)
    const seen: Array<{ host?: string }> = []
    const supervisor = (server as unknown as { supervisor: Record<string, unknown> }).supervisor
    supervisor.switchSurface = (req: { host?: string }) => {
      seen.push(req)
      return Promise.resolve({ ok: false, reason: 'stubbed' })
    }
    supervisor.teleport = (req: { subject: { host?: string } }) => {
      seen.push(req.subject)
      return Promise.resolve({ ok: false, reason: 'stubbed' })
    }
    const emitter = new EventEmitter()
    const frames: ServerMessage[] = []
    const conn = Object.assign(emitter, {
      write: (line: string) => frames.push(JSON.parse(line) as ServerMessage),
    }) as unknown as Conn
    server.onConnection(conn)
    const send = (msg: ClientMessage) => emitter.emit('data', JSON.stringify(msg) + '\n')
    send({
      t: 'register',
      name: 'old-seat',
      workingOn: 'x',
      cwd: dir,
      pid: 1,
      sessionId: 'session-uuid-9',
      hostPid: HOST,
    })
    return { send, seen, frames, dir }
  }

  afterEach(() => {
    delete process.env.AGENT_CHAT_HOME
  })

  it.each(['background', 'teleport'] as const)(
    '%s treats a peer inside its process tree as local',
    async kind => {
      const { send, seen, dir } = setup(tree({ 700: [HOST, 'node'] }, 700))

      send(kind === 'background' ? { t: 'background' } : { t: 'teleport', handoff: 'x' })
      await vi.waitFor(() => expect(seen).toHaveLength(1))

      expect(seen[0]?.host).toBe(os.hostname())
      fs.rmSync(dir, { recursive: true, force: true })
    },
  )

  it.each(['background', 'teleport'] as const)('%s leaves an sshd peer without a host', async kind => {
    const { send, seen, dir } = setup(tree({ 900: [1, 'sshd'] }, 900))

    send(kind === 'background' ? { t: 'background' } : { t: 'teleport', handoff: 'x' })
    await vi.waitFor(() => expect(seen).toHaveLength(1))

    expect(seen[0]?.host).toBeUndefined()
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
