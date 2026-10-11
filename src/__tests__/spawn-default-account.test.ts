import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { SocketServer } from '../broker/socket.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { readLaunchPlan } from '../agents/launch-files.js'
import type { ServerMessage } from '../protocol.js'
import { autoAttach } from './broker-harness.js'

/**
 * CC-156. Seven agents spawned from the human's default-account session, which has no
 * `CLAUDE_CONFIG_DIR`, ran on the briefing initiative's profile account instead. These
 * drive the real socket handler and supervisor, so the registry's evidence that the
 * spawner is a Claude session is what decides the account.
 */

const tmpDirs: string[] = []
let realHome: string | undefined
let core: BrokerCore
let server: SocketServer
let stopAutoAttach: () => void

function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

const liveChild = () => ({ pid: 4242, unref: () => undefined, once: () => undefined })

beforeEach(() => {
  realHome = process.env.HOME
  process.env.HOME = tmp('agent-chat-home-')
  const bus = tmp('agent-chat-bus-')
  process.env.AGENT_CHAT_HOME = bus
  delete process.env.CLAUDE_CONFIG_DIR
  core = new BrokerCore(() => undefined, {
    events: new EventLog(path.join(bus, 'events.db')),
    registry: new Registry<Conn>(),
  })
  stopAutoAttach = autoAttach(core)
  server = new SocketServer(core, { surface: { platform: 'linux', spawn: liveChild } })
  initiativeWithProfile('widgets', 'agents')
})

afterEach(() => {
  stopAutoAttach()
  server.close()
  if (realHome === undefined) delete process.env.HOME
  else process.env.HOME = realHome
  delete process.env.AGENT_CHAT_HOME
  delete process.env.AGENT_CHAT_ACTIVE_WORK_ROOT
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

/** An initiative whose brief names `profile`, with that profile's dir present so it would be used. */
function initiativeWithProfile(slug: string, profile: string): void {
  const root = tmp('agent-chat-aw-')
  fs.mkdirSync(path.join(root, slug), { recursive: true })
  fs.writeFileSync(
    path.join(root, slug, 'brief.md'),
    `---\ntitle: Widgets\nprofile: ${profile}\n---\n# Widgets\n\nWhy: to prove it.\n`,
  )
  process.env.AGENT_CHAT_ACTIVE_WORK_ROOT = root
  fs.mkdirSync(path.join(process.env.HOME as string, '.claude-profiles', profile), { recursive: true })
}

function connection(): { conn: Conn; replies: ServerMessage[] } {
  const replies: ServerMessage[] = []
  const write = (chunk: string) => {
    for (const line of chunk.split('\n').filter(Boolean)) replies.push(JSON.parse(line) as ServerMessage)
    return true
  }
  return { conn: { write, end: () => undefined } as unknown as Conn, replies }
}

async function spawnFrom(conn: Conn, replies: ServerMessage[], configDir?: string): Promise<string> {
  server.handleMessage(conn, {
    t: 'spawn',
    ...(configDir === undefined ? {} : { configDir }),
    name: 'scout',
    profile: 'explorer',
    brief: 'read the log',
    cwd: tmp('agent-chat-ws-'),
    isolation: 'none',
    surface: 'headless',
    briefing: 'widgets',
  })
  const result = await vi.waitFor(() => {
    const found = replies.find(r => r.t === 'spawn_result')
    if (found === undefined) throw new Error('no spawn_result yet')
    return found as Extract<ServerMessage, { t: 'spawn_result' }>
  })
  expect(result.ok).toBe(true)
  return result.agentId as string
}

function registerSession(conn: Conn): void {
  server.handleMessage(conn, {
    t: 'register',
    name: 'human-default',
    workingOn: 'spawning',
    cwd: tmp('agent-chat-ws-'),
    pid: 1,
    sessionId: '11111111-1111-4111-8111-111111111111',
  })
}

describe('a spawn from a Claude session with no CLAUDE_CONFIG_DIR', () => {
  // Mutation caught: dropping the spawnerIsSession step in resolveConfigDir runs this child on `agents`.
  it('runs the child with CLAUDE_CONFIG_DIR unset, not on the briefing profile', async () => {
    const { conn, replies } = connection()
    registerSession(conn)

    const agentId = await spawnFrom(conn, replies)

    const plan = readLaunchPlan(agentId)
    expect('CLAUDE_CONFIG_DIR' in plan.env).toBe(false)
    expect(plan.unsetEnv).toContain('CLAUDE_CONFIG_DIR')
    expect(core.agents.get(agentId)?.configDir).toBe(path.join(process.env.HOME as string, '.claude'))
    expect(core.agents.get(agentId)?.configDirUnset).toBe(true)
  })

  it('still runs on an explicit config_dir, set rather than unset', async () => {
    const { conn, replies } = connection()
    registerSession(conn)
    const explicit = path.join(process.env.HOME as string, '.claude-profiles', 'agents')

    const agentId = await spawnFrom(conn, replies, explicit)

    const plan = readLaunchPlan(agentId)
    expect(plan.env.CLAUDE_CONFIG_DIR).toBe(explicit)
    expect(plan.unsetEnv).not.toContain('CLAUDE_CONFIG_DIR')
    expect(core.agents.get(agentId)?.configDirUnset).toBeUndefined()
  })
})

describe('a spawn from an unknown caller with no CLAUDE_CONFIG_DIR', () => {
  it('still falls through to the briefing profile', async () => {
    const { conn, replies } = connection()

    const agentId = await spawnFrom(conn, replies)

    const plan = readLaunchPlan(agentId)
    expect(plan.env.CLAUDE_CONFIG_DIR).toBe(
      path.join(process.env.HOME as string, '.claude-profiles', 'agents'),
    )
    expect(plan.unsetEnv).not.toContain('CLAUDE_CONFIG_DIR')
  })
})
