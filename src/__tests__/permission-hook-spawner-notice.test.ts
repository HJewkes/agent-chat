import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type net from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { SocketServer } from '../broker/socket.js'
import { Supervisor } from '../agents/supervisor.js'
import type { ClientMessage, DeliveredMessage } from '../protocol.js'
import { autoAttach } from './broker-harness.js'

/**
 * CC-610 (and CC-256): a headless agent parked on the permission hook used to
 * wait ~30 minutes with nobody told. Its spawner now gets a message at once.
 */

const tmpDirs: string[] = []
let core: BrokerCore
let supervisor: Supervisor
let server: SocketServer
let delivered: { conn: Conn; message: DeliveredMessage }[]
let stopAutoAttach: () => void

const tmp = (prefix: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

const controlledChild = () => ({ pid: 4242, unref: () => undefined, once: () => undefined })

beforeEach(() => {
  process.env.AGENT_CHAT_HOME = tmp('agent-chat-permnotice-')
  delivered = []
  const events = new EventLog(path.join(process.env.AGENT_CHAT_HOME, 'events.db'))
  core = new BrokerCore((conn, message) => delivered.push({ conn, message }), {
    events,
    registry: new Registry<Conn>(),
  })
  stopAutoAttach = autoAttach(core)
  supervisor = new Supervisor(core, { surface: { platform: 'linux', spawn: controlledChild } })
  server = new SocketServer(core)
})

afterEach(() => {
  stopAutoAttach()
  supervisor.close()
  vi.restoreAllMocks()
  delete process.env.AGENT_CHAT_HOME
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function registerCoord(): Conn {
  const coord = {} as unknown as net.Socket
  core.register(coord, { t: 'register', name: 'coord', workingOn: '', cwd: tmp('agent-chat-coord-'), pid: 1 })
  return coord
}

async function spawnScout(requestedBy: string): Promise<void> {
  const result = await supervisor.spawn({
    name: 'scout',
    profile: 'explorer',
    brief: 'do the task',
    requestedBy,
    cwd: tmp('agent-chat-ws-'),
    isolation: 'none',
    surface: 'headless',
    spawnerConfigDir: tmp('agent-chat-account-'),
  })
  expect(result.ok).toBe(true)
  await vi.waitFor(() => expect(core.agents.get(result.agentId as string)?.state).toBe('live'))
}

/** The hook's own unregistered connection, as `agent-chat permission-hook` opens it. */
function raiseHookPrompt(toolInput: Record<string, unknown>): void {
  const emitter = new EventEmitter()
  const conn = Object.assign(emitter, { write: () => true }) as unknown as Conn
  server.onConnection(conn)
  const frame: ClientMessage = { t: 'permission_hook', session: 'scout', toolName: 'Write', toolInput }
  emitter.emit('data', JSON.stringify(frame) + '\n')
}

const notices = () =>
  core.events.history(200).filter(row => row.kind === 'message' && row.meta.event === 'permission-waiting')

describe('a spawned agent parking on the permission hook', () => {
  it('tells its spawner at once, naming the agent, tool and path', async () => {
    const coord = registerCoord()
    await spawnScout('coord')

    raiseHookPrompt({ file_path: '/repo/sources/runbooks/plan.md', content: 'x' })

    const [row] = notices()
    const approval = core.events.humanQueue().find(item => item.kind === 'approval_request')
    expect(row?.from).toBe('agent-chat')
    expect(row?.meta).toMatchObject({
      target: 'coord',
      agent: 'scout',
      tool: 'Write',
      approval_ref: approval?.msgId,
    })
    expect(row?.text).toBe('scout is waiting on a permission prompt: Write /repo/sources/runbooks/plan.md')
    const pushed = delivered.find(d => d.message.event === 'permission-waiting')
    expect(pushed?.conn).toBe(coord)
    expect(pushed?.message.text).toBe(row?.text)
  })

  it('sends one notice per prompt', async () => {
    registerCoord()
    await spawnScout('coord')

    raiseHookPrompt({ file_path: '/a.md' })
    raiseHookPrompt({ file_path: '/b.md' })

    expect(notices().map(row => row.text)).toEqual([
      'scout is waiting on a permission prompt: Write /a.md',
      'scout is waiting on a permission prompt: Write /b.md',
    ])
  })
})

describe('no permission-waiting notice', () => {
  it('goes to a human spawner, who already has the queue', async () => {
    await spawnScout('human')

    raiseHookPrompt({ file_path: '/repo/plan.md' })

    expect(core.events.humanQueue().some(item => item.kind === 'approval_request')).toBe(true)
    expect(notices()).toEqual([])
  })

  it('goes anywhere for a session that is not a spawned agent', () => {
    registerCoord()

    raiseHookPrompt({ file_path: '/repo/plan.md' })

    expect(notices()).toEqual([])
    expect(delivered.some(d => d.message.event === 'permission-waiting')).toBe(false)
  })
})
