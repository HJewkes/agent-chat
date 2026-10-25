import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { HostDirectory, LAUNCH_TIMEOUT_MS, PROBE_TIMEOUT_MS } from '../broker/host-directory.js'
import { ensureBrokerKey, helloProof, registerMachineAlias } from '../broker/launcher-key.js'
import { logPath } from '../paths.js'
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

function challenge(launcher: Wire): string {
  launcher.send({ t: 'host_challenge' })
  const nonce = launcher.frames.filter(f => f.t === 'host_challenge_result').at(-1)?.nonce
  if (nonce === undefined) throw new Error('the broker sent no host_challenge_result')
  return nonce
}

/** A hello for the Mac carrying `proof`; the launcher's helper below proves with the broker's own key. */
function helloAsMac(launcher: Wire, proof?: string): void {
  launcher.send({
    t: 'host_hello',
    host: MAC,
    platform: 'darwin',
    surfaces: ['iterm-tab', 'headless'],
    ...(proof === undefined ? {} : { proof }),
  })
}

function macLauncher(): Wire {
  const launcher = wire()
  helloAsMac(launcher, helloProof(ensureBrokerKey(MAC), MAC, challenge(launcher)))
  return launcher
}

const configureMac = (hostProof: 'enforce' | 'off' = 'enforce'): void =>
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ machines: { mac: MAC }, hostProof }))

const configureNoMachines = (hostProof: 'enforce' | 'off'): void =>
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ hostProof }))

const brokerLog = (): string => (fs.existsSync(logPath()) ? fs.readFileSync(logPath(), 'utf8') : '')

const lastHello = (w: Wire) => w.frames.filter(f => f.t === 'host_hello_result').at(-1)

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

  it('refuses a second connection claiming a held machine even with a valid proof, and the real launcher keeps it', async () => {
    configureMac()
    const launcher = macLauncher()
    const impostor = wire()
    impostor.send({
      t: 'host_hello',
      host: MAC.toUpperCase(),
      platform: 'darwin',
      surfaces: ['iterm-tab'],
      proof: helloProof(ensureBrokerKey(MAC), MAC, challenge(impostor)),
    })

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

  it('refuses an impostor in the gap after the real launcher disconnects, with no proof or a wrong-key one', () => {
    configureMac()
    const launcher = macLauncher()
    expect(lastHello(launcher)?.ok).toBe(true)
    launcher.conn.emit('close')

    const impostor = wire()
    challenge(impostor)
    helloAsMac(impostor)
    expect(lastHello(impostor)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('no valid launcher proof'),
    })
    helloAsMac(impostor, helloProof('f'.repeat(64), MAC, challenge(impostor)))
    expect(lastHello(impostor)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('no valid launcher proof'),
    })
    expect(listed()).toEqual([])
    expect(JSON.stringify(core.events.agentEvents())).not.toContain(ensureBrokerKey(MAC))
  })

  it('refuses a hello replayed on a new connection with the earlier nonce and proof', () => {
    configureMac()
    const launcher = wire()
    const proof = helloProof(ensureBrokerKey(MAC), MAC, challenge(launcher))
    helloAsMac(launcher, proof)
    launcher.conn.emit('close')

    const replayer = wire()
    helloAsMac(replayer, proof)
    challenge(replayer)
    helloAsMac(replayer, proof)
    expect(replayer.frames.filter(f => f.t === 'host_hello_result').map(f => f.ok)).toEqual([false, false])
    expect(listed()).toEqual([])
  })

  it('takes a nonce once, so a second hello on the same connection needs a new challenge', () => {
    configureMac()
    const launcher = wire()
    const proof = helloProof(ensureBrokerKey(MAC), MAC, challenge(launcher))
    helloAsMac(launcher, proof)
    helloAsMac(launcher, proof)

    expect(launcher.frames.filter(f => f.t === 'host_hello_result').map(f => f.ok)).toEqual([true, false])
    expect(lastHello(launcher)?.reason).toContain('send host_challenge first')
  })

  it('refuses a configured machine the broker has no key for, naming the provisioning step', () => {
    configureMac()
    const launcher = wire()
    helloAsMac(launcher, helloProof('a'.repeat(64), MAC, challenge(launcher)))

    expect(lastHello(launcher)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('provision the launcher key'),
    })
    expect(listed()).toEqual([])
  })

  it('refuses a configured machine’s hello sent without a prior challenge', () => {
    configureMac()
    const key = ensureBrokerKey(MAC)
    const launcher = wire()
    helloAsMac(launcher, helloProof(key, MAC, ''))

    expect(lastHello(launcher)?.reason).toContain('send host_challenge first')
    expect(listed()).toEqual([])
  })

  it('accepts a configured machine’s hello with a valid proof', () => {
    configureMac()
    const launcher = macLauncher()

    expect(lastHello(launcher)).toEqual({ t: 'host_hello_result', ok: true })
    expect(listed()).toEqual([MAC])
  })

  it('accepts a configured machine’s hello with no proof while hostProof is off, as before', () => {
    configureMac('off')
    const launcher = wire()
    helloAsMac(launcher)

    expect(lastHello(launcher)).toEqual({ t: 'host_hello_result', ok: true })
    expect(listed()).toEqual([MAC])
    expect(brokerLog()).not.toContain('host_launcher_refused')
  })

  it('accepts and logs a bad proof while hostProof is off', () => {
    configureMac('off')
    ensureBrokerKey(MAC)
    const launcher = wire()
    helloAsMac(launcher, helloProof('f'.repeat(64), MAC, challenge(launcher)))

    expect(lastHello(launcher)).toEqual({ t: 'host_hello_result', ok: true })
    expect(listed()).toEqual([MAC])
    expect(brokerLog()).toContain('proof-invalid (not enforced)')
  })

  it('defaults hostProof to off when the config does not name it', () => {
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ machines: { mac: MAC } }))
    const launcher = wire()
    helloAsMac(launcher)

    expect(lastHello(launcher)?.ok).toBe(true)
  })

  it('with machines empty and hostProof enforce, refuses a hello for an unkeyed host and never routes a teleport to it', async () => {
    configureNoMachines('enforce')
    const impostor = wire()
    challenge(impostor)
    helloAsMac(impostor)

    expect(lastHello(impostor)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('provision the launcher key'),
    })
    expect(listed()).toEqual([])
    const predecessor = localPredecessor()
    await teleportToMac(predecessor)
    expect(frame(predecessor, 'teleport_result')?.ok).toBe(false)
    expect(frame(impostor, 'host_probe')).toBeUndefined()
    expect(brokerLog()).toContain('host_launcher_refused')
  })

  it('with machines empty and hostProof enforce, refuses an unkeyed host’s hello sent without a challenge', () => {
    configureNoMachines('enforce')
    const impostor = wire()
    helloAsMac(impostor)

    expect(lastHello(impostor)?.reason).toContain('provision the launcher key')
    expect(listed()).toEqual([])
  })

  it('with machines empty and hostProof enforce, accepts a host with a minted key and a valid proof but routes no teleport to it', async () => {
    configureNoMachines('enforce')
    const launcher = macLauncher()

    expect(lastHello(launcher)).toEqual({ t: 'host_hello_result', ok: true })
    expect(listed()).toEqual([MAC])
    const predecessor = localPredecessor()
    await teleportToMac(predecessor)
    expect(frame(predecessor, 'teleport_result')?.reason).toContain('is not one of the configured machines')
    expect(frame(launcher, 'host_probe')).toBeUndefined()
  })

  it('with machines empty, routes to a proved launcher whose host key-new registered', async () => {
    configureNoMachines('enforce')
    registerMachineAlias('mac', MAC)
    const launcher = macLauncher()

    await teleportToMac(localPredecessor())
    expect(frame(launcher, 'host_probe')).toBeDefined()
  })

  it('with machines empty and hostProof off, accepts a keyless hello', () => {
    configureNoMachines('off')
    const launcher = wire()
    helloAsMac(launcher)

    expect(lastHello(launcher)).toEqual({ t: 'host_hello_result', ok: true })
    expect(listed()).toEqual([MAC])
  })

  it('refuses a configured machine’s keyless, proofless hello under hostProof enforce, keeping key material out of the log', () => {
    configureMac()
    const launcher = wire()
    challenge(launcher)
    helloAsMac(launcher)

    expect(lastHello(launcher)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('provision the launcher key'),
    })
    expect(listed()).toEqual([])
    expect(JSON.stringify(core.events.agentEvents())).not.toContain(ensureBrokerKey(MAC))
  })

  it('refuses a challenge from a registered session connection', () => {
    const session = localPredecessor()
    session.send({ t: 'host_challenge' })

    expect(frame(session, 'host_challenge_result')).toBeUndefined()
    expect(frame(session, 'host_hello_result')?.ok).toBe(false)
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

describe('choosing a launcher for a teleport (CC-1331)', () => {
  it('never probes a keyless launcher for an unconfigured host', async () => {
    configureNoMachines('off')
    const launcher = wire()
    helloAsMac(launcher)
    const predecessor = localPredecessor()
    await teleportToMac(predecessor)

    expect(lastHello(launcher)?.ok).toBe(true)
    expect(frame(predecessor, 'teleport_result')?.reason).toContain('is not one of the configured machines')
    expect(frame(launcher, 'host_probe')).toBeUndefined()
  })

  it('never probes a proofless launcher for a configured host under hostProof off', async () => {
    configureMac('off')
    const launcher = wire()
    helloAsMac(launcher)
    const predecessor = localPredecessor()
    await teleportToMac(predecessor)

    expect(lastHello(launcher)?.ok).toBe(true)
    expect(frame(predecessor, 'teleport_result')?.reason).toContain('has not proved its host key')
    expect(frame(launcher, 'host_probe')).toBeUndefined()
  })
})

describe('teleporting a local session to a launcher’s machine', () => {
  beforeEach(() => configureMac('off'))

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

  // Mutation caught: the successor's agent_spawned row dropping host, so its liveness is probed on the broker's host.
  it('records the successor as running on the launcher’s machine', async () => {
    const launcher = macLauncher()
    await teleportToMac(localPredecessor())
    answer(launcher, 'host_probe', true)
    await vi.advanceTimersByTimeAsync(COUNTDOWN_MS)
    answer(launcher, 'host_launch', true)
    await vi.advanceTimersByTimeAsync(0)

    wire().send({ t: 'register', name: 'cc27', workingOn: 'w', cwd: home, pid: 2, agentId: successorOf() })
    await vi.advanceTimersByTimeAsync(1)

    expect(core.agents.get(successorOf())).toMatchObject({ state: 'live', host: MAC })
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

  it('writes no handoff when the same identity comes back on another Claude Code during the probe', async () => {
    const launcher = macLauncher()
    const predecessor = localPredecessor()
    const conn = core.registry.connFor('cc27')
    const agentId = conn === undefined ? undefined : core.registry.entryFor(conn)?.agentId
    await teleportToMac(predecessor)
    predecessor.conn.emit('close')
    wire().send({
      t: 'register',
      name: 'cc27',
      workingOn: 'work',
      cwd: home,
      pid: 112,
      host: os.hostname(),
      hostPid: PREDECESSOR_PID + 1,
      ...(agentId === undefined ? {} : { agentId }),
    })
    expect(core.registry.connFor('cc27')).toBeDefined()
    answer(launcher, 'host_probe', true)
    await vi.advanceTimersByTimeAsync(COUNTDOWN_MS)

    expect(frame(predecessor, 'teleport_result')?.reason).toContain('disconnected or was replaced')
    expect(kinds()).not.toContain('agent_handoff')
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
  const macHello = { host: MAC, platform: 'darwin' as const, surfaces: ['headless' as const] }
  const recorded = (): boolean | undefined =>
    (server as unknown as { hosts: HostDirectory }).hosts.launchers().find(l => l.host === MAC)?.proved

  it.each([true, false])('reports a launcher as proved only when the broker said so (%s)', proved => {
    const hosts = new HostDirectory<string>()
    hosts.hello('launcher', macHello, () => undefined, proved)

    expect(hosts.launchers()).toEqual([{ host: MAC, platform: 'darwin', proved }])
  })

  it('replaces the proved flag on a re-hello', () => {
    const hosts = new HostDirectory<string>()
    hosts.hello('launcher', macHello, () => undefined, true)
    hosts.hello('launcher', macHello, () => undefined, false)

    expect(hosts.launchers()).toEqual([{ host: MAC, platform: 'darwin', proved: false }])
  })

  it('records a proofless hello accepted under hostProof off as not proved', () => {
    configureMac('off')
    helloAsMac(wire())

    expect(recorded()).toBe(false)
  })

  it('records a bad-proof hello accepted under hostProof off as not proved', () => {
    configureMac('off')
    ensureBrokerKey(MAC)
    const launcher = wire()
    helloAsMac(launcher, helloProof('f'.repeat(64), MAC, challenge(launcher)))

    expect(lastHello(launcher)?.ok).toBe(true)
    expect(recorded()).toBe(false)
  })

  it.each(['off', 'enforce'] as const)('records a valid-proof hello under hostProof %s as proved', mode => {
    configureMac(mode)
    macLauncher()

    expect(recorded()).toBe(true)
  })

  it('takes an answer only from the connection that was asked', async () => {
    const hosts = new HostDirectory<string>()
    hosts.hello('launcher', macHello, () => undefined, true)
    const pending = hosts.probe(MAC, { cwd: '/x', surface: 'headless' })
    const [id] = [...(hosts as unknown as { outstanding: Map<string, unknown> }).outstanding.keys()]

    expect(hosts.answer('impostor', id as string, { ok: true })).toBe(false)
    hosts.drop('launcher')
    expect(await pending).toEqual({ ok: false, reason: `launcher on ${MAC} disconnected` })
  })
})
