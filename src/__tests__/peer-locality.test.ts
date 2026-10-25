import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { SocketServer } from '../broker/socket.js'
import type { ClientMessage, ServerMessage } from '../protocol.js'
import {
  claudeCodeAncestor,
  humanProofGap,
  parseStat,
  parseStatTerminal,
  peerPidFromSs,
  provePeerLocal,
  type PeerPorts,
} from '../broker/peer-locality.js'

/** CC-896 — locality for a session that reported no host comes from the kernel's view of its socket. */

const conn = {} as net.Socket
const HOST_PID = 500

const tree = (
  procs: Record<number, [number, string]>,
  peer: number | undefined,
  argvs: Record<number, string> = {},
  terminals: Record<number, { session: number; ttyNr: number }> = {},
): PeerPorts => ({
  peerPid: () => peer,
  argv: pid =>
    pid in argvs ? argvs[pid] : procs[pid] === undefined ? undefined : `/usr/bin/${procs[pid]![1]} --flag`,
  process: pid => (procs[pid] === undefined ? undefined : { ppid: procs[pid]![0], comm: procs[pid]![1] }),
  terminal: pid => terminals[pid],
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

  it('refuses an ssh -R client peer whose parent shell shares the session’s host pid', () => {
    const ports = tree({ 800: [777, 'ssh'], 777: [1, 'zsh'] }, 800)

    expect(provePeerLocal(conn, 777, ports)).toBe(false)
  })

  it.each(['ssh', 'sshd-session', 'ssh-agent', 'autossh', 'mosh-server', 'socat', 'nc', 'ncat', 'netcat'])(
    'refuses a %s relay as the peer',
    comm => {
      const ports = tree({ 800: [HOST_PID, comm], [HOST_PID]: [1, 'claude'] }, 800)

      expect(provePeerLocal(conn, HOST_PID, ports)).toBe(false)
    },
  )

  it('refuses a relay between the peer and the host pid', () => {
    const ports = tree({ 800: [790, 'node'], 790: [HOST_PID, 'socat'], [HOST_PID]: [1, 'claude'] }, 800)

    expect(provePeerLocal(conn, HOST_PID, ports)).toBe(false)
  })

  it.each([
    'dbclient',
    'stunnel',
    'websocat',
    'python3',
    'node',
    'busybox',
    'et',
    'tsh',
    'nc.openbsd',
    'nc.traditional',
    'renamed',
  ])('refuses a %s relay when the host pid is a shell, not Claude Code', relay => {
    const ports = tree({ 800: [777, relay], 777: [1, 'zsh'] }, 800)

    expect(provePeerLocal(conn, 777, ports)).toBe(false)
  })

  it.each([
    ['its executable', '/usr/local/bin/claude --model opus'],
    ['a node run of the Claude Code package', 'node /opt/claude-code/cli.js --resume x'],
  ])('accepts a host pid running Claude Code by %s', (_, argv) => {
    const ports = tree({ 700: [HOST_PID, 'node'], [HOST_PID]: [1, 'x'] }, 700, { [HOST_PID]: argv })

    expect(provePeerLocal(conn, HOST_PID, ports)).toBe(true)
  })

  it('refuses a host pid whose argv is unreadable or only mentions claude as an argument', () => {
    const base = { 700: [HOST_PID, 'node'], [HOST_PID]: [1, 'claude'] } as Record<number, [number, string]>

    expect(provePeerLocal(conn, HOST_PID, { ...tree(base, 700), argv: () => undefined })).toBe(false)
    expect(provePeerLocal(conn, HOST_PID, tree(base, 700, { [HOST_PID]: 'nc -l claude' }))).toBe(false)
  })

  it('refuses a host pid that is itself a forwarder, or unreadable', () => {
    expect(
      provePeerLocal(conn, HOST_PID, tree({ 700: [HOST_PID, 'node'], [HOST_PID]: [1, 'ssh'] }, 700)),
    ).toBe(false)
    expect(provePeerLocal(conn, HOST_PID, tree({ 700: [HOST_PID, 'node'] }, 700))).toBe(false)
  })

  it('refuses a chain deeper than an MCP server wrapper', () => {
    const deep = tree(
      { 6: [5, 'z'], 5: [4, 'a'], 4: [3, 'b'], 3: [2, 'c'], 2: [HOST_PID, 'd'], [HOST_PID]: [1, 'claude'] },
      6,
    )

    expect(provePeerLocal(conn, HOST_PID, deep)).toBe(false)
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

describe('claudeCodeAncestor', () => {
  it('finds a Claude Code process several steps above the peer', () => {
    const ports = tree({ 700: [650, 'node'], 650: [500, 'bash'], 500: [1, 'claude'] }, 700)

    expect(claudeCodeAncestor(conn, ports)).toBe(500)
  })

  it('counts the peer itself when it runs Claude Code', () => {
    expect(claudeCodeAncestor(conn, tree({ 700: [1, 'claude'] }, 700))).toBe(700)
  })

  it('recognises a node runtime running the Claude Code package as an ancestor', () => {
    const ports = tree({ 700: [650, 'node'], 650: [500, 'bash'], 500: [1, 'node'] }, 700, {
      500: 'node /opt/claude-code/cli.js --resume x',
    })

    expect(claudeCodeAncestor(conn, ports)).toBe(500)
  })

  it('finds nothing above a plain terminal chain', () => {
    const ports = tree({ 700: [650, 'node'], 650: [600, 'zsh'], 600: [1, 'tmux'] }, 700)

    expect(claudeCodeAncestor(conn, ports)).toBeUndefined()
  })

  it('finds nothing when the peer pid or its process cannot be read', () => {
    expect(claudeCodeAncestor(conn, tree({}, undefined))).toBeUndefined()
    expect(claudeCodeAncestor(conn, tree({}, 700))).toBeUndefined()
  })

  it('ends a ppid cycle without a match', () => {
    const ports = tree({ 700: [701, 'a'], 701: [700, 'b'] }, 700)
    const readProcess = vi.fn((pid: number) => {
      if (readProcess.mock.calls.length > 10) throw new Error('walked the cycle')
      return ports.process(pid)
    })

    expect(claudeCodeAncestor(conn, { ...ports, process: readProcess }, 1_000_000)).toBeUndefined()
    expect(readProcess).toHaveBeenCalledTimes(2)
  })

  it('stops at maxDepth', () => {
    const ports = tree({ 700: [650, 'a'], 650: [600, 'b'], 600: [1, 'claude'] }, 700)

    expect(claudeCodeAncestor(conn, ports, 2)).toBeUndefined()
    expect(claudeCodeAncestor(conn, ports, 3)).toBe(600)
  })
})

describe('humanProofGap (CC-1246)', () => {
  const PTS = 34816
  /** The human typing `agent-chat spawn` in a tmux pane: node under the pane's interactive zsh. */
  const TERMINAL = { 700: [650, 'node'], 650: [600, 'zsh'], 600: [1, 'tmux'] } as Record<
    number,
    [number, string]
  >
  const inSession = (session: number, ttyNr = PTS) => ({ 700: { session, ttyNr }, 650: { session, ttyNr } })

  it('proves the human at an interactive shell with a controlling tty', () => {
    expect(humanProofGap(700, tree(TERMINAL, 700, {}, inSession(650)))).toBeUndefined()
  })

  it('accepts a login shell, whose argv starts with a dash', () => {
    expect(humanProofGap(700, tree(TERMINAL, 700, { 650: '-zsh' }, inSession(650)))).toBeUndefined()
  })

  it('refuses an undefined peer pid, as off Linux or through a forwarded socket', () => {
    expect(humanProofGap(undefined, tree(TERMINAL, undefined, {}, inSession(650)))).toBe('no peer pid')
  })

  it('refuses when the peer’s stat cannot be read, as on darwin with no /proc', () => {
    expect(humanProofGap(700, tree(TERMINAL, 700))).toBe('peer terminal unreadable')
  })

  it('refuses a caller with no controlling tty (setsid, systemd-run --user)', () => {
    expect(humanProofGap(700, tree(TERMINAL, 700, {}, inSession(650, 0)))).toBe('no controlling tty')
  })

  it('refuses a caller that leads its own session (tmux new -d <cmd>, setsid -c)', () => {
    expect(humanProofGap(700, tree(TERMINAL, 700, {}, inSession(700)))).toBe('not under its session leader')
  })

  it('refuses an orphan reparented away from its session leader (nohup … &)', () => {
    const orphan = { 700: [1, 'node'], 650: [600, 'zsh'], 600: [1, 'tmux'] } as Record<
      number,
      [number, string]
    >

    expect(humanProofGap(700, tree(orphan, 700, {}, inSession(650)))).toBe('not under its session leader')
  })

  it('refuses a session led by a shell running a -c script, or one whose argv is unreadable', () => {
    expect(
      humanProofGap(700, tree(TERMINAL, 700, { 650: '/bin/zsh -lc agent-chat spawn x' }, inSession(650))),
    ).toBe('session leader runs a script')
    expect(humanProofGap(700, { ...tree(TERMINAL, 700, {}, inSession(650)), argv: () => undefined })).toBe(
      'session leader runs a script',
    )
  })

  it('refuses a session whose leader sits under Claude Code', () => {
    const underClaude = { 700: [650, 'node'], 650: [500, 'zsh'], 500: [1, 'claude'] } as Record<
      number,
      [number, string]
    >

    expect(humanProofGap(700, tree(underClaude, 700, {}, inSession(650)))).toBe(
      'session leader under Claude Code 500',
    )
  })
})

describe('parsers', () => {
  it('reads ppid and comm from stat even when comm holds parentheses', () => {
    expect(parseStat('12 (a) b) S 7 12 12 0')).toEqual({ ppid: 7, comm: 'a) b' })
    expect(parseStat('garbage')).toBeUndefined()
  })

  it('reads session and tty_nr from stat after the last parenthesis', () => {
    expect(parseStatTerminal('12 (a) b) S 7 12 9 34816 12 4194560')).toEqual({ session: 9, ttyNr: 34816 })
    expect(parseStatTerminal('12 (x) S 7 12 12 0 -1')).toEqual({ session: 12, ttyNr: 0 })
    expect(parseStatTerminal('12 (x) S 7')).toBeUndefined()
    expect(parseStatTerminal('garbage')).toBeUndefined()
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
      const { send, seen, dir } = setup(tree({ 700: [HOST, 'node'], [HOST]: [1, 'claude'] }, 700))

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
