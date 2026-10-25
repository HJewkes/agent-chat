import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { FRAME_CLASSES } from '../broker/frame-classes.js'
import { Registry } from '../broker/registry.js'
import { SocketServer } from '../broker/socket.js'
import type { ClientMessage, ServerMessage } from '../protocol.js'

/**
 * CC-1138 slice D: a connection whose `hello` declared an agent id is not the human. Class 1
 * frames are refused from it; Class 3 frames are taken from it only for the declared agent.
 * Without a hello every frame behaves as it did. Names, ids, pids and hosts are synthetic.
 */

const HOST = 'example-host'
const CODEX_PID = 71_002
const tmpDirs: string[] = []

interface Wire {
  conn: Conn
  frames: ServerMessage[]
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function setup(): { core: BrokerCore; server: SocketServer; wire: () => Wire } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-caller-gate-'))
  tmpDirs.push(dir)
  const core = new BrokerCore(() => undefined, {
    events: new EventLog(path.join(dir, 'events.db')),
    registry: new Registry<Conn>(),
  })
  core.append({ kind: 'agent_spawned', actor: 'coord', target: 'scout', msgId: 'a1', body: 'work' })
  core.append({ kind: 'agent_spawned', actor: 'coord', target: 'peer', msgId: 'a2', body: 'work' })
  const wire = (): Wire => {
    const frames: ServerMessage[] = []
    const conn = { write: (line: string) => frames.push(JSON.parse(line) as ServerMessage) } as unknown as Conn
    return { conn, frames }
  }
  return { core, server: new SocketServer(core), wire }
}

/** An unregistered connection that says hello with `agentId`, or says nothing when it is undefined. */
function caller(server: SocketServer, wire: () => Wire, agentId?: string): Wire {
  const cli = wire()
  if (agentId !== undefined) server.handleMessage(cli.conn, { t: 'hello', agentId })
  return cli
}

const lastReply = (cli: Wire) => cli.frames.at(-1) as { ok: boolean; reason?: string }

const refusals = (core: BrokerCore) => core.events.since(0, 500).filter(row => row.kind === 'verdict_refused')

const CLASS_1: ClientMessage[] = [
  { t: 'human_send', to: 'peer', text: 'hello' },
  { t: 'answer', msgId: 'm-none', text: 'yes' },
  { t: 'dismiss', msgId: 'm-none' },
  { t: 'endorse_approve', msgId: 'm-none', text: 'go', to: 'peer' },
  { t: 'approve_permission', msgId: 'm-none', behavior: 'allow' },
  { t: 'teleport_abort', name: 'peer' },
  { t: 'service_ask', as: 'factory-t', text: 'Approve gate g-1?' },
  { t: 'account_move', name: 'peer', to: 'acct-b' },
  { t: 'account_move_check', name: 'peer', to: 'acct-b' },
]

const PLAIN_SHELL = 'run the verb from a plain shell'

describe('Class 1 frames and the declared caller', () => {
  it('covers every Class 1 frame in the table', () => {
    const classOne = Object.entries(FRAME_CLASSES)
      .filter(([, cls]) => cls === 1)
      .map(([t]) => t)

    expect(CLASS_1.map(f => f.t).sort()).toEqual(classOne.sort())
  })

  it.each(CLASS_1.map(f => [f.t, f] as const))('%s without a hello is handled as the human', (_t, frame) => {
    const { core, server, wire } = setup()
    const cli = caller(server, wire)

    server.handleMessage(cli.conn, frame)

    expect(refusals(core)).toEqual([])
    expect(lastReply(cli).reason ?? '').not.toContain(PLAIN_SHELL)
  })

  it.each(CLASS_1.map(f => [f.t, f] as const))(
    '%s from a known declared agent is refused under its name',
    (_t, frame) => {
      const { core, server, wire } = setup()
      const cli = caller(server, wire, 'a1')

      server.handleMessage(cli.conn, frame)

      expect(lastReply(cli)).toMatchObject({ ok: false })
      expect(lastReply(cli).reason).toContain(PLAIN_SHELL)
      expect(refusals(core)).toMatchObject([{ actor: 'scout', meta: { declared_agent_id: 'a1' } }])
    },
  )

  it.each(CLASS_1.map(f => [f.t, f] as const))('%s from an unknown declared id is refused', (_t, frame) => {
    const { core, server, wire } = setup()
    const cli = caller(server, wire, 'a-gone')

    server.handleMessage(cli.conn, frame)

    expect(lastReply(cli)).toMatchObject({ ok: false })
    expect(lastReply(cli).reason).toContain(PLAIN_SHELL)
    expect(refusals(core)).toMatchObject([{ actor: '?', meta: { declared_agent_id: 'a-gone' } }])
  })

  it('lets a declared agent dismiss its own queue item', () => {
    const { core, server, wire } = setup()
    const { msgId } = core.append({ kind: 'question', actor: 'scout', target: 'human', body: 'which way?' })
    const cli = caller(server, wire, 'a1')

    server.handleMessage(cli.conn, { t: 'dismiss', msgId })

    expect(lastReply(cli)).toMatchObject({ ok: true })
    expect(refusals(core)).toEqual([])
  })

  it('refuses a declared agent dismissing a peer’s queue item', () => {
    const { core, server, wire } = setup()
    const { msgId } = core.append({ kind: 'question', actor: 'peer', target: 'human', body: 'which way?' })
    const cli = caller(server, wire, 'a1')

    server.handleMessage(cli.conn, { t: 'dismiss', msgId })

    expect(lastReply(cli)).toMatchObject({ ok: false })
    expect(refusals(core)).toMatchObject([{ actor: 'scout' }])
  })
})

const hookFrame = (session: string): ClientMessage => ({
  t: 'permission_hook',
  session,
  toolName: 'Bash',
  toolInput: { command: 'ls' },
})

const selfGrantFrame = (session: string): ClientMessage => ({
  t: 'permission_self_granted',
  session,
  toolName: 'Write',
  toolInput: { file_path: '/tmp/example/.claude/skills/demo/SKILL.md', content: 'demo' },
  grant: 'repo-skills',
})

describe.each([
  ['permission_hook', hookFrame],
  ['permission_self_granted', selfGrantFrame],
])('Class 3 %s and the declared caller', (_t, frame) => {
  it('is accepted when the session is the declared agent', () => {
    const { core, server, wire } = setup()
    const cli = caller(server, wire, 'a1')

    server.handleMessage(cli.conn, frame('scout'))

    expect(lastReply(cli)).toMatchObject({ ok: true })
    expect(refusals(core)).toEqual([])
  })

  it('is refused when the session names another agent', () => {
    const { core, server, wire } = setup()
    const cli = caller(server, wire, 'a1')

    server.handleMessage(cli.conn, frame('peer'))

    expect(lastReply(cli)).toMatchObject({ ok: false })
    expect(lastReply(cli).reason).toContain('only for that agent')
    expect(refusals(core)).toMatchObject([{ actor: 'scout', meta: { declared_agent_id: 'a1' } }])
  })

  it('is refused from an unknown declared id, whatever the session', () => {
    const { core, server, wire } = setup()
    const cli = caller(server, wire, 'a-gone')

    server.handleMessage(cli.conn, frame('a-gone'))

    expect(lastReply(cli)).toMatchObject({ ok: false })
    expect(refusals(core)).toMatchObject([{ actor: '?' }])
  })

  it('is accepted for any session without a hello, as before', () => {
    const { core, server, wire } = setup()
    const cli = caller(server, wire)

    server.handleMessage(cli.conn, frame('peer'))

    expect(lastReply(cli)).toMatchObject({ ok: true })
    expect(refusals(core)).toEqual([])
  })
})

describe('Class 3 codex_wake_capped and the declared caller', () => {
  const capped: ClientMessage = { t: 'codex_wake_capped', hostPid: CODEX_PID, host: HOST, cap: 3 }

  function withCodexSession(name: string, agentId: string) {
    const ctx = setup()
    const codex = ctx.wire()
    ctx.server.handleMessage(codex.conn, {
      t: 'register',
      name,
      agentId,
      workingOn: 'testing',
      cwd: '/tmp',
      pid: 1,
      hostPid: CODEX_PID,
      host: HOST,
    } as ClientMessage)
    return ctx
  }

  it('is accepted when the pid is registered under the declared agent', () => {
    const { core, server, wire } = withCodexSession('scout', 'a1')
    const cli = caller(server, wire, 'a1')

    server.handleMessage(cli.conn, capped)

    expect(lastReply(cli)).toMatchObject({ ok: true })
    expect(refusals(core)).toEqual([])
  })

  it('is refused when the pid is registered under another agent', () => {
    const { core, server, wire } = withCodexSession('peer', 'a2')
    const cli = caller(server, wire, 'a1')

    server.handleMessage(cli.conn, capped)

    expect(lastReply(cli)).toMatchObject({ ok: false })
    expect(refusals(core)).toMatchObject([{ actor: 'scout' }])
  })

  it('is accepted for another agent’s pid without a hello, as before', () => {
    const { core, server, wire } = withCodexSession('peer', 'a2')
    const cli = caller(server, wire)

    server.handleMessage(cli.conn, capped)

    expect(lastReply(cli)).toMatchObject({ ok: true })
    expect(refusals(core)).toEqual([])
  })
})
