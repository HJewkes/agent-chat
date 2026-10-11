import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import type { Supervisor } from '../agents/supervisor.js'
import { SocketServer } from '../broker/socket.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { readRuntimeState } from '../agents/launch-files.js'
import { transcriptPath } from '../agents/transcript.js'
import type { ClientMessage, ServerMessage } from '../protocol.js'
import { autoAttach } from './broker-harness.js'

/**
 * CC-216. `agent_resume` had no requester check, so a worker could relaunch any
 * stopped agent on a message of its choosing. These drive the real socket
 * handler, so the requester's agent id comes from its own registered connection.
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

function connection(): { conn: Conn; replies: ServerMessage[] } {
  const replies: ServerMessage[] = []
  const write = (chunk: string) => {
    for (const line of chunk.split('\n').filter(Boolean)) replies.push(JSON.parse(line) as ServerMessage)
    return true
  }
  return { conn: { write, end: () => undefined } as unknown as Conn, replies }
}

async function spawnResult(replies: ServerMessage[]) {
  return vi.waitFor(() => {
    const found = replies.find(r => r.t === 'spawn_result')
    if (found === undefined) throw new Error('no spawn_result yet')
    return found as Extract<ServerMessage, { t: 'spawn_result' }>
  })
}

/** A worker agent spawned by the human, the way every CLI spawn arrives. */
async function spawnAsHuman(name: string): Promise<string> {
  const { conn, replies } = connection()
  server.handleMessage(conn, {
    t: 'spawn',
    name,
    profile: 'explorer',
    brief: 'read the log',
    cwd: tmp('agent-chat-ws-'),
    isolation: 'none',
    surface: 'headless',
  })
  const result = await spawnResult(replies)
  expect(result.ok).toBe(true)
  return result.agentId as string
}

/** Ends a spawned agent and leaves the transcript a resume needs to find. */
async function stopWithTranscript(agentId: string): Promise<void> {
  const supervisor = (
    server as unknown as { supervisor: { recordExit: (id: string, o: unknown) => Promise<void> } }
  ).supervisor
  await supervisor.recordExit(agentId, { code: 0, signal: null })
  const agent = core.agents.get(agentId)
  if (!agent) throw new Error(`no identity for ${agentId}`)
  const file = transcriptPath(agent.cwd, agent.sessionId, agent.configDir)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '{}\n')
}

describe('resume asked for over the socket', () => {
  // Mutation caught: dropping requesterAgentId from handleResume lets the worker through.
  it('refuses a registered worker resuming an agent it did not spawn', async () => {
    await spawnAsHuman('scout')
    const diggerId = await spawnAsHuman('digger')
    const { conn, replies } = connection()
    server.handleMessage(conn, {
      t: 'register',
      name: 'digger',
      workingOn: 'digging',
      cwd: tmp('agent-chat-ws-'),
      pid: 1,
      agentId: diggerId,
    })

    server.handleMessage(conn, { t: 'resume', name: 'scout', message: 'do my bidding' })

    const result = await spawnResult(replies)
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(
      /digger is a worker \(profile explorer\) and can resume only agents it spawned/,
    )
  })

  it('leaves the human at the CLI to the ordinary resume checks', async () => {
    await spawnAsHuman('scout')
    const { conn, replies } = connection()

    server.handleMessage(conn, { t: 'resume', name: 'scout' })

    const result = await spawnResult(replies)
    expect(result.reason).not.toMatch(/is a worker/)
    expect(result.reason).toMatch(/already live/)
  })

  it.each([
    ['keeps a watchdog source', 'watchdog', 'watchdog'],
    ['drops any other source', 'owner-approved', undefined],
  ])('%s on the resume it passes to the supervisor (CC-203)', async (_name, sent, passed) => {
    const supervisor = (server as unknown as { supervisor: Pick<Supervisor, 'resume'> }).supervisor
    const resume = vi.spyOn(supervisor, 'resume').mockResolvedValue({ ok: false, reason: 'stubbed' })
    const { conn, replies } = connection()

    server.handleMessage(conn, { t: 'resume', name: 'scout', source: sent } as unknown as ClientMessage)

    await spawnResult(replies)
    expect(resume.mock.calls[0]?.[1]).toMatchObject({ requestedBy: 'human' })
    expect(resume.mock.calls[0]?.[1]?.source).toBe(passed)
  })

  // Mutation caught: dropping the anchor from handleResume or relaunchResumed opens a new window instead.
  it('places a visible resume beside the pane of the connection that asked (CC-497)', async () => {
    const scripts: string[] = []
    const runAppleScript = async (script: string): Promise<string> => {
      scripts.push(script)
      return script.includes('is running') ? 'true' : 'RESUMED-PANE'
    }
    server.close()
    server = new SocketServer(core, { surface: { platform: 'darwin', spawn: liveChild, runAppleScript } })
    const agentId = await spawnAsHuman('scout')
    await stopWithTranscript(agentId)
    const { conn, replies } = connection()
    server.handleMessage(conn, {
      t: 'register',
      name: 'owner-session',
      workingOn: 'resuming',
      cwd: tmp('agent-chat-ws-'),
      pid: 1,
      termSessionId: 'w0t0p0:ANCHOR-PANE',
    })

    server.handleMessage(conn, { t: 'resume', name: 'scout', surface: 'iterm-pane' })

    const result = await spawnResult(replies)
    expect(result.ok).toBe(true)
    expect(scripts[scripts.length - 1]).toContain('is "ANCHOR-PANE"')
    expect(readRuntimeState(agentId)?.anchor).toBe('w0t0p0:ANCHOR-PANE')
  })
})
