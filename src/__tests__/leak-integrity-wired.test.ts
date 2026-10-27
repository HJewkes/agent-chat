import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import type net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { autoAttach } from './broker-harness.js'
import { hookSettingsPath } from '../agents/launch-files.js'
import { relaunchRefusal } from '../agents/relaunch-integrity.js'
import { RELAUNCH_RETRY_MS, Supervisor } from '../agents/supervisor.js'
import { transcriptPath } from '../agents/transcript.js'
import type { AgentProfile } from '../agents/types.js'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog, INTEGRITY_WIRED_SINCE } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { HUMAN_ROOT } from '../broker/integrity-ledger.js'
import { SocketServer } from '../broker/socket.js'
import {
  integrityDenial,
  INTEGRITY_DEADLINE_MS,
  type AskBroker,
  type CollectRecords,
} from '../cli/verbs/leak-integrity.js'
import { leakPosttool, leakPretool, type PretoolIo } from '../cli/verbs/leak-pretool.js'
import { currentRecords } from '../leak-guard/integrity/env-records.js'
import { agentDir } from '../paths.js'
import type { ClientMessage, ServerMessage } from '../protocol.js'

// The in-process broker runs wired whatever the shipped flag says, as A3a-A3d's suites injected the gate.
vi.mock('../broker/integrity-wired.js', () => ({ INTEGRITY_WIRED: true }))
const { INTEGRITY_WIRED: BUILT_WIRED } = await vi.importActual<typeof import('../broker/integrity-wired.js')>(
  '../broker/integrity-wired.js',
)

/**
 * TP-4256 A3 acceptance rows, wired: `INTEGRITY_WIRED` on, a real `SocketServer` whose supervisor
 * writes every launch through the ledger's `admit`, the hook's records and `integrity_check`, and
 * `run-agent`'s relaunch ask. Every write is a real `bash -c` under a synthetic HOME. The shapes are
 * S1-S17 of the A5 redesign, FIFO and /dev/zero swaps, and the three classes the A3 rounds missed.
 * Names, ids and paths are synthetic.
 */

const SESSION = '00000000-0000-4000-8000-0000000000a3'
const CLI = path.join(import.meta.dirname, '..', '..', 'dist', 'cli.js')
const cleanups: (() => void)[] = []

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

function answer<T extends ServerMessage['t']>(server: SocketServer, frame: ClientMessage, t: T) {
  const frames: ServerMessage[] = []
  const conn = { write: (line: string) => frames.push(JSON.parse(line) as ServerMessage) } as unknown as Conn
  server.handleMessage(conn, frame)
  return frames.find(frame => frame.t === t) as Extract<ServerMessage, { t: T }>
}

/** A synthetic home with a .zshrc, a session snapshot and a coordinator profile, in the env a launch reads. */
function syntheticHome() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-wired-')))
  cleanups.push(() => {
    execFileSync('chmod', ['-R', 'u+rwx', root])
    fs.rmSync(root, { recursive: true, force: true })
  })
  const home = path.join(root, 'home')
  const acHome = path.join(home, '.agent-chat')
  const configDir = path.join(home, '.claude')
  fs.mkdirSync(path.join(configDir, 'shell-snapshots'), { recursive: true })
  fs.mkdirSync(path.join(acHome, 'profiles'), { recursive: true })
  fs.mkdirSync(path.join(root, 'work'))
  fs.writeFileSync(path.join(configDir, 'shell-snapshots', 'snapshot-zsh-1.sh'), 'export A=1\n')
  fs.writeFileSync(path.join(home, '.zshrc'), 'alias ll=ls\n')
  const lead = {
    model: 'opus',
    allowedTools: ['Read'],
    isolation: 'none',
    surface: 'headless',
    role: 'coordinator',
  }
  fs.writeFileSync(path.join(acHome, 'profiles', 'lead.json'), JSON.stringify(lead))
  for (const [name, value] of Object.entries({
    HOME: home,
    AGENT_CHAT_HOME: acHome,
    CLAUDE_CONFIG_DIR: configDir,
  }))
    vi.stubEnv(name, value)
  for (const name of ['ZDOTDIR', 'BASH_ENV', 'ENV']) vi.stubEnv(name, undefined)
  return { root, home, acHome, configDir }
}

/** The broker as the daemon builds it; launches land on a headless child that never starts anything. */
function broker(root: string) {
  const core = new BrokerCore(() => undefined, {
    events: new EventLog(path.join(root, 'events.db')),
    registry: new Registry<Conn>(),
  })
  core.register({} as unknown as net.Socket, {
    t: 'register',
    name: 'coord',
    workingOn: '',
    cwd: root,
    pid: 1,
  })
  const exits = { latest: () => undefined as void }
  const spawnChild = () => ({
    pid: 4242,
    unref: () => undefined,
    once: (event: string, listener: (code: number, signal: null) => void) => {
      if (event === 'exit') exits.latest = () => listener(0, null)
    },
  })
  // A mode switch signals the old pid; nothing real holds 4242.
  vi.spyOn(process, 'kill').mockImplementation(() => true)
  const stopAttach = autoAttach(core)
  const server = new SocketServer(core, {
    nameFreeMs: 50,
    launcherRunning: async () => false,
    surface: {
      platform: 'darwin',
      spawn: spawnChild as never,
      runAppleScript: script => Promise.resolve(script.includes('is running') ? 'true' : 'fake-pane'),
    },
  })
  cleanups.push(() => {
    stopAttach()
    server.close()
  })
  // The broker owns its supervisor; reaching it here is the same path `handleSpawn` takes.
  const supervisor = (server as unknown as { supervisor: Supervisor }).supervisor
  return { core, server, supervisor, exits, stopAttach }
}

const nonceOf = (agentId: string): string => {
  const settings = hookSettingsPath(agentId)
  const match = /--integrity '([0-9a-f]{64})'/.exec(fs.readFileSync(settings, 'utf8'))
  if (match?.[1] === undefined) throw new Error(`no --integrity nonce in ${settings}`)
  return match[1]
}

/** The worker's collection, run in-process: a worker needs the built file, which these rows do not. */
const inline: CollectRecords = async (session, env) => currentRecords(session, env)

/** A lead the human spawned and a sibling, both admitted by the broker's ledger. */
async function setup() {
  const { root, home, acHome, configDir } = syntheticHome()
  const { core, server, supervisor, exits, stopAttach } = broker(root)
  const spawn = async (
    name: string,
    profile: string,
    over: { requestedBy: string; parentAgentId?: string },
  ) => {
    const result = await supervisor.spawn({
      name,
      profile,
      brief: 'read the log',
      cwd: path.join(root, 'work'),
      isolation: 'none',
      surface: 'headless',
      ...over,
    })
    return result.ok ? (result.agentId as string) : `refused: ${result.reason}`
  }
  const sibling = await spawn('sibling', 'explorer', { requestedBy: 'human' })
  // Last, so `exits.latest` ends the lead.
  const lead = await spawn('lead', 'lead', { requestedBy: 'human' })
  const leadNonce = nonceOf(lead)
  const env = { HOME: home, CLAUDE_CONFIG_DIR: configDir }
  const ask: AskBroker = async frame => answer(server, frame, 'integrity_result')
  const check = (nonce: string, raw: string) =>
    integrityDenial(nonce, raw, env, ask, INTEGRITY_DEADLINE_MS, inline)
  const hook = (nonce: string = leadNonce) => check(nonce, JSON.stringify({ session_id: SESSION }))
  const relaunch = (id: string = lead) =>
    relaunchRefusal(id, async agentId =>
      answer(
        server,
        { t: 'integrity_relaunch', agentId, agentDir: agentDir(agentId) },
        'integrity_relaunch_result',
      ),
    )
  const bash = (script: string): void => {
    execFileSync('bash', ['-c', script], {
      env: { PATH: process.env.PATH ?? '', HOME: home, AC: acHome, A: agentDir(lead), T: root },
      cwd: root,
    })
  }
  const notices = (id: string = lead) =>
    core.events
      .since(0, 500)
      .filter(row => row.meta?.event === 'integrity_quarantine' && row.meta.agent_id === id)
  return {
    ...{ root, home, acHome, env, core, supervisor, exits, stopAttach },
    ...{ lead, leadNonce, sibling, spawn, check, hook, relaunch, bash, notices },
  }
}

type Wired = Awaited<ReturnType<typeof setup>>

/** Every row: a clean call, the write, then a deny naming the file, a refused relaunch, one notice. */
async function expectCaught(script: (w: Wired) => string, file: RegExp): Promise<void> {
  const wired = await setup()
  expect(await wired.hook()).toBeUndefined()

  wired.bash(script(wired))

  const denial = await wired.hook()
  expect(denial).toMatch(/quarantined/)
  expect(denial).toMatch(file)
  expect(await wired.relaunch()).toMatch(/it is quarantined: .*changed/)
  expect(wired.notices()).toHaveLength(1)
}

const LAUNCH_FILE = /\/agents\/[^/]+\/(settings\.json|mcp\.json|plan\.json|relaunch) changed/
const ZSHRC = /\/home\/\.zshrc changed/

const isRoot = process.getuid?.() === 0
const caseInsensitiveTmp =
  fs.existsSync(os.tmpdir().toUpperCase()) && os.tmpdir() !== os.tmpdir().toUpperCase()

describe('a launch the broker admitted, then a clean tool call', () => {
  it('allows the call, its relaunch, and files no notice', async () => {
    const wired = await setup()

    const calls = [await wired.hook(), await wired.hook()]

    expect(calls).toEqual([undefined, undefined])
    expect(await wired.relaunch()).toBeUndefined()
    expect(wired.notices()).toEqual([])
  })

  it('denies a nonce the broker did not mint', async () => {
    const wired = await setup()

    expect(await wired.hook('f'.repeat(64))).toMatch(/integrity check refused: no baseline/)
  })
})

/** What a hook verb printed before it exited. */
const hookOutput = (run: (io: PretoolIo) => Promise<void>, raw: string): Promise<string> =>
  new Promise(resolve => {
    let out = ''
    const io: PretoolIo = {
      readInput: async () => raw,
      write: (text, done) => {
        out += text
        done()
      },
      exit: () => resolve(out),
    }
    void run(io)
  })

describe('the hook verbs the admitted settings name', () => {
  it('posttool blocks the call that changed .zshrc, then pretool denies the next one', async () => {
    const wired = await setup()
    const raw = JSON.stringify({ session_id: SESSION, tool_name: 'Read', tool_input: { file_path: '/x' } })
    const pretool = () => hookOutput(io => leakPretool(io, wired.leadNonce, wired.check), raw)
    expect(await pretool()).toBe('')

    wired.bash(`echo 'alias ls=rm' >> ~/.zshrc`)

    const post = await hookOutput(io => leakPosttool(wired.leadNonce, io, wired.check), raw)
    expect(JSON.parse(post)).toMatchObject({ decision: 'block', reason: expect.stringMatching(ZSHRC) })
    expect(await pretool()).toMatch(/deny.*\.zshrc changed/)
  })
})

describe('Bash writes to a launch file (S1-S8, S14, S17)', () => {
  it.each<[string, (w: Wired) => string]>([
    ['S1 redirect', () => `echo '{}' > "$A/settings.json"`],
    ['S1 sed -i', () => `sed -i.bak 's/pretool/xx/' "$A/settings.json"`],
    ['S1 rm', () => `rm "$A/settings.json"`],
    ['S1 mv over', () => `printf x > "$T/x" && mv "$T/x" "$A/settings.json"`],
    ['S2 ~ spelling', w => `echo x >> ~/.agent-chat/agents/${w.lead}/settings.json`],
    ['S2 $HOME spelling', w => `echo x >> "$HOME/.agent-chat/agents/${w.lead}/mcp.json"`],
    ['S3 // ./ .. spelling', w => `echo x >> "$AC//agents/./${w.sibling}/../${w.lead}/plan.json"`],
    ['S4 rm -r the agent dir', () => `rm -r "$A"`],
    ['S4 rm -rf the agents dir', () => `rm -rf "$AC/agents"`],
    ['S4 mv the agents dir', () => `mv "$AC/agents" "$T/moved"`],
    ['S5 cd, then a relative path', w => `cd "$AC/agents" && echo x >> ${w.lead}/relaunch`],
    ['S6 glob', w => `echo x >> "$AC"/agents/${w.lead.slice(0, -1)}?/settings.json`],
    ['S6 quote split', w => `echo x >> "$AC"/agents/${w.lead.slice(0, 3)}''${w.lead.slice(3)}/settings.json`],
    ['S7 symlinked parent', w => `ln -s "$AC" "$T/x" && echo x >> "$T/x/agents/${w.lead}/settings.json"`],
    ['S8 find -delete', () => `find "$AC" -name settings.json -delete`],
    ['S14 hard link, then a write to it', () => `ln "$A/settings.json" "$T/h" && echo x >> "$T/h"`],
    ['S17 a dir in place of the file', () => `rm "$A/settings.json" && mkdir "$A/settings.json"`],
  ])('%s is caught at the next call', async (_shape, script) => {
    await expectCaught(script, LAUNCH_FILE)
  })

  it.runIf(caseInsensitiveTmp)('S10 a case variant of the directory is caught at the next call', async () => {
    await expectCaught(w => `echo x >> "$AC/AGENTS/${w.lead}/settings.json"`, LAUNCH_FILE)
  })

  it.skipIf(isRoot)('S17 chmod 000 is caught at the next call', async () => {
    await expectCaught(() => `chmod 000 "$A/settings.json"`, LAUNCH_FILE)
  })
})

describe('writes to the launch files that are not settings.json (S9, S11-S13)', () => {
  it.each([
    ['S9 through a symlink to plan.json', `ln -s "$A/plan.json" "$T/p" && echo x >> "$T/p"`],
    [
      'S11 plan.json with --settings /dev/null',
      `printf '{"args":["--settings","/dev/null"]}' > "$A/plan.json"`,
    ],
    ['S12 the relaunch script', `printf '#!/bin/sh\\nexec claude\\n' > "$A/relaunch"`],
    ['S13 mcp.json', `echo '{}' > "$A/mcp.json"`],
  ])('%s is caught at the next call, and run-agent will not start it', async (_shape, script) => {
    await expectCaught(() => script, LAUNCH_FILE)
  })

  it('S11 refuses the relaunch even before any tool call reports', async () => {
    const wired = await setup()

    wired.bash(`printf '{"args":["--settings","/dev/null"]}' > "$A/plan.json"`)

    expect(await wired.relaunch()).toMatch(/plan\.json changed \(sha256\)/)
    expect(await wired.hook()).toMatch(/quarantined/)
  })
})

describe('FIFO and /dev/zero swaps, which must deny without blocking', () => {
  it.each([
    ['a FIFO for settings.json', `rm "$A/settings.json" && mkfifo "$A/settings.json"`, LAUNCH_FILE],
    ['/dev/zero for settings.json', `ln -sf /dev/zero "$A/settings.json"`, LAUNCH_FILE],
    ['a FIFO for .zshrc', `rm ~/.zshrc && mkfifo ~/.zshrc`, ZSHRC],
    ['/dev/zero for .zshrc', `ln -sf /dev/zero ~/.zshrc`, ZSHRC],
  ])('%s is caught', { timeout: 5_000 }, async (_shape, script, file) => {
    await expectCaught(() => script, file)
  })
})

describe('the files a later shell sources', () => {
  it.each([
    ['an appended .zshrc', `echo 'alias ls=rm' >> ~/.zshrc`, ZSHRC],
    [
      'a .zshrc restored by cp -p',
      `cp -p ~/.zshrc "$T/z" && echo x >> ~/.zshrc && cp -p "$T/z" ~/.zshrc`,
      ZSHRC,
    ],
    ['a new .zshenv', `echo 'export X=1' > ~/.zshenv`, /\.zshenv changed \(state\)/],
    [
      'a rewritten session snapshot',
      `echo x >> ~/.claude/shell-snapshots/snapshot-zsh-1.sh`,
      /snapshot-zsh-1\.sh changed/,
    ],
  ])('%s is caught', async (_shape, script, file) => {
    await expectCaught(() => script, file)
  })
})

describe('S15 edit-then-restore of a launch file between two calls', () => {
  // Known gap, kept a TP-4256 follow-up: the watch keeps no ctime, so a same-inode restore passes.
  it('is not caught yet', async () => {
    const wired = await setup()
    expect(await wired.hook()).toBeUndefined()

    wired.bash(`cp "$A/settings.json" "$T/s" && echo x >> "$A/settings.json" && cp "$T/s" "$A/settings.json"`)

    expect(await wired.hook()).toBeUndefined()
  })
})

/** The lead, exited, with a transcript on disk so a resume has a conversation to continue. */
function finish(wired: Wired): void {
  wired.exits.latest()
  const agent = wired.core.agents.get(wired.lead)
  if (agent === undefined) throw new Error('no identity for the lead')
  const file = transcriptPath(agent.cwd, agent.sessionId, agent.configDir)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '{}\n')
}

const settle = () => new Promise(resolve => setImmediate(resolve))

describe('FF1: a re-admit of the same agent', () => {
  it('rewrites its files under a new nonce and files no false quarantine', async () => {
    const wired = await setup()
    expect(await wired.hook()).toBeUndefined()
    finish(wired)
    await settle()

    const resumed = await wired.supervisor.resume('lead', { requestedBy: 'human', source: 'watchdog' })

    const nonce = nonceOf(wired.lead)
    expect(resumed.ok).toBe(true)
    expect(nonce).not.toBe(wired.leadNonce)
    expect(await wired.hook(nonce)).toBeUndefined()
    expect(wired.notices()).toEqual([])
  })

  it('still quarantines for a change made before the re-admit', async () => {
    const wired = await setup()
    wired.bash(`echo x >> "$A/mcp.json"`)
    finish(wired)
    await settle()

    const resumed = await wired.supervisor.resume('lead', { requestedBy: 'human', source: 'watchdog' })

    expect(resumed.ok).toBe(false)
    expect(wired.notices()).toHaveLength(1)
  })
})

/** The lead quarantined by a launch-file change its next call reports. */
async function quarantined(): Promise<Wired> {
  const wired = await setup()
  wired.bash(`echo x >> "$A/mcp.json"`)
  expect(await wired.hook()).toMatch(/mcp\.json changed/)
  return wired
}

const inherited: AgentProfile = {
  name: 'lead',
  description: '',
  model: '',
  allowedTools: [],
  isolation: 'none',
  surface: 'headless',
  promptPrelude: '',
}

/** A teleport successor of the lead; nothing attaches, so its retries run on the fake clock. */
async function teleportSuccessor(wired: Wired): Promise<boolean> {
  wired.stopAttach()
  vi.useFakeTimers({ toFake: ['setTimeout'] })
  const settled = wired.supervisor
    .relaunch({
      agentId: 'agsucc01',
      name: 'lead',
      profile: inherited,
      brief: 'carry on',
      cwd: path.join(wired.root, 'work'),
      surface: 'headless',
      preamble: 'you are the continuation',
      meta: { teleport_from: wired.lead, parent: '' },
      inheritedFrom: wired.lead,
    })
    .then(() => true)
    .catch(() => false)
  await vi.advanceTimersByTimeAsync(RELAUNCH_RETRY_MS * 3)
  return settled
}

describe('FF2: a quarantine survives every new launch of the agent or its descendants', () => {
  it('a mode switch is refused', async () => {
    const wired = await quarantined()

    const switched = await wired.supervisor.switchSurface({
      name: 'lead',
      to: 'interactive',
      requestedBy: 'human',
    })

    expect(switched.ok).toBe(false)
    expect(switched.reason).toMatch(/integrity: .* is quarantined/)
  })

  it('a wake is refused', async () => {
    const wired = await quarantined()
    finish(wired)
    await settle()

    const woken = await wired.supervisor.resume('lead', { requestedBy: 'human', source: 'watchdog' })

    expect(woken.ok).toBe(false)
    expect(woken.reason).toMatch(/integrity: .* is quarantined/)
  })

  it('a teleport successor is refused', async () => {
    const wired = await quarantined()

    expect(await teleportSuccessor(wired)).toBe(false)
    expect(wired.core.events.humanQueue().some(item => item.text.includes('integrity: agsucc01'))).toBe(true)
  })

  it('a child spawned now is refused', async () => {
    const wired = await quarantined()

    const child = await wired.spawn('child', 'lead', { requestedBy: 'coord', parentAgentId: wired.lead })

    expect(child).toMatch(/^refused: .*quarantined/)
  })

  it('a child spawned before the latch denies once its parent latches', async () => {
    const wired = await setup()
    const child = await wired.spawn('child', 'lead', { requestedBy: 'coord', parentAgentId: wired.lead })
    expect(await wired.hook(nonceOf(child))).toBeUndefined()

    wired.bash(`echo x >> "$A/mcp.json"`)
    await wired.hook()

    expect(await wired.hook(nonceOf(child))).toMatch(/mcp\.json changed.*quarantined/)
    expect(await wired.relaunch(child)).toMatch(/it is quarantined: .*mcp\.json changed/)
  })

  it("only the human's own resume clears it, under a new nonce", async () => {
    const wired = await quarantined()
    finish(wired)
    await settle()

    const resumed = await wired.supervisor.resume('lead', { requestedBy: 'human' })

    const nonce = nonceOf(wired.lead)
    expect(resumed.ok).toBe(true)
    expect(nonce).not.toBe(wired.leadNonce)
    expect(await wired.hook(nonce)).toBeUndefined()
    expect(await wired.relaunch()).toBeUndefined()
  })
})

// The built CLI reads the shipped flag, which no mock reaches.
describe.skipIf(!BUILT_WIRED)('FF3/4: run-agent with no broker to ask', () => {
  it('refuses the relaunch with exit 77 and starts nothing', async () => {
    const wired = await setup()
    expect(fs.existsSync(CLI), 'run `npm run build` first').toBe(true)

    const run = spawnSync(process.execPath, [CLI, 'run-agent', wired.lead], {
      encoding: 'utf8',
      env: {
        PATH: '/usr/bin:/bin',
        HOME: wired.home,
        AGENT_CHAT_HOME: wired.acHome,
        AGENT_CHAT_CLAUDE: '/bin/echo',
      },
    })

    expect(run.status).toBe(77)
    expect(run.stderr).toMatch(/not launched, the broker could not be asked/)
    expect(run.stdout).toBe('')
  })
})

/** A coordinator's spawn of `name` under `parentAgentId`: its id, or why it was refused. */
async function spawnUnder(supervisor: Supervisor, root: string, name: string, parentAgentId?: string) {
  const result = await supervisor.spawn({
    name,
    profile: 'lead',
    brief: 'read the log',
    cwd: path.join(root, 'work'),
    isolation: 'none',
    surface: 'headless',
    requestedBy: parentAgentId === undefined ? 'human' : 'coord',
    ...(parentAgentId === undefined ? {} : { parentAgentId }),
  })
  return result.ok ? (result.agentId as string) : `refused: ${result.reason}`
}

/**
 * TP-4341: a restart leaves the ledger empty while the agents run on. Broker two is a new
 * `SocketServer` over the same event log and home, so only what is on disk carries across.
 */
function restarted(wired: Wired) {
  wired.stopAttach()
  const next = broker(wired.root)
  const ask: AskBroker = async frame => answer(next.server, frame, 'integrity_result')
  const hook = (nonce: string) =>
    integrityDenial(
      nonce,
      JSON.stringify({ session_id: SESSION }),
      wired.env,
      ask,
      INTEGRITY_DEADLINE_MS,
      inline,
    )
  const spawn = (name: string, parentAgentId: string) =>
    spawnUnder(next.supervisor, wired.root, name, parentAgentId)
  return { ...next, hook, spawn }
}

/** The newest launch ended, with a transcript on disk so a resume has a conversation to continue. */
async function ended(wired: Wired, agentId: string): Promise<void> {
  wired.exits.latest()
  await settle()
  const agent = wired.core.agents.get(agentId)
  if (agent === undefined) throw new Error(`no identity for ${agentId}`)
  const file = transcriptPath(agent.cwd, agent.sessionId, agent.configDir)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '{}\n')
}

/** A teleport successor of the lead on `supervisor`; it attaches, so the relaunch settles. */
const succeed = (supervisor: Supervisor, wired: Wired, agentId: string) =>
  supervisor.relaunch({
    agentId,
    name: 'lead',
    profile: inherited,
    brief: 'carry on',
    cwd: path.join(wired.root, 'work'),
    surface: 'headless',
    preamble: 'you are the continuation',
    meta: { teleport_from: wired.lead, parent: '' },
    inheritedFrom: wired.lead,
  })

describe('TP-4341: coordinators that outlive a wired broker restart', () => {
  it('a teleport successor started after the restart is admitted and spawns a child', async () => {
    const wired = await setup()
    const after = restarted(wired)

    await succeed(after.supervisor, wired, 'agsucc01')
    const child = await after.spawn('child', 'agsucc01')

    expect(after.server.integrity.verdict('agsucc01')).toEqual({ ok: true })
    expect(child).not.toMatch(/^refused/)
    expect(await after.hook(nonceOf(child))).toBeUndefined()
  })

  it('a successor whose predecessor ended before the restart roots at its lineage and spawns', async () => {
    const wired = await setup()
    await succeed(wired.supervisor, wired, 'agsucc01')
    wired.core.append({ kind: 'agent_exited', actor: 'lead', ref: wired.lead, body: '', meta: {} })
    const after = restarted(wired)

    const child = await after.spawn('child', 'agsucc01')

    expect(child).not.toMatch(/^refused/)
    expect(after.server.integrity.parentOf('agsucc01')).toBe(HUMAN_ROOT)
  })

  it('a live coordinator resumes its child without the human, and its own hook passes on reattach', async () => {
    const wired = await setup()
    const child = await wired.spawn('child', 'lead', { requestedBy: 'coord', parentAgentId: wired.lead })
    await ended(wired, child)
    const after = restarted(wired)

    after.core.append({ kind: 'agent_attached', actor: 'lead', ref: wired.lead })
    const resumed = await after.supervisor.resume('child', { requestedBy: 'coord' })

    expect(resumed).toMatchObject({ ok: true, agentId: child })
    expect(await after.hook(wired.leadNonce)).toBeUndefined()
    expect(await after.hook(nonceOf(child))).toBeUndefined()
  })

  it('a coordinator whose relaunch script was rewritten before the restart stays quarantined', async () => {
    const wired = await setup()
    const child = await wired.spawn('child', 'lead', { requestedBy: 'coord', parentAgentId: wired.lead })
    await ended(wired, child)
    wired.bash(`printf '#!/bin/sh\\nexec claude\\n' > "$A/relaunch"`)
    const after = restarted(wired)

    const resumed = await after.supervisor.resume('child', { requestedBy: 'coord' })

    expect(resumed.ok).toBe(false)
    expect(resumed.reason).toMatch(/integrity: .* is quarantined/)
    expect(after.server.integrity.verdict(wired.lead)).toMatchObject({
      reason: 'quarantined',
      file: agentDir(wired.lead) + '/relaunch',
    })
    expect(await after.hook(wired.leadNonce)).toMatch(/integrity check refused/)
    const notices = after.core.events.since(0, 500).filter(row => row.meta?.event === 'integrity_quarantine')
    expect(notices.map(row => row.meta?.agent_id)).toContain(wired.lead)
  })

  it('a re-admitted coordinator still quarantines a .zshrc change made after the restart', async () => {
    const wired = await setup()
    const after = restarted(wired)
    after.core.append({ kind: 'agent_attached', actor: 'lead', ref: wired.lead })
    expect(await after.hook(wired.leadNonce)).toBeUndefined()

    wired.bash(`echo 'alias ls=rm' >> ~/.zshrc`)

    expect(await after.hook(wired.leadNonce)).toMatch(/\.zshrc changed/)
    expect(await after.spawn('child', wired.lead)).toMatch(/^refused: .*quarantined/)
  })

  it('a coordinator a hand-started session spawned roots at the human and spawns after the restart', async () => {
    const wired = await setup()
    wired.core.append({
      kind: 'agent_spawned',
      actor: 'human',
      target: 'desk',
      msgId: 'agdesk01',
      meta: { origin: 'adopted', name: 'desk', cwd: wired.root, depth: '0' },
    })
    const lead = await wired.spawn('desk-lead', 'lead', { requestedBy: 'coord', parentAgentId: 'agdesk01' })
    const after = restarted(wired)

    const child = await after.spawn('child', lead)

    expect(child).not.toMatch(/^refused/)
    expect(after.server.integrity.parentOf(lead)).toBe(HUMAN_ROOT)
  })
})

/** A lead an unwired broker launched in `root`, before any wired broker ran there: its guard is unarmed. */
async function unwiredLead(root: string): Promise<string> {
  const core = new BrokerCore(() => undefined, {
    events: new EventLog(path.join(root, 'events.db')),
    registry: new Registry<Conn>(),
  })
  const stopAttach = autoAttach(core)
  const supervisor = new Supervisor(core, {
    nameFreeMs: 50,
    launcherRunning: async () => false,
    surface: {
      platform: 'darwin',
      spawn: (() => ({ pid: 4243, unref: () => undefined, once: () => undefined })) as never,
    },
  })
  const lead = await spawnUnder(supervisor, root, 'lead')
  await settle()
  stopAttach()
  supervisor.close()
  return lead
}

/** The lead's settings rewritten to the unarmed shape an unwired broker writes. */
function stripNonce(agentId: string): void {
  const file = hookSettingsPath(agentId)
  const settings = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    hooks: Record<string, { hooks: { command: string }[] }[]>
  }
  settings.hooks.PostToolUse = (settings.hooks.PostToolUse ?? []).filter(
    entry => !entry.hooks.some(hook => hook.command.includes('leak-guard posttool')),
  )
  for (const entry of settings.hooks.PreToolUse ?? [])
    for (const hook of entry.hooks) hook.command = hook.command.replace(/ --integrity '[0-9a-f]{64}'/, '')
  fs.writeFileSync(file, JSON.stringify(settings, null, 2))
}

const wiredMarks = (core: BrokerCore) =>
  core.events.since(0, 500).filter(row => row.meta?.event === INTEGRITY_WIRED_SINCE)

describe('TP-4341: an unarmed launch is accepted once, as the migration to a wired ledger', () => {
  it('admits a coordinator an unwired broker launched before the first wired start', async () => {
    const { root } = syntheticHome()
    const lead = await unwiredLead(root)
    await new Promise(resolve => setTimeout(resolve, 20))
    const wired = broker(root)

    const child = await spawnUnder(wired.supervisor, root, 'child', lead)

    expect(child).not.toMatch(/^refused/)
    expect(wired.server.integrity.parentOf(lead)).toBe(HUMAN_ROOT)
  })

  it('quarantines a coordinator whose nonce was stripped after the first wired start, mtime backdated', async () => {
    const wired = await setup()
    stripNonce(wired.lead)
    // touch -d sets mtime, never ctime, so the ctime half of the check still sees the rewrite.
    fs.utimesSync(hookSettingsPath(wired.lead), new Date(0), new Date(0))
    const after = restarted(wired)

    const child = await after.spawn('child', wired.lead)

    expect(child).toMatch(/^refused: .*quarantined/)
    expect(after.server.integrity.verdict(wired.lead)).toMatchObject({
      reason: 'quarantined',
      field: 'unarmed since wiring',
    })
  })

  it('keeps the first mark through later restarts', async () => {
    const wired = await setup()
    const mark = wired.core.events.integrityWiredSince()
    await new Promise(resolve => setTimeout(resolve, 20))

    const after = restarted(wired)

    expect(mark).toBeDefined()
    expect(after.core.events.integrityWiredSince()).toBe(mark)
    expect(wiredMarks(after.core)).toHaveLength(1)
  })
})
