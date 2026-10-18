import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { SocketServer } from '../broker/socket.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { BrokerClient } from '../client/broker-client.js'
import type { ClientMessage, ServerMessage } from '../protocol.js'
import { agentList } from '../server/commands/agent-list.js'

/**
 * CC-1464: agent_list over a roster of mostly exited agents. The broker cuts the
 * roster to live, spawning and detached rows before sending it, and the reply
 * counts what it dropped, so the footer is right without the full transfer.
 */

let dir: string
let core: BrokerCore
let server: net.Server | undefined
let client: BrokerClient | undefined
const previousHome = process.env['AGENT_CHAT_HOME']

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac1464-'))
  process.env['AGENT_CHAT_HOME'] = dir
  core = new BrokerCore(() => undefined, {
    events: new EventLog(path.join(dir, 'events.db')),
    registry: new Registry<Conn>(),
  })
  const socketServer = new SocketServer(core)
  const listener = net.createServer(conn => socketServer.onConnection(conn))
  server = listener
  await new Promise<void>(resolve => listener.listen(path.join(dir, 'chat.sock'), resolve))
  client = new BrokerClient(() => undefined, undefined, undefined, undefined, undefined, { autoStart: false })
  await client.connect()
})

afterEach(async () => {
  client?.close()
  client = undefined
  const listener = server
  server = undefined
  if (listener) await new Promise<void>(resolve => listener.close(() => resolve()))
  if (previousHome === undefined) delete process.env['AGENT_CHAT_HOME']
  else process.env['AGENT_CHAT_HOME'] = previousHome
  fs.rmSync(dir, { recursive: true, force: true })
})

type Fate = 'live' | 'exited' | 'retired'

function seed(name: string, fate: Fate, spawnedBy = 'scout'): void {
  const agentId = core.append({
    kind: 'agent_spawned',
    actor: spawnedBy,
    target: name,
    meta: { origin: 'adopted', name, cwd: '/tmp/cc1464', session_id: `session-${name}`, depth: '0' },
  }).msgId
  core.append({ kind: 'agent_attached', actor: name, ref: agentId })
  if (fate !== 'live') core.append({ kind: 'agent_exited', actor: name, ref: agentId, meta: { code: '0' } })
  if (fate === 'retired') core.append({ kind: 'agent_retired', actor: 'human', ref: agentId })
}

function seedMany(count: number, fate: Fate, stem: string): void {
  for (let i = 0; i < count; i += 1) seed(`${stem}-${i}`, fate)
}

const run = (args: Parameters<typeof agentList.run>[0], broker: unknown = client): Promise<string> =>
  agentList.run(args, { registeredName: 'scout', broker } as never)

const agents = async (frame: ClientMessage) =>
  (await client!.request(frame, 'agents_result')) as Extract<ServerMessage, { t: 'agents_result' }>

const rowNames = (out: string): string[] =>
  out
    .split('\n')
    .filter(line => line.startsWith('- '))
    .map(line => line.slice(2).split(' ')[0] ?? '')

describe('agent_list against a roster of mostly finished agents', () => {
  it('shows the 3 live agents of 503 and counts the 500 exited in the footer', async () => {
    seedMany(500, 'exited', 'agent-x')
    seedMany(3, 'live', 'seat-x')

    const out = await run({})

    expect(rowNames(out).sort()).toEqual(['seat-x-0', 'seat-x-1', 'seat-x-2'])
    expect(out.split('\n').at(-1)).toBe('500 finished, 0 retired not shown')
  })

  it('cuts the roster in the broker, not after the transfer', async () => {
    seedMany(500, 'exited', 'agent-x')
    seedMany(3, 'live', 'seat-x')
    seed('agent-gone', 'retired')

    const res = await agents({ t: 'agents', view: { limit: 50 } })

    expect(res.agents).toHaveLength(3)
    expect(res.hidden).toEqual({ finished: 500, retired: 1, overLimit: 0 })
  })

  it('keeps answering a frame with no view with every unretired agent', async () => {
    seedMany(5, 'exited', 'agent-x')
    seedMany(3, 'live', 'seat-x')
    seed('agent-gone', 'retired')

    const res = await agents({ t: 'agents' })

    expect(res.agents).toHaveLength(8)
    expect('hidden' in res).toBe(false)
  })

  it('lists exited agents with include_finished, newest first, up to the limit', async () => {
    let clock = Date.now()
    const now = vi.spyOn(Date, 'now').mockImplementation(() => (clock += 1000))
    seedMany(5, 'exited', 'agent-x')
    seed('seat-x', 'live')
    now.mockRestore()

    const out = await run({ include_finished: true, limit: 3 })

    expect(rowNames(out)).toEqual(['seat-x', 'agent-x-4', 'agent-x-3'])
    expect(out.split('\n').at(-1)).toBe('0 finished, 0 retired not shown; 3 more past limit 3')
  })

  it('combines prefix, mine and include_retired with the state filter', async () => {
    seedMany(4, 'exited', 'agent-x')
    seed('seat-x-a', 'live')
    seed('seat-x-b', 'live', 'someone-else')
    seed('seat-x-c', 'retired')

    const out = await run({ prefix: 'seat-x', mine: true, include_retired: true })

    expect(rowNames(out).sort()).toEqual(['seat-x-a', 'seat-x-c'])
    expect(out.split('\n').at(-1)).toBe('0 finished, 0 retired not shown')
  })

  it('says no agents and still counts the finished ones', async () => {
    seedMany(2, 'exited', 'agent-x')

    expect(await run({})).toBe('No agents.\n2 finished, 0 retired not shown')
  })

  it('shows the same page against an older broker that ignores the view', async () => {
    seedMany(500, 'exited', 'agent-x')
    seedMany(3, 'live', 'seat-x')
    seed('agent-gone', 'retired')
    const oldBroker = {
      request: async (frame: ClientMessage, reply: ServerMessage['t']) => {
        if (frame.t !== 'agents') return client!.request(frame, reply as never)
        return {
          t: 'agents_result',
          agents: core.agents.roster({ includeRetired: frame.includeRetired ?? false }),
        }
      },
    }

    const out = await run({}, oldBroker)

    expect(rowNames(out).sort()).toEqual(['seat-x-0', 'seat-x-1', 'seat-x-2'])
    expect(out.split('\n').at(-1)).toBe('500 finished, 1 retired not shown')
  })
})
