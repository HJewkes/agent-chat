import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { SocketServer } from '../broker/socket.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import type { ClientMessage } from '../protocol.js'
import { Supervisor, type SpawnRequest } from '../agents/supervisor.js'

/**
 * CC-178: resolveSpawnCwd is unit-tested alone, so nothing failed when handleSpawn stopped
 * calling it. These drive the real handler with the supervisor's spawn stubbed out.
 */

let home: string
let server: SocketServer | undefined

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-spawn-cwd-'))
  process.env.AGENT_CHAT_HOME = home
})

afterEach(() => {
  server?.close()
  vi.restoreAllMocks()
  delete process.env.AGENT_CHAT_HOME
  fs.rmSync(home, { recursive: true, force: true })
})

async function spawnedRequest(frame: {
  name?: string
  cwd?: string
  worktree?: string
  tier?: unknown
  spawnedAs?: unknown
}): Promise<SpawnRequest> {
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
  const conn = { write: () => undefined } as unknown as Conn
  server.handleMessage(conn, {
    t: 'spawn',
    name: 'w',
    profile: 'implementer',
    brief: 'b',
    ...frame,
  } as ClientMessage)
  await vi.waitFor(() => expect(seen).toHaveLength(1))
  return seen[0] as SpawnRequest
}

describe('handleSpawn cwd', () => {
  // Mutation caught: handleSpawn passes the spawner's cwd (or nothing) and ignores msg.worktree.
  it('hands the supervisor the adopted worktree as cwd when no cwd is given', async () => {
    const request = await spawnedRequest({ worktree: '/tmp/cc178-worktree' })

    expect(request.cwd).toBe('/tmp/cc178-worktree')
  })

  it('lets an explicit cwd win over the worktree', async () => {
    const request = await spawnedRequest({ cwd: '/tmp/cc178-explicit', worktree: '/tmp/cc178-worktree' })

    expect(request.cwd).toBe('/tmp/cc178-explicit')
  })
})

/** CC-774: the tick's planned tier reaches the supervisor, and only as an integer. */
describe('handleSpawn tier', () => {
  it('hands the supervisor the integer tier the frame carries', async () => {
    const request = await spawnedRequest({ tier: 2 })

    expect(request.tier).toBe(2)
  })

  it.each([undefined, 1.5, '2'])('leaves tier off the request for %s', async tier => {
    const request = await spawnedRequest({ tier })

    expect(request).not.toHaveProperty('tier')
  })
})

/** CC-802: a CLI spawn names the automation it runs for, so the dispatch row does not record the human. */
describe('handleSpawn spawnedAs', () => {
  it('hands the supervisor the marker an unregistered caller sends', async () => {
    const request = await spawnedRequest({ spawnedAs: 'burndown' })

    expect(request.spawnedAs).toBe('burndown')
  })

  it('reads a Shepherd fix-round name as shepherd when no marker is sent', async () => {
    const request = await spawnedRequest({ name: 'tc-cc-778-compare-tiers-s2-s1-s1' })

    expect(request.spawnedAs).toBe('shepherd')
  })

  it('leaves a hand-named spawn without a marker', async () => {
    const request = await spawnedRequest({})

    expect(request).not.toHaveProperty('spawnedAs')
  })
})

/** CC-445: the broker's spawn_result carries the supervisor's refusal code and retryable flag. */
describe('handleSpawn refusal reply', () => {
  it('forwards code and retryable from the supervisor outcome', async () => {
    vi.spyOn(Supervisor.prototype, 'spawn').mockResolvedValue({
      ok: false,
      reason: 'machine guard: memory 8% free',
      code: 'machine_memory_floor',
      retryable: true,
    })
    const core = new BrokerCore(() => undefined, {
      events: new EventLog(path.join(home, 'events.db')),
      registry: new Registry<Conn>(),
    })
    server = new SocketServer(core)
    const frames: unknown[] = []
    const conn = { write: (line: string) => frames.push(JSON.parse(line)) } as unknown as Conn

    server.handleMessage(conn, { t: 'spawn', name: 'w', profile: 'implementer', brief: 'b' })

    await vi.waitFor(() =>
      expect(frames).toContainEqual(
        expect.objectContaining({
          t: 'spawn_result',
          ok: false,
          code: 'machine_memory_floor',
          retryable: true,
        }),
      ),
    )
  })
})
