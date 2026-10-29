import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { SocketServer } from '../broker/socket.js'
import { Supervisor, type SpawnRequest } from '../agents/supervisor.js'
import type { ClientMessage } from '../protocol.js'
import { startSupervisor, type RestartHarness } from './helpers/restart-harness.js'

/** CC-1666 S4a: `slice` and `route_override` ride every spawn surface to the spawn row; nothing routes on them yet. */

const sent: ClientMessage[] = []

vi.mock('../cli/client.js', async importOriginal => ({
  ...(await importOriginal<object>()),
  withBroker: async (fn: (b: unknown) => Promise<unknown>) =>
    fn({
      request: async (frame: ClientMessage) => {
        sent.push(frame)
        return { t: 'spawn_result', ok: true, name: 'impl', agentId: 'a1' }
      },
    }),
  fail: (reason: string): never => {
    throw new Error(reason)
  },
}))

const { buildProgram } = await import('../cli/index.js')

async function cli(...argv: string[]): Promise<ClientMessage | undefined> {
  const program = buildProgram()
  program.exitOverride().configureOutput({ writeErr: () => undefined, writeOut: () => undefined })
  const agent = program.commands.find(c => c.name() === 'agent')
  agent?.commands.forEach(c => c.exitOverride().configureOutput({ writeErr: () => undefined }))
  await program.parseAsync(['agent', ...argv], { from: 'user' }).catch(() => undefined)
  return sent.find(f => f.t === 'spawn')
}

describe('agent spawn --slice and --route-override', () => {
  beforeEach(() => {
    sent.length = 0
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })
  afterEach(() => vi.restoreAllMocks())

  it('puts both on the spawn frame', async () => {
    const frame = await cli(
      'spawn',
      'impl',
      'implementer',
      'do it',
      '--task',
      'AB-1',
      '--slice',
      'b',
      '--route-override',
      'touches auth',
    )

    expect(frame).toMatchObject({ t: 'spawn', task: 'AB-1', slice: 'b', routeOverride: 'touches auth' })
  })

  it('leaves both off a frame that names neither', async () => {
    const frame = await cli('spawn', 'impl', 'implementer', 'do it')

    expect(frame).not.toHaveProperty('slice')
    expect(frame).not.toHaveProperty('routeOverride')
  })
})

describe('the broker reading slice and routeOverride', () => {
  let home: string
  let server: SocketServer | undefined

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-route-fields-'))
    process.env.AGENT_CHAT_HOME = home
  })
  afterEach(() => {
    server?.close()
    vi.restoreAllMocks()
    delete process.env.AGENT_CHAT_HOME
    fs.rmSync(home, { recursive: true, force: true })
  })

  async function requestOf(fields: Record<string, unknown>): Promise<SpawnRequest> {
    const seen: SpawnRequest[] = []
    vi.spyOn(Supervisor.prototype, 'spawn').mockImplementation(async req => {
      seen.push(req)
      return { ok: false, reason: 'stubbed' }
    })
    const core = new BrokerCore(() => undefined, {
      events: new EventLog(path.join(home, 'events.db')),
      registry: new Registry<Conn>(),
    })
    server = new SocketServer(core)
    const conn = { write: () => true, end: () => undefined } as unknown as Conn
    server.handleMessage(conn, { t: 'spawn', name: 'impl', profile: 'explorer', brief: 'b', ...fields })
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    return seen[0] as SpawnRequest
  }

  // Catches: the socket mapping dropping either field, so the router never sees it.
  it('passes both to the spawn request, trimmed', async () => {
    expect(await requestOf({ slice: ' b ', routeOverride: ' touches auth ' })).toMatchObject({
      slice: 'b',
      routeOverride: 'touches auth',
    })
  })

  it('drops a blank or non-string value', async () => {
    const request = await requestOf({ slice: '   ', routeOverride: 7 })

    expect(request).not.toHaveProperty('slice')
    expect(request).not.toHaveProperty('routeOverride')
  })
})

describe('slice and routeOverride on the spawn row', () => {
  let sup: RestartHarness | undefined
  afterEach(() => {
    sup?.close()
    sup = undefined
  })

  const spawnRow = async (req: Partial<SpawnRequest>) => {
    sup = startSupervisor()
    const { agentId } = await sup.spawnAgent('impl-1', { profile: 'implementer', ...req })
    return sup.core.events.agentEvents().find(r => r.kind === 'agent_spawned' && r.msgId === agentId)
  }

  it('records both beside the task, and keeps the requested profile', async () => {
    const row = await spawnRow({ task: 'AB-1', slice: 'b', routeOverride: 'touches auth' })

    expect(row?.meta).toMatchObject({ task: 'AB-1', slice: 'b', route_override: 'touches auth' })
    expect(row?.meta).toMatchObject({ profile: 'implementer' })
  })

  it('records neither when the request has neither', async () => {
    const row = await spawnRow({ task: 'AB-1' })

    expect(row?.meta).not.toHaveProperty('slice')
    expect(row?.meta).not.toHaveProperty('route_override')
  })
})
