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
 * At the home directory the project settings file is the default account's user
 * file, so a worker spawned there must load no settings file at all. These drive
 * the real socket handler and supervisor, so the check is the one a spawn runs.
 */

const tmpDirs: string[] = []
let realHome: string | undefined
let core: BrokerCore
let server: SocketServer
let stopAutoAttach: () => void

function tmp(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
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
})

afterEach(() => {
  stopAutoAttach()
  server.close()
  if (realHome === undefined) delete process.env.HOME
  else process.env.HOME = realHome
  delete process.env.AGENT_CHAT_HOME
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

/** A session rooted at `cwd`, which is what makes the home directory spawnable at all. */
function sessionAt(cwd: string): { conn: Conn; replies: ServerMessage[] } {
  const replies: ServerMessage[] = []
  const write = (chunk: string) => {
    for (const line of chunk.split('\n').filter(Boolean)) replies.push(JSON.parse(line) as ServerMessage)
    return true
  }
  const conn = { write, end: () => undefined } as unknown as Conn
  server.handleMessage(conn, {
    t: 'register',
    name: 'rooted',
    workingOn: 'spawning',
    cwd,
    pid: 1,
    sessionId: '11111111-1111-4111-8111-111111111111',
  })
  return { conn, replies }
}

async function settingSourcesOfSpawnAt(cwd: string): Promise<string | undefined> {
  const { conn, replies } = sessionAt(cwd)
  server.handleMessage(conn, {
    t: 'spawn',
    name: 'scout',
    profile: 'explorer',
    brief: 'read the log',
    cwd,
    isolation: 'none',
    surface: 'headless',
  })
  const result = await vi.waitFor(() => {
    const found = replies.find(r => r.t === 'spawn_result')
    if (found === undefined) throw new Error('no spawn_result yet')
    return found as Extract<ServerMessage, { t: 'spawn_result' }>
  })
  expect(result.ok).toBe(true)
  const { args } = readLaunchPlan(result.agentId as string)
  const at = args.indexOf('--setting-sources')
  return at === -1 ? undefined : args[at + 1]
}

describe('a worker spawned at the home directory', () => {
  // Mutation caught: leaving the cwd check out of the spawn path, which loads the user file as the project file.
  it('loads no settings file, since the project file there is the user file', async () => {
    expect(await settingSourcesOfSpawnAt(process.env.HOME as string)).toBe('')
  })

  it('loads project and local settings from a workspace under it', async () => {
    const workspace = path.join(process.env.HOME as string, 'projects', 'repo')
    fs.mkdirSync(workspace, { recursive: true })

    expect(await settingSourcesOfSpawnAt(workspace)).toBe('project,local')
  })
})
