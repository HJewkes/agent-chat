import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { HostDirectory, LAUNCH_TIMEOUT_MS, PROBE_TIMEOUT_MS } from '../broker/host-directory.js'
import { Registry } from '../broker/registry.js'
import { SocketServer } from '../broker/socket.js'
import type { ClientMessage, ServerMessage } from '../protocol.js'

/**
 * CC-951 slice g1, over the socket: a host launcher announces its machine, and a teleport to that
 * machine is probed there before anything is written, launched there at the end of the countdown,
 * and ends its local predecessor only once the successor attaches.
 */

const MAC = 'owners-mac.invalid'
const COUNTDOWN_MS = 1000
const PREDECESSOR_PID = 83212

interface Wire {
  conn: EventEmitter
  frames: ServerMessage[]
  send: (msg: ClientMessage) => void
}

let home: string
let core: BrokerCore
let server: SocketServer
let kill: { mock: { calls: unknown[][] } }

beforeEach(() => {
  vi.useFakeTimers()
  kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-hosts-'))
  // A launcher is only handed paths under the home directory, so the test's tree stands in for it.
  vi.spyOn(os, 'homedir').mockReturnValue(path.dirname(home))
  process.env.AGENT_CHAT_HOME = home
  process.env.AGENT_CHAT_ACTIVE_WORK_ROOT = path.join(home, 'active-work')
  core = new BrokerCore(() => undefined, {
    events: new EventLog(path.join(home, 'events.db')),
    registry: new Registry<Conn>(),
  })
  server = new SocketServer(core, {
    countdownMs: COUNTDOWN_MS,
    argvReader: () => 'claude',
    launcherRunning: async () => false,
    surface: {
      platform: 'linux',
      spawn: () => ({ pid: 4242, unref: () => undefined, once: () => undefined }),
      runAppleScript: () => Promise.resolve(''),
    },
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  delete process.env.AGENT_CHAT_HOME
  delete process.env.AGENT_CHAT_ACTIVE_WORK_ROOT
  fs.rmSync(home, { recursive: true, force: true })
})

function wire(): Wire {
  const frames: ServerMessage[] = []
  const record = (line: string) => frames.push(JSON.parse(line) as ServerMessage)
  const conn = Object.assign(new EventEmitter(), { write: record, end: record })
  server.onConnection(conn as unknown as Conn)
  return { conn, frames, send: msg => conn.emit('data', JSON.stringify(msg) + '\n') }
}

const frame = <T extends ServerMessage['t']>(w: Wire, t: T): Extract<ServerMessage, { t: T }> | undefined =>
  w.frames.find(f => f.t === t) as Extract<ServerMessage, { t: T }> | undefined

function macLauncher(): Wire {
  const launcher = wire()
  launcher.send({ t: 'host_hello', host: MAC, platform: 'darwin', surfaces: ['iterm-tab', 'headless'] })
  return launcher
}

function localPredecessor(): Wire {
  const predecessor = wire()
  predecessor.send({
    t: 'register',
    name: 'cc27',
    workingOn: 'work',
    cwd: home,
    pid: 111,
    host: os.hostname(),
    hostPid: PREDECESSOR_PID,
    sessionId: '0f8fad5b-d9cb-469f-a165-70867728950e',
  })
  return predecessor
}

async function teleportToMac(predecessor: Wire): Promise<void> {
  predecessor.send({ t: 'teleport', handoff: 'carry on', to: MAC, surface: 'iterm-tab', endsSelf: true })
  await vi.advanceTimersByTimeAsync(0)
}

function answer(launcher: Wire, t: 'host_probe' | 'host_launch', ok: boolean, reason?: string): void {
  const asked = frame(launcher, t)
  if (asked === undefined) throw new Error(`the launcher was never sent ${t}`)
  launcher.send({ t: `${t}_result`, id: asked.id, ok, ...(reason === undefined ? {} : { reason }) })
}

/** After the countdown, with the launch sent and unanswered. */
async function launchPending(launcher: Wire, predecessor: Wire): Promise<void> {
  await teleportToMac(predecessor)
  answer(launcher, 'host_probe', true)
  await vi.advanceTimersByTimeAsync(COUNTDOWN_MS)
  expect(frame(launcher, 'host_launch')).toBeDefined()
}

function expectPredecessorKept(): void {
  expect(signalled()).toBe(false)
  expect(kinds()).not.toContain('agent_stood_down')
  const successor = core.events
    .agentEvents()
    .find(row => row.kind === 'agent_retired' && row.ref === successorOf())
  expect(successor).toBeDefined()
}

const listed = (): string[] => {
  const cli = wire()
  cli.send({ t: 'hosts' })
  return frame(cli, 'hosts_result')?.hosts.map(h => h.host) ?? []
}

const kinds = (): string[] => core.events.agentEvents().map(row => row.kind)
const successorOf = (): string =>
  core.events.agentEvents().find(row => row.kind === 'agent_handoff')?.meta?.successor as string
const signalled = (): boolean =>
  kill.mock.calls.some(([pid, sig]) => pid === PREDECESSOR_PID && sig === 'SIGTERM')

describe('announcing a host launcher', () => {
  it('lists a launcher until its connection closes', () => {
    const launcher = macLauncher()
    const cli = wire()
    cli.send({ t: 'hosts' })
    expect(frame(launcher, 'host_hello_result')).toEqual({ t: 'host_hello_result', ok: true })
    expect(frame(cli, 'hosts_result')?.hosts.map(h => [h.host, h.platform])).toEqual([[MAC, 'darwin']])

    launcher.conn.emit('close')
    const after = wire()
    after.send({ t: 'hosts' })
    expect(frame(after, 'hosts_result')?.hosts).toEqual([])
  })

  it('refuses a second connection claiming a held machine, and the real launcher keeps it', async () => {
    const launcher = macLauncher()
    const impostor = wire()
    impostor.send({ t: 'host_hello', host: MAC.toUpperCase(), platform: 'darwin', surfaces: ['iterm-tab'] })

    expect(frame(impostor, 'host_hello_result')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('already connected'),
    })
    expect(listed()).toEqual([MAC])
    await teleportToMac(localPredecessor())
    expect(frame(launcher, 'host_probe')).toBeDefined()
    expect(frame(impostor, 'host_probe')).toBeUndefined()
  })

  it('refuses a machine outside the configured machines list', () => {
    fs.writeFileSync(
      path.join(home, 'config.json'),
      JSON.stringify({ machines: { mac: 'other-mac.invalid' } }),
    )
    const launcher = macLauncher()

    expect(frame(launcher, 'host_hello_result')?.reason).toContain('not one of the configured machines')
    expect(listed()).toEqual([])
  })

  it('refuses a register on a launcher connection', () => {
    const launcher = macLauncher()
    launcher.send({ t: 'register', name: 'cc27', workingOn: 'w', cwd: home, pid: 3 })

    expect(frame(launcher, 'register_result')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('host launcher'),
    })
    expect(core.registry.connFor('cc27')).toBeUndefined()
  })

  it('refuses a hello from a registered session connection', () => {
    const session = localPredecessor()
    session.send({ t: 'host_hello', host: MAC, platform: 'darwin', surfaces: ['iterm-tab'] })
    const cli = wire()
    cli.send({ t: 'hosts' })
    expect(frame(session, 'host_hello_result')?.ok).toBe(false)
    expect(frame(cli, 'hosts_result')?.hosts).toEqual([])
  })
})

describe('teleporting a local session to a launcher’s machine', () => {
  it('probes, launches there with the cwd, and ends the predecessor only after the successor attaches', async () => {
    const launcher = macLauncher()
    const predecessor = localPredecessor()
    await teleportToMac(predecessor)
    expect(frame(launcher, 'host_probe')?.probe).toEqual({ cwd: home, surface: 'iterm-tab' })
    expect(kinds()).not.toContain('agent_handoff')

    answer(launcher, 'host_probe', true)
    await vi.advanceTimersByTimeAsync(COUNTDOWN_MS)
    expect(frame(predecessor, 'teleport_result')?.ok).toBe(true)
    expect(frame(launcher, 'host_launch')?.launch).toMatchObject({ cwd: home, surface: 'iterm-tab' })

    answer(launcher, 'host_launch', true)
    await vi.advanceTimersByTimeAsync(0)
    expect(signalled()).toBe(false)

    wire().send({ t: 'register', name: 'cc27', workingOn: 'w', cwd: home, pid: 2, agentId: successorOf() })
    await vi.advanceTimersByTimeAsync(1)
    expect(signalled()).toBe(true)
    const order = kinds()
    expect(order.indexOf('agent_attached')).toBeLessThan(order.indexOf('agent_stood_down'))
  })

  it('refuses with the launcher’s reason when the cwd is missing there, writing no handoff', async () => {
    const launcher = macLauncher()
    const predecessor = localPredecessor()
    await teleportToMac(predecessor)
    answer(launcher, 'host_probe', false, `its working directory ${home} does not exist on ${MAC}`)
    await vi.advanceTimersByTimeAsync(0)

    const result = frame(predecessor, 'teleport_result')
    expect(result?.ok).toBe(false)
    expect(result?.reason).toContain(`its working directory ${home} does not exist`)
    expect(kinds()).not.toContain('agent_handoff')
  })

  it('refuses a second teleport sent while the first one’s probe is pending', async () => {
    const launcher = macLauncher()
    const predecessor = localPredecessor()
    await teleportToMac(predecessor)
    await teleportToMac(predecessor)
    expect(frame(predecessor, 'teleport_result')?.reason).toContain('already teleporting')

    answer(launcher, 'host_probe', true)
    await vi.advanceTimersByTimeAsync(0)
    expect(launcher.frames.filter(f => f.t === 'host_probe')).toHaveLength(1)
    expect(kinds().filter(kind => kind === 'agent_handoff')).toHaveLength(1)
  })

  it('writes no handoff for a predecessor that disconnects during the probe', async () => {
    const launcher = macLauncher()
    const predecessor = localPredecessor()
    await teleportToMac(predecessor)
    predecessor.conn.emit('close')
    answer(launcher, 'host_probe', true)
    await vi.advanceTimersByTimeAsync(COUNTDOWN_MS)

    expect(frame(predecessor, 'teleport_result')?.reason).toContain('disconnected or was replaced')
    expect(kinds()).not.toContain('agent_handoff')
    expect(frame(launcher, 'host_launch')).toBeUndefined()
  })

  it('refuses when the launcher does not answer its probe', async () => {
    macLauncher()
    const predecessor = localPredecessor()
    await teleportToMac(predecessor)
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS)

    expect(frame(predecessor, 'teleport_result')?.reason).toContain(`launcher on ${MAC} did not answer`)
    expect(kinds()).not.toContain('agent_handoff')
  })

  it('refuses a cwd outside the home directory without probing', async () => {
    vi.mocked(os.homedir).mockReturnValue('/nowhere-home')
    const launcher = macLauncher()
    const predecessor = localPredecessor()
    await teleportToMac(predecessor)

    expect(frame(predecessor, 'teleport_result')?.reason).toContain('is not under the home directory')
    expect(frame(launcher, 'host_probe')).toBeUndefined()
    expect(kinds()).not.toContain('agent_handoff')
  })

  it('refuses when the launcher disconnects during its probe', async () => {
    const launcher = macLauncher()
    const predecessor = localPredecessor()
    await teleportToMac(predecessor)
    launcher.conn.emit('close')
    await vi.advanceTimersByTimeAsync(0)

    expect(frame(predecessor, 'teleport_result')?.reason).toContain(`launcher on ${MAC} disconnected`)
    expect(kinds()).not.toContain('agent_handoff')
  })

  it('keeps the predecessor when the launcher disconnects during the launch', async () => {
    const launcher = macLauncher()
    const predecessor = localPredecessor()
    await launchPending(launcher, predecessor)
    launcher.conn.emit('close')
    await vi.advanceTimersByTimeAsync(0)

    expectPredecessorKept()
  })

  it('keeps the predecessor when the launcher never answers the launch', async () => {
    const launcher = macLauncher()
    const predecessor = localPredecessor()
    await launchPending(launcher, predecessor)
    await vi.advanceTimersByTimeAsync(LAUNCH_TIMEOUT_MS)

    expectPredecessorKept()
  })

  it('refuses a surface the launcher did not announce, without probing', async () => {
    const launcher = macLauncher()
    const predecessor = localPredecessor()
    predecessor.send({ t: 'teleport', handoff: 'carry on', to: MAC, surface: 'iterm-window', endsSelf: true })
    await vi.advanceTimersByTimeAsync(0)

    expect(frame(predecessor, 'teleport_result')?.reason).toContain('cannot open a iterm-window surface')
    expect(frame(launcher, 'host_probe')).toBeUndefined()
  })

  it('keeps the predecessor and releases the successor when the launcher refuses the launch', async () => {
    const launcher = macLauncher()
    const predecessor = localPredecessor()
    await teleportToMac(predecessor)
    answer(launcher, 'host_probe', true)
    await vi.advanceTimersByTimeAsync(COUNTDOWN_MS)
    answer(launcher, 'host_launch', false, 'checkLaunch refused it')
    await vi.advanceTimersByTimeAsync(0)

    expect(signalled()).toBe(false)
    const retired = core.events
      .agentEvents()
      .find(row => row.kind === 'agent_retired' && row.ref === successorOf())
    expect(retired?.body).toContain(`not launched on the launcher on ${MAC}`)
    expect(retired?.body).toContain('checkLaunch refused it')
    expect(kinds()).not.toContain('agent_stood_down')
  })
})

describe('the host directory', () => {
  it('takes an answer only from the connection that was asked', async () => {
    const hosts = new HostDirectory<string>()
    hosts.hello('launcher', { host: MAC, platform: 'darwin', surfaces: ['headless'] }, () => undefined)
    const pending = hosts.probe(MAC, { cwd: '/x', surface: 'headless' })
    const [id] = [...(hosts as unknown as { outstanding: Map<string, unknown> }).outstanding.keys()]

    expect(hosts.answer('impostor', id as string, { ok: true })).toBe(false)
    hosts.drop('launcher')
    expect(await pending).toEqual({ ok: false, reason: `launcher on ${MAC} disconnected` })
  })
})
