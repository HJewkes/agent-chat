import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LaunchPlan } from '../agents/types.js'
import { helloProof } from '../broker/launcher-key.js'
import { encode, lineReader, type ClientMessage, type RemoteLaunch, type ServerMessage } from '../protocol.js'
import {
  answerLaunch,
  answerProbe,
  answerSpawn,
  handleHostFrame,
  hostSurfaces,
  serveConnection,
  type LauncherDeps,
  type LauncherIdentity,
} from '../server/host-launcher.js'
import type { SpawnHost } from '../server/remote-launch.js'
import { hostInstallReport, hostLauncherJob } from '../cli/verbs/host.js'

/**
 * CC-951 g2: the machine side of a host launcher. The broker checked the spec's paths only
 * lexically, so the launcher resolves them on its own disk and launches with the spec's cwd and
 * account, never its own. The surface, the file writes and the superseded marker are fakes.
 */

const LINUX: LauncherIdentity = { host: 'basement', platform: 'linux', surfaces: ['headless', 'tmux-window'] }

let home: string
let cwd: string
let configDir: string

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-launcher-home-')))
  cwd = path.join(home, 'projects', 'repo')
  configDir = path.join(home, '.claude-profiles', 'personal')
  fs.mkdirSync(cwd, { recursive: true })
  fs.mkdirSync(configDir, { recursive: true })
  // A spec with no config dir reads `~/.claude.json`; keep the real one out of these tests.
  vi.spyOn(os, 'homedir').mockReturnValue(home)
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(home, { recursive: true, force: true })
})

const spec = (over: Partial<RemoteLaunch> = {}): RemoteLaunch => ({
  agentId: 'abcd1234',
  sessionId: '0f8fad5b-d9cb-469f-a165-70867728950e',
  name: 'cc27',
  profile: {
    name: 'inherited',
    description: 'd',
    model: '',
    allowedTools: [],
    isolation: 'none',
    surface: 'tmux-window',
    role: 'coordinator',
    promptPrelude: '',
  },
  brief: 'State at teleport',
  preamble: 'you are a continuation',
  surface: 'tmux-window',
  successorFirst: true,
  cwd,
  configDir,
  ...over,
})

/** The shared executor's host, recording what it was asked to load, write, open and discard. */
function fakeSpawnHost(launch: (plan: LaunchPlan) => Promise<void>) {
  const calls = {
    profiles: [] as string[],
    written: [] as LaunchPlan[],
    launched: [] as { surface: string; plan: LaunchPlan }[],
    discarded: [] as string[],
  }
  const spawnHost: SpawnHost = {
    cliEntry: '/opt/agent-chat/dist/cli/index.js',
    homeDir: home,
    loadProfile: name => {
      calls.profiles.push(name)
      return { ...spec().profile, env: { FROM_LOCAL_PROFILE: '1' } }
    },
    writeFiles: plan => void calls.written.push(plan),
    launch: async (surface, plan) => {
      calls.launched.push({ surface, plan })
      await launch(plan)
    },
    discard: agentId => void calls.discarded.push(agentId),
  }
  return { spawnHost, calls }
}

function fakeDeps(
  launch: (plan: LaunchPlan) => Promise<void> = async () => undefined,
  readKey: () => string | null = () => null,
) {
  const launched: { surface: string; plan: LaunchPlan }[] = []
  const written: LaunchPlan[] = []
  const superseded: string[] = []
  const { spawnHost, calls: spawned } = fakeSpawnHost(launch)
  const deps: LauncherDeps = {
    homeDir: home,
    cliEntry: '/opt/agent-chat/dist/cli/index.js',
    env: { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/launcher/own/account' },
    writeFiles: plan => void written.push(plan),
    launch: async (surface, plan) => {
      launched.push({ surface, plan })
      await launch(plan)
    },
    markSuperseded: agentId => void superseded.push(agentId),
    readKey,
    spawnHost,
  }
  return { deps, launched, written, superseded, spawned }
}

describe('a host_launch spec', () => {
  it('with a bad agent id is refused and nothing is written or launched', async () => {
    const { deps, launched, written } = fakeDeps()

    const answer = await answerLaunch(spec({ agentId: '../../etc' }), LINUX, deps)

    expect(answer.ok).toBe(false)
    expect(answer.reason).toMatch(/not an agent id/)
    expect(written).toEqual([])
    expect(launched).toEqual([])
  })

  it("launches with the spec's cwd and account, not the launcher's own", async () => {
    const { deps, launched } = fakeDeps()

    const answer = await answerLaunch(spec(), LINUX, deps)

    expect(answer).toEqual({ ok: true })
    expect(launched).toHaveLength(1)
    expect(launched[0]?.surface).toBe('tmux-window')
    expect(launched[0]?.plan.cwd).toBe(cwd)
    expect(launched[0]?.plan.cwd).not.toBe(process.cwd())
    expect(launched[0]?.plan.env.CLAUDE_CONFIG_DIR).toBe(configDir)
  })

  it('resolves a symlinked cwd that leads into a credential directory, and refuses it', async () => {
    const ssh = path.join(home, '.ssh')
    fs.mkdirSync(ssh)
    const link = path.join(home, 'projects', 'innocent')
    fs.symlinkSync(ssh, link)
    const { deps, launched } = fakeDeps()

    const answer = await answerLaunch(spec({ cwd: link }), LINUX, deps)

    expect(answer.reason).toMatch(/protected directory \("\.ssh"\)/)
    expect(launched).toEqual([])
  })

  it('refuses a config dir that resolves outside the home directory', async () => {
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-outside-')))
    const link = path.join(home, 'account')
    fs.symlinkSync(outside, link)
    const { deps, launched } = fakeDeps()

    const answer = await answerLaunch(spec({ configDir: link }), LINUX, deps)

    fs.rmSync(outside, { recursive: true, force: true })
    expect(answer.reason).toMatch(/config dir .* outside the home directory/)
    expect(launched).toEqual([])
  })

  it('refuses a credential directory spelled in another case', async () => {
    const shouty = path.join(home, 'projects', '.SSH')
    fs.mkdirSync(shouty)
    const { deps, launched } = fakeDeps()

    const answer = await answerLaunch(spec({ cwd: shouty }), LINUX, deps)

    expect(answer.reason).toMatch(/protected directory \("\.ssh"\)/)
    expect(launched).toEqual([])
  })

  it("never hands the launcher's own account to a successor whose predecessor named none", async () => {
    const { deps, launched } = fakeDeps()
    const { configDir: _account, ...noAccount } = spec()

    const answer = await answerLaunch(noAccount, LINUX, deps)

    expect(answer).toEqual({ ok: true })
    expect(launched[0]?.plan.env.CLAUDE_CONFIG_DIR).toBeUndefined()
  })

  it('refuses a sibling of home whose name only starts with the home name', async () => {
    const alice = `${home}ice`
    fs.mkdirSync(path.join(alice, 'repo'), { recursive: true })
    const { deps, launched } = fakeDeps()

    const answer = await answerLaunch(spec({ cwd: path.join(alice, 'repo') }), LINUX, deps)

    fs.rmSync(alice, { recursive: true, force: true })
    expect(answer.reason).toMatch(/outside the home directory/)
    expect(launched).toEqual([])
  })

  it('refuses an iTerm2 surface on linux before writing anything', async () => {
    const { deps, written } = fakeDeps()

    const answer = await answerLaunch(spec({ surface: 'iterm-window' }), LINUX, deps)

    expect(answer.reason).toMatch(/cannot open a iterm-window surface/)
    expect(written).toEqual([])
  })

  it('that outruns its budget is refused and its successor marked superseded', async () => {
    const { deps, superseded } = fakeDeps(() => new Promise(() => undefined))

    const answer = await answerLaunch(spec(), LINUX, deps, 20)

    expect(answer.ok).toBe(false)
    expect(answer.reason).toMatch(/did not open within/)
    expect(superseded).toEqual(['abcd1234'])
  })
})

describe('a host_spawn spec (CC-1062)', () => {
  const spawnSpec = (over: Partial<RemoteLaunch> = {}): RemoteLaunch => {
    const { successorFirst: _teleportOnly, ...launch } = spec({
      profile: { ...spec().profile, name: 'worker' },
    })
    return { ...launch, ...over }
  }

  it("opens through the shared executor, with this machine's profile env and the real cwd", async () => {
    const link = path.join(home, 'projects', 'via-link')
    fs.symlinkSync(cwd, link)
    const { deps, spawned, launched } = fakeDeps()

    const answer = await answerSpawn(spawnSpec({ cwd: link }), LINUX, deps)

    expect(answer).toEqual({ ok: true })
    expect(spawned.profiles).toEqual(['worker'])
    expect(spawned.written).toHaveLength(1)
    expect(spawned.launched).toHaveLength(1)
    expect(spawned.launched[0]?.plan.cwd).toBe(cwd)
    expect(spawned.launched[0]?.plan.env.FROM_LOCAL_PROFILE).toBe('1')
    expect(spawned.launched[0]?.plan.env.CLAUDE_CONFIG_DIR).toBe(configDir)
    expect(launched).toEqual([])
  })

  it('in a cwd the account has not trusted is refused with nothing written', async () => {
    fs.writeFileSync(path.join(configDir, '.claude.json'), JSON.stringify({ projects: {} }))
    const { deps, spawned } = fakeDeps()

    const answer = await answerSpawn(spawnSpec(), LINUX, deps)

    expect(answer.ok).toBe(false)
    expect(answer.reason).toContain('workspace trust prompt')
    expect(spawned.written).toEqual([])
    expect(spawned.launched).toEqual([])
  })

  it('outside home is refused with nothing written', async () => {
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-outside-')))
    const { deps, spawned } = fakeDeps()

    const answer = await answerSpawn(spawnSpec({ cwd: outside }), LINUX, deps)

    fs.rmSync(outside, { recursive: true, force: true })
    expect(answer.reason).toMatch(/outside the home directory/)
    expect(spawned.written).toEqual([])
  })

  it('whose surface fails to open is refused with its message and its files discarded', async () => {
    const { deps, spawned, superseded } = fakeDeps(async () => {
      throw new Error('tmux is not running')
    })

    const answer = await answerSpawn(spawnSpec(), LINUX, deps)

    expect(answer).toEqual({ ok: false, reason: 'tmux is not running' })
    expect(spawned.discarded).toEqual(['abcd1234'])
    expect(superseded).toEqual([])
  })

  it('that outruns its budget is refused and marked superseded', async () => {
    const { deps, spawned, superseded } = fakeDeps(() => new Promise(() => undefined))

    const answer = await answerSpawn(spawnSpec(), LINUX, deps, 20)

    expect(answer.ok).toBe(false)
    expect(answer.reason).toMatch(/did not open within/)
    expect(superseded).toEqual(['abcd1234'])
    expect(spawned.discarded).toEqual([])
  })

  it('is answered on the link as host_launch_result with the frame id', async () => {
    const { deps, launched } = fakeDeps()
    const sent: ClientMessage[] = []
    const link = { send: (frame: ClientMessage) => void sent.push(frame), isOpen: () => true }

    await handleHostFrame({ t: 'host_spawn', id: 's1', launch: spawnSpec() }, LINUX, deps, link)

    expect(sent).toEqual([{ t: 'host_launch_result', id: 's1', ok: true }])
    expect(launched).toEqual([])
  })

  it('whose answer can no longer reach the broker is marked superseded and nothing is sent', async () => {
    const { deps, spawned, superseded } = fakeDeps()
    const sent: ClientMessage[] = []
    const link = { send: (frame: ClientMessage) => void sent.push(frame), isOpen: () => false }

    await handleHostFrame({ t: 'host_spawn', id: 's2', launch: spawnSpec() }, LINUX, deps, link)

    expect(spawned.launched).toHaveLength(1)
    expect(superseded).toEqual(['abcd1234'])
    expect(sent).toEqual([])
  })

  it('leaves a host_launch frame on the teleport path', async () => {
    const { deps, launched, spawned } = fakeDeps()
    const link = { send: () => undefined, isOpen: () => true }

    await handleHostFrame({ t: 'host_launch', id: 'l2', launch: spec() }, LINUX, deps, link)

    expect(launched).toHaveLength(1)
    expect(spawned.launched).toEqual([])
  })
})

describe('a host_probe', () => {
  it('passes when the cwd and config dir exist under home', () => {
    const { deps } = fakeDeps()

    expect(answerProbe({ cwd, configDir, surface: 'tmux-window' }, LINUX, deps)).toEqual({ ok: true })
  })

  it('names the missing cwd', () => {
    const { deps } = fakeDeps()
    const missing = path.join(home, 'projects', 'gone')

    const answer = answerProbe({ cwd: missing, surface: 'headless' }, LINUX, deps)

    expect(answer).toEqual({ ok: false, reason: `its cwd ${missing} is not a directory on this machine` })
  })
})

describe('a launch into a cwd the destination account has not trusted (CC-1081)', () => {
  const trusting = (projects: Record<string, { hasTrustDialogAccepted: boolean }>): string => {
    const file = path.join(configDir, '.claude.json')
    fs.writeFileSync(file, JSON.stringify({ projects }))
    return file
  }

  it('is refused at the probe, naming the trust prompt, the cwd and the config file', () => {
    const file = trusting({ '/elsewhere': { hasTrustDialogAccepted: true } })
    const { deps } = fakeDeps()

    const answer = answerProbe({ cwd, configDir, surface: 'tmux-window' }, LINUX, deps)

    expect(answer.ok).toBe(false)
    expect(answer.reason).toContain('workspace trust prompt')
    expect(answer.reason).toContain(cwd)
    expect(answer.reason).toContain(file)
  })

  it('is refused at launch with nothing written, opened or superseded', async () => {
    trusting({ '/elsewhere': { hasTrustDialogAccepted: true } })
    const { deps, launched, written, superseded } = fakeDeps()

    const answer = await answerLaunch(spec(), LINUX, deps)

    expect(answer.ok).toBe(false)
    expect(answer.reason).toContain('workspace trust prompt')
    expect(written).toEqual([])
    expect(launched).toEqual([])
    expect(superseded).toEqual([])
  })

  it('with no config dir is refused from the home ~/.claude.json', () => {
    const file = path.join(home, '.claude.json')
    fs.writeFileSync(file, JSON.stringify({ projects: {} }))
    const { deps } = fakeDeps()

    const answer = answerProbe({ cwd, surface: 'headless' }, LINUX, deps)

    expect(answer.reason).toContain(file)
    expect(answer.reason).not.toContain('CLAUDE_CONFIG_DIR')
  })

  it('is refused when its entry was seen but not accepted', () => {
    trusting({ [cwd]: { hasTrustDialogAccepted: false } })
    const { deps } = fakeDeps()

    const answer = answerProbe({ cwd, configDir, surface: 'headless' }, LINUX, deps)

    expect(answer.reason).toContain('workspace trust prompt')
  })

  it('launches a subdirectory whose git root is trusted, even with a space in its path', async () => {
    fs.mkdirSync(path.join(cwd, '.git'))
    const sub = path.join(cwd, 'Application Support', 'seat')
    fs.mkdirSync(sub, { recursive: true })
    trusting({ [cwd]: { hasTrustDialogAccepted: true } })
    const { deps, launched } = fakeDeps()

    expect(answerProbe({ cwd: sub, configDir, surface: 'tmux-window' }, LINUX, deps)).toEqual({ ok: true })
    expect(await answerLaunch(spec({ cwd: sub }), LINUX, deps)).toEqual({ ok: true })
    expect(launched).toHaveLength(1)
  })

  it('launches as before when the config file cannot be read', () => {
    fs.writeFileSync(path.join(configDir, '.claude.json'), '{not json')
    const { deps } = fakeDeps()

    expect(answerProbe({ cwd, configDir, surface: 'tmux-window' }, LINUX, deps)).toEqual({ ok: true })
  })
})

describe('handleHostFrame', () => {
  it('answers a probe on the link with the same id', async () => {
    const { deps } = fakeDeps()
    const sent: ClientMessage[] = []
    const link = { send: (frame: ClientMessage) => void sent.push(frame), isOpen: () => true }

    await handleHostFrame(
      { t: 'host_probe', id: 'p1', probe: { cwd, surface: 'headless' } },
      LINUX,
      deps,
      link,
    )

    expect(sent).toEqual([{ t: 'host_probe_result', id: 'p1', ok: true }])
  })

  it('marks a launched successor superseded when its answer can no longer reach the broker', async () => {
    const { deps, superseded, launched } = fakeDeps()
    const sent: ClientMessage[] = []
    const link = { send: (frame: ClientMessage) => void sent.push(frame), isOpen: () => false }

    await handleHostFrame({ t: 'host_launch', id: 'l1', launch: spec() }, LINUX, deps, link)

    expect(launched).toHaveLength(1)
    expect(superseded).toEqual(['abcd1234'])
    expect(sent).toEqual([])
  })
})

/** A broker stub on a unix socket: records the launcher's frames and answers through `answer`. */
async function brokerStub(answer: (frame: ClientMessage, reply: (f: ServerMessage) => void) => void) {
  const received: ClientMessage[] = []
  const sockPath = path.join(home, 'stub.sock')
  const server = net.createServer(conn => {
    const reply = (f: ServerMessage): void => void conn.write(encode(f))
    conn.on(
      'data',
      lineReader<ClientMessage>(
        frame => {
          received.push(frame)
          answer(frame, reply)
        },
        () => undefined,
      ),
    )
  })
  await new Promise<void>(resolve => server.listen(sockPath, resolve))
  const connect = (): Promise<net.Socket> =>
    new Promise(resolve => {
      const socket = net.connect(sockPath, () => resolve(socket))
    })
  return { received, connect, close: () => server.close() }
}

const KEY = 'a'.repeat(64)
const refuseHello = (frame: ClientMessage, reply: (f: ServerMessage) => void, nonce = 'n1'): void => {
  if (frame.t === 'host_challenge') reply({ t: 'host_challenge_result', nonce })
  if (frame.t === 'host_hello') reply({ t: 'host_hello_result', ok: false, reason: 'stub refusal' })
}

describe('serveConnection answering the broker challenge (CC-1063)', () => {
  it('sends host_challenge before any hello, then a hello proved over the nonce', async () => {
    const stub = await brokerStub((frame, reply) => refuseHello(frame, reply, 'nonce-1'))
    const { deps } = fakeDeps(undefined, () => KEY)

    await serveConnection(await stub.connect(), LINUX, deps, () => undefined)

    stub.close()
    expect(stub.received.map(f => f.t)).toEqual(['host_challenge', 'host_hello'])
    expect(stub.received[1]).toMatchObject({ proof: helloProof(KEY, 'basement', 'nonce-1') })
  })

  it('with no key file sends a hello without a proof and resolves with the broker refusal', async () => {
    const stub = await brokerStub(refuseHello)
    const { deps } = fakeDeps()

    const why = await serveConnection(await stub.connect(), LINUX, deps, () => undefined)

    stub.close()
    expect(stub.received[1]?.t).toBe('host_hello')
    expect(stub.received[1]).not.toHaveProperty('proof')
    expect(why).toBe('the broker refused this launcher: stub refusal')
  })

  it('reads the key on every connect, so a rotated key is used without a restart', async () => {
    const keys = ['b'.repeat(64), 'c'.repeat(64)]
    const stub = await brokerStub(refuseHello)
    const { deps } = fakeDeps(undefined, () => keys.shift() ?? null)

    await serveConnection(await stub.connect(), LINUX, deps, () => undefined)
    await serveConnection(await stub.connect(), LINUX, deps, () => undefined)

    stub.close()
    const proofs = stub.received.filter(f => f.t === 'host_hello').map(f => (f as { proof?: string }).proof)
    expect(proofs).toEqual([
      helloProof('b'.repeat(64), 'basement', 'n1'),
      helloProof('c'.repeat(64), 'basement', 'n1'),
    ])
  })

  it('gives up on a broker that never answers the challenge, without sending a hello', async () => {
    const stub = await brokerStub(() => undefined)
    const { deps } = fakeDeps(undefined, () => KEY)

    const why = await serveConnection(await stub.connect(), LINUX, deps, () => undefined, 30)

    stub.close()
    expect(why).toMatch(/did not answer host_challenge/)
    expect(stub.received.map(f => f.t)).toEqual(['host_challenge'])
  })

  it('never puts the key in the env a successor is launched with', async () => {
    const { deps, launched } = fakeDeps(undefined, () => KEY)

    await answerLaunch(spec(), LINUX, deps)

    expect(Object.values(launched[0]?.plan.env ?? {})).not.toContain(KEY)
    expect(JSON.stringify(launched[0]?.plan)).not.toContain(KEY)
  })
})

describe('host surfaces and install', () => {
  it('offers iTerm2 only on macOS and tmux only where it is installed', () => {
    expect(hostSurfaces('linux', true)).toEqual(['headless', 'tmux-window'])
    expect(hostSurfaces('linux', false)).toEqual(['headless'])
    expect(hostSurfaces('darwin', false)).toEqual(['headless', 'iterm-pane', 'iterm-tab', 'iterm-window'])
  })

  it('keeps `host serve` alive under the announced name', () => {
    const job = hostLauncherJob({ nodePath: '/n', cliEntry: '/c.js', logDir: '/l', env: {}, host: 'mac' })

    expect(job.args).toEqual(['/n', '/c.js', 'host', 'serve', '--host', 'mac'])
    expect(job.schedule.kind).toBe('keep-alive')
  })

  const target = { uid: 501, nodePath: '/n', cliEntry: '/opt/agent-chat/dist/cli.js', env: {}, host: 'mac' }

  it('prints the launchd plist and the commands for the owner to run', () => {
    const report = hostInstallReport({ ...target, platform: 'darwin' })

    expect(report.ok).toBe(true)
    expect(report.lines.join('\n')).toContain('<string>serve</string>')
    expect(report.lines.at(-1)).toMatch(
      /^launchctl bootstrap gui\/501 .*dev\.hjewkes\.agent-chat-host-launcher\.plist'?$/,
    )
  })

  it('prints the systemd unit and the systemctl commands on linux', () => {
    const report = hostInstallReport({ ...target, platform: 'linux' })

    expect(report.lines.join('\n')).toContain(
      'ExecStart=/n /opt/agent-chat/dist/cli.js host serve --host mac',
    )
    expect(report.lines.at(-1)).toBe('systemctl --user enable --now agent-chat-host-launcher.service')
  })
})
