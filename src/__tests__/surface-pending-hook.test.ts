import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { SocketServer } from '../broker/socket.js'
import type { Supervisor, SupervisorOptions } from '../agents/supervisor.js'
import type { ClientMessage, ServerMessage } from '../protocol.js'
import { autoAttach } from './broker-harness.js'

/**
 * CC-1505. `agent_surface` on a headless agent blocked on a hook prompt took the
 * broker down: on a Linux host the switch stopped the agent, the hook withdrew as
 * it died, and then the iTerm launch threw out of a handler nothing awaited.
 * Driven through the real socket handler; `process.kill` is faked, and a SIGTERM
 * to the agent's pid plays its death: its session and its hook both go away.
 */

const AGENT_PID = 4242
const tmpDirs: string[] = []
let realHome: string | undefined
let core: BrokerCore
let server: SocketServer
let stopAutoAttach: () => void
let killed: Array<{ pid: number; signal: string }>

interface Wire {
  frames: ServerMessage[]
  send: (msg: ClientMessage) => void
  close: () => void
}

function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

function wire(): Wire {
  const frames: ServerMessage[] = []
  const emitter = new EventEmitter()
  const conn = Object.assign(emitter, {
    write: (chunk: string) => {
      for (const line of chunk.split('\n').filter(Boolean)) frames.push(JSON.parse(line) as ServerMessage)
      return true
    },
    end: () => undefined,
  }) as unknown as Conn
  server.onConnection(conn)
  return {
    frames,
    send: msg => emitter.emit('data', JSON.stringify(msg) + '\n'),
    close: () => emitter.emit('close'),
  }
}

async function reply<T extends ServerMessage['t']>(frames: ServerMessage[], t: T) {
  return vi.waitFor(
    () => {
      const found = frames.find(f => f.t === t)
      if (found === undefined) throw new Error(`no ${t} yet`)
      return found as Extract<ServerMessage, { t: T }>
    },
    { timeout: 4000 },
  )
}

function startServer(surface: SupervisorOptions['surface']): void {
  const bus = tmp('agent-chat-bus-')
  process.env.AGENT_CHAT_HOME = bus
  core = new BrokerCore(() => undefined, {
    events: new EventLog(path.join(bus, 'events.db')),
    registry: new Registry<Conn>(),
  })
  stopAutoAttach = autoAttach(core)
  server = new SocketServer(core, { surface })
}

/** A headless scout, registered, with a hook prompt pending that dies with it on SIGTERM. */
async function scoutAwaitingApproval(): Promise<string> {
  const human = wire()
  human.send({
    t: 'spawn',
    name: 'scout',
    profile: 'explorer',
    brief: 'b',
    cwd: tmp('ws-'),
    isolation: 'none',
    surface: 'headless',
  })
  const agentId = (await reply(human.frames, 'spawn_result')).agentId as string
  const session = wire()
  session.send({ t: 'register', name: 'scout', workingOn: 'w', cwd: tmp('ws-'), pid: 1, agentId })
  const hook = wire()
  hook.send({
    t: 'permission_hook',
    session: 'scout',
    toolName: 'WebSearch',
    toolInput: {},
    description: 'search',
  })
  const msgId = (await reply(hook.frames, 'permission_hook_result')).msgId as string
  vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: string | number) => {
    killed.push({ pid, signal: String(signal) })
    if (pid === AGENT_PID && signal === 'SIGTERM') {
      session.close()
      hook.send({ t: 'permission_hook_withdrawn', msgId })
    }
    return true
  })
  return msgId
}

const surface = async (): Promise<Extract<ServerMessage, { t: 'switch_result' }>> => {
  const human = wire()
  human.send({ t: 'surface', name: 'scout' })
  return reply(human.frames, 'switch_result')
}

const liveChild = () => ({ pid: AGENT_PID, unref: () => undefined, once: () => undefined })

beforeEach(() => {
  killed = []
  realHome = process.env.HOME
  process.env.HOME = tmp('agent-chat-home-')
})

afterEach(() => {
  vi.restoreAllMocks()
  stopAutoAttach()
  server.close()
  if (realHome === undefined) delete process.env.HOME
  else process.env.HOME = realHome
  delete process.env.AGENT_CHAT_HOME
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('surfacing a headless agent with a hook prompt pending', () => {
  it('refuses on a host with no iTerm, before stopping the agent', async () => {
    startServer({ platform: 'linux', spawn: liveChild })
    const msgId = await scoutAwaitingApproval()

    const result = await surface()

    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/iTerm2 surfaces need macOS/) })
    expect(killed).toEqual([])
    expect(core.events.openApproval(msgId)).toMatchObject({ source: 'hook', session: 'scout' })
  })

  it('answers a launch that throws after the stop, and closes the resume it never started', async () => {
    const itermDown = () => Promise.resolve('false')
    startServer({ platform: 'darwin', spawn: liveChild, runAppleScript: itermDown })
    const msgId = await scoutAwaitingApproval()

    const result = await surface()

    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/did not relaunch: iTerm2 is not running/),
    })
    expect(killed).toContainEqual({ pid: AGENT_PID, signal: 'SIGTERM' })
    expect(core.events.openApproval(msgId)).toBeUndefined()
    const exits = core.events.agentEvents().filter(r => r.kind === 'agent_exited')
    expect(exits.at(-1)?.meta).toMatchObject({ never_started: 'true' })
  })

  it('answers the caller when the switch itself throws, instead of leaving the rejection unhandled', async () => {
    startServer({ platform: 'darwin', spawn: liveChild })
    const supervisor = (server as unknown as { supervisor: Pick<Supervisor, 'switchSurface'> }).supervisor
    vi.spyOn(supervisor, 'switchSurface').mockRejectedValue(new Error('launch exploded'))

    const result = await surface()

    expect(result).toEqual({ t: 'switch_result', ok: false, reason: 'switch failed: launch exploded' })
  })
})
