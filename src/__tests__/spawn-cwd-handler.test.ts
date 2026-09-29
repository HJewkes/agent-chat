import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { SocketServer } from '../broker/socket.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
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

async function spawnedRequest(frame: { cwd?: string; worktree?: string }): Promise<SpawnRequest> {
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
  server.handleMessage(conn, { t: 'spawn', name: 'w', profile: 'implementer', brief: 'b', ...frame })
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
