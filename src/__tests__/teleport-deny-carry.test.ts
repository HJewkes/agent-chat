import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { Supervisor } from '../agents/supervisor.js'
import type { SeatTeleportDeps } from '../agents/seats/teleport-state.js'
import { autoAttach } from './broker-harness.js'

/** CC-1612: a teleport successor row keeps its profile's deny list, so CC-40 still holds after the hop. */

const COUNTDOWN_MS = 1000
const tmpDirs: string[] = []
let home: string
let core: BrokerCore
let sup: Supervisor
let stopAutoAttach: () => void

const tmp = (prefix: string): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  tmpDirs.push(dir)
  return dir
}

function writeProfile(name: string, disallowedTools: string[], role = 'worker'): void {
  fs.writeFileSync(
    path.join(home, 'profiles', `${name}.json`),
    JSON.stringify({
      role,
      model: 'sonnet',
      allowedTools: ['Read'],
      ...(disallowedTools.length ? { disallowedTools } : {}),
      isolation: 'none',
      surface: 'headless',
    }),
  )
}

const isolatedSeatTeleport = (): SeatTeleportDeps => ({
  autonomyRoot: tmp('deny-seats-'),
  now: () => new Date(),
  shepherd: async () => undefined,
})

function start(): void {
  sup = new Supervisor(core, {
    countdownMs: COUNTDOWN_MS,
    seatTeleport: isolatedSeatTeleport(),
    argvReader: () => 'claude',
    launcherRunning: async () => false,
    cwdLister: async () => [],
    surface: {
      platform: 'darwin',
      spawn: () => ({ pid: 4242, unref: () => undefined, once: () => undefined }),
      runAppleScript: script => Promise.resolve(script.includes('is running') ? 'true' : 'fake-pane-uuid'),
    },
  })
}

const spawnRow = (agentId: string) =>
  core.events.agentEvents().find(row => row.kind === 'agent_spawned' && row.msgId === agentId)

const successorOf = (agentId: string) =>
  core.events.agentEvents().find(row => row.kind === 'agent_spawned' && row.meta.teleport_from === agentId)

async function teleportedGuardedAgent(): Promise<string> {
  const worker = await sup.spawn({
    name: 'worker-t',
    profile: 'guarded',
    brief: 'do the task',
    requestedBy: 'seat-a',
    cwd: tmp('deny-cwd-'),
    surface: 'headless',
    spawnerConfigDir: tmp('deny-account-'),
  })
  const agentId = worker.agentId as string
  const result = await sup.teleport({
    subject: {
      agentId,
      name: 'worker-t',
      cwd: tmp('deny-cwd-'),
      hostPid: 9999,
      host: os.hostname(),
      tags: [],
      subscriptions: [],
    },
    handoff: 'h',
  })
  await vi.advanceTimersByTimeAsync(COUNTDOWN_MS)
  expect(result.ok).toBe(true)
  return successorOf(agentId)?.msgId as string
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(process, 'kill').mockImplementation((_pid: number, signal?: unknown) => {
    if (signal === 0) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
    return true
  })
  home = tmp('deny-home-')
  process.env.AGENT_CHAT_HOME = home
  process.env.AGENT_CHAT_ACTIVE_WORK_ROOT = path.join(home, 'active-work')
  fs.mkdirSync(path.join(home, 'profiles'), { recursive: true })
  writeProfile('guarded', ['Bash'], 'coordinator')
  writeProfile('looser', [])
  const events = new EventLog(path.join(home, 'events.db'))
  core = new BrokerCore(() => undefined, { events, registry: new Registry<Conn>() })
  stopAutoAttach = autoAttach(core)
  start()
})

afterEach(() => {
  stopAutoAttach()
  sup.close()
  vi.restoreAllMocks()
  vi.useRealTimers()
  delete process.env.AGENT_CHAT_HOME
  delete process.env.AGENT_CHAT_ACTIVE_WORK_ROOT
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('deny list across a teleport (CC-1612)', () => {
  it('records the predecessor profile deny list on the successor row', async () => {
    const successorId = await teleportedGuardedAgent()

    const denied = (spawnRow(successorId)?.meta.disallowed_tools ?? '').split(',')

    expect(denied).toContain('Bash')
  })

  it('refuses a teleported agent spawning a peer with a weaker deny list', async () => {
    const successorId = await teleportedGuardedAgent()

    const result = await sup.spawn({
      name: 'child-c',
      profile: 'looser',
      brief: 'do the task',
      requestedBy: 'worker-t',
      parentAgentId: successorId,
      cwd: tmp('deny-cwd-'),
      surface: 'headless',
      spawnerConfigDir: tmp('deny-account-'),
    })

    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/weaker deny list/)
    expect(result.reason).toMatch(/Bash/)
  })
})
