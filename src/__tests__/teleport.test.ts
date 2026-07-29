import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type net from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { Semaphore } from '../agents/semaphore.js'
import { Supervisor } from '../agents/supervisor.js'
import { HANDOFF_MAX_BYTES } from '../agents/teleport.js'
import { planPath } from '../agents/launch-files.js'
import type { LaunchPlan } from '../agents/types.js'

/**
 * CC-20 — teleport. What is being proved is that a session can end itself into a
 * successor without losing the three things a naive implementation loses: its
 * NAME (peers keep addressing something real), its ISOLATION (the descendant
 * stands in the predecessor's tree rather than allocating over it or deleting
 * it), and its DEPTH (succession is not branching, so a long-lived agent does
 * not run out of teleports).
 *
 * Nothing here launches a process or signals one. `process.kill` and the spawn
 * used by the headless surface are the two OS boundaries, and both are faked —
 * a test that really signalled would be killing whatever pid it invented.
 */

const tmpDirs: string[] = []
let core: BrokerCore
let supervisor: Supervisor
let killed: Array<{ pid: number; signal: string }>

const COUNTDOWN_MS = 1000

function makeCore(): BrokerCore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-tele-'))
  tmpDirs.push(dir)
  process.env.AGENT_CHAT_HOME = dir
  return new BrokerCore(() => undefined, {
    events: new EventLog(path.join(dir, 'events.db')),
    registry: new Registry<Conn>(),
  })
}

function workspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-ws-'))
  tmpDirs.push(dir)
  return dir
}

const fakeConn = (): Conn => ({}) as unknown as net.Socket

/**
 * Launches nothing. The visible surfaces matter here — teleport branches on
 * whether a human can see the predecessor — so iTerm is faked rather than
 * refused: `platform: darwin` plus a script runner that reports iTerm running
 * and hands back a pane id. No AppleScript reaches the machine, and no window
 * opens on whatever laptop is running the suite.
 */
function makeSupervisor(semaphore?: Semaphore): Supervisor {
  supervisor = new Supervisor(core, {
    countdownMs: COUNTDOWN_MS,
    ...(semaphore ? { semaphore } : {}),
    surface: {
      platform: 'darwin',
      spawn: () => ({ pid: 4242, unref: () => undefined, once: () => undefined }),
      runAppleScript: script => (script.includes('is running') ? 'true' : 'fake-pane-uuid'),
    },
  })
  return supervisor
}

/** A spawned agent, live and tracked, ready to teleport. */
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

/** An ordinary human-started session, adopted the way `chat_register` adopts one. */
function adoptSession(name: string, cwd: string): string {
  const conn = fakeConn()
  core.register(conn, {
    t: 'register',
    name,
    workingOn: 'the thing that motivated all this',
    cwd,
    pid: 111,
    sessionId: 'session-uuid-1',
    hostPid: 222,
  })
  const agentId = core.registry.entryFor(conn)?.agentId
  expect(agentId).toBeDefined()
  // Dropped again so presence is gone: these tests drive the supervisor directly
  // rather than through a socket, and a connection left open would make the
  // descendant wait out the whole name-free window for a peer that cannot exit.
  core.drop(conn)
  return agentId as string
}

const subject = (agentId: string, over: Record<string, unknown> = {}) => ({
  agentId,
  name: 'scout',
  cwd: workspace(),
  hostPid: 9999,
  tags: [] as string[],
  subscriptions: [],
  ...over,
})

const kinds = (): string[] => core.events.agentEvents().map(r => r.kind)

const rowsFor = (agentId: string) =>
  core.events.agentEvents().filter(r => r.ref === agentId || r.msgId === agentId)

const spawnRowFor = (agentId: string) =>
  core.events.agentEvents().find(r => r.kind === 'agent_spawned' && r.msgId === agentId)

const planFor = (agentId: string): LaunchPlan =>
  JSON.parse(fs.readFileSync(planPath(agentId), 'utf8')) as LaunchPlan

beforeEach(() => {
  vi.useFakeTimers()
  killed = []
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
  vi.useRealTimers()
  delete process.env.AGENT_CHAT_HOME
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('what teleport refuses before it commits to anything', () => {
  /**
   * The mechanical reason, not a policy one: `BrokerCore.answer` resolves the
   * recipient with `authorOf` and delivers BY NAME. A question left open across
   * a teleport would have its answer appended to the log and delivered to
   * nothing. The refusal has to name the question, or it is one a model will
   * retry against the same wall.
   */
  it('refuses while a question to the human is open, and says which', async () => {
    const agentId = await spawnAgent()
    const { msgId } = core.append({
      kind: 'question',
      actor: 'scout',
      target: 'human',
      body: 'which branch should this land on?',
    })

    const result = await supervisor.teleport({ subject: subject(agentId), handoff: 'ok' })

    expect(result.ok).toBe(false)
    expect(result.reason).toContain(msgId)
    expect(result.reason).toContain('which branch should this land on?')
    expect(kinds()).not.toContain('agent_handoff')
  })

  it('lets the same session teleport once the question is answered', async () => {
    const agentId = await spawnAgent()
    const { msgId } = core.append({ kind: 'question', actor: 'scout', target: 'human', body: 'q' })
    core.answer(msgId, 'main')

    expect((await supervisor.teleport({ subject: subject(agentId), handoff: 'ok' })).ok).toBe(true)
  })

  /** Truncation would drop the tail, and the tail is what was already tried. */
  it('refuses an oversized handoff rather than truncating it', async () => {
    const agentId = await spawnAgent()
    const huge = 'x'.repeat(HANDOFF_MAX_BYTES + 1)

    const result = await supervisor.teleport({ subject: subject(agentId), handoff: huge })

    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/refused rather than truncated/)
    expect(kinds()).not.toContain('agent_handoff')
  })

  /**
   * Ending the MCP subprocess instead of Claude Code is the measured failure of
   * §5.1: the host restarts the server, the session's tools keep working, and it
   * is silently deregistered from a bus it cannot tell it has fallen off. If the
   * one pid that ends the session was never reported, teleport does not proceed.
   */
  it('refuses a session that never reported the pid of Claude Code itself', async () => {
    const agentId = await spawnAgent()

    const result = await supervisor.teleport({
      subject: { ...subject(agentId), hostPid: undefined },
      handoff: 'ok',
    })

    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/pid of Claude Code/)
    expect(killed).toEqual([])
  })

  it('warns about messages that arrived, but does not refuse on them', async () => {
    const agentId = await spawnAgent()
    core.append({ kind: 'message', actor: 'peer', target: 'scout', body: 'have you seen this' })

    const result = await supervisor.teleport({ subject: subject(agentId), handoff: 'ok' })

    expect(result.ok).toBe(true)
    expect(result.warnings?.[0]).toMatch(/1 message\(s\) arrived/)
  })
})

describe('a headless predecessor', () => {
  it('completes with no countdown, in the order the design fixes', async () => {
    const agentId = await spawnAgent()

    const result = await supervisor.teleport({ subject: subject(agentId), handoff: 'here is what I knew' })
    await vi.advanceTimersByTimeAsync(0)

    // No countdown: nobody is watching a headless agent's pane, so the 30
    // seconds would buy a veto no one is positioned to exercise.
    expect(result.countdownMs).toBeUndefined()
    const sequence = rowsFor(agentId).map(r => r.kind)
    expect(sequence).toEqual([
      'isolation_allocated',
      'agent_spawned',
      'agent_handoff',
      'agent_stood_down',
      'agent_retired',
    ])
  })

  it('signals Claude Code, not the MCP subprocess', async () => {
    const agentId = await spawnAgent()

    await supervisor.teleport({ subject: subject(agentId, { hostPid: 31337 }), handoff: 'h' })
    await vi.advanceTimersByTimeAsync(0)

    expect(killed[0]).toEqual({ pid: 31337, signal: 'SIGTERM' })
  })

  it('records the handoff verbatim, and points at its successor', async () => {
    const agentId = await spawnAgent()
    const handoff = 'mid-way through X\n@/abs/path/notes.md'

    const result = await supervisor.teleport({ subject: subject(agentId), handoff })
    await vi.advanceTimersByTimeAsync(0)

    const row = rowsFor(agentId).find(r => r.kind === 'agent_handoff')
    expect(row?.body).toBe(handoff)
    expect(row?.meta.successor).toBe(result.agentId)
  })
})

describe('the descendant', () => {
  it('keeps the predecessor’s name and gets the handoff as its brief', async () => {
    const agentId = await spawnAgent()

    const result = await supervisor.teleport({ subject: subject(agentId), handoff: 'the handoff' })
    await vi.advanceTimersByTimeAsync(0)

    expect(result.name).toBe('scout')
    const spawn = spawnRowFor(result.agentId as string)
    expect(spawn?.target).toBe('scout')
    expect(spawn?.body).toBe('the handoff')
    expect(planFor(result.agentId as string).stdin).toBe('the handoff')
  })

  /**
   * The bug waiting in the obvious implementation: reuse the ordinary parent
   * path and `depthOf` returns parent + 1, so a depth-1 agent can teleport twice
   * and then never again — losing the ability to pick up its own improvements
   * precisely because it has run long enough to need them.
   */
  it('inherits depth rather than incrementing it, and counts a generation', async () => {
    const first = await spawnAgent()
    const depthBefore = spawnRowFor(first)?.meta.depth

    const one = await supervisor.teleport({ subject: subject(first), handoff: 'h1' })
    await vi.advanceTimersByTimeAsync(0)
    const two = await supervisor.teleport({ subject: subject(one.agentId as string), handoff: 'h2' })
    await vi.advanceTimersByTimeAsync(0)

    expect(spawnRowFor(one.agentId as string)?.meta.depth).toBe(depthBefore)
    expect(spawnRowFor(two.agentId as string)?.meta.depth).toBe(depthBefore)
    expect(spawnRowFor(one.agentId as string)?.meta.generation).toBe('2')
    expect(spawnRowFor(two.agentId as string)?.meta.generation).toBe('3')
    expect(spawnRowFor(two.agentId as string)?.meta.teleport_from).toBe(one.agentId)
  })

  it('is reachable as lineage through the read model', async () => {
    const agentId = await spawnAgent()
    const result = await supervisor.teleport({ subject: subject(agentId), handoff: 'h' })
    await vi.advanceTimersByTimeAsync(0)

    expect(core.agents.stoodDown(agentId)).toBe(true)
    expect(core.agents.successorOf(agentId)?.agentId).toBe(result.agentId)
    expect(core.agents.get(result.agentId as string)?.generation).toBe(2)
    expect(core.agents.get(agentId)?.state).toBe('retired')
  })

  /**
   * §9, the part most likely to destroy work. `worktreeStrategy.allocate`
   * derives the branch and path from the agent NAME, and the descendant now
   * keeps that name — so "just let it allocate normally" is a trap that
   * sometimes doesn't spring. It inherits instead, and the predecessor is closed
   * WITHOUT a release, or the tree the descendant is about to stand in is the
   * one being deleted.
   */
  it('inherits the isolation allocation instead of re-allocating or releasing it', async () => {
    const cwd = workspace()
    const agentId = await spawnAgent({ cwd })

    const result = await supervisor.teleport({ subject: subject(agentId, { cwd }), handoff: 'h' })
    await vi.advanceTimersByTimeAsync(0)

    expect(kinds()).not.toContain('isolation_released')
    const allocated = rowsFor(result.agentId as string).find(r => r.kind === 'isolation_allocated')
    expect(allocated?.meta.inherited_from).toBe(agentId)
    expect(planFor(result.agentId as string).cwd).toBe(cwd)
  })

  /** One logical agent throughout: the budget must not see two, nor forget one. */
  it('occupies exactly the slot its predecessor held', async () => {
    const semaphore = new Semaphore(1)
    supervisor.close()
    makeSupervisor(semaphore)
    const agentId = await spawnAgent()
    expect(semaphore.inUse).toBe(1)

    const result = await supervisor.teleport({ subject: subject(agentId), handoff: 'h' })
    await vi.advanceTimersByTimeAsync(0)

    expect(semaphore.inUse).toBe(1)
    expect(semaphore.has(result.agentId as string)).toBe(true)
  })

  it('carries the predecessor’s tags and subscriptions into its own registration', async () => {
    const agentId = await spawnAgent()
    const subscriptions = [{ selector: { all: true as const }, kinds: ['registered' as const] }]

    const result = await supervisor.teleport({
      subject: subject(agentId, { tags: ['cc-20'], subscriptions }),
      handoff: 'h',
    })
    await vi.advanceTimersByTimeAsync(0)

    const { env } = planFor(result.agentId as string)
    expect(env.AGENT_CHAT_TAGS).toBe('cc-20')
    expect(JSON.parse(env.AGENT_CHAT_SUBSCRIPTIONS ?? 'null')).toEqual(subscriptions)
  })

  /**
   * The whole payoff: the plan and the MCP config are rebuilt now, so the
   * descendant's MCP subprocess execs the CURRENT cli entry and reads the
   * CURRENT instructions. A reused plan would teleport into the same stale build.
   */
  it('is launched from a freshly written plan with its own session id', async () => {
    const agentId = await spawnAgent()
    const before = planFor(agentId)

    const result = await supervisor.teleport({ subject: subject(agentId), handoff: 'h' })
    await vi.advanceTimersByTimeAsync(0)

    const after = planFor(result.agentId as string)
    expect(after.args).not.toEqual(before.args)
    expect(after.env.AGENT_CHAT_AGENT_ID).toBe(result.agentId)
    const sessionId = after.args[after.args.indexOf('--session-id') + 1]
    expect(sessionId).not.toBe(before.args[before.args.indexOf('--session-id') + 1])
  })
})

describe('a visible predecessor', () => {
  const visible = { surface: 'iterm-pane' as const }

  it('gets a countdown, and nothing happens until it elapses', async () => {
    const agentId = await spawnAgent(visible)

    const result = await supervisor.teleport({ subject: subject(agentId), handoff: 'h' })

    expect(result.countdownMs).toBe(COUNTDOWN_MS)
    expect(kinds()).toContain('agent_handoff')
    expect(kinds()).not.toContain('agent_stood_down')
    expect(killed).toEqual([])

    await vi.advanceTimersByTimeAsync(COUNTDOWN_MS)
    expect(kinds()).toContain('agent_stood_down')
    expect(killed[0]?.signal).toBe('SIGTERM')
  })

  it('tells the human how to stop it', async () => {
    const agentId = await spawnAgent(visible)
    await supervisor.teleport({ subject: subject(agentId), handoff: 'h' })

    const notice = core.events.humanQueue().find(item => item.text.includes('teleporting'))
    expect(notice?.text).toContain('agent-chat teleport abort scout')
  })

  /** The veto has to actually stop it, and leave the predecessor running. */
  it('is left alive when the human aborts', async () => {
    const agentId = await spawnAgent(visible)
    await supervisor.teleport({ subject: subject(agentId), handoff: 'h' })

    expect(supervisor.abortTeleport('scout').ok).toBe(true)
    await vi.advanceTimersByTimeAsync(COUNTDOWN_MS * 2)

    expect(kinds()).not.toContain('agent_stood_down')
    expect(kinds()).not.toContain('agent_retired')
    expect(killed).toEqual([])
    expect(core.agents.get(agentId)?.state).not.toBe('retired')
  })

  it('cannot be aborted once the countdown has already run out', async () => {
    const agentId = await spawnAgent(visible)
    await supervisor.teleport({ subject: subject(agentId), handoff: 'h' })
    await vi.advanceTimersByTimeAsync(COUNTDOWN_MS)

    expect(supervisor.abortTeleport('scout').ok).toBe(false)
  })

  it('refuses a second teleport while one is counting down', async () => {
    const agentId = await spawnAgent(visible)
    await supervisor.teleport({ subject: subject(agentId), handoff: 'h' })

    const again = await supervisor.teleport({ subject: subject(agentId), handoff: 'h2' })
    expect(again.reason).toMatch(/already teleporting/)
  })
})

describe('an ordinary human-started session', () => {
  /**
   * D3, and the case that motivated the feature: the incident in §1 was three
   * ordinary sessions that could not pick up their own fix. An adopted identity
   * has no profile, no launch plan and no isolation, so the descendant inherits
   * the HARNESS's configuration — no --model and no --allowed-tools — rather
   * than this code inventing a posture and calling it continuity.
   */
  it('teleports, and its descendant inherits the harness configuration', async () => {
    const cwd = workspace()
    const agentId = adoptSession('cc27', cwd)

    const result = await supervisor.teleport({
      subject: subject(agentId, { name: 'cc27', cwd }),
      handoff: 'what I was mid-way through',
    })
    await vi.advanceTimersByTimeAsync(COUNTDOWN_MS)

    expect(result.ok).toBe(true)
    const plan = planFor(result.agentId as string)
    expect(plan.args).not.toContain('--allowed-tools')
    expect(plan.args).not.toContain('--model')
    expect(plan.cwd).toBe(cwd)
    // Visible, and in the human's own window: an ordinary session lives in a
    // terminal, and a headless successor could never answer a prompt.
    expect(plan.surface).toBe('iterm-tab')
  })

  it('takes no agent slot, because the session it continues never held one', async () => {
    const semaphore = new Semaphore(1)
    supervisor.close()
    makeSupervisor(semaphore)
    const cwd = workspace()
    const agentId = adoptSession('cc27', cwd)

    await supervisor.teleport({ subject: subject(agentId, { name: 'cc27', cwd }), handoff: 'h' })
    await vi.advanceTimersByTimeAsync(COUNTDOWN_MS)

    expect(semaphore.inUse).toBe(0)
  })

  it('succeeds itself onto a different model when it asks for one', async () => {
    const cwd = workspace()
    const agentId = adoptSession('cc27', cwd)

    const result = await supervisor.teleport({
      subject: subject(agentId, { name: 'cc27', cwd }),
      handoff: 'h',
      model: 'claude-sonnet-5',
    })
    await vi.advanceTimersByTimeAsync(COUNTDOWN_MS)

    const { args } = planFor(result.agentId as string)
    expect(args[args.indexOf('--model') + 1]).toBe('claude-sonnet-5')
  })
})
