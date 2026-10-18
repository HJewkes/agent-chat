import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { PROBE_TIMEOUT_MS } from '../broker/host-directory.js'
import { brokerHost } from '../broker/host-guard.js'
import { ensureBrokerKey, helloProof } from '../broker/launcher-key.js'
import { Registry } from '../broker/registry.js'
import { SocketServer } from '../broker/socket.js'
import {
  launcherHome,
  localCopyWarning,
  remoteResumeRefusal,
  resumeRouteFor,
  type RemoteResumeSite,
} from '../agents/remote-resume.js'
import { transcriptPath } from '../agents/transcript.js'
import type { AgentIdentity, ClientMessage, ServerMessage } from '../protocol.js'

/**
 * CC-1472 slice B: `resume host:<name>` is routed to that machine's host launcher, which checks the
 * transcript on its own disk and relaunches the same identity there with `--resume`. A refusal on
 * the way never turns into a local resume. Drives the real socket with a fake launcher for `mac`.
 */

const MAC = 'owners-mac.invalid'
const AGENT = 'agent-x-id'
const SESSION = '0f8fad5b-d9cb-469f-a165-70867728950e'
const CEILING_MS = 5_000
const USER = os.userInfo().username
const MAC_HOME = `/Users/${USER}`
const MAC_CWD = `${MAC_HOME}/proj-a`
const MAC_ACCOUNT = `${MAC_HOME}/accounts/seat-a`
const GONE = "agent-x's transcript is gone, so it would come back with no conversation"

interface Wire {
  conn: EventEmitter
  frames: ServerMessage[]
  send: (msg: ClientMessage) => void
}

let home: string
let core: BrokerCore
let server: SocketServer

beforeEach(() => {
  vi.useFakeTimers()
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-remote-resume-'))
  // The broker's home and the Mac's coincide, so the lexical check holds on a Linux and a macOS runner alike.
  vi.spyOn(os, 'homedir').mockReturnValue(MAC_HOME)
  process.env.AGENT_CHAT_HOME = home
  core = new BrokerCore(() => undefined, {
    events: new EventLog(path.join(home, 'events.db')),
    registry: new Registry<Conn>(),
  })
  server = new SocketServer(core, {
    attachCeilingMs: CEILING_MS,
    launcherRunning: async () => false,
    surface: {
      platform: 'linux',
      spawn: () => ({ pid: 4242, unref: () => undefined, once: () => undefined }),
    },
  })
  fs.writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify({ machines: { mac: MAC }, hostProof: 'enforce' }),
  )
})

afterEach(() => {
  server.close()
  vi.restoreAllMocks()
  vi.useRealTimers()
  delete process.env.AGENT_CHAT_HOME
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
  launcher.send({ t: 'host_challenge' })
  const nonce = frame(launcher, 'host_challenge_result')?.nonce ?? ''
  const proof = helloProof(ensureBrokerKey(MAC), MAC, nonce)
  launcher.send({
    t: 'host_hello',
    host: MAC,
    platform: 'darwin',
    surfaces: ['iterm-tab', 'headless'],
    proof,
  })
  return launcher
}

/** A stopped agent whose conversation was recorded on the Mac: nothing of it is on this disk. */
function stoppedAgent(meta: Record<string, string> = {}): void {
  core.append({
    kind: 'agent_spawned',
    actor: 'human',
    target: 'agent-x',
    msgId: AGENT,
    body: 'read the log',
    meta: {
      profile: 'explorer',
      cwd: MAC_CWD,
      isolation: 'none',
      surface: 'headless',
      session_id: SESSION,
      config_dir: MAC_ACCOUNT,
      host: MAC,
      ...meta,
    },
  })
  core.append({ kind: 'agent_exited', actor: 'agent-x', ref: AGENT, body: 'done', meta: { code: '0' } })
}

async function resume(msg: Omit<Extract<ClientMessage, { t: 'resume' }>, 't' | 'name'>) {
  const cli = wire()
  cli.send({ t: 'resume', name: 'agent-x', ...msg })
  await vi.advanceTimersByTimeAsync(0)
  return cli
}

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

function answerProbe(launcher: Wire, answer: { ok: boolean; reason?: string; transcript?: unknown }): void {
  const asked = frame(launcher, 'host_probe')
  if (asked === undefined) throw new Error('the launcher was never probed')
  launcher.send({ t: 'host_probe_result', id: asked.id, ...answer } as ClientMessage)
}

function answerSpawn(launcher: Wire, ok: boolean, reason?: string): void {
  const asked = frame(launcher, 'host_spawn')
  if (asked === undefined) throw new Error('the launcher was never sent host_spawn')
  launcher.send({ t: 'host_launch_result', id: asked.id, ok, ...(reason === undefined ? {} : { reason }) })
}

const FOUND = { found: true, path: `${MAC_ACCOUNT}/projects/proj-a/${SESSION}.jsonl` }
const rows = (kind: string) => core.events.agentEvents().filter(row => row.kind === kind && row.ref === AGENT)
const result = (cli: Wire) => frame(cli, 'spawn_result')

describe('resume host:mac through the host launcher', () => {
  // Mutation caught: resumeUnguarded ignoring req.host (no probe is sent), or a local fallback.
  it('launches the same identity on the Mac, while a local resume still refuses as today', async () => {
    const launcher = macLauncher()
    stoppedAgent()

    const cli = await resume({ host: 'mac', launchedBy: 'shepherd', launchReason: 'follow-up' })
    expect(frame(launcher, 'host_probe')?.probe).toEqual({
      cwd: MAC_CWD,
      surface: 'headless',
      configDir: MAC_ACCOUNT,
      resumeSession: SESSION,
    })
    answerProbe(launcher, { ok: true, transcript: FOUND })
    await settle()
    const launch = frame(launcher, 'host_spawn')?.launch
    expect(launch).toMatchObject({
      agentId: AGENT,
      sessionId: SESSION,
      name: 'agent-x',
      resume: true,
      cwd: MAC_CWD,
      configDir: MAC_ACCOUNT,
      surface: 'headless',
    })
    expect(launch?.anchor).toBeUndefined()
    answerSpawn(launcher, true)
    await settle()

    expect(result(cli)).toMatchObject({ ok: true, agentId: AGENT, host: MAC, transcript: FOUND })
    expect(rows('agent_resumed').map(row => row.meta)).toEqual([
      expect.objectContaining({
        host: MAC,
        session_id: SESSION,
        launched_by: 'shepherd',
        launch_reason: 'follow-up',
      }),
    ])

    const local = await resume({})
    expect(result(local)).toMatchObject({ ok: false, reason: GONE })
    expect(rows('agent_resumed')).toHaveLength(1)
  })

  // Mutation caught: a route refusal falling through to the local path, which refuses on the transcript.
  it('refuses an unknown machine with the route reason, probing nothing', async () => {
    const launcher = macLauncher()
    stoppedAgent()

    const cli = await resume({ host: 'nowhere' })

    expect(result(cli)?.ok).toBe(false)
    expect(result(cli)?.reason).toMatch(/^unknown machine "nowhere"/)
    expect(frame(launcher, 'host_probe')).toBeUndefined()
    expect(rows('agent_resumed')).toEqual([])
  })

  it('refuses a configured machine with no launcher connected', async () => {
    stoppedAgent()

    const cli = await resume({ host: 'mac' })

    expect(result(cli)?.reason).toMatch(new RegExp(`^no launcher connected on ${MAC}`))
    expect(rows('agent_resumed')).toEqual([])
  })

  // Mutation caught: treating a timeout as ok.
  it('refuses when the launcher never answers the probe', async () => {
    const launcher = macLauncher()
    stoppedAgent()

    const cli = await resume({ host: 'mac' })
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS)

    expect(result(cli)?.reason).toMatch(/did not answer/)
    expect(frame(launcher, 'host_spawn')).toBeUndefined()
    expect(rows('agent_resumed')).toEqual([])
  })

  it('refuses when the launcher disconnects mid-probe', async () => {
    const launcher = macLauncher()
    stoppedAgent()

    const cli = await resume({ host: 'mac' })
    launcher.conn.emit('close')
    await settle()

    expect(result(cli)?.reason).toMatch(/disconnected/)
    expect(rows('agent_resumed')).toEqual([])
  })

  // Mutation caught: gating on answer.ok alone.
  it('refuses a launcher too old to check the transcript', async () => {
    const launcher = macLauncher()
    stoppedAgent()

    const cli = await resume({ host: 'mac' })
    answerProbe(launcher, { ok: true })
    await settle()

    expect(result(cli)?.ok).toBe(false)
    expect(result(cli)?.reason).toMatch(/predates resuming a session.*update agent-chat there/)
    expect(frame(launcher, 'host_spawn')).toBeUndefined()
  })

  it('relays a missing remote transcript with the launcher verdict', async () => {
    const launcher = macLauncher()
    stoppedAgent()
    const missing = { found: false, path: FOUND.path }

    const cli = await resume({ host: 'mac' })
    answerProbe(launcher, {
      ok: false,
      reason: `the transcript of session ${SESSION} is not on ${MAC}`,
      transcript: missing,
    })
    await settle()

    expect(result(cli)).toMatchObject({ ok: false, transcript: missing })
    expect(result(cli)?.reason).toContain(`is not on ${MAC}`)
    expect(rows('agent_resumed')).toEqual([])
  })

  // Mutation caught: retiring the identity through RemoteSpawns' default retire.
  it('closes a resume the launcher refused as never started, keeping the identity', async () => {
    const launcher = macLauncher()
    stoppedAgent()

    const cli = await resume({ host: 'mac' })
    answerProbe(launcher, { ok: true, transcript: FOUND })
    await settle()
    answerSpawn(launcher, false, 'the headless surface did not open')
    await settle()

    expect(result(cli)).toMatchObject({
      ok: false,
      reason: `refused on ${MAC}: the headless surface did not open`,
    })
    expect(rows('agent_resumed')).toHaveLength(1)
    expect(rows('agent_exited').at(-1)?.meta).toMatchObject({ never_started: 'true', failed: 'true' })
    expect(rows('agent_retired')).toEqual([])
    expect(core.agents.byName('agent-x')?.state).toBe('exited')
  })

  it('closes a launched resume that never registers within the ceiling, keeping the identity', async () => {
    const launcher = macLauncher()
    stoppedAgent()

    await resume({ host: 'mac' })
    answerProbe(launcher, { ok: true, transcript: FOUND })
    await settle()
    answerSpawn(launcher, true)
    await settle()
    expect(rows('agent_exited')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(CEILING_MS)

    expect(rows('agent_exited').at(-1)?.meta).toMatchObject({ never_started: 'true' })
    expect(rows('agent_retired')).toEqual([])
  })

  it('refuses a worktree agent before probing', async () => {
    const launcher = macLauncher()
    stoppedAgent({ isolation: 'worktree' })

    const cli = await resume({ host: 'mac' })

    expect(result(cli)?.reason).toBe(
      `agent-x has worktree isolation, which is local to ${brokerHost()}, so it cannot resume on ${MAC}`,
    )
    expect(frame(launcher, 'host_probe')).toBeUndefined()
  })

  it("resumes locally, exactly as today, when host names the broker's own machine", async () => {
    const launcher = macLauncher()
    const cwd = fs.mkdtempSync(path.join(home, 'proj-'))
    const account = fs.mkdtempSync(path.join(home, 'acct-'))
    stoppedAgent({ cwd, config_dir: account, host: '' })
    const file = transcriptPath(cwd, SESSION, account)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '{}\n')

    const cli = await resume({ host: brokerHost() })
    await vi.waitFor(() => expect(result(cli)).toBeDefined())

    expect(result(cli)).toMatchObject({ ok: true, transcript: { found: true, path: file } })
    expect(result(cli)?.host).toBeUndefined()
    expect(frame(launcher, 'host_probe')).toBeUndefined()
    expect(rows('agent_resumed')[0]?.meta.host).toBeUndefined()
  })
})

describe('the broker-side checks of a host resume', () => {
  const agent = (fields: Partial<AgentIdentity>): AgentIdentity =>
    ({
      agentId: AGENT,
      name: 'agent-x',
      cwd: '/Users/example/proj-a',
      isolation: 'none',
      sessionId: SESSION,
      configDir: '/Users/example/accounts/seat-a',
      ...fields,
    }) as AgentIdentity
  const site: RemoteResumeSite = {
    host: MAC,
    platform: 'darwin',
    brokerHost: 'linux-box',
    brokerPlatform: 'linux',
    user: 'example',
    brokerHome: '/home/example',
    surfaces: ['headless'],
  }

  it("checks a Mac's paths under its own home, not the Linux broker's", () => {
    expect(launcherHome(site)).toBe('/Users/example')
    expect(remoteResumeRefusal(agent({}), 'headless', site)).toBeUndefined()
    expect(remoteResumeRefusal(agent({ cwd: '/home/example/proj-a' }), 'headless', site)).toMatch(
      /not under the home directory \/Users\/example/,
    )
  })

  it('refuses an identity that records no account rather than guess one', () => {
    const { configDir: _dir, ...unrecorded } = agent({})
    expect(remoteResumeRefusal(unrecorded as AgentIdentity, 'headless', site)).toMatch(/records no account/)
    const unset = { ...unrecorded, configDirUnset: true } as AgentIdentity
    expect(remoteResumeRefusal(unset, 'headless', site)).toBeUndefined()
  })

  it('names a second copy of the transcript on the broker, which now diverges', () => {
    expect(localCopyWarning({ found: false, path: '/x' }, 'linux-box', MAC)).toEqual([])
    expect(localCopyWarning({ found: true, path: '/x' }, 'linux-box', MAC)).toEqual([
      `a transcript for this session also exists on linux-box at /x; resumed the one on ${MAC}, so the two copies diverge from here`,
    ])
  })

  it('refuses a surface the launcher did not announce', () => {
    expect(remoteResumeRefusal(agent({}), 'iterm-tab', site)).toBe(
      `the launcher on ${MAC} cannot open a iterm-tab surface`,
    )
  })

  it("routes the broker's own host here and an alias to its launcher, case-insensitively", () => {
    const launchers = [{ host: MAC, platform: 'darwin' as const }]
    const input = { brokerHost: 'linux-box', launchers, aliases: { mac: MAC } }
    expect(resumeRouteFor({ ...input, host: 'LINUX-BOX' })).toEqual({ site: 'broker' })
    expect(resumeRouteFor({ ...input, host: 'Mac' })).toEqual({
      site: 'launcher',
      host: MAC,
      platform: 'darwin',
    })
  })
})
