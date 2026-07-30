import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type net from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { Semaphore } from '../agents/semaphore.js'
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
function withStubbedSurface(opts: { settleMs?: number; semaphore?: Semaphore } = {}): Supervisor {
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
   * §11.2 promised this check in prose — "must exist, must be a directory, and
   * must be at or under the cwd of some currently-registered session ... A peer
   * can spawn where somebody is already working; it cannot spawn in ~/.ssh" —
   * and the code never had it. Found by a spawned reviewer reading the section
   * against the source. `cwd` decides where a process with the profile's tools
   * gets to read, so an unvalidated one is a read primitive anywhere on disk.
   */
  describe('the cwd a spawn asks for', () => {
    it('refuses a peer a directory nobody is working in', async () => {
      const sup = withStubbedSurface()
      core.register(fakeConn(), { t: 'register', name: 'peer', workingOn: '', cwd: workspace(), pid: 1 })

      const result = await sup.spawn(spawnReq({ requestedBy: 'peer', cwd: os.homedir() }))

      expect(result.ok).toBe(false)
      expect(result.reason).toMatch(/at or under a directory some session is working in/)
      expect(core.events.history(10).some(r => r.kind === 'agent_spawn_refused')).toBe(true)
    })

    it('lets a peer spawn under a directory a session is working in', async () => {
      const sup = withStubbedSurface()
      const shared = workspace()
      core.register(fakeConn(), { t: 'register', name: 'peer', workingOn: '', cwd: shared, pid: 1 })

      expect((await sup.spawn(spawnReq({ requestedBy: 'peer', cwd: shared }))).ok).toBe(true)
    })

    it('does not let .. climb out of a session workspace', async () => {
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
    it('exempts the human from containment but not from existence', async () => {
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
    expect(result.disallowedTools).toEqual(['Bash', 'Write', 'Edit'])
  })

  it('omits disallowedTools for a profile that grants everything it lists', async () => {
    const sup = withStubbedSurface()

    const result = await sup.spawn(spawnReq({ profile: 'implementer', isolation: 'none' }))

    expect(result.ok).toBe(true)
    expect(result.disallowedTools).toBeUndefined()
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
