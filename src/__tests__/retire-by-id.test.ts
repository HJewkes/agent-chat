import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type net from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { Supervisor } from '../agents/supervisor.js'
import { transcriptPath } from '../agents/transcript.js'
import { autoAttach } from './broker-harness.js'

/**
 * CC-408: a teleport successor keeps its predecessor's name and spawner, so a
 * bulk retire that resolved its plan by name reaped the live seat for a stale row.
 */

const tmpDirs: string[] = []
let core: BrokerCore
let sup: Supervisor
let stopAutoAttach: () => void
let signals: number[]

const tmp = (prefix: string): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  tmpDirs.push(dir)
  return dir
}

/** Each row a second after the last, so spawn order is newest-first as on a real roster. */
const tick = (): void => void vi.setSystemTime(Date.now() + 1_000)

function spawnRow(id: string, name: string, spawner: string, meta: Record<string, string> = {}): void {
  tick()
  core.append({ kind: 'agent_spawned', actor: spawner, target: name, msgId: id, body: 'work', meta })
}

/** Waits for the stand-in attach first, so it cannot land after the exit and revive the row. */
async function exitRow(id: string, name: string): Promise<void> {
  await vi.waitFor(() => expect(stateOf(id)).toBe('live'))
  tick()
  core.append({ kind: 'agent_exited', actor: name, ref: id, meta: { code: '0' } })
}

/** The live process for `name`, bound to the agent id it registered with. */
function connect(name: string, agentId: string): void {
  const conn = {} as unknown as net.Socket as Conn
  core.registry.register(conn, { name, workingOn: 'work', cwd: '/tmp', pid: 1, hostPid: 4242, agentId })
}

const stateOf = (agentId: string): string | undefined =>
  core.agents.roster({ includeRetired: true }).find(a => a.agentId === agentId)?.state

/** A stale generation of seat-x that exited, and its live teleport successor under the same name. */
async function staleAndSuccessor(): Promise<void> {
  spawnRow('stale', 'seat-x', 'seat-x')
  await exitRow('stale', 'seat-x')
  spawnRow('succ', 'seat-x', 'seat-x', { teleport_from: 'stale' })
  await vi.waitFor(() => expect(stateOf('succ')).toBe('live'))
  connect('seat-x', 'succ')
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const home = tmp('by-id-home-')
  process.env.AGENT_CHAT_HOME = home
  const events = new EventLog(path.join(home, 'events.db'))
  core = new BrokerCore(() => undefined, { events, registry: new Registry<Conn>() })
  stopAutoAttach = autoAttach(core)
  sup = new Supervisor(core, {
    surface: {
      platform: 'linux',
      spawn: () => ({ pid: 4242, unref: () => undefined, once: () => undefined }),
    },
  })
  signals = []
  vi.spyOn(process, 'kill').mockImplementation(pid => {
    signals.push(pid)
    return true
  })
})

afterEach(() => {
  stopAutoAttach()
  sup.close()
  vi.useRealTimers()
  vi.restoreAllMocks()
  delete process.env.AGENT_CHAT_HOME
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('bulk retire with a stale row and a live successor under one name', () => {
  // Fails on main: retire(name) resolved to the live successor and signalled its host pid.
  it('retires only the stale record and leaves the live process untouched', async () => {
    await staleAndSuccessor()

    const out = await sup.retireFinished({ prefix: 'seat-' })

    expect(out.results).toEqual([
      { name: 'seat-x', ok: true, reason: expect.stringMatching(/another agent/) },
    ])
    expect([stateOf('stale'), stateOf('succ')]).toEqual(['retired', 'live'])
    expect(signals).toEqual([])
    const retired = core.events.agentEvents().filter(r => r.kind === 'agent_retired')
    expect(retired.map(r => [r.ref, r.meta.reaped])).toEqual([['stale', 'another_agent']])
  })

  // Fails on main: plan entries carried only the name.
  it('flags both rows as duplicates on the dry run, each with its agent id', async () => {
    await staleAndSuccessor()

    const out = await sup.retireFinished({ prefix: 'seat-', dryRun: true })

    expect(out.plan).toEqual([
      { name: 'seat-x', agentId: 'succ', duplicate: true, action: 'skip', reason: 'live' },
      { name: 'seat-x', agentId: 'stale', duplicate: true, action: 'retire' },
    ])
  })

  // Fails on main: an exited row was planned for retire while its own process was still connected.
  it('skips an exited row whose own process is still connected', async () => {
    spawnRow('w1', 'worker-1', 'coord-x')
    await exitRow('w1', 'worker-1')
    connect('worker-1', 'w1')

    const out = await sup.retireFinished({ prefix: 'worker-', dryRun: true })

    expect(out.plan).toEqual([
      { name: 'worker-1', action: 'skip', reason: 'exited, but its process is still connected' },
    ])
  })
})

describe('the caller', () => {
  // Fails on main: --spawner <seat> matched the seat's own older rows and planned them for retire.
  it('excludes rows under the spawner name, and retires what it spawned', async () => {
    spawnRow('old-seat', 'seat-x', 'seat-x')
    await exitRow('old-seat', 'seat-x')
    spawnRow('w1', 'worker-1', 'seat-x')
    await exitRow('w1', 'worker-1')

    const out = await sup.retireFinished({ spawner: 'seat-x' })

    expect(out.plan).toEqual([
      { name: 'worker-1', action: 'retire' },
      { name: 'seat-x', action: 'skip', reason: 'seat-x is the caller itself, not an agent it spawned' },
    ])
    expect([stateOf('w1'), stateOf('old-seat')]).toEqual(['retired', 'exited'])
  })

  it('excludes the registered caller under a prefix scope', async () => {
    spawnRow('old-seat', 'seat-x', 'seat-x')
    await exitRow('old-seat', 'seat-x')

    const out = await sup.retireFinished({ prefix: 'seat-', caller: 'seat-x', dryRun: true })

    expect(out.plan).toEqual([
      { name: 'seat-x', action: 'skip', reason: 'seat-x is the caller itself, not an agent it spawned' },
    ])
  })
})

describe('the watchdog resume', () => {
  // Fails on main: with the newest generation retired, byName fell back to the stale session and resumed it.
  it('refuses a stale session once a newer one under the name was retired', async () => {
    const cwd = tmp('by-id-cwd-')
    const configDir = tmp('by-id-account-')
    const meta = { cwd, profile: 'explorer', isolation: 'none', surface: 'headless', config_dir: configDir }
    spawnRow('stale', 'seat-x', 'seat-x', { ...meta, session_id: 'sess-old' })
    await exitRow('stale', 'seat-x')
    const file = transcriptPath(cwd, 'sess-old', configDir)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '{}\n')
    spawnRow('succ', 'seat-x', 'seat-x', { ...meta, session_id: 'sess-new', teleport_from: 'stale' })
    await exitRow('succ', 'seat-x')
    expect((await sup.retire('seat-x')).ok).toBe(true)

    const res = await sup.resume('seat-x', { message: 'Watchdog: wake', source: 'watchdog' })

    expect(res.ok).toBe(false)
    expect(res.reason).toMatch(
      /sess-old is stale: a newer seat-x \(agent succ, session sess-new\) is retired/,
    )
    expect(core.events.agentEvents().filter(r => r.kind === 'agent_resumed')).toEqual([])
  })
})
