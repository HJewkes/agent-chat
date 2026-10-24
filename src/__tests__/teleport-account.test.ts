import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { SocketServer } from '../broker/socket.js'
import { RELAUNCH_RETRY_MS, type Supervisor } from '../agents/supervisor.js'
import { moveTranscript } from '../agents/account-move.js'
import { planPath } from '../agents/launch-files.js'
import { PANE_EXIT_TIMEOUT_MS } from '../agents/teleport.js'
import { realAccountMoves, type AccountMoves } from '../agents/teleport-account.js'
import { transcriptPath } from '../agents/transcript.js'
import type { LaunchPlan } from '../agents/types.js'
import type { SeatTeleportDeps } from '../agents/seats/teleport-state.js'
import type { ClientMessage, ServerMessage, Subscription } from '../protocol.js'
import { autoAttach } from './broker-harness.js'

/**
 * CC-892 S2: the human moves a live session to another account. The real socket handler and
 * supervisor run; the account reads are faked, the transcript move is real on temp dirs, and the
 * only OS boundaries, `process.kill` and the launch, are faked.
 */

const SESSION = '0f1e2d3c-4b5a-6978-8091-a2b3c4d5e6f7'
const HOST_PID = 9999
const SUBSCRIPTIONS: Subscription[] = [{ selector: { all: true }, kinds: ['registered'] }]

const tmpDirs: string[] = []
let realHome: string | undefined
let core: BrokerCore
let server: SocketServer
let stopAutoAttach: () => void
let signals: string[]
let subjectConn: Conn
let subjectReplies: ServerMessage[]
let fromDir: string
let toDir: string
let cwd: string
let checked: number
/** The predecessor's Claude Code ignores every signal. */
let neverExits: boolean

function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

function connection(): { conn: Conn; replies: ServerMessage[] } {
  const replies: ServerMessage[] = []
  const write = (chunk: string) => {
    for (const line of chunk.split('\n').filter(Boolean)) replies.push(JSON.parse(line) as ServerMessage)
    return true
  }
  return { conn: { write, end: () => undefined } as unknown as Conn, replies }
}

/** The account reads a test controls; the transcript move is the real one. */
function fakeAccounts(refusals: string[] = []): AccountMoves {
  return {
    resolve: account => (account === 'server' ? { dir: toDir } : { error: `unknown account ${account}` }),
    check: () => {
      checked += 1
      return { ok: refusals.length === 0, refusals }
    },
    move: moveTranscript,
  }
}

const isolatedSeatTeleport = (): SeatTeleportDeps => ({
  autonomyRoot: tmp('agent-chat-seat-'),
  now: () => new Date(),
  shepherd: async () => undefined,
})

/** Answers iTerm's "is running" probe; `paneOpens` false makes every pane launch fail. */
const fakeAppleScript =
  (paneOpens: boolean) =>
  (script: string): Promise<string> => {
    if (script.includes('is running')) return Promise.resolve('true')
    return paneOpens ? Promise.resolve('fake-pane-uuid') : Promise.reject(new Error('iTerm refused'))
  }

function startServer(accountMoves: AccountMoves, paneOpens = true): void {
  server = new SocketServer(core, {
    countdownMs: 60_000,
    seatTeleport: isolatedSeatTeleport(),
    argvReader: () => 'claude',
    launcherRunning: async () => false,
    accountMoves,
    surface: {
      platform: 'darwin',
      spawn: () => ({ pid: 4242, unref: () => undefined, once: () => undefined }),
      runAppleScript: fakeAppleScript(paneOpens),
    },
  })
}

function registerSubject(): string {
  const { conn, replies } = connection()
  subjectConn = conn
  subjectReplies = replies
  server.handleMessage(conn, {
    t: 'register',
    name: 'scout',
    workingOn: 'a long investigation',
    cwd,
    pid: 111,
    sessionId: SESSION,
    hostPid: HOST_PID,
    host: os.hostname(),
    tags: ['alpha'],
    subscriptions: SUBSCRIPTIONS,
    observed: { configDir: fromDir },
  })
  const agentId = core.registry.entryFor(conn)?.agentId
  expect(agentId).toBeDefined()
  return agentId as string
}

function writeSourceTranscript(): string {
  const file = transcriptPath(cwd, SESSION, fromDir)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '{"turn":1}\n{"turn":2}\n')
  return file
}

async function moveAs(conn: Conn, replies: ServerMessage[], frame: ClientMessage) {
  server.handleMessage(conn, frame)
  return vi.waitFor(() => {
    const found = replies.find(r => r.t === 'teleport_result')
    if (found === undefined) throw new Error('no teleport_result yet')
    return found as Extract<ServerMessage, { t: 'teleport_result' }>
  })
}

const humanMove = (to = 'server') => {
  const { conn, replies } = connection()
  return moveAs(conn, replies, { t: 'account_move', name: 'scout', to })
}

const kinds = (): string[] => core.events.agentEvents().map(r => r.kind)

const spawnRowFor = (agentId: string) =>
  core.events.agentEvents().find(r => r.kind === 'agent_spawned' && r.msgId === agentId)

const planFor = (agentId: string): LaunchPlan =>
  JSON.parse(fs.readFileSync(planPath(agentId), 'utf8')) as LaunchPlan

async function successorPlan(agentId: string): Promise<LaunchPlan> {
  return vi.waitFor(() => planFor(agentId), { timeout: 5_000 })
}

const supervisorOf = (): Supervisor => (server as unknown as { supervisor: Supervisor }).supervisor

beforeEach(() => {
  realHome = process.env.HOME
  process.env.HOME = tmp('agent-chat-home-')
  const bus = tmp('agent-chat-bus-')
  process.env.AGENT_CHAT_HOME = bus
  process.env.AGENT_CHAT_ACTIVE_WORK_ROOT = path.join(bus, 'active-work')
  fromDir = tmp('agent-chat-from-')
  toDir = tmp('agent-chat-to-')
  cwd = tmp('agent-chat-cwd-')
  checked = 0
  signals = []
  let ended = false
  neverExits = false
  vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: unknown) => {
    if (pid !== HOST_PID) return true
    if (signal === 0) {
      if (ended && !neverExits) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
      return true
    }
    signals.push(String(signal))
    if (!ended) core.drop(subjectConn)
    ended = true
    return true
  })
  core = new BrokerCore(() => undefined, {
    events: new EventLog(path.join(bus, 'events.db')),
    registry: new Registry<Conn>(),
  })
  stopAutoAttach = autoAttach(core)
})

afterEach(() => {
  stopAutoAttach()
  server.close()
  vi.restoreAllMocks()
  vi.useRealTimers()
  if (realHome === undefined) delete process.env.HOME
  else process.env.HOME = realHome
  delete process.env.AGENT_CHAT_HOME
  delete process.env.AGENT_CHAT_ACTIVE_WORK_ROOT
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('an account move refused before anything ends', () => {
  it('refuses an over-ceiling target with no handoff row and no signal', async () => {
    startServer(fakeAccounts(['five_hour 96% is at or over the ceiling of 95%']))
    registerSubject()
    writeSourceTranscript()

    const result = await humanMove()

    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/five_hour 96% is at or over the ceiling of 95%.*scout was not ended/)
    expect(kinds()).not.toContain('agent_handoff')
    expect(signals).toEqual([])
  })

  it('refuses a target on the same login as the source, read from each dir’s own config', async () => {
    const home = tmp('agent-chat-acct-home-')
    fromDir = path.join(home, 'from')
    toDir = path.join(home, 'to')
    const oauth = { oauthAccount: { accountUuid: 'acct-1', organizationUuid: 'org-1' } }
    for (const dir of [fromDir, toDir]) {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify(oauth))
    }
    startServer(realAccountMoves(tmp('agent-chat-root-'), home))
    registerSubject()
    writeSourceTranscript()

    const result = await humanMove(toDir)

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('bills the same Anthropic login')
    expect(kinds()).not.toContain('agent_handoff')
    expect(signals).toEqual([])
  })

  it('refuses account_move from a registered connection, whatever it names', async () => {
    startServer(fakeAccounts())
    registerSubject()
    writeSourceTranscript()
    const { conn, replies } = connection()
    server.handleMessage(conn, {
      t: 'register',
      name: 'impostor',
      workingOn: 'trying it on',
      cwd,
      pid: process.pid,
    })

    const result = await moveAs(conn, replies, { t: 'account_move', name: 'scout', to: 'server' })

    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/human/)
    expect(checked).toBe(0)
    expect(kinds()).not.toContain('agent_handoff')
    expect(signals).toEqual([])
  })

  it('refuses the account reason on a session’s own teleport frame', async () => {
    startServer(fakeAccounts())
    registerSubject()

    const result = await moveAs(subjectConn, subjectReplies, {
      t: 'teleport',
      handoff: 'h',
      reason: 'account',
    } as unknown as ClientMessage)

    expect(result.ok).toBe(false)
    expect(kinds()).not.toContain('agent_handoff')
  })
})

describe('an account move that goes through', () => {
  it('resumes the same session id on the target, carrying tags and subscriptions', async () => {
    startServer(fakeAccounts())
    registerSubject()
    const source = writeSourceTranscript()

    const result = await humanMove()
    const plan = await successorPlan(result.agentId as string)

    expect(result.ok).toBe(true)
    expect(plan.args).toEqual(expect.arrayContaining(['--resume', SESSION]))
    expect(plan.args).not.toContain('--session-id')
    expect(plan.env.CLAUDE_CONFIG_DIR).toBe(toDir)
    expect(plan.env.AGENT_CHAT_TAGS).toBe('alpha')
    expect(JSON.parse(plan.env.AGENT_CHAT_SUBSCRIPTIONS ?? 'null')).toEqual(SUBSCRIPTIONS)
    const row = spawnRowFor(result.agentId as string)
    expect(row?.meta).toMatchObject({ session_id: SESSION, config_dir: toDir, account_from: fromDir })
    expect(fs.readFileSync(transcriptPath(cwd, SESSION, toDir), 'utf8')).toBe('{"turn":1}\n{"turn":2}\n')
    expect(fs.existsSync(source)).toBe(false)
    // A resumed pane opens on the conversation with no prompt typed into it.
    expect(plan.args).not.toContain('--')
  })

  it('records a local successor’s spawn row with no host', async () => {
    startServer(fakeAccounts())
    registerSubject()
    writeSourceTranscript()

    const result = await humanMove()
    await successorPlan(result.agentId as string)

    const row = spawnRowFor(result.agentId as string)
    expect(row).toBeDefined()
    expect(row?.meta).not.toHaveProperty('host')
  })

  it('still moves with an open question the handoff does not name', async () => {
    startServer(fakeAccounts())
    registerSubject()
    writeSourceTranscript()
    core.append({ kind: 'question', actor: 'scout', target: 'human', body: 'merge #12?' })

    const result = await humanMove()

    expect(result.ok).toBe(true)
    expect(kinds()).toContain('agent_handoff')
  })

  it('records the target dir on the handoff row and restates no question there', async () => {
    startServer(fakeAccounts())
    registerSubject()
    writeSourceTranscript()
    core.append({ kind: 'question', actor: 'scout', target: 'human', body: 'merge #12?' })

    const result = await humanMove()

    const row = core.events.agentEvents().find(r => r.kind === 'agent_handoff')
    expect(row?.meta).toMatchObject({ successor: result.agentId, account_to: toDir })
    expect(row?.meta).not.toHaveProperty('questions')
  })

  it('ends the predecessor before the successor is recorded, even with a surface asked for', async () => {
    startServer(fakeAccounts())
    const agentId = registerSubject()
    writeSourceTranscript()

    const result = await supervisorOf().teleport({
      subject: {
        agentId,
        name: 'scout',
        cwd,
        hostPid: HOST_PID,
        host: os.hostname(),
        tags: [],
        subscriptions: [],
        configDir: fromDir,
      },
      handoff: '',
      surface: 'iterm-pane',
      endsSelf: true,
      account: { to: 'server', by: 'human' },
    })
    await successorPlan(result.agentId as string)

    expect(result.ok).toBe(true)
    const rows = core.events.agentEvents()
    const retired = rows.findIndex(r => r.kind === 'agent_retired' && r.ref === agentId)
    const spawned = rows.findIndex(r => r.kind === 'agent_spawned' && r.msgId === result.agentId)
    expect(signals[0]).toBe('SIGTERM')
    expect(retired).toBeGreaterThanOrEqual(0)
    expect(retired).toBeLessThan(spawned)
    const told = await vi.waitFor(() => {
      const note = core.events.inboxFor('scout', 5).find(m => m.text.includes('moved from'))
      if (note === undefined) throw new Error('not told yet')
      return note
    })
    expect(told.from).toBe('agent-chat')
  })

  it('resumes on the old account and tells the human when the transcript cannot move', async () => {
    const accounts = fakeAccounts()
    startServer({ ...accounts, move: () => ({ ok: false, error: 'EBUSY: injected' }) })
    registerSubject()
    writeSourceTranscript()

    const result = await humanMove()
    const plan = await successorPlan(result.agentId as string)

    expect(plan.args).toEqual(expect.arrayContaining(['--resume', SESSION]))
    expect(plan.env.CLAUDE_CONFIG_DIR).toBe(fromDir)
    expect(spawnRowFor(result.agentId as string)?.meta.account_from).toBeUndefined()
    const notices = core.events.humanQueue().map(item => item.text)
    expect(notices.join('\n')).toContain('EBUSY: injected')
  })
})

describe('an account move whose pane cannot open (CC-1372)', () => {
  it('falls back headless, resuming the same id on the target account', async () => {
    stopAutoAttach()
    stopAutoAttach = () => undefined
    startServer(fakeAccounts(), false)
    registerSubject()
    writeSourceTranscript()
    vi.useFakeTimers()

    const result = await humanMove()
    await vi.advanceTimersByTimeAsync(PANE_EXIT_TIMEOUT_MS + 2 * RELAUNCH_RETRY_MS)

    const plan = await vi.waitFor(() => {
      const current = planFor(result.agentId as string)
      if (current.surface !== 'headless') throw new Error('not headless yet')
      return current
    })
    expect(plan.args).toEqual(expect.arrayContaining(['--resume', SESSION]))
    expect(plan.args).not.toContain('--session-id')
    expect(plan.env.CLAUDE_CONFIG_DIR).toBe(toDir)
    expect(spawnRowFor(result.agentId as string)?.meta.session_id).toBe(SESSION)
  })
})

describe('what a moved successor carries into its attach', () => {
  it('stamps account_from on its first agent_attached row only, for the seat file to follow', async () => {
    stopAutoAttach()
    stopAutoAttach = () => undefined
    startServer(fakeAccounts())
    registerSubject()
    writeSourceTranscript()

    const result = await humanMove()
    await successorPlan(result.agentId as string)
    const register = (): void =>
      server.handleMessage(connection().conn, {
        t: 'register',
        name: 'scout',
        workingOn: 'a long investigation',
        cwd,
        pid: 112,
        agentId: result.agentId as string,
      })
    register()
    register()

    const attaches = core.events
      .agentEventsFor(result.agentId as string)
      .filter(r => r.kind === 'agent_attached')
    expect(attaches.map(r => r.meta.account_from)).toEqual([fromDir, undefined])
  })
})

describe('an account move held when the predecessor will not exit', () => {
  it('moves nothing, launches nothing, and tells the human', async () => {
    startServer(fakeAccounts())
    registerSubject()
    const source = writeSourceTranscript()
    neverExits = true
    vi.useFakeTimers()

    const result = await humanMove()
    await vi.advanceTimersByTimeAsync(PANE_EXIT_TIMEOUT_MS + 2_000)

    expect(result.ok).toBe(true)
    expect(signals[0]).toBe('SIGTERM')
    expect(spawnRowFor(result.agentId as string)).toBeUndefined()
    expect(fs.existsSync(planPath(result.agentId as string))).toBe(false)
    expect(fs.existsSync(source)).toBe(true)
    expect(fs.existsSync(transcriptPath(cwd, SESSION, toDir))).toBe(false)
    const notices = core.events.humanQueue().map(item => item.text)
    expect(notices.join('\n')).toMatch(/still running .* no successor was launched/)
  })
})
