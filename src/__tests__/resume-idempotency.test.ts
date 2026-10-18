import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { SocketServer } from '../broker/socket.js'
import { transcriptPath } from '../agents/transcript.js'
import type { ServerMessage } from '../protocol.js'
import { autoAttach } from './broker-harness.js'

/**
 * CC-1454: a resume retried with the same nonce joins the first while it is
 * launching and replays its outcome after, so the agent is launched once. A
 * retry without the key still meets CC-1456's in-flight refusal.
 */

type Launch = (...args: unknown[]) => Promise<unknown>
type SpawnResult = Extract<ServerMessage, { t: 'spawn_result' }>
interface SupervisorInternals {
  launchOn: Launch
  recordExit: (id: string, o: unknown) => Promise<void>
}

const NONCE = 'r'.repeat(32)
const tmpDirs: string[] = []
let core: BrokerCore
let server: SocketServer
let stopAutoAttach: () => void

const tmp = (prefix: string): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  tmpDirs.push(dir)
  return dir
}

const internals = (): SupervisorInternals =>
  (server as unknown as { supervisor: SupervisorInternals }).supervisor

function connection(): { conn: Conn; replies: ServerMessage[] } {
  const replies: ServerMessage[] = []
  const write = (chunk: string) => {
    for (const line of chunk.split('\n').filter(Boolean)) replies.push(JSON.parse(line) as ServerMessage)
    return true
  }
  return { conn: { write, end: () => undefined } as unknown as Conn, replies }
}

const spawnResults = (replies: ServerMessage[]): SpawnResult[] =>
  replies.filter((r): r is SpawnResult => r.t === 'spawn_result')

/** A headless seat-x the human spawned, now exited with its transcript on disk. */
async function exitedSeat(): Promise<string> {
  const { conn, replies } = connection()
  const cwd = tmp('resume-idem-cwd-')
  server.handleMessage(conn, {
    t: 'spawn',
    name: 'seat-x',
    profile: 'explorer',
    brief: 'work',
    cwd,
    isolation: 'none',
    surface: 'headless',
  })
  const [spawned] = await vi.waitFor(() => {
    const found = spawnResults(replies)
    if (found.length === 0) throw new Error('no spawn_result yet')
    return found
  })
  const agentId = spawned!.agentId as string
  await recordExit(agentId)
  const agent = core.agents.get(agentId)!
  const file = transcriptPath(agent.cwd, agent.sessionId, agent.configDir)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '{}\n')
  return agentId
}

const recordExit = (agentId: string): Promise<void> =>
  internals().recordExit(agentId, { code: 0, signal: null })

/** Holds launches until `open`; later launches pass straight through. */
function slowLauncher(): { launches: () => number; open: () => void } {
  const target = internals()
  const real = target.launchOn.bind(target)
  let count = 0
  let release: () => void = () => undefined
  let gate = new Promise<void>(resolve => (release = resolve))
  target.launchOn = async (...args) => {
    count += 1
    await gate
    gate = Promise.resolve()
    return real(...args)
  }
  return { launches: () => count, open: () => release() }
}

function resume(nonce?: string): ServerMessage[] {
  const { conn, replies } = connection()
  server.handleMessage(conn, { t: 'resume', name: 'seat-x', ...(nonce === undefined ? {} : { nonce }) })
  return replies
}

const answered = async (replies: ServerMessage[]): Promise<SpawnResult> =>
  vi.waitFor(() => {
    const found = spawnResults(replies)[0]
    if (found === undefined) throw new Error('no spawn_result yet')
    return found
  })

beforeEach(() => {
  const home = tmp('resume-idem-home-')
  process.env.AGENT_CHAT_HOME = home
  core = new BrokerCore(() => undefined, {
    events: new EventLog(path.join(home, 'events.db')),
    registry: new Registry<Conn>(),
  })
  stopAutoAttach = autoAttach(core)
  server = new SocketServer(core, {
    surface: {
      platform: 'linux',
      spawn: () => ({ pid: 4242, unref: () => undefined, once: () => undefined }),
    },
  })
})

afterEach(() => {
  stopAutoAttach()
  server.close()
  delete process.env.AGENT_CHAT_HOME
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('a keyed resume retried with the same nonce', () => {
  it('joins the launch in flight and answers both from its one outcome', async () => {
    const agentId = await exitedSeat()
    const launcher = slowLauncher()

    const first = resume(NONCE)
    await vi.waitFor(() => expect(launcher.launches()).toBe(1))
    const retry = resume(NONCE)
    launcher.open()

    expect(await answered(first)).toMatchObject({ ok: true, agentId })
    expect(await answered(retry)).toMatchObject({ ok: true, agentId, deduped: true })
    expect(launcher.launches()).toBe(1)
  })

  it('replays after the resumed run has exited instead of launching again', async () => {
    const agentId = await exitedSeat()
    const launcher = slowLauncher()
    launcher.open()
    expect(await answered(resume(NONCE))).toMatchObject({ ok: true })
    await recordExit(agentId)

    const retry = await answered(resume(NONCE))

    expect(retry).toMatchObject({ ok: true, agentId, deduped: true })
    expect(launcher.launches()).toBe(1)
  })

  it('still refuses a retry under a different nonce as already resuming', async () => {
    await exitedSeat()
    const launcher = slowLauncher()

    const first = resume(NONCE)
    await vi.waitFor(() => expect(launcher.launches()).toBe(1))
    const other = resume('o'.repeat(32))
    launcher.open()

    expect(await answered(other)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/already resuming/),
    })
    expect(await answered(first)).toMatchObject({ ok: true })
    expect(launcher.launches()).toBe(1)
  })
})
