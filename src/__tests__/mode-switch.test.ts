import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type net from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { Supervisor } from '../agents/supervisor.js'
import { buildLaunchPlan } from '../agents/launch-plan.js'
import { planPath } from '../agents/launch-files.js'
import { foldAgent } from '../agents/identity.js'
import type { AgentEventRow } from '../broker/event-log.js'
import {
  checkBackgroundable,
  checkSurfaceable,
  placementFor,
  SURFACED_NOTICE,
} from '../agents/mode-switch.js'
import type { AgentIdentity } from '../protocol.js'
import type { AgentProfile, LaunchPlan } from '../agents/types.js'

/**
 * CC-23 — moving a running agent between headless and a terminal, both ways.
 *
 * What is being proved is that a switch is a CONTINUATION and not a second
 * agent: same identity, same name, same conversation, different presentation.
 * That is the whole difference from teleport, which mints a new conversation and
 * carries a written handoff across the gap.
 *
 * Nothing here launches a process or signals one. `process.kill` and the spawn
 * used by the headless surface are the two OS boundaries and both are faked; a
 * test that really signalled would be killing whatever pid it invented.
 */

const tmpDirs: string[] = []
let core: BrokerCore
let supervisor: Supervisor
let killed: Array<{ pid: number; signal: string }>
let delivered: Array<{ conn: Conn; text: string }>

function makeCore(): BrokerCore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-switch-'))
  tmpDirs.push(dir)
  process.env.AGENT_CHAT_HOME = dir
  return new BrokerCore((conn, message) => delivered.push({ conn, text: message.text }), {
    events: new EventLog(path.join(dir, 'events.db')),
    registry: new Registry<Conn>(),
  })
}

function workspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-ws-'))
  tmpDirs.push(dir)
  return dir
}

/** Launches nothing: iTerm is faked, so no window opens on whoever runs the suite. */
function makeSupervisor(): Supervisor {
  supervisor = new Supervisor(core, {
    nameFreeMs: 200,
    surface: {
      platform: 'darwin',
      spawn: () => ({ pid: 4242, unref: () => undefined, once: () => undefined }),
      runAppleScript: script => Promise.resolve(script.includes('is running') ? 'true' : 'fake-pane-uuid'),
    },
  })
  return supervisor
}

async function spawnAgent(over: Record<string, unknown> = {}): Promise<string> {
  const result = await supervisor.spawn({
    name: 'scout',
    profile: 'explorer',
    brief: 'read the log',
    requestedBy: 'human',
    cwd: workspace(),
    isolation: 'none',
    surface: 'headless',
    ...over,
  })
  expect(result.ok).toBe(true)
  return result.agentId as string
}

const planFor = (agentId: string): LaunchPlan =>
  JSON.parse(fs.readFileSync(planPath(agentId), 'utf8')) as LaunchPlan

const rowsFor = (agentId: string): AgentEventRow[] =>
  core.events.agentEvents().filter(r => r.ref === agentId || r.msgId === agentId)

const resumedRow = (agentId: string) => rowsFor(agentId).find(r => r.kind === 'agent_resumed')

const fakeConn = (): Conn => ({}) as unknown as net.Socket

const profile: AgentProfile = {
  name: 'explorer',
  description: 'test',
  model: 'sonnet',
  allowedTools: ['Read'],
  isolation: 'none',
  surface: 'headless',
  promptPrelude: '',
}

const identity = (over: Partial<AgentIdentity> = {}): AgentIdentity =>
  ({
    agentId: 'a1',
    name: 'scout',
    profile: 'explorer',
    state: 'live',
    origin: 'spawned',
    spawnedBy: 'human',
    spawnedAt: 1,
    brief: '',
    cwd: '/tmp',
    isolation: 'none',
    surface: 'headless',
    sessionId: 'sess-1',
    lastEventAt: 1,
    generation: 1,
    ...over,
  }) as AgentIdentity

beforeEach(() => {
  killed = []
  delivered = []
  vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: unknown) => {
    killed.push({ pid, signal: String(signal) })
    return true
  })
  core = makeCore()
  makeSupervisor()
})

afterEach(() => {
  supervisor?.close()
  vi.restoreAllMocks()
  delete process.env.AGENT_CHAT_HOME
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('the launch plan for a resume', () => {
  const base = {
    agentId: 'a1',
    sessionId: 'sess-1',
    name: 'scout',
    profile,
    brief: 'the original task',
    cwd: '/tmp',
    mcpConfigPath: '/tmp/mcp.json',
  }

  it('reattaches to the conversation instead of minting one', () => {
    const plan = buildLaunchPlan({ ...base, resume: true, surface: 'iterm-pane' })
    expect(plan.args).toContain('--resume')
    expect(plan.args).not.toContain('--session-id')
    expect(plan.args[plan.args.indexOf('--resume') + 1]).toBe('sess-1')
  })

  it('still mints one when this is not a resume, which is every ordinary spawn', () => {
    const plan = buildLaunchPlan({ ...base, surface: 'iterm-pane' })
    expect(plan.args).toContain('--session-id')
    expect(plan.args).not.toContain('--resume')
  })

  /**
   * The pane must open on the conversation as it stands. Injecting a turn would
   * answer the pending tool call on the human's behalf — and a pending tool call
   * nobody could answer is the entire reason surfacing exists.
   */
  it('gives an interactive resume no prompt to start on', () => {
    const plan = buildLaunchPlan({ ...base, resume: true, surface: 'iterm-pane' })
    expect(plan.args).not.toContain('--')
    expect(plan.args).not.toContain('the original task')
  })

  /** `-p` refuses without input, so the headless direction must still carry one. */
  it('keeps a prompt on the headless direction, because -p refuses without one', () => {
    const plan = buildLaunchPlan({ ...base, resume: true, surface: 'headless', brief: 'carry on' })
    expect(plan.args).toContain('-p')
    expect(plan.stdin).toBe('carry on')
  })
})

describe('who may switch what', () => {
  it('sends a surfaced agent beside its requester when the requester has a window', () => {
    expect(placementFor('w0t1p2:UUID')).toBe('iterm-pane')
  })

  it('gives a background agent surfacing itself its own window to open', () => {
    expect(placementFor(undefined)).toBe('iterm-tab')
  })

  it('refuses to surface an agent that is already in a terminal', () => {
    expect(checkSurfaceable(identity({ surface: 'iterm-pane' }), 'scout')).toMatch(/already in a terminal/)
  })

  it('refuses to background an agent that is already headless', () => {
    expect(checkBackgroundable(identity(), 'scout', 999)).toMatch(/already running headless/)
  })

  /**
   * An ordinary session has no launch plan to rebuild it from. Refused with the
   * alternative named, rather than failing later inside `readLaunchPlan`.
   */
  it('refuses either direction for a session the broker did not launch', () => {
    const adopted = identity({ origin: 'adopted' })
    expect(checkSurfaceable(adopted, 'scout')).toMatch(/agent_teleport/)
    expect(checkBackgroundable({ ...adopted, surface: 'iterm-pane' }, 'scout', 9)).toMatch(/agent_teleport/)
  })

  /**
   * Signalling the MCP subprocess rather than Claude Code severs the bus and
   * leaves a live session no peer can reach and that cannot tell — the failure
   * teleport §5.1 measured. Refused rather than approximated.
   */
  it('refuses to background a session that never reported the pid of Claude Code', () => {
    expect(checkBackgroundable(identity({ surface: 'iterm-pane' }), 'scout', undefined)).toMatch(
      /pid of Claude Code/,
    )
  })

  it('refuses anything already retired', () => {
    expect(checkSurfaceable(identity({ state: 'retired' }), 'scout')).toMatch(/retired/)
  })
})

describe('the roster after a switch', () => {
  const spawnRow = (over: Partial<AgentEventRow> = {}): AgentEventRow =>
    ({
      kind: 'agent_spawned',
      msgId: 'a1',
      actor: 'human',
      target: 'scout',
      ts: 1,
      meta: { name: 'scout', surface: 'headless', session_id: 'sess-1' },
      ...over,
    }) as AgentEventRow

  /**
   * Presentation is not fixed at spawn. Without this the roster keeps reporting
   * the surface an agent had when it started, which is the half of CC-23's
   * done_when that says it keeps its place in the roster across the switch.
   */
  it('reports where the agent is NOW, not where it started', () => {
    const agent = foldAgent([
      spawnRow(),
      {
        kind: 'agent_resumed',
        ref: 'a1',
        actor: 'human',
        ts: 2,
        meta: { surface: 'iterm-pane' },
      } as unknown as AgentEventRow,
    ])
    expect(agent?.surface).toBe('iterm-pane')
    expect(agent?.agentId).toBe('a1')
    expect(agent?.name).toBe('scout')
  })

  it('leaves the surface alone on an ordinary resume, which does not carry one', () => {
    const agent = foldAgent([
      spawnRow(),
      { kind: 'agent_resumed', ref: 'a1', actor: 'human', ts: 2, meta: {} } as unknown as AgentEventRow,
    ])
    expect(agent?.surface).toBe('headless')
  })
})

describe('surfacing a headless agent', () => {
  it('keeps the identity, the name and the conversation', async () => {
    const agentId = await spawnAgent()
    const before = core.agents.get(agentId)

    const result = await supervisor.switchSurface({
      name: 'scout',
      to: 'interactive',
      requestedBy: 'coordinator',
      anchor: 'w0t1p2:UUID',
    })

    expect(result.ok).toBe(true)
    expect(result.agentId).toBe(agentId)
    expect(result.name).toBe('scout')
    // The same conversation, not a new one: this is what makes it a switch.
    expect(planFor(agentId).args).toContain('--resume')
    expect(planFor(agentId).args).toContain(before?.sessionId)
  })

  it('records where it went, so the roster stops reporting the old surface', async () => {
    const agentId = await spawnAgent()
    await supervisor.switchSurface({
      name: 'scout',
      to: 'interactive',
      requestedBy: 'coordinator',
      anchor: 'w0t1p2:UUID',
    })

    expect(resumedRow(agentId)?.meta.surface).toBe('iterm-pane')
    expect(resumedRow(agentId)?.meta.from_surface).toBe('headless')
    expect(core.agents.get(agentId)?.surface).toBe('iterm-pane')
  })

  it('stops the old process rather than leaving two on one name', async () => {
    await spawnAgent()
    await supervisor.switchSurface({ name: 'scout', to: 'interactive', requestedBy: 'human' })
    expect(killed.map(k => k.pid)).toContain(4242)
  })

  /**
   * A `notice` would not do: notices are not pushed and are not an inbox kind, so
   * one aimed at a session is simply never seen — the defect the teleport live
   * runs found, and the same trap is open here.
   */
  it('tells the agent what happened to it, on a kind that is actually delivered', async () => {
    await spawnAgent()
    const conn = fakeConn()
    core.register(conn, { t: 'register', name: 'scout', workingOn: 'x', cwd: workspace(), pid: 1 })
    await supervisor.switchSurface({ name: 'scout', to: 'interactive', requestedBy: 'human' })
    expect(delivered.some(d => d.text === SURFACED_NOTICE)).toBe(true)
  })

  it('refuses a name nothing holds', async () => {
    const result = await supervisor.switchSurface({ name: 'nobody', to: 'interactive', requestedBy: 'human' })
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/no agent named/)
  })
})

describe('an agent sending itself headless', () => {
  it('comes back on the same conversation with no window', async () => {
    const agentId = await spawnAgent({ surface: 'iterm-pane' })
    const before = core.agents.get(agentId)

    const result = await supervisor.switchSurface({
      name: 'scout',
      to: 'headless',
      requestedBy: 'scout',
      hostPid: 7777,
    })

    expect(result.ok).toBe(true)
    expect(result.surface).toBe('headless')
    const plan = planFor(agentId)
    expect(plan.args).toContain('--resume')
    expect(plan.args).toContain(before?.sessionId)
    expect(plan.args).toContain('-p')
    expect(core.agents.get(agentId)?.surface).toBe('headless')
  })

  /**
   * The pid signalled is Claude Code's own, reported by the session about ITSELF
   * at registration. Signalling the MCP subprocess would sever the bus and leave
   * a live session no peer can reach.
   */
  it('ends Claude Code itself, on the pid the caller reported about its own process', async () => {
    await spawnAgent({ surface: 'iterm-pane' })
    await supervisor.switchSurface({ name: 'scout', to: 'headless', requestedBy: 'scout', hostPid: 7777 })
    expect(killed.map(k => k.pid)).toContain(7777)
  })

  it('refuses without that pid rather than signalling something else', async () => {
    await spawnAgent({ surface: 'iterm-pane' })
    const result = await supervisor.switchSurface({ name: 'scout', to: 'headless', requestedBy: 'scout' })
    expect(result.ok).toBe(false)
    expect(killed).toHaveLength(0)
  })
})
