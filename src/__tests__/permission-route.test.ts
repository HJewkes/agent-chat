import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { OWNER_CHANNEL_HEADER, TOKEN_HEADER, type VerdictResponse } from '../api-contract.js'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { buildHttpApp } from '../broker/http.js'
import { Registry } from '../broker/registry.js'
import { SocketServer } from '../broker/socket.js'
import type { ClientMessage, ServerMessage } from '../protocol.js'

/**
 * TP-1989: the owner-console permission route runs the socket's own arbiter.
 * A real SocketServer raises the prompts and the real HTTP app answers them,
 * wired the way `daemon.ts` wires it, so the shared method is what is tested.
 */

interface Wire {
  conn: Conn
  frames: ServerMessage[]
  send: (msg: ClientMessage) => void
}

const TOKEN = 'test-token'
const PORT = 7601
const OWNER_HEADERS = {
  'Content-Type': 'application/json',
  Origin: `http://127.0.0.1:${PORT}`,
  [TOKEN_HEADER]: TOKEN,
  [OWNER_CHANNEL_HEADER]: 'console',
}

const dirs: string[] = []

afterAll(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function setup(): { core: BrokerCore; server: SocketServer; wire: () => Wire } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-perm-route-'))
  dirs.push(dir)
  const core = new BrokerCore(() => undefined, {
    events: new EventLog(path.join(dir, 'events.db')),
    registry: new Registry<Conn>(),
  })
  const server = new SocketServer(core)
  return { core, server, wire: () => wireFor(server) }
}

function wireFor(server: SocketServer): Wire {
  const frames: ServerMessage[] = []
  const emitter = new EventEmitter()
  const conn = Object.assign(emitter, {
    write: (line: string) => frames.push(JSON.parse(line) as ServerMessage),
  }) as unknown as Conn
  server.onConnection(conn)
  return { conn, frames, send: msg => emitter.emit('data', JSON.stringify(msg) + '\n') }
}

function promptingSession(wire: () => Wire): Wire {
  const session = wire()
  session.send({ t: 'register', name: 'agent-1', workingOn: 'testing', cwd: '/tmp', pid: 1 })
  session.send({
    t: 'approval',
    requestId: 'agent-1-req',
    toolName: 'Bash',
    description: 'Bash: example command',
    inputPreview: 'echo example',
  })
  return session
}

function hookPrompt(hook: Wire): string {
  hook.send({
    t: 'permission_hook',
    session: 'agent-1',
    toolName: 'Bash',
    toolInput: { command: 'echo example' },
    description: 'Bash: example command',
  })
  const result = hook.frames.find(f => f.t === 'permission_hook_result')
  if (result?.t !== 'permission_hook_result' || !result.ok || !result.msgId) throw new Error('not filed')
  return result.msgId
}

const openId = (core: BrokerCore): string =>
  core.events.humanQueue().find(i => i.kind === 'approval_request')!.msgId

async function postVerdict(server: SocketServer, core: BrokerCore, msgId: string, behavior: string) {
  const app = buildHttpApp({
    core,
    port: () => PORT,
    token: TOKEN,
    verdicts: { permission: (m, b, c) => server.permissionVerdict(m, b, c) },
  })
  const res = await app.fetch(
    new Request(`http://127.0.0.1/api/queue/${encodeURIComponent(msgId)}/permission`, {
      method: 'POST',
      headers: OWNER_HEADERS,
      body: JSON.stringify({ behavior }),
    }),
  )
  return { status: res.status, body: (await res.json()) as VerdictResponse }
}

const verdictsIn = (frames: ServerMessage[]) => frames.filter(f => f.t === 'permission_verdict')

const resolutions = (core: BrokerCore, msgId: string) =>
  core.events.since(0, 1000).filter(row => row.kind === 'resolution' && row.ref === msgId)

describe('the owner-console permission route over a live socket server (TP-1989)', () => {
  it('sends an allow to the prompting session and records owner-console on the resolution', async () => {
    const { core, server, wire } = setup()
    const session = promptingSession(wire)
    const msgId = openId(core)

    const { status, body } = await postVerdict(server, core, msgId, 'allow')

    expect(status).toBe(200)
    expect(body).toEqual({ ok: true, reason: 'Bash allow sent to agent-1' })
    expect(verdictsIn(session.frames)).toEqual([
      { t: 'permission_verdict', requestId: 'agent-1-req', behavior: 'allow' },
    ])
    expect(resolutions(core, msgId).map(r => [r.body, r.meta.channel])).toEqual([['allow', 'owner-console']])
    expect(core.registry.isAwaitingApproval(session.conn)).toBe(false)
  })

  it('settles a hook-raised prompt on the hook connection and unblocks the session', async () => {
    const { core, server, wire } = setup()
    const session = wire()
    session.send({ t: 'register', name: 'agent-1', workingOn: 'testing', cwd: '/tmp', pid: 1 })
    const hook = wire()
    const msgId = hookPrompt(hook)
    expect(core.registry.isAwaitingApproval(session.conn)).toBe(true)

    const { body } = await postVerdict(server, core, msgId, 'deny')

    expect(body.ok).toBe(true)
    expect(verdictsIn(hook.frames)).toEqual([{ t: 'permission_verdict', requestId: msgId, behavior: 'deny' }])
    expect(verdictsIn(session.frames)).toHaveLength(0)
    expect(resolutions(core, msgId).map(r => [r.body, r.meta.channel])).toEqual([['deny', 'owner-console']])
    expect(core.registry.isAwaitingApproval(session.conn)).toBe(false)
  })

  it('refuses a second verdict after an HTTP one and writes one resolution', async () => {
    const { core, server, wire } = setup()
    const session = promptingSession(wire)
    const msgId = openId(core)

    await postVerdict(server, core, msgId, 'allow')
    const second = await postVerdict(server, core, msgId, 'deny')

    expect(second.status).toBe(200)
    expect(second.body.ok).toBe(false)
    expect(second.body.reason).toContain('is not an open permission prompt')
    expect(verdictsIn(session.frames)).toHaveLength(1)
    expect(resolutions(core, msgId)).toHaveLength(1)
  })

  it('refuses an HTTP verdict after the socket answered and writes one resolution', async () => {
    const { core, server, wire } = setup()
    const session = promptingSession(wire)
    const msgId = openId(core)
    const human = wire()

    human.send({ t: 'approve_permission', msgId, behavior: 'allow' })
    const second = await postVerdict(server, core, msgId, 'deny')

    expect(human.frames.at(-1)).toMatchObject({ t: 'answer_result', ok: true })
    expect(second.body.ok).toBe(false)
    expect(second.body.reason).toContain('is not an open permission prompt')
    expect(verdictsIn(session.frames)).toHaveLength(1)
    expect(resolutions(core, msgId).map(r => r.meta.channel)).toEqual([undefined])
  })
})
