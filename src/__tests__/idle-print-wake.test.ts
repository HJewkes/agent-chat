import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type net from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { brokerHost } from '../broker/host-guard.js'
import { Registry } from '../broker/registry.js'
import { Supervisor } from '../agents/supervisor.js'
import { transcriptPath } from '../agents/transcript.js'
import { readLaunchPlan } from '../agents/launch-files.js'
import {
  IDLE_PRINT_WAKE_AFTER_MS,
  IDLE_PRINT_WAKE_EVERY_MS,
  idlePrintWakeDue,
  oldestSpooledAt,
  turnEndedIn,
} from '../agents/idle-print-wake.js'
import { inboxSpoolDir, spoolRecord } from '../server/inbox-spool.js'
import { autoAttach } from './broker-harness.js'

/**
 * CC-1669 S2: a print host idle on a background task, with mail spooled for it, is
 * ended and resumed with that mail as its prompt. Transcripts and spool records are
 * synthetic, written where Claude Code and the MCP server would put them.
 */

const HOST_PID = 4242
const tmpDirs: string[] = []
let core: BrokerCore
let supervisor: Supervisor
let exitChild: (code: number | null, signal: string | null) => void
let terms: number[]
let scoutConn: net.Socket | undefined

const tmp = (prefix: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

const controlledChild = () => ({
  pid: HOST_PID,
  unref: () => undefined,
  once: (event: string, listener: (...args: unknown[]) => void) => {
    if (event === 'exit') exitChild = (code, signal) => listener(code, signal)
  },
})

/** SIGTERM to the host closes its MCP connection and ends the run, as a real `claude -p` does. */
function stubHostKill(): void {
  vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: string | number) => {
    if (pid !== HOST_PID || signal !== 'SIGTERM') return true
    terms.push(pid)
    if (scoutConn !== undefined) core.drop(scoutConn)
    scoutConn = undefined
    queueMicrotask(() => exitChild(null, 'SIGTERM'))
    return true
  })
}

beforeEach(() => {
  process.env.AGENT_CHAT_HOME = tmp('agent-chat-idlewake-')
  terms = []
  scoutConn = undefined
  const events = new EventLog(path.join(process.env.AGENT_CHAT_HOME, 'events.db'))
  core = new BrokerCore(() => undefined, { events, registry: new Registry<Conn>(Date.now, () => 'yes') })
  autoAttachStop = autoAttach(core)
  stubHostKill()
  supervisor = new Supervisor(core, {
    surface: { platform: 'linux', spawn: controlledChild },
    nameFreeMs: 200,
  })
})

let autoAttachStop: () => void

afterEach(() => {
  autoAttachStop()
  supervisor.close()
  vi.restoreAllMocks()
  delete process.env.AGENT_CHAT_HOME
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

async function spawnScout(): Promise<string> {
  core.register({} as unknown as net.Socket, {
    t: 'register',
    name: 'coord',
    workingOn: '',
    cwd: tmp('agent-chat-coord-'),
    pid: 1,
  })
  const result = await supervisor.spawn({
    name: 'scout',
    profile: 'explorer',
    brief: 'do the task',
    requestedBy: 'coord',
    cwd: tmp('agent-chat-ws-'),
    isolation: 'none',
    surface: 'headless',
    spawnerConfigDir: tmp('agent-chat-account-'),
  })
  expect(result.ok).toBe(true)
  const agentId = result.agentId as string
  await vi.waitFor(() => expect(core.agents.get(agentId)?.state).toBe('live'))
  return agentId
}

/** The scout's own MCP server registering; `print` is what the S1 launcher env makes it say. */
function registerScout(agentId: string, hostMode?: 'print'): void {
  scoutConn = {} as unknown as net.Socket
  const registered = core.register(scoutConn, {
    t: 'register',
    name: 'scout',
    workingOn: 'x',
    cwd: '/tmp',
    pid: 2,
    hostPid: HOST_PID,
    host: brokerHost(),
    agentId,
    inboxSpool: true,
    ...(hostMode === undefined ? {} : { hostMode }),
  })
  expect(registered.ok).toBe(true)
}

function writeTranscript(agentId: string, records: object[]): void {
  const agent = core.agents.get(agentId)!
  const file = transcriptPath(agent.cwd, agent.sessionId, agent.configDir)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, records.map(r => JSON.stringify(r)).join('\n') + '\n')
}

const backgroundStarted = [
  {
    type: 'assistant',
    message: {
      stop_reason: 'tool_use',
      content: [
        { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test', run_in_background: true } },
      ],
    },
  },
  {
    type: 'user',
    message: {
      content: [
        { type: 'tool_result', tool_use_id: 't1', content: 'Command running in background with ID: b7' },
      ],
    },
  },
]

const endedOnBackground = [
  ...backgroundStarted,
  {
    type: 'assistant',
    message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Suite running.' }] },
  },
  { type: 'system', subtype: 'stop_hook_summary' },
]

const toolInFlight = [
  ...backgroundStarted,
  {
    type: 'assistant',
    message: {
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm run build' } }],
    },
  },
]

function spoolWake(agentId: string, msgId: string, arrivedAt: number): void {
  const record = {
    kind: 'message' as const,
    msgId,
    meta: { from: 'shepherd', msg_id: msgId },
    text: `wake ${msgId}`,
  }
  expect(spoolRecord(inboxSpoolDir(agentId), record, { now: () => arrivedAt })).toBe(true)
}

const resumes = () => core.events.agentEvents().filter(r => r.kind === 'agent_resumed')
const shown = () => core.events.history(500).filter(r => r.kind === 'inbox_shown')
const spoolLeft = (agentId: string): string[] => {
  const dir = inboxSpoolDir(agentId)
  const claimed = path.join(dir, '.claimed')
  return [...fs.readdirSync(dir), ...(fs.existsSync(claimed) ? fs.readdirSync(claimed) : [])].filter(
    n => n !== '.claimed',
  )
}

describe('an idle print host with a waiting message', () => {
  it('is ended and resumed with the message as its prompt, within the minute', async () => {
    const agentId = await spawnScout()
    registerScout(agentId, 'print')
    writeTranscript(agentId, endedOnBackground)
    const arrivedAt = Date.now() - IDLE_PRINT_WAKE_AFTER_MS
    spoolWake(agentId, 'm-wake-1', arrivedAt)
    spoolWake(agentId, 'm-wake-2', arrivedAt + 1)

    expect(supervisor.wakeIdlePrintHosts()).toEqual(['scout'])

    await vi.waitFor(() => expect(resumes()).toHaveLength(1))
    expect(Date.now() - arrivedAt).toBeLessThan(60_000)
    expect(terms).toEqual([HOST_PID])
    expect(resumes()[0]?.meta.cause).toBe('idle-print-wake')
    expect(resumes()[0]?.actor).toBe('coord')
    const prompt = readLaunchPlan(agentId).stdin ?? ''
    expect(prompt.match(/wake m-wake-1/g)).toHaveLength(1)
    expect(prompt.match(/wake m-wake-2/g)).toHaveLength(1)
    expect(spoolLeft(agentId)).toEqual([])
    expect(shown().map(r => r.meta.msgIds)).toEqual(['m-wake-1,m-wake-2'])
  })

  it('keeps the message in the spool and tells the spawner when the resume is refused', async () => {
    const agentId = await spawnScout()
    registerScout(agentId, 'print')
    writeTranscript(agentId, endedOnBackground)
    spoolWake(agentId, 'm-kept', Date.now() - IDLE_PRINT_WAKE_AFTER_MS)
    const agent = core.agents.get(agentId)!

    expect(supervisor.wakeIdlePrintHosts()).toEqual(['scout'])
    fs.rmSync(transcriptPath(agent.cwd, agent.sessionId, agent.configDir))

    await vi.waitFor(() =>
      expect(core.events.history(500).some(r => r.meta.event === 'idle-print-wake')).toBe(true),
    )
    expect(resumes()).toEqual([])
    expect(oldestSpooledAt(inboxSpoolDir(agentId))).toBeDefined()
    expect(shown()).toEqual([])
  })

  it('is not woken while the message is younger than the threshold', async () => {
    const agentId = await spawnScout()
    registerScout(agentId, 'print')
    writeTranscript(agentId, endedOnBackground)
    spoolWake(agentId, 'm-fresh', Date.now())

    expect(supervisor.wakeIdlePrintHosts()).toEqual([])
    expect(terms).toEqual([])
  })
})

describe('hosts the wake leaves alone', () => {
  it('leaves a print host with a tool call in flight running', async () => {
    const agentId = await spawnScout()
    registerScout(agentId, 'print')
    writeTranscript(agentId, toolInFlight)
    spoolWake(agentId, 'm-mid', Date.now() - 5 * IDLE_PRINT_WAKE_AFTER_MS)

    expect(supervisor.wakeIdlePrintHosts()).toEqual([])
    expect(terms).toEqual([])
    expect(resumes()).toEqual([])
    expect(spoolLeft(agentId)).toHaveLength(1)
  })

  it('leaves a host that is not in print mode running', async () => {
    const agentId = await spawnScout()
    registerScout(agentId)
    writeTranscript(agentId, endedOnBackground)
    spoolWake(agentId, 'm-interactive', Date.now() - 5 * IDLE_PRINT_WAKE_AFTER_MS)

    expect(supervisor.wakeIdlePrintHosts()).toEqual([])
    expect(terms).toEqual([])
    expect(resumes()).toEqual([])
  })
})

describe('the idle print wake decision', () => {
  it('lands inside the 60 s done_when at the worst tick phase', () => {
    expect(IDLE_PRINT_WAKE_AFTER_MS + IDLE_PRINT_WAKE_EVERY_MS).toBeLessThan(60_000)
  })

  it.each([
    [undefined, true, 60_000, false],
    [0, false, 60_000, false],
    [0, true, IDLE_PRINT_WAKE_AFTER_MS - 1, false],
    [0, true, IDLE_PRINT_WAKE_AFTER_MS, true],
  ] as const)('spooled at %s, turn ended %s, now %s is due: %s', (spooledAt, turnEnded, now, due) => {
    expect(idlePrintWakeDue({ spooledAt, turnEnded, now })).toBe(due)
  })

  it('reads a turn as ended only when the last main-thread message ended it', () => {
    const lines = (rows: object[]) => rows.map(r => JSON.stringify(r)).join('\n')
    const sidechain = { type: 'user', isSidechain: true, message: { content: 'sub' } }

    expect(turnEndedIn(lines(endedOnBackground))).toBe(true)
    expect(turnEndedIn(lines([...endedOnBackground, sidechain]))).toBe(true)
    expect(turnEndedIn(lines(toolInFlight))).toBe(false)
    expect(turnEndedIn(lines([...endedOnBackground, { type: 'user', message: { content: 'next' } }]))).toBe(
      false,
    )
    expect(turnEndedIn('not json')).toBe(false)
  })

  it('finds the oldest spooled record by its file name', () => {
    const dir = tmp('agent-chat-spool-')
    fs.writeFileSync(path.join(dir, '0000000002000-000000002-b.json'), '{}')
    fs.writeFileSync(path.join(dir, '0000000001000-000000001-a.json'), '{}')
    fs.writeFileSync(path.join(dir, '.0000000000500-x.json.1.tmp'), '')

    expect(oldestSpooledAt(dir)).toBe(1000)
    expect(oldestSpooledAt(path.join(dir, 'missing'))).toBeUndefined()
  })
})
