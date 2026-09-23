import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  isTerminalExecutionPhase,
  type ExecutionRecord,
  type ExecutionTransition,
} from '@titan-design/agent-protocol'
import { gather } from '../agents/ledger/verifier.js'
import { classify } from '../agents/ledger/verify.js'
import { openShadowLedger, type ShadowLedger } from '../agents/ledger/shadow-ledger.js'
import { transcriptPath } from '../agents/transcript.js'
import type { AgentProfile } from '../agents/types.js'
import type { Conn } from '../broker/core.js'
import type { EventLog } from '../broker/event-log.js'
import {
  startSupervisor,
  type HarnessOptions,
  type RestartHarness,
  type SurfaceSpawn,
} from './helpers/restart-harness.js'

/**
 * CC-118 slice 2: resume, teleport and mode switch continue an agent, and each
 * continuation closes the execution it supersedes and opens its own. Assertions
 * read the ledger over a second, read-only connection, as in slice 1's suite.
 */

const harnesses: RestartHarness[] = []
const readers: DatabaseSync[] = []
const tmpDirs: string[] = []

afterEach(() => {
  for (const reader of readers.splice(0)) reader.close()
  for (const h of harnesses.splice(0)) h.close()
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

const shadowOver = (events: EventLog): ShadowLedger =>
  openShadowLedger(events.ledgerHandle(), { supervisorId: 'agent-chat@test' })

function start(options: HarnessOptions = {}): RestartHarness {
  const h = startSupervisor({ ledger: shadowOver, ...options })
  harnesses.push(h)
  return h
}

/** Shadow writes are promise chains with no timers, so draining microtasks settles them. */
async function drain(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-continuations-'))
  tmpDirs.push(dir)
  return dir
}

function records(h: RestartHarness): ExecutionRecord[] {
  const db = new DatabaseSync(path.join(h.home, 'events.db'), { readOnly: true })
  readers.push(db)
  const rows = db.prepare('SELECT record FROM agent_execution ORDER BY prepared_at, rowid').all()
  return rows.map(row => JSON.parse(String(row.record)) as ExecutionRecord)
}

const active = (h: RestartHarness): ExecutionRecord[] =>
  records(h).filter(record => !isTerminalExecutionPhase(record.phase))

function shadowErrors(h: RestartHarness): string[] {
  const log = path.join(h.home, 'broker.log')
  if (!fs.existsSync(log)) return []
  return fs
    .readFileSync(log, 'utf8')
    .split('\n')
    .filter(line => line.includes('ledger_shadow_error'))
}

/** A headless child whose exit the test decides; every launch reuses it. */
function exitingChild() {
  let onExit: ((code: number | null, signal: string | null) => void) | undefined
  const spawn = () => ({
    pid: 4243,
    unref: () => undefined,
    once: (event: string, listener: (code: number | null, signal: string | null) => void) => {
      if (event === 'exit') onExit = listener
    },
  })
  return {
    spawn: spawn as unknown as SurfaceSpawn,
    exit: (code: number | null, signal: string | null = null) => onExit?.(code, signal),
  }
}

/** A finished agent on its own account dir, with a transcript on disk so it can be resumed. */
async function finishedAgent(h: RestartHarness, child: ReturnType<typeof exitingChild>) {
  const configDir = tmpDir()
  const spawned = await h.supervisor.spawn({
    name: 'scout',
    profile: 'explorer',
    brief: 'continuations',
    requestedBy: 'human',
    cwd: tmpDir(),
    isolation: 'none',
    surface: 'headless',
    spawnerConfigDir: configDir,
  })
  expect(spawned.ok).toBe(true)
  child.exit(0)
  await drain()
  const agent = h.core.agents.get(String(spawned.agentId))
  if (!agent) throw new Error('no identity for the spawned agent')
  const file = transcriptPath(agent.cwd, agent.sessionId, agent.configDir)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '{}\n')
  return { agentId: agent.agentId, sessionId: agent.sessionId, configDir }
}

const inheritedProfile: AgentProfile = {
  name: 'inherited',
  description: '',
  model: '',
  allowedTools: [],
  isolation: 'none',
  surface: 'headless',
  promptPrelude: '',
}

/** The rows `teleport.ts` writes around its relaunch: handoff, retire, then the descendant launches. */
async function teleport(h: RestartHarness, predecessorId: string, descendantId: string): Promise<void> {
  const successor = { successor: descendantId }
  h.core.append({ kind: 'agent_handoff', actor: 'scout', ref: predecessorId, body: 'notes', meta: successor })
  h.core.append({ kind: 'agent_retired', actor: 'agent-chat', target: 'scout', ref: predecessorId })
  await h.supervisor.relaunch({
    agentId: descendantId,
    name: 'scout',
    profile: inheritedProfile,
    brief: 'carry on',
    cwd: tmpDir(),
    surface: 'headless',
    preamble: 'you are the continuation',
    meta: { teleport_from: predecessorId },
    inheritedFrom: predecessorId,
  })
}

describe('resume', () => {
  it('resume opens a second execution with target resume and the same agentId', async () => {
    const child = exitingChild()
    const h = start({ spawn: child.spawn })
    const agent = await finishedAgent(h, child)

    const resumed = await h.supervisor.resume('scout')
    await drain()
    // The attach from the agent's first life says nothing about the resumed process.
    const beforeAttach = records(h)[1]?.phase
    h.core.append({ kind: 'agent_attached', actor: 'scout', ref: agent.agentId })
    await drain()

    expect(resumed.ok).toBe(true)
    expect(beforeAttach).toBe('dispatching')
    const [first, second] = records(h)
    expect(first).toMatchObject({ phase: 'succeeded', requestKey: `spawn:${agent.agentId}` })
    expect(second).toMatchObject({
      phase: 'running',
      agent: { agentId: agent.agentId },
      requestKey: expect.stringMatching(new RegExp(`^resume:${agent.agentId}:\\d+$`)),
      target: {
        kind: 'resume',
        conversation: { harness: 'claude-code', namespace: agent.configDir, nativeId: agent.sessionId },
      },
    })
    expect(shadowErrors(h)).toEqual([])
  })

  it('two resumes get distinct request keys', async () => {
    const child = exitingChild()
    const h = start({ spawn: child.spawn })
    await finishedAgent(h, child)

    expect((await h.supervisor.resume('scout')).ok).toBe(true)
    child.exit(0)
    await drain()
    expect((await h.supervisor.resume('scout')).ok).toBe(true)
    await drain()

    const keys = records(h).map(record => record.requestKey)
    expect(keys).toHaveLength(3)
    expect(new Set(keys).size).toBe(3)
    expect(active(h)).toHaveLength(1)
  })

  it('a resume whose launch throws finishes its execution failed', async () => {
    const child = exitingChild()
    const h = start({ spawn: child.spawn })
    await finishedAgent(h, child)
    const broken = (() => {
      throw new Error('no claude on PATH')
    }) as unknown as SurfaceSpawn
    h.restart({ ledger: shadowOver, spawn: broken })

    const resumed = await h.supervisor.resume('scout')
    await drain()

    expect(resumed.ok).toBe(false)
    expect(records(h)[1]?.terminal).toMatchObject({
      outcome: 'failed',
      reason: expect.stringMatching(/^resume failed: /),
    })
  })
})

/** The broker dies after the predecessor's finish is written and before the successor's prepare is. */
const diesBeforeSuccessor =
  (successorId: string) =>
  (events: EventLog): ShadowLedger => {
    const real = shadowOver(events)
    const apply = (t: ExecutionTransition): Promise<void> =>
      t.kind === 'prepare' && t.agent?.agentId === successorId ? new Promise(() => undefined) : real.apply(t)
    return new Proxy(real, {
      get: (target, key) => (key === 'apply' ? apply : Reflect.get(target, key, target)),
    })
  }

async function divergences(h: RestartHarness) {
  const db = new DatabaseSync(path.join(h.home, 'events.db'), { readOnly: true })
  readers.push(db)
  const broker = { liveIds: () => h.supervisor.liveIds(), slotIds: () => h.supervisor.slotIds(), bootAt: 0 }
  const { input } = await gather({ db, events: h.core.events, broker, list: () => Promise.resolve(null) })
  return classify(input).map(item => ({ class: item.class, id: item.id, unclassified: item.unclassified }))
}

describe('teleport', () => {
  it('teleport finishes the predecessor cancelled and leaves exactly one active row for the name', async () => {
    const h = start()
    const predecessor = String((await h.spawnAgent('scout')).agentId)
    await drain()

    await teleport(h, predecessor, 'descendant-1')
    await drain()

    const [before, after] = records(h)
    expect(before).toMatchObject({
      agent: { agentId: predecessor },
      terminal: { outcome: 'cancelled', reason: 'superseded by teleport' },
    })
    expect(after).toMatchObject({ agent: { agentId: 'descendant-1' }, requestKey: 'spawn:descendant-1' })
    expect(active(h).map(record => record.agent?.agentId)).toEqual(['descendant-1'])
    expect(active(h)[0]?.phase).toBe('running')
  })

  it('a restart between predecessor finish and successor prepare is a classified divergence, not an error', async () => {
    const h = start({ ledger: diesBeforeSuccessor('descendant-1') })
    const predecessor = String((await h.spawnAgent('scout')).agentId)
    await drain()
    await teleport(h, predecessor, 'descendant-1')
    await drain()
    const beforeRestart = await divergences(h)

    h.restart({ ledger: shadowOver })
    h.reattach(['scout'])
    await drain()
    const afterRestart = await divergences(h)

    expect(records(h)).toHaveLength(1)
    expect(records(h)[0]).toMatchObject({
      agent: { agentId: predecessor },
      terminal: { outcome: 'cancelled', reason: 'superseded by teleport' },
    })
    // No unclassified item, so `doctor lifecycle` exits 0 on this state.
    expect(beforeRestart).toEqual([
      { class: 'teleport_half_written', id: 'descendant-1', unclassified: false },
    ])
    // The new broker does not hold the successor; it holds only the slot its reattach adopted.
    expect(afterRestart).toEqual([
      { class: 'slot_reattached_no_row', id: 'descendant-1', unclassified: false },
    ])
    expect(shadowErrors(h)).toEqual([])
  })
})

describe('mode switch', () => {
  const iterm = (script: string): Promise<string> =>
    Promise.resolve(script.includes('is running') ? 'true' : 'fake-pane-uuid')

  async function surface(h: RestartHarness): Promise<string> {
    const agentId = String((await h.spawnAgent('scout')).agentId)
    await drain()
    const switched = await h.supervisor.switchSurface({
      name: 'scout',
      to: 'interactive',
      requestedBy: 'human',
    })
    expect(switched.ok).toBe(true)
    h.core.append({ kind: 'agent_attached', actor: 'scout', ref: agentId })
    await drain()
    return agentId
  }

  it('mode switch finishes the first execution cancelled and opens a second', async () => {
    vi.spyOn(process, 'kill').mockImplementation(() => true)
    const h = start({ appleScript: iterm })

    const agentId = await surface(h)

    const [first, second] = records(h)
    expect(first).toMatchObject({
      agent: { agentId },
      terminal: { outcome: 'cancelled', reason: 'mode switch' },
    })
    expect(second).toMatchObject({ agent: { agentId }, phase: 'running', target: { kind: 'resume' } })
    expect(active(h)).toHaveLength(1)
    expect(shadowErrors(h)).toEqual([])
  })

  it('a stopped process whose exit lands before the relaunch still finishes cancelled for the mode switch', async () => {
    vi.spyOn(process, 'kill').mockImplementation(() => true)
    const child = exitingChild()
    const h = start({ appleScript: iterm, spawn: child.spawn })
    const agentId = String((await h.spawnAgent('scout')).agentId)
    // The stopped session holds its name until its socket goes, so the switch waits for the exit.
    const conn = {} as unknown as Conn
    h.core.register(conn, { t: 'register', name: 'scout', workingOn: 'x', cwd: tmpDir(), pid: 1 })

    const switching = h.supervisor.switchSurface({ name: 'scout', to: 'interactive', requestedBy: 'human' })
    child.exit(null, 'SIGTERM')
    await drain()
    h.core.drop(conn)
    expect((await switching).ok).toBe(true)
    await drain()

    const kinds = h.core.events.agentEvents().map(row => row.kind)
    expect(kinds.indexOf('agent_exited')).toBeLessThan(kinds.indexOf('agent_resumed'))
    expect(records(h)[0]).toMatchObject({
      agent: { agentId },
      terminal: { outcome: 'cancelled', reason: 'mode switch' },
    })
    expect(active(h)).toHaveLength(1)
  })
})
