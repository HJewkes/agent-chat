import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type net from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { Semaphore } from '../agents/semaphore.js'
import { SpawnRateBudget } from '../agents/spawn-rate.js'
import { MAX_DEPTH, Supervisor } from '../agents/supervisor.js'

/**
 * A6 — lifecycle. What is being proved is that an agent's slot, isolation and
 * identity all end up in the right state however it dies: a real exit code when
 * one exists, and an inference from presence when none can.
 */

const tmpDirs: string[] = []
let core: BrokerCore
let supervisor: Supervisor

function makeCore(): BrokerCore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-sup-'))
  tmpDirs.push(dir)
  process.env.AGENT_CHAT_HOME = dir
  return new BrokerCore(() => undefined, {
    events: new EventLog(path.join(dir, 'events.db')),
    registry: new Registry<Conn>(),
  })
}

const fakeConn = (): Conn => ({}) as unknown as net.Socket

/** A workspace the `none` isolation strategy is happy with. */
function workspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-ws-'))
  tmpDirs.push(dir)
  return dir
}

const spawnReq = (over: Record<string, unknown> = {}) => ({
  name: 'scout',
  profile: 'explorer',
  brief: 'read the log',
  requestedBy: 'human',
  cwd: workspace(),
  isolation: 'none' as const,
  surface: 'headless' as const,
  ...over,
})

const kindsFor = (agentId: string): string[] =>
  core.events
    .agentEvents()
    .filter(r => r.ref === agentId || r.msgId === agentId)
    .map(r => r.kind)

beforeEach(() => {
  vi.useFakeTimers()
  core = makeCore()
})

afterEach(() => {
  supervisor?.close()
  vi.useRealTimers()
  delete process.env.AGENT_CHAT_HOME
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

/**
 * Launches nothing. The reported platform is forced to a non-macOS one so an
 * `iterm-pane` request refuses deterministically instead of depending on whether
 * the machine running the tests happens to have iTerm open — which it did, and
 * which meant these tests opened real windows on a developer laptop.
 */
function withStubbedSurface(
  opts: { settleMs?: number; semaphore?: Semaphore; spawnRateBudget?: SpawnRateBudget } = {},
): Supervisor {
  supervisor = new Supervisor(core, { ...opts, surface: { platform: 'linux' } })
  return supervisor
}

describe('spawning', () => {
  it('records the identity before the launch, so a failed spawn is still visible', async () => {
    const sup = withStubbedSurface()
    const result = await sup.spawn(spawnReq({ surface: 'iterm-pane', name: 'ghost' }))

    // No iTerm in a test environment, so the launch refuses — and the point is
    // that the identity survives that with a refusal beside it.
    expect(result.ok).toBe(false)
    const spawned = core.events.agentEvents().filter(r => r.kind === 'agent_spawned')
    expect(spawned).toHaveLength(1)
    expect(core.events.agentEvents().some(r => r.kind === 'isolation_allocated')).toBe(true)
  })

  /**
   * §11.2 promised this check in prose — "must exist, must be a directory ... A
   * peer can spawn where somebody is already working; it cannot spawn in
   * ~/.ssh" — and the code never had it. Found by a spawned reviewer reading the
   * section against the source. `cwd` decides where a process with the profile's
   * tools gets to read, so an unvalidated one is a read primitive anywhere on
   * disk. The location rules themselves live in `spawn-cwd.ts` and are tested
   * there; these cover the supervisor honouring them, plus the human exemption,
   * which exists only at this layer.
   */
  describe('the cwd a spawn asks for', () => {
    it('refuses a peer the home directory itself', async () => {
      const sup = withStubbedSurface()
      core.register(fakeConn(), { t: 'register', name: 'peer', workingOn: '', cwd: workspace(), pid: 1 })

      const result = await sup.spawn(spawnReq({ requestedBy: 'peer', cwd: os.homedir() }))

      expect(result.ok).toBe(false)
      expect(result.reason).toMatch(/must be under your home directory/)
      expect(core.events.history(10).some(r => r.kind === 'agent_spawn_refused')).toBe(true)
    })

    /**
     * CC-62's regression. This refused before the widening: the target existed
     * and was perfectly ordinary, but no OTHER session happened to be sitting in
     * it — which is exactly the state a freshly created worktree is in, and why
     * `isolation: worktree` was unusable without a decoy session first.
     */
    it('lets a peer spawn into a fresh directory no session is working in', async () => {
      const sup = withStubbedSurface()
      core.register(fakeConn(), { t: 'register', name: 'peer', workingOn: '', cwd: workspace(), pid: 1 })

      const result = await sup.spawn(spawnReq({ requestedBy: 'peer', cwd: workspace() }))

      expect(result.reason).toBeUndefined()
      expect(result.ok).toBe(true)
    })

    it('lets a peer spawn under a directory a session is working in', async () => {
      const sup = withStubbedSurface()
      const shared = workspace()
      core.register(fakeConn(), { t: 'register', name: 'peer', workingOn: '', cwd: shared, pid: 1 })

      expect((await sup.spawn(spawnReq({ requestedBy: 'peer', cwd: shared }))).ok).toBe(true)
    })

    it('does not let .. climb out to the root of the temp area', async () => {
      const sup = withStubbedSurface()
      const shared = workspace()
      core.register(fakeConn(), { t: 'register', name: 'peer', workingOn: '', cwd: shared, pid: 1 })

      const escape = path.join(shared, '..')
      const result = await sup.spawn(spawnReq({ requestedBy: 'peer', cwd: escape }))

      expect(result.ok).toBe(false)
    })

    it('refuses a path that does not exist, or is a file', async () => {
      const sup = withStubbedSurface()
      const dir = workspace()
      const file = path.join(dir, 'a-file')
      fs.writeFileSync(file, 'x')

      expect((await sup.spawn(spawnReq({ cwd: path.join(dir, 'nope') }))).reason).toMatch(/does not exist/)
      expect((await sup.spawn(spawnReq({ name: 'two', cwd: file }))).reason).toMatch(/not a directory/)
    })

    /** The human holds no registry entry to be contained by, and is the trust root. */
    it('exempts the human from the location rules but not from existence', async () => {
      const sup = withStubbedSurface()

      expect((await sup.spawn(spawnReq({ requestedBy: 'human', cwd: os.homedir() }))).ok).toBe(true)
      expect(
        (await sup.spawn(spawnReq({ name: 'two', requestedBy: 'human', cwd: '/nope/nowhere' }))).reason,
      ).toMatch(/does not exist/)
    })
  })

  it('refuses a reserved name, and records the refusal as an event', async () => {
    const sup = withStubbedSurface()
    const result = await sup.spawn(spawnReq({ name: 'human' }))

    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/reserved/)
    expect(core.events.history(10).some(r => r.kind === 'agent_spawn_refused')).toBe(true)
  })

  it('refuses a name a live session already holds', async () => {
    const sup = withStubbedSurface()
    core.register(fakeConn(), { t: 'register', name: 'scout', workingOn: '', cwd: '/tmp', pid: 1 })

    expect((await sup.spawn(spawnReq())).reason).toMatch(/already registered/)
  })

  it('refuses an unknown profile by name, listing the ones that exist', async () => {
    const sup = withStubbedSurface()
    expect((await sup.spawn(spawnReq({ profile: 'nope' }))).reason).toMatch(/no profile named "nope"/)
  })

  /**
   * Regression: the isolation context was built without the profile's tool lists,
   * so `toolset-limited` reported that every explorer and reviewer "runs at full
   * capability". It never did — the launch plan passes --allowed-tools straight
   * from the profile — but a false alarm on the read-only profiles spends the
   * exact channel a real over-permission needs.
   */
  it('does not warn that a read-only profile is unrestricted', async () => {
    const sup = withStubbedSurface()

    const result = await sup.spawn(spawnReq({ profile: 'explorer', isolation: 'toolset-limited' }))

    expect(result.ok).toBe(true)
    expect(result.warnings ?? []).not.toContainEqual(expect.stringMatching(/restricts nothing/))
  })

  /**
   * CC-29: a toolset-confined tool never shows up as a denial after the fact, so
   * the deny list has to be knowable at spawn time instead. Echoed on the outcome
   * so the SPAWNER sees it, not just the spawned agent's own brief.
   */
  it('echoes the profile deny list on a successful spawn', async () => {
    const sup = withStubbedSurface()

    const result = await sup.spawn(spawnReq({ profile: 'explorer' }))

    expect(result.ok).toBe(true)
    expect(result.disallowedTools).toEqual(['Bash', 'Write', 'Edit', 'AskUserQuestion'])
  })

  /**
   * CC-22 hardening: `implementer` grants Bash outright, but even it denies
   * shelling out to the CLI's own human-only verbs (HUMAN_ONLY_CLI_DENY in
   * profiles.ts) — the mitigation for the adversarial review's self-approval
   * finding. Echoed here for the same reason CC-29's deny list is: the spawner
   * should see it, not just infer it from a failed shell command later.
   */
  it('denies the CLI human-only verbs even on a profile that otherwise grants Bash', async () => {
    const sup = withStubbedSurface()

    const result = await sup.spawn(spawnReq({ profile: 'implementer', isolation: 'none' }))

    expect(result.ok).toBe(true)
    expect(result.disallowedTools).toEqual([
      'Bash(agent-chat endorse:*)',
      'Bash(agent-chat dismiss:*)',
      'Bash(agent-chat send:*)',
      'Bash(agent-chat answer:*)',
      'AskUserQuestion',
    ])
  })

  /**
   * The supervisor is the only thing that knows which agents are live and where
   * they were put, so it is what turns "second agent for this anchor" into a pane
   * to split. Asserted through the AppleScript because that is the observable:
   * the surface is built per launch and keeps no state of its own.
   */
  it('stacks the second agent on the first, and only for the same anchor', async () => {
    const scripts: string[] = []
    const runAppleScript = (script: string): string => {
      scripts.push(script)
      if (script.includes('is running')) return 'true'
      return `PANE-${scripts.length}`
    }
    supervisor = new Supervisor(core, { surface: { platform: 'darwin', runAppleScript } })

    const first = await supervisor.spawn(spawnReq({ name: 'one', surface: 'iterm-pane', anchor: 'w0t0p0:A' }))
    const second = await supervisor.spawn(
      spawnReq({ name: 'two', surface: 'iterm-pane', anchor: 'w0t0p0:A' }),
    )
    const elsewhere = await supervisor.spawn(
      spawnReq({ name: 'three', surface: 'iterm-pane', anchor: 'w9t9p9:B' }),
    )

    expect([first.ok, second.ok, elsewhere.ok]).toEqual([true, true, true])
    // Each spawn runs an "is running" probe then a launch; the launch is what
    // carries the target, and the stub numbers panes by call order.
    const launches = scripts.filter(s => s.includes('spawned'))

    // The first agent has no column to join, so it names no pane to split.
    expect(launches[0]).not.toContain('is "PANE-')
    // The second stacks on the first agent's pane, not on the anchor.
    expect(launches[1]).toContain('is "PANE-2"')
    // A different anchor starts its own column rather than continuing this one.
    expect(launches[2]).not.toContain('is "PANE-2"')
    expect(launches[2]).not.toContain('is "PANE-4"')
  })

  it('releases the slot when the launch fails, rather than leaking it', async () => {
    const semaphore = new Semaphore(1)
    const sup = withStubbedSurface({ semaphore })

    await sup.spawn(spawnReq({ surface: 'iterm-pane' }))

    expect(semaphore.inUse).toBe(0)
  })
})

describe('the concurrency budget', () => {
  it('refuses past the slot count with a reason naming the limit', async () => {
    const semaphore = new Semaphore(0)
    const sup = withStubbedSurface({ semaphore })

    const result = await sup.spawn(spawnReq())

    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/no free agent slots \(0\/0 slots\)/)
  })

  it('says how many slots are blocked, so "why can\'t I spawn" has an answer', () => {
    const semaphore = new Semaphore(3)
    semaphore.acquire('a1')
    expect(semaphore.summary(1)).toBe('1/3 slots (1 blocked)')
  })

  it('does not consume a second slot when the same agent re-acquires', () => {
    const semaphore = new Semaphore(1)
    expect(semaphore.acquire('a1')).toBe(true)
    expect(semaphore.acquire('a1')).toBe(true)
    expect(semaphore.inUse).toBe(1)
  })
})

/**
 * CC-25 — §11.3 promised "a spawn budget per requester per window" and it did
 * not exist. The semaphore bounds standing population; this bounds churn, which
 * the semaphore cannot see because each spawn in a loop is legal on its own.
 */
describe('the spawn rate budget', () => {
  /** A requester needs a registered session at `cwd` or checkCwd refuses first. */
  const registerPeer = (name: string, cwd: string): void => {
    core.register(fakeConn(), { t: 'register', name, workingOn: '', cwd, pid: 1 })
  }

  it('refuses once a requester exceeds the per-window limit, naming the limit', async () => {
    const spawnRateBudget = new SpawnRateBudget(60_000, 2)
    const sup = withStubbedSurface({ spawnRateBudget })
    const shared = workspace()
    registerPeer('peer', shared)

    const first = await sup.spawn(spawnReq({ name: 'scout-1', requestedBy: 'peer', cwd: shared }))
    const second = await sup.spawn(spawnReq({ name: 'scout-2', requestedBy: 'peer', cwd: shared }))
    const third = await sup.spawn(spawnReq({ name: 'scout-3', requestedBy: 'peer', cwd: shared }))

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    expect(third.ok).toBe(false)
    expect(third.reason).toMatch(/peer has attempted 2 spawns in the last 60s \(limit 2\)/)
  })

  it('records the refusal as an event, not just a reply string', async () => {
    const spawnRateBudget = new SpawnRateBudget(60_000, 1)
    const sup = withStubbedSurface({ spawnRateBudget })
    const shared = workspace()
    registerPeer('peer', shared)

    await sup.spawn(spawnReq({ name: 'scout-1', requestedBy: 'peer', cwd: shared }))
    await sup.spawn(spawnReq({ name: 'scout-2', requestedBy: 'peer', cwd: shared }))

    const refusal = core.events.history(10).find(r => r.kind === 'agent_spawn_refused')
    expect(refusal?.from).toBe('peer')
    expect(refusal?.text).toMatch(/attempted 1 spawns/)
  })

  it('tracks requesters independently, so a busy peer does not throttle another', async () => {
    const spawnRateBudget = new SpawnRateBudget(60_000, 1)
    const sup = withStubbedSurface({ spawnRateBudget })
    const sharedA = workspace()
    const sharedB = workspace()
    registerPeer('alice', sharedA)
    registerPeer('bob', sharedB)

    const peerA = await sup.spawn(spawnReq({ name: 'scout-a', requestedBy: 'alice', cwd: sharedA }))
    const peerB = await sup.spawn(spawnReq({ name: 'scout-b', requestedBy: 'bob', cwd: sharedB }))

    expect(peerA.ok).toBe(true)
    expect(peerB.ok).toBe(true)
  })

  it('lets a spent budget free up once the window has passed', async () => {
    const spawnRateBudget = new SpawnRateBudget(60_000, 1)
    const sup = withStubbedSurface({ spawnRateBudget })
    const shared = workspace()
    registerPeer('peer', shared)

    await sup.spawn(spawnReq({ name: 'scout-1', requestedBy: 'peer', cwd: shared }))
    const blocked = await sup.spawn(spawnReq({ name: 'scout-2', requestedBy: 'peer', cwd: shared }))
    expect(blocked.ok).toBe(false)

    vi.advanceTimersByTime(60_001)

    const after = await sup.spawn(spawnReq({ name: 'scout-3', requestedBy: 'peer', cwd: shared }))
    expect(after.ok).toBe(true)
  })

  it('exempts the human at the CLI, same reasoning as checkCwd', async () => {
    const spawnRateBudget = new SpawnRateBudget(60_000, 1)
    const sup = withStubbedSurface({ spawnRateBudget })

    const first = await sup.spawn(spawnReq({ name: 'scout-1', requestedBy: 'human' }))
    const second = await sup.spawn(spawnReq({ name: 'scout-2', requestedBy: 'human' }))

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
  })
})

describe('inferring the exit of a visible agent', () => {
  /** Put an identity into the live set the way a successful spawn would. */
  const liveAgent = (sup: Supervisor, agentId: string, name: string): void => {
    core.append({ kind: 'agent_spawned', actor: 'human', target: name, msgId: agentId, body: 'work' })
    // Reaching in is deliberate: A6's exit paths are the unit under test, and
    // routing a real launch through them would be testing the surface instead.
    ;(sup as unknown as { live: Map<string, unknown> }).live.set(agentId, {
      agentId,
      name,
      handle: { surface: 'iterm-pane' },
      allocation: { cwd: '/tmp' },
      isolation: 'none',
    })
  }

  it('synthesises an exit when a detach is never followed by a reattach', () => {
    const sup = withStubbedSurface({ settleMs: 30_000 })
    liveAgent(sup, 'a1', 'scout')

    core.append({ kind: 'agent_detached', actor: 'scout', ref: 'a1' })
    expect(kindsFor('a1')).not.toContain('agent_exited')

    vi.advanceTimersByTime(30_000)

    expect(kindsFor('a1')).toContain('agent_exited')
    expect(core.agents.get('a1')?.state).toBe('exited')
  })

  it('says the exit was inferred rather than reporting an exit code it never saw', () => {
    const sup = withStubbedSurface({ settleMs: 1000 })
    liveAgent(sup, 'a1', 'scout')

    core.append({ kind: 'agent_detached', actor: 'scout', ref: 'a1' })
    vi.advanceTimersByTime(1000)

    const exit = core.events.agentEvents().find(r => r.kind === 'agent_exited')
    expect(exit?.meta.inferred).toBe('true')
    expect(exit?.meta.code).toBeUndefined()
    expect(core.agents.get('a1')?.exit).toEqual({ code: null, summary: expect.stringMatching(/inferred/) })
  })

  it('cancels the settle when the agent comes back, so a reconnect is not a death', () => {
    // The reconnect ladder runs to 8.85s in the worst case. Treating that as an
    // exit would make every broker bounce read as a room full of dead agents.
    const sup = withStubbedSurface({ settleMs: 30_000 })
    liveAgent(sup, 'a1', 'scout')

    core.append({ kind: 'agent_detached', actor: 'scout', ref: 'a1' })
    vi.advanceTimersByTime(8_850)
    core.append({ kind: 'agent_attached', actor: 'scout', ref: 'a1' })
    vi.advanceTimersByTime(60_000)

    expect(kindsFor('a1')).not.toContain('agent_exited')
    expect(core.agents.get('a1')?.state).toBe('live')
  })

  it('frees the slot once the exit is recorded', () => {
    const semaphore = new Semaphore(1)
    const sup = withStubbedSurface({ settleMs: 500, semaphore })
    liveAgent(sup, 'a1', 'scout')
    semaphore.acquire('a1')

    core.append({ kind: 'agent_detached', actor: 'scout', ref: 'a1' })
    vi.advanceTimersByTime(500)

    expect(semaphore.inUse).toBe(0)
  })

  /**
   * Regression, found by a spawned reviewer reading A6 against §8.
   *
   * The settle timer closes over the Live object, but `recordExit` looks the
   * entry up by id in the CURRENT map. A resume inside the settle window replaces
   * that entry without cancelling the old timer, so the stale timer fires against
   * the AGENT THAT JUST CAME BACK — deleting it, freeing its slot, and appending
   * an `agent_exited` for a process that is running.
   *
   * Driven through a real spawn and resume rather than the map, because the
   * interaction between the two is the thing under test.
   */
  it('does not let a settle from the previous life kill a resumed agent', async () => {
    const semaphore = new Semaphore(2)
    const sup = withStubbedSurface({ settleMs: 30_000, semaphore })
    const spawned = await sup.spawn(spawnReq({ name: 'scout' }))
    const agentId = spawned.agentId!

    // Attach, then drop: the settle window is now counting down.
    core.append({ kind: 'agent_attached', actor: 'scout', ref: agentId })
    core.append({ kind: 'agent_detached', actor: 'scout', ref: agentId })
    vi.advanceTimersByTime(5_000)

    // It comes back before the window closes.
    expect((await sup.resume('scout')).ok).toBe(true)
    core.append({ kind: 'agent_attached', actor: 'scout', ref: agentId })

    // The window from the FIRST life now expires.
    vi.advanceTimersByTime(60_000)

    expect(kindsFor(agentId)).not.toContain('agent_exited')
    expect(core.agents.get(agentId)?.state).toBe('live')
    expect(semaphore.inUse).toBeGreaterThan(0)
  })

  it('records one exit even when both the settle and a child exit fire', () => {
    const sup = withStubbedSurface({ settleMs: 100 })
    liveAgent(sup, 'a1', 'scout')

    core.append({ kind: 'agent_detached', actor: 'scout', ref: 'a1' })
    vi.advanceTimersByTime(100)
    vi.advanceTimersByTime(100)

    expect(kindsFor('a1').filter(k => k === 'agent_exited')).toHaveLength(1)
  })
})

describe('kill', () => {
  const liveOn = (sup: Supervisor, surface: string, pid?: number): void => {
    ;(sup as unknown as { live: Map<string, unknown> }).live.set('a1', {
      agentId: 'a1',
      name: 'scout',
      handle: { surface, ...(pid === undefined ? {} : { pid }) },
      allocation: { cwd: '/tmp' },
      isolation: 'none',
    })
  }

  it('refuses to kill a pane a human is looking at, and says where to go instead', () => {
    const sup = withStubbedSurface()
    liveOn(sup, 'iterm-pane', 999999)

    const result = sup.kill('scout')

    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/exit it there/)
    expect(result.reason).toMatch(/agent attach scout/)
  })

  it('reports plainly when there is no such live agent', () => {
    expect(withStubbedSurface().kill('nobody').reason).toMatch(/no live agent named "nobody"/)
  })
})

describe('retire', () => {
  it('frees the name, which nothing else does', async () => {
    const sup = withStubbedSurface()
    core.append({ kind: 'agent_spawned', actor: 'human', target: 'scout', msgId: 'a1', body: 'work' })
    expect(core.agents.nameIsClaimed('scout')).toBe(true)

    const result = await sup.retire('scout')

    expect(result.ok).toBe(true)
    expect(core.agents.nameIsClaimed('scout')).toBe(false)
  })

  it('leaves a merely exited agent still holding its name', async () => {
    // Peers remember addressing. An exit must not silently invalidate it; only
    // an explicit retire does.
    withStubbedSurface()
    core.append({ kind: 'agent_spawned', actor: 'human', target: 'scout', msgId: 'a1', body: 'work' })
    core.append({ kind: 'agent_exited', actor: 'scout', ref: 'a1' })

    expect(core.agents.nameIsClaimed('scout')).toBe(true)
  })

  it('reports plainly when there is no such agent', async () => {
    expect((await withStubbedSurface().retire('nobody')).reason).toMatch(/no agent named "nobody"/)
  })
})

/**
 * CC-37. Opening a pane and never closing it left a dead shell behind every
 * retired agent. The line drawn here: retire closes, an exit does not, and only
 * a surface the broker itself opened is ever a candidate.
 */
describe('retiring an agent that was given a pane', () => {
  /** An iTerm2 that answers scripts without one existing. Never reaches osascript. */
  function fakeIterm(settleMs = 30_000) {
    const scripts: string[] = []
    const runAppleScript = (script: string): string => {
      scripts.push(script)
      if (script.includes('is running')) return 'true'
      if (script.includes('to close')) return '@@closed@@'
      return 'PANE-1'
    }
    supervisor = new Supervisor(core, { settleMs, surface: { platform: 'darwin', runAppleScript } })
    return { scripts, sup: supervisor, closes: () => scripts.filter(s => s.includes('to close')) }
  }

  const liveOn = (sup: Supervisor, handle: Record<string, unknown>, id = 'a1'): void => {
    core.append({ kind: 'agent_spawned', actor: 'human', target: 'scout', msgId: id, body: 'work' })
    ;(sup as unknown as { live: Map<string, unknown> }).live.set(id, {
      agentId: id,
      name: 'scout',
      handle,
      allocation: { cwd: '/tmp' },
      isolation: 'none',
    })
  }

  it('closes the pane the broker opened for it', async () => {
    const { sup, closes } = fakeIterm()
    liveOn(sup, { surface: 'iterm-pane', paneRef: 'PANE-1', ownsSurface: true })

    expect((await sup.retire('scout')).ok).toBe(true)
    expect(closes()).toHaveLength(1)
    expect(closes()[0]).toContain('is "PANE-1"')
  })

  /**
   * The constraint that matters. An adopted session's pane is the human's own,
   * and the bus that reaches retire is one any peer can talk to.
   */
  it('never closes a surface the broker did not create', async () => {
    const { sup, closes } = fakeIterm()
    liveOn(sup, { surface: 'iterm-pane', paneRef: 'HUMANS-OWN-PANE' })

    expect((await sup.retire('scout')).ok).toBe(true)
    expect(closes()).toEqual([])
  })

  /**
   * An agent finishing is not an instruction to throw away what it printed: the
   * pane stays until a human explicitly retires it.
   */
  it('leaves the pane open when the agent merely exits', () => {
    const { sup, closes } = fakeIterm(500)
    liveOn(sup, { surface: 'iterm-pane', paneRef: 'PANE-1', ownsSurface: true })

    core.append({ kind: 'agent_detached', actor: 'scout', ref: 'a1' })
    vi.advanceTimersByTime(500)

    expect(kindsFor('a1')).toContain('agent_exited')
    expect(closes()).toEqual([])
  })

  it('does nothing for a headless agent, which has no surface', async () => {
    const { sup, scripts } = fakeIterm()
    liveOn(sup, { surface: 'headless', pid: 999999 })

    expect((await sup.retire('scout')).ok).toBe(true)
    expect(scripts).toEqual([])
  })

  /**
   * The subtle case. A teleport descendant lands IN the predecessor's pane, so
   * its own launch cannot tell who created it — the answer is a generation or
   * more old. Ownership has to travel with the succession, or an agent becomes
   * unclosable simply by having teleported once.
   */
  it('still closes a pane a descendant inherited from the agent it succeeded', async () => {
    const { sup, closes } = fakeIterm()
    liveOn(sup, { surface: 'iterm-pane', paneRef: 'PANE-1', ownsSurface: true }, 'a1')

    // What teleport's `finish` does before it relaunches: the predecessor stands
    // down and gives up the name, so the descendant is the agent called scout.
    core.append({ kind: 'agent_retired', actor: 'agent-chat', target: 'scout', ref: 'a1' })

    await sup.relaunch({
      agentId: 'a2',
      name: 'scout',
      profile: {
        name: 'inherited',
        description: '',
        model: '',
        allowedTools: [],
        isolation: 'none',
        surface: 'iterm-pane',
        promptPrelude: '',
      },
      brief: 'carry on',
      cwd: '/tmp',
      surface: 'iterm-pane',
      preamble: 'you are the continuation',
      meta: {},
      anchor: 'w1t0p0:PANE-1',
      reuseAnchor: true,
      inheritedFrom: 'a1',
    })

    expect((await sup.retire('scout')).ok).toBe(true)
    expect(closes()).toHaveLength(1)
    expect(closes()[0]).toContain('is "PANE-1"')
  })

  /** The same succession, but into a pane that was the human's to begin with. */
  it('does not let a teleport turn a human’s pane into one the broker may close', async () => {
    const { sup, closes } = fakeIterm()
    liveOn(sup, { surface: 'iterm-pane', paneRef: 'PANE-1' }, 'a1')

    // What teleport's `finish` does before it relaunches: the predecessor stands
    // down and gives up the name, so the descendant is the agent called scout.
    core.append({ kind: 'agent_retired', actor: 'agent-chat', target: 'scout', ref: 'a1' })

    await sup.relaunch({
      agentId: 'a2',
      name: 'scout',
      profile: {
        name: 'inherited',
        description: '',
        model: '',
        allowedTools: [],
        isolation: 'none',
        surface: 'iterm-pane',
        promptPrelude: '',
      },
      brief: 'carry on',
      cwd: '/tmp',
      surface: 'iterm-pane',
      preamble: 'you are the continuation',
      meta: {},
      anchor: 'w1t0p0:PANE-1',
      reuseAnchor: true,
      inheritedFrom: 'a1',
    })

    expect((await sup.retire('scout')).ok).toBe(true)
    expect(closes()).toEqual([])
  })
})

describe('spawn depth', () => {
  it('caps a chain of agents spawning agents', async () => {
    const sup = withStubbedSurface()
    // A parent already at the cap: its child would be MAX_DEPTH + 1.
    core.append({
      kind: 'agent_spawned',
      actor: 'human',
      target: 'parent',
      msgId: 'p1',
      meta: { depth: String(MAX_DEPTH) },
    })

    const result = await sup.spawn(spawnReq({ parentAgentId: 'p1' }))

    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(new RegExp(`exceeds the cap of ${MAX_DEPTH}`))
  })

  it('treats a human-initiated spawn as depth 1', async () => {
    const sup = withStubbedSurface()
    await sup.spawn(spawnReq({ surface: 'iterm-pane' }))

    const spawned = core.events.agentEvents().find(r => r.kind === 'agent_spawned')
    expect(spawned?.meta.depth).toBe('1')
  })

  it('leaves a human session at the depth it had before it had an identity', async () => {
    // An adopted session is a parent now, and depthOf() adds one to the parent's
    // recorded depth. If adoption recorded depth 1, every agent a human spawned
    // would start at 2 and its children would breach the cap — the fleet would
    // silently lose a level on the day ordinary sessions gained identities.
    const sup = withStubbedSurface()
    core.register(fakeConn(), {
      t: 'register',
      name: 'human-session',
      workingOn: 'CC-30',
      cwd: workspace(),
      pid: 1,
      sessionId: 'sess-adopted',
    })
    const parentAgentId = core.agents.roster()[0]?.agentId

    await sup.spawn(spawnReq({ parentAgentId }))

    const spawned = core.events
      .agentEvents()
      .find(r => r.kind === 'agent_spawned' && r.meta.origin !== 'adopted')
    expect(spawned?.meta.depth).toBe('1')
  })
})

/**
 * CC-39. `agent_spawn` resolves a profile by NAME and never asked whether the
 * requester was privileged enough to grant what that profile allows — while
 * `launch-plan.ts` appends agent-chat's own tools (agent_spawn among them) to
 * every profile unconditionally. A read-only `explorer` could therefore ask for
 * `profile: "peer"` and get a Bash-capable agent back, with no Write and no
 * custom profile file needed: escalation by naming a string.
 */
describe('spawn privilege', () => {
  /** A spawned agent that was itself granted `tools`, and is registered so it may spawn. */
  const spawnedParent = (name: string, cwd: string, tools: string[]): string => {
    const { msgId } = core.append({
      kind: 'agent_spawned',
      actor: 'human',
      target: name,
      meta: { name, depth: '1', allowed_tools: tools.join(',') },
    })
    core.register(fakeConn(), { t: 'register', name, workingOn: '', cwd, pid: 1 })
    return msgId
  }

  /** Same as `spawnedParent`, but also records the deny list it was itself held to. */
  const spawnedParentWithDeny = (name: string, cwd: string, tools: string[], denied: string[]): string => {
    const { msgId } = core.append({
      kind: 'agent_spawned',
      actor: 'human',
      target: name,
      meta: { name, depth: '1', allowed_tools: tools.join(','), disallowed_tools: denied.join(',') },
    })
    core.register(fakeConn(), { t: 'register', name, workingOn: '', cwd, pid: 1 })
    return msgId
  }

  const profilesDirFor = (): string => {
    const dir = path.join(process.env.AGENT_CHAT_HOME as string, 'profiles')
    fs.mkdirSync(dir, { recursive: true })
    return dir
  }

  it('refuses an agent a profile granting tools it was not granted itself', async () => {
    const sup = withStubbedSurface()
    const shared = workspace()
    const parentAgentId = spawnedParent('explorer-agent', shared, ['Read', 'Grep', 'Glob'])

    const result = await sup.spawn(
      spawnReq({ profile: 'peer', requestedBy: 'explorer-agent', parentAgentId, cwd: shared }),
    )

    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/cannot spawn a peer more capable than itself/)
    expect(result.reason).toMatch(/Bash/)
    expect(core.events.history(10).some(r => r.kind === 'agent_spawn_refused')).toBe(true)
  })

  it('allows an agent a profile no wider than its own grant', async () => {
    const sup = withStubbedSurface()
    const shared = workspace()
    const parentAgentId = spawnedParent('reviewer-agent', shared, ['Read', 'Grep', 'Glob', 'Bash'])

    const result = await sup.spawn(
      spawnReq({ profile: 'explorer', requestedBy: 'reviewer-agent', parentAgentId, cwd: shared }),
    )

    expect(result.ok).toBe(true)
  })

  /**
   * Scoped forms are matched as STRINGS, not semantically: nothing here can tell
   * whether `Bash(git:*)` covers what a child asking for plain `Bash` will run,
   * and the direction to be wrong in is refusing.
   */
  it('does not read a scoped grant as satisfying a broader one', async () => {
    const sup = withStubbedSurface()
    const shared = workspace()
    const parentAgentId = spawnedParent('scoped-agent', shared, ['Read', 'Grep', 'Glob', 'Bash(git:*)'])

    const result = await sup.spawn(
      spawnReq({ profile: 'reviewer', requestedBy: 'scoped-agent', parentAgentId, cwd: shared }),
    )

    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/Bash/)
  })

  /**
   * A session a human started directly holds no broker-granted profile — it runs
   * under that human's own settings — so there is no boundary here to hold it to,
   * and gating it would be false confidence rather than protection. Its adopted
   * identity is a parent id like any other, which is exactly the trap.
   */
  it('exempts an ordinary human session, adopted identity and all', async () => {
    const sup = withStubbedSurface()
    const shared = workspace()
    core.register(fakeConn(), {
      t: 'register',
      name: 'human-session',
      workingOn: 'CC-39',
      cwd: shared,
      pid: 1,
      sessionId: 'sess-adopted',
    })
    const parentAgentId = core.agents.roster()[0]?.agentId

    const result = await sup.spawn(
      spawnReq({ profile: 'peer', requestedBy: 'human-session', parentAgentId, cwd: shared }),
    )

    expect(result.ok).toBe(true)
  })

  it('records the deny list beside the allow list on the spawn row', async () => {
    const sup = withStubbedSurface()
    await sup.spawn(spawnReq({ profile: 'explorer' }))

    const spawned = core.events.agentEvents().find(r => r.kind === 'agent_spawned')
    expect(spawned?.meta.disallowed_tools).toBe('Bash,Write,Edit,AskUserQuestion')
  })

  /**
   * CC-40: same allowedTools as the parent, so the allow-side check alone would
   * wave this through — but `disallowedTools` is what actually confines a
   * profile (see profiles.ts), and this one drops `Bash` from the deny list the
   * parent itself was held to. A custom profile file, because no builtin pairs
   * identical allowedTools with a strictly weaker disallowedTools.
   */
  it('refuses a profile with the same grant but a weaker deny list', async () => {
    const sup = withStubbedSurface()
    const shared = workspace()
    fs.writeFileSync(
      path.join(profilesDirFor(), 'looser-explorer.json'),
      JSON.stringify({
        model: 'sonnet',
        allowedTools: ['Read', 'Grep', 'Glob'],
        disallowedTools: ['Write', 'Edit'],
        isolation: 'toolset-limited',
        surface: 'headless',
      }),
    )
    const parentAgentId = spawnedParentWithDeny(
      'explorer-agent',
      shared,
      ['Read', 'Grep', 'Glob'],
      ['Bash', 'Write', 'Edit'],
    )

    const result = await sup.spawn(
      spawnReq({ profile: 'looser-explorer', requestedBy: 'explorer-agent', parentAgentId, cwd: shared }),
    )

    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/weaker deny list/)
    expect(result.reason).toMatch(/Bash/)
    expect(core.events.history(10).some(r => r.kind === 'agent_spawn_refused')).toBe(true)
  })
})
