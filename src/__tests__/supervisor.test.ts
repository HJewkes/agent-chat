import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import type net from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { Semaphore } from '../agents/semaphore.js'
import { SpawnRateBudget } from '../agents/spawn-rate.js'
import {
  MAX_COORDINATOR_DEPTH,
  Supervisor,
  type SpawnOutcome,
  type SupervisorOptions,
} from '../agents/supervisor.js'
import { shadowLedgerFromConfig } from '../agents/ledger/shadow-ledger.js'
import { pairPresence } from '../agents/identity.js'
import type { AgentIdentity } from '../protocol.js'
import {
  readLaunchPlan,
  readRuntimeState,
  runtimeStatePath,
  writeRuntimeState,
} from '../agents/launch-files.js'
import { RECLAIM_GRACE_MS, worktreeStrategy } from '../agents/isolation/worktree.js'
import type { Allocation } from '../agents/isolation/index.js'
import type { HookProcess, HookSpawnFn } from '../agents/hooks.js'
import { autoAttach } from './broker-harness.js'
import { transcriptPath } from '../agents/transcript.js'
import { writeOutputTail } from '../agents/launch-output.js'
import { RESUMED_BRIEF } from '../agents/resume-session.js'

/**
 * A6 — lifecycle. What is being proved is that an agent's slot, isolation and
 * identity all end up in the right state however it dies: a real exit code when
 * one exists, and an inference from presence when none can.
 */

const tmpDirs: string[] = []
let core: BrokerCore
let supervisor: Supervisor
let events: EventLog
/** Drop the stand-in registration, for the tests that are about it not arriving. */
let stopAutoAttach: () => void

function makeCore(): BrokerCore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-sup-'))
  tmpDirs.push(dir)
  process.env.AGENT_CHAT_HOME = dir
  events = new EventLog(path.join(dir, 'events.db'))
  return new BrokerCore(() => undefined, { events, registry: new Registry<Conn>() })
}

/** CC-118: CI runs this suite again with `AGENT_CHAT_LEDGER_SHADOW=1`, which must change nothing. */
function withShadow(options: SupervisorOptions): SupervisorOptions {
  const ledger = shadowLedgerFromConfig(() => events.ledgerHandle())
  return ledger === undefined ? options : { ...options, ledger }
}

const fakeConn = (): Conn => ({}) as unknown as net.Socket

/** A workspace the `none` isolation strategy is happy with. */
function workspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-ws-'))
  tmpDirs.push(dir)
  return dir
}

/** A home directory the cwd policy really treats as home, even when it sits under the tmp root. */
function isolatedHome(): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-home-'))
  tmpDirs.push(base)
  const home = path.join(base, 'home')
  fs.mkdirSync(home)
  vi.spyOn(os, 'homedir').mockReturnValue(home)
  return home
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

/** Puts Claude Code's transcript where it would be for this identity, so a resume has a conversation to find. */
function writeTranscriptFor(agent: AgentIdentity): string {
  const file = transcriptPath(agent.cwd, agent.sessionId, agent.configDir)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '{}\n')
  return file
}

const kindsFor = (agentId: string): string[] =>
  core.events
    .agentEvents()
    .filter(r => r.ref === agentId || r.msgId === agentId)
    .map(r => r.kind)

beforeEach(() => {
  vi.useFakeTimers()
  core = makeCore()
  stopAutoAttach = autoAttach(core)
})

afterEach(() => {
  stopAutoAttach()
  supervisor?.close()
  vi.useRealTimers()
  vi.restoreAllMocks()
  delete process.env.AGENT_CHAT_HOME
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

/**
 * A child that starts and keeps running — the ordinary case, and the one that
 * lets the attach path rather than a real process decide what a test sees.
 *
 * `once` never fires, so `handle.exited` stays pending. A test that wants a death
 * supplies its own spawn.
 */
const liveChild = (): { pid: number; unref: () => void; once: () => undefined } => ({
  pid: 4242,
  unref: () => undefined,
  once: () => undefined,
})

/**
 * Launches nothing. The reported platform is forced to a non-macOS one so an
 * `iterm-pane` request refuses deterministically instead of depending on whether
 * the machine running the tests happens to have iTerm open — which it did, and
 * which meant these tests opened real windows on a developer laptop.
 *
 * `spawn` is stubbed for the headless equivalent of that, and it is not
 * cosmetic. Without it every headless spawn here really ran
 * `node dist/cli.js run-agent <id>`, which really ran `claude`, whose own MCP
 * server found no socket at the test's `AGENT_CHAT_HOME` and started a DETACHED
 * BROKER — which then wrote `agent_attached` into the very events.db the test was
 * asserting against. Two abandoned homes on this machine still hold the
 * `broker.log` and `ui.token` that proves it. It made `gives the slot back` pass
 * on a laptop with `claude` installed and fail on CI, where there is none.
 */
function withStubbedSurface(
  opts: {
    settleMs?: number
    attachMs?: number
    semaphore?: Semaphore
    spawnRateBudget?: SpawnRateBudget
    hookSpawn?: HookSpawnFn
  } = {},
): Supervisor {
  supervisor = new Supervisor(core, withShadow({ ...opts, surface: { platform: 'linux', spawn: liveChild } }))
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

      const result = await sup.spawn(spawnReq({ requestedBy: 'peer', cwd: isolatedHome() }))

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

  /**
   * CC-63. The briefing itself is built and resolved in `active-work.ts` and
   * tested there; what matters here is that the spawned agent is actually HANDED
   * it, and that a briefing that cannot be resolved costs a warning rather than
   * the spawn.
   */
  describe('an injected active-work briefing', () => {
    /** A minimal initiative, in a root the supervisor is pointed at by env. */
    function initiativeRoot(slug: string): string {
      const root = workspace()
      fs.mkdirSync(path.join(root, slug), { recursive: true })
      fs.writeFileSync(path.join(root, slug, 'brief.md'), '# Widgets\n\nWhy: to prove orientation lands.\n')
      process.env.AGENT_CHAT_ACTIVE_WORK_ROOT = root
      return root
    }

    afterEach(() => {
      delete process.env.AGENT_CHAT_ACTIVE_WORK_ROOT
    })

    it('prepends the initiative to the brief the agent actually receives', async () => {
      const sup = withStubbedSurface()
      initiativeRoot('widgets')

      const result = await sup.spawn(spawnReq({ brief: 'review the parser', briefing: 'widgets' }))

      expect(result.ok).toBe(true)
      // Headless carries the brief on stdin; this is what the process is handed.
      const delivered = readLaunchPlan(result.agentId as string).stdin ?? ''
      expect(delivered).toContain('Why: to prove orientation lands.')
      expect(delivered).toContain('review the parser')
      // CC-101: the test env points the daemon at a refusing port, so the ranked section fails open.
      expect(result.warnings?.join(' ')).toMatch(
        /related context unavailable \(active-work daemon: ECONNREFUSED, after \d+ ms of \d+ ms budget\)/,
      )
      // The log records what was ASKED FOR, with the slug as the pointer.
      const row = core.events.agentEvents().find(r => r.kind === 'agent_spawned')
      expect(row?.body).toBe('review the parser')
      expect(row?.meta.briefing).toBe('widgets')
    })

    it('spawns anyway, with a warning, when the initiative cannot be resolved', async () => {
      const sup = withStubbedSurface()
      initiativeRoot('widgets')

      const result = await sup.spawn(spawnReq({ briefing: 'no-such-initiative' }))

      expect(result.ok).toBe(true)
      expect(result.warnings?.join(' ')).toMatch(/no active-work initiative "no-such-initiative"/)
      expect(readLaunchPlan(result.agentId as string).stdin ?? '').not.toContain('Orientation')
    })
  })

  /** CC-133. The section is built in `predecessor.ts`; here it must reach the agent and the log. */
  describe('a successor spawned with a predecessor', () => {
    it("puts the predecessor's last report ahead of the assignment, and warns that it is unretired", async () => {
      const sup = withStubbedSurface()
      expect((await sup.spawn(spawnReq({ name: 'first', requestedBy: 'coord' }))).ok).toBe(true)
      core.events.append({ kind: 'message', actor: 'first', target: 'coord', body: 'Status: DONE. PR #7.' })

      const result = await sup.spawn(
        spawnReq({ name: 'second', requestedBy: 'coord', brief: 'address the review', predecessor: 'first' }),
      )

      expect(result.ok).toBe(true)
      const delivered = readLaunchPlan(result.agentId as string).stdin ?? ''
      expect(delivered.indexOf('Status: DONE. PR #7.')).toBeGreaterThan(-1)
      expect(delivered.indexOf('Status: DONE. PR #7.')).toBeLessThan(delivered.indexOf('address the review'))
      expect(result.warnings?.join(' ')).toMatch(/predecessor first is live, not retired/)
      const row = core.events.agentEvents().find(r => r.kind === 'agent_spawned' && r.target === 'second')
      expect(row?.meta.predecessor).toBe('first')
      expect(row?.body).toBe('address the review')
    })

    it("refuses before taking a slot when the predecessor is not the requester's", async () => {
      const sup = withStubbedSurface()
      await sup.spawn(spawnReq({ name: 'first', requestedBy: 'other' }))

      const result = await sup.spawn(spawnReq({ name: 'second', requestedBy: 'coord', predecessor: 'first' }))

      expect(result.ok).toBe(false)
      expect(result.reason).toMatch(/spawned by other, not by you/)
      expect(core.events.agentEvents().some(r => r.kind === 'agent_spawned' && r.target === 'second')).toBe(
        false,
      )
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
      'Bash(agent-chat approve:*)',
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
    const runAppleScript = async (script: string): Promise<string> => {
      scripts.push(script)
      if (script.includes('is running')) return 'true'
      return `PANE-${scripts.length}`
    }
    supervisor = new Supervisor(core, withShadow({ surface: { platform: 'darwin', runAppleScript } }))

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
    const account = workspace()
    const spawned = await sup.spawn(spawnReq({ name: 'scout', spawnerConfigDir: account }))
    const agentId = spawned.agentId!
    writeTranscriptFor(core.agents.get(agentId)!)

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
 * CC-77. Retire used to end a process only as a side effect of closing the pane
 * it opened, and closing needs a launch handle — which lives in memory and dies
 * with the broker. An agent retired after a broker restart therefore kept its
 * name freed, its slot released, and its process running: observed three days
 * running in a pane, with `agent_retired` in the log and nothing after it.
 *
 * The pid comes from the REGISTRY, which is the whole point: a session
 * re-registers after every broker restart, so it is populated exactly when the
 * handle is not.
 */
describe('retiring reaps the process', () => {
  let signals: [number, NodeJS.Signals][]

  beforeEach(() => {
    signals = []
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      signals.push([pid, signal as NodeJS.Signals])
      return true
    })
  })

  afterEach(() => vi.restoreAllMocks())

  const identity = (name = 'scout', id = 'a1'): void => {
    core.append({ kind: 'agent_spawned', actor: 'human', target: name, msgId: id, body: 'work' })
  }

  /** `pid` is the MCP subprocess; `hostPid` is Claude Code, and is the optional one. */
  const registerSession = (over: { hostPid?: number } = { hostPid: 4242 }): void => {
    core.registry.register(fakeConn(), { name: 'scout', workingOn: 'work', cwd: '/tmp', pid: 1, ...over })
  }

  const liveOn = (
    sup: Supervisor,
    isolation = 'none',
    allocation: Record<string, unknown> = { cwd: '/tmp' },
  ): void => {
    ;(sup as unknown as { live: Map<string, unknown> }).live.set('a1', {
      agentId: 'a1',
      name: 'scout',
      handle: { surface: 'headless' },
      allocation,
      isolation,
    })
  }

  it('ends Claude Code itself, not the MCP subprocess that reported it', async () => {
    // `pid` above is the subprocess: signalling that severs the bus and leaves a
    // live session no peer can reach. `hostPid` is the one that is actionable.
    const sup = withStubbedSurface()
    identity()
    registerSession()

    expect((await sup.retire('scout')).ok).toBe(true)

    expect(signals).toEqual([[4242, 'SIGTERM']])
  })

  it('follows an ignored SIGTERM with SIGKILL', async () => {
    const sup = withStubbedSurface()
    identity()
    registerSession()

    await sup.retire('scout')
    vi.advanceTimersByTime(3000)

    expect(signals.map(s => s[1])).toEqual(['SIGTERM', 'SIGKILL'])
  })

  it('reaps an agent whose launch handle the broker lost in a restart', async () => {
    // The regression itself: no live entry, because nothing rehydrates `live`.
    const sup = withStubbedSurface()
    identity()
    registerSession()

    const result = await sup.retire('scout')

    expect(result.ok).toBe(true)
    expect(signals[0]).toEqual([4242, 'SIGTERM'])
  })

  it('says what it could not do instead of reporting a bare ok', async () => {
    // Nothing in memory AND nothing on disk: an agent from before runtime state
    // was persisted. Retire still frees the name, and still says what it skipped.
    const sup = withStubbedSurface()
    identity()
    registerSession()

    const result = await sup.retire('scout')

    expect(result.ok).toBe(true)
    expect(result.reason).toMatch(/no record of what scout held/)
    expect(result.reason).toMatch(/isolation.*not released/)
  })

  it('signals nothing for an agent that is no longer registered', async () => {
    // The ordinary, quiet case: the agent already exited, or closing its pane
    // just ended it. Nothing left to signal, and nothing to warn about.
    const sup = withStubbedSurface()
    identity()
    liveOn(sup)

    const result = await sup.retire('scout')

    expect(signals).toEqual([])
    expect(result.reason).toBeUndefined()
  })

  it('refuses to signal a session that never reported hostPid, and says where to go', async () => {
    const sup = withStubbedSurface()
    identity()
    liveOn(sup)
    registerSession({})

    const result = await sup.retire('scout')

    expect(signals).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.reason).toMatch(/exit it in its terminal/)
  })

  it('kills nothing when the isolation refuses to release', async () => {
    // Order matters: isolation can hold uncommitted work, and a refusal that has
    // already killed the process is not a refusal.
    const sup = withStubbedSurface()
    identity()
    liveOn(sup, 'worktree')
    registerSession()

    const result = await sup.retire('scout')

    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/refused release/)
    expect(signals).toEqual([])
  })

  it('records what the reap did on the retire row', async () => {
    const sup = withStubbedSurface()
    identity()
    registerSession()

    await sup.retire('scout')

    const row = core.events.agentEvents().find(r => r.kind === 'agent_retired')
    expect(row?.meta?.reaped).toBe('true')
  })
})

/**
 * CC-78. The other half of what CC-77 exposed. The reap could be fixed from the
 * registry, but the worktree and the pane could not: `alloc.ref` and the pane's
 * UUID existed only in `Supervisor.live`, so a broker restart leaked a worktree
 * and a branch per agent. What a running agent HOLDS now goes to disk beside its
 * plan, and retire reads it back when memory has nothing.
 *
 * A fresh Supervisor over the same core and the same AGENT_CHAT_HOME is exactly
 * what a broker restart looks like from here: the log and the agent directories
 * survive, `live` does not.
 */
describe('runtime state outliving the broker', () => {
  const identity = (id = 'a1'): void => {
    core.append({ kind: 'agent_spawned', actor: 'human', target: 'scout', msgId: id, body: 'work' })
  }

  it('is written when an agent is launched', async () => {
    const sup = withStubbedSurface()
    const result = await sup.spawn(spawnReq())

    const state = readRuntimeState(result.agentId as string)
    expect(state?.handle.surface).toBe('headless')
    expect(state?.isolation).toBe('none')
    expect(state?.allocation.cwd).toBeDefined()
  })

  it('is not the launch handle: an unserialisable exit promise is dropped', async () => {
    // `exited` is a Promise held by the process that launched the agent. Keeping
    // it out is what makes the persisted copy safe to hand to retire and nowhere
    // else — its absence already means "infer this agent's exit from presence".
    const sup = withStubbedSurface()
    const result = await sup.spawn(spawnReq())

    expect(readRuntimeState(result.agentId as string)?.handle).not.toHaveProperty('exited')
  })

  it('lets a restarted broker release the worktree it did not allocate', async () => {
    identity()
    // A worktree allocation with no `ref` is one the strategy refuses to
    // release — which is the point: only a supervisor that actually READ the
    // persisted isolation can refuse for that reason.
    writeRuntimeState('a1', {
      handle: { surface: 'headless' },
      allocation: { cwd: '/tmp' },
      isolation: 'worktree',
    })

    const result = await withStubbedSurface().retire('scout')

    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/refused release \(allocation carries no worktree reference\)/)
  })

  it('lets a restarted broker close the pane it did not open', async () => {
    identity()
    writeRuntimeState('a1', {
      handle: { surface: 'iterm-pane', paneRef: 'PANE-1', ownsSurface: true },
      allocation: { cwd: '/tmp' },
      isolation: 'none',
    })
    const scripts: string[] = []
    supervisor = new Supervisor(
      core,
      withShadow({
        surface: {
          platform: 'darwin',
          runAppleScript: async (script: string): Promise<string> => {
            scripts.push(script)
            return script.includes('is running')
              ? 'true'
              : script.includes('to close')
                ? '@@closed@@'
                : 'PANE-1'
          },
        },
      }),
    )

    expect((await supervisor.retire('scout')).ok).toBe(true)
    expect(scripts.filter(s => s.includes('to close'))[0]).toContain('is "PANE-1"')
  })

  it('says nothing about a lost handle when it found one on disk', async () => {
    identity()
    writeRuntimeState('a1', {
      handle: { surface: 'headless' },
      allocation: { cwd: '/tmp' },
      isolation: 'none',
    })

    expect((await withStubbedSurface().retire('scout')).reason).toBeUndefined()
  })

  it('drops the state on retire, so an allocation is never released twice', async () => {
    // `worktree remove` plus `branch -D`, replayed against a branch name a later
    // agent has since taken, destroys someone else's work.
    identity()
    writeRuntimeState('a1', {
      handle: { surface: 'headless' },
      allocation: { cwd: '/tmp' },
      isolation: 'none',
    })

    await withStubbedSurface().retire('scout')

    expect(readRuntimeState('a1')).toBeUndefined()
  })

  it('degrades to the old behaviour on an unreadable file rather than failing', async () => {
    identity()
    fs.mkdirSync(path.dirname(runtimeStatePath('a1')), { recursive: true })
    fs.writeFileSync(runtimeStatePath('a1'), 'not json')

    const result = await withStubbedSurface().retire('scout')

    expect(result.ok).toBe(true)
    expect(result.reason).toMatch(/no record of what scout held/)
  })
})

/**
 * CC-79. The strategies have honoured `force` since they were written, and it is
 * tested against them directly in isolation.test.ts. What was never wired was
 * the path a person actually takes to reach it — so this covers the supervisor's
 * half of that, against a real repository, because a worktree that refuses is
 * not provable against a mock.
 */
const git = (args: string[], cwd: string): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()

/** A repository with one commit, for a worktree to be cut from. */
function makeRepo(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sup-force-')))
  tmpDirs.push(dir)
  git(['init', '-b', 'main'], dir)
  git(['config', 'user.email', 'test@example.com'], dir)
  git(['config', 'user.name', 'Test'], dir)
  git(['config', 'commit.gpgsign', 'false'], dir)
  fs.writeFileSync(path.join(dir, 'README.md'), 'seed\n')
  git(['add', '.'], dir)
  git(['commit', '-m', 'seed'], dir)
  return dir
}

describe('retiring with force', () => {
  /** An agent holding a real worktree with a commit nobody else has. */
  async function agentHoldingUnmergedWork(sup: Supervisor): Promise<Allocation> {
    core.append({ kind: 'agent_spawned', actor: 'human', target: 'scout', msgId: 'a1', body: 'work' })
    const repo = makeRepo()
    const allocation = await worktreeStrategy.allocate({ agentId: 'a1', agentName: 'scout', baseCwd: repo })
    fs.writeFileSync(path.join(allocation.cwd, 'feature.ts'), 'work\n')
    git(['add', 'feature.ts'], allocation.cwd)
    git(['commit', '-m', 'add feature'], allocation.cwd)
    ;(sup as unknown as { live: Map<string, unknown> }).live.set('a1', {
      agentId: 'a1',
      name: 'scout',
      handle: { surface: 'headless' },
      allocation,
      isolation: 'worktree',
    })
    return allocation
  }

  it('refuses without it, keeping the commits nobody else has', async () => {
    const sup = withStubbedSurface()
    const allocation = await agentHoldingUnmergedWork(sup)

    const result = await sup.retire('scout')

    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/retire with --force/)
    expect(fs.existsSync(allocation.cwd)).toBe(true)
  })

  /** CC-188: cc181 was refused at +85s, then again at +124s because the first refusal's row restarted the clock. */
  it('releases a clean worktree once the grace window after the exit has passed, despite an earlier refusal', async () => {
    const sup = withStubbedSurface()
    core.append({ kind: 'agent_spawned', actor: 'human', target: 'scout', msgId: 'a1', body: 'work' })
    const allocation = await worktreeStrategy.allocate({
      agentId: 'a1',
      agentName: 'scout',
      baseCwd: makeRepo(),
    })
    ;(sup as unknown as { live: Map<string, unknown> }).live.set('a1', {
      agentId: 'a1',
      name: 'scout',
      handle: { surface: 'headless' },
      allocation,
      isolation: 'worktree',
    })
    core.append({ kind: 'agent_exited', actor: 'scout', ref: 'a1', meta: { code: '0' } })

    vi.advanceTimersByTime(85_000)
    const early = await sup.retire('scout')
    vi.advanceTimersByTime(RECLAIM_GRACE_MS - 85_000 + 4_000)
    const late = await sup.retire('scout')

    expect(early.reason).toMatch(/inside the reclaim grace window/)
    expect(late).toEqual({ ok: true })
    expect(fs.existsSync(allocation.cwd)).toBe(false)
  })

  /** CC-189: an explicit retire ends the agent, live or not, so a resume must not make the tree unreleasable. */
  describe('an agent that exited and was resumed', () => {
    async function resumedAgentWithCleanTree(sup: Supervisor): Promise<Allocation> {
      core.append({ kind: 'agent_spawned', actor: 'human', target: 'scout', msgId: 'a1', body: 'work' })
      const allocation = await worktreeStrategy.allocate({
        agentId: 'a1',
        agentName: 'scout',
        baseCwd: makeRepo(),
      })
      ;(sup as unknown as { live: Map<string, unknown> }).live.set('a1', {
        agentId: 'a1',
        name: 'scout',
        handle: { surface: 'headless' },
        allocation,
        isolation: 'worktree',
      })
      core.append({ kind: 'agent_exited', actor: 'scout', ref: 'a1', meta: { code: '0' } })
      core.append({ kind: 'agent_resumed', actor: 'human', target: 'scout', ref: 'a1' })
      core.append({ kind: 'agent_attached', actor: 'scout', ref: 'a1' })
      return allocation
    }

    it('releases a clean tree without force', async () => {
      const sup = withStubbedSurface()
      const allocation = await resumedAgentWithCleanTree(sup)
      expect(core.agents.byName('scout')?.state).toBe('live')

      const result = await sup.retire('scout')

      expect(result).toEqual({ ok: true })
      expect(fs.existsSync(allocation.cwd)).toBe(false)
    })

    it('refuses a tree with an uncommitted file, naming the dirty reason', async () => {
      const sup = withStubbedSurface()
      const allocation = await resumedAgentWithCleanTree(sup)
      fs.writeFileSync(path.join(allocation.cwd, 'wip.ts'), 'unsaved\n')

      const result = await sup.retire('scout')

      expect(result.ok).toBe(false)
      expect(result.reason).toMatch(/uncommitted/)
      expect(fs.existsSync(allocation.cwd)).toBe(true)
    })
  })

  it('destroys them when the human says so', async () => {
    const sup = withStubbedSurface()
    const allocation = await agentHoldingUnmergedWork(sup)

    const result = await sup.retire('scout', true)

    expect(result.ok).toBe(true)
    expect(fs.existsSync(allocation.cwd)).toBe(false)
    expect(core.agents.nameIsClaimed('scout')).toBe(false)
  })

  /**
   * CC-141. A clean, merged worktree is exactly what release removes without
   * asking, so it is the case where a successor working in it loses it silently.
   */
  describe('while a successor works in the predecessor’s worktree', () => {
    async function predecessorWithCleanWorktree(sup: Supervisor): Promise<Allocation> {
      core.append({ kind: 'agent_spawned', actor: 'human', target: 'scout', msgId: 'a1', body: 'work' })
      const allocation = await worktreeStrategy.allocate({
        agentId: 'a1',
        agentName: 'scout',
        baseCwd: makeRepo(),
      })
      ;(sup as unknown as { live: Map<string, unknown> }).live.set('a1', {
        agentId: 'a1',
        name: 'scout',
        handle: { surface: 'headless' },
        allocation,
        isolation: 'worktree',
      })
      return allocation
    }

    const successorIn = (cwd: string): void =>
      void core.append({
        kind: 'agent_spawned',
        actor: 'human',
        target: 'heir',
        msgId: 'a2',
        body: 'carry on',
        meta: { name: 'heir', cwd, isolation: 'worktree' },
      })

    it('refuses to retire the predecessor, and names the successor', async () => {
      const sup = withStubbedSurface()
      const allocation = await predecessorWithCleanWorktree(sup)
      successorIn(allocation.cwd)

      const result = await sup.retire('scout')

      expect(result.ok).toBe(false)
      expect(result.reason).toMatch(/heir \(not retired\) is working in it/)
      expect(result.reason).toMatch(/--force/)
      expect(fs.existsSync(allocation.cwd)).toBe(true)
      expect(core.agents.nameIsClaimed('scout')).toBe(true)
    })

    it('releases it under --force, and says what it released', async () => {
      const sup = withStubbedSurface()
      const allocation = await predecessorWithCleanWorktree(sup)
      successorIn(allocation.cwd)

      const result = await sup.retire('scout', true)

      expect(result.ok).toBe(true)
      expect(result.reason).toContain(`released the worktree ${allocation.cwd} and branch agent-chat/scout`)
      expect(result.reason).toMatch(/while heir was still working in it/)
      expect(fs.existsSync(allocation.cwd)).toBe(false)
    })

    it('refuses when the successor reached the worktree through a symlink', async () => {
      const sup = withStubbedSurface()
      const allocation = await predecessorWithCleanWorktree(sup)
      const link = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sup-link-'))), 'tree')
      tmpDirs.push(path.dirname(link))
      fs.symlinkSync(allocation.cwd, link)
      successorIn(path.join(link, 'src'))

      const result = await sup.retire('scout')

      expect(result.ok).toBe(false)
      expect(result.reason).toMatch(/heir \(not retired\) is working in it/)
      expect(fs.existsSync(allocation.cwd)).toBe(true)
    })

    it('refuses when the predecessor recorded its worktree through a symlink', async () => {
      const sup = withStubbedSurface()
      const allocation = await predecessorWithCleanWorktree(sup)
      const link = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sup-link-'))), 'tree')
      tmpDirs.push(path.dirname(link))
      fs.symlinkSync(allocation.cwd, link)
      const entry = (sup as unknown as { live: Map<string, { allocation: Allocation }> }).live.get('a1')
      if (entry?.allocation.ref) entry.allocation.ref.worktree = link
      successorIn(allocation.cwd)

      const result = await sup.retire('scout')

      expect(result.ok).toBe(false)
      expect(result.reason).toMatch(/heir \(not retired\) is working in it/)
      expect(fs.existsSync(allocation.cwd)).toBe(true)
    })

    it('does not count an agent in a sibling worktree whose name extends this one', async () => {
      const sup = withStubbedSurface()
      const allocation = await predecessorWithCleanWorktree(sup)
      const sibling = `${allocation.cwd}-2`
      fs.mkdirSync(sibling)
      tmpDirs.push(sibling)
      successorIn(sibling)

      const result = await sup.retire('scout')

      expect(result.ok).toBe(true)
      expect(fs.existsSync(allocation.cwd)).toBe(false)
    })

    it('still refuses after the successor exits, because exited is not retired', async () => {
      const sup = withStubbedSurface()
      const allocation = await predecessorWithCleanWorktree(sup)
      successorIn(allocation.cwd)
      core.append({ kind: 'agent_exited', actor: 'heir', ref: 'a2', meta: { code: '0' } })
      expect(core.agents.get('a2')?.state).toBe('exited')

      const result = await sup.retire('scout')

      expect(result.ok).toBe(false)
      expect(result.reason).toMatch(/heir \(not retired\) is working in it/)
      expect(fs.existsSync(allocation.cwd)).toBe(true)
    })

    it('releases it once the successor is retired', async () => {
      const sup = withStubbedSurface()
      const allocation = await predecessorWithCleanWorktree(sup)
      successorIn(allocation.cwd)
      core.append({ kind: 'agent_retired', actor: 'human', target: 'heir', ref: 'a2' })

      const result = await sup.retire('scout')

      expect(result.ok).toBe(true)
      expect(result.reason).toBeUndefined()
      expect(fs.existsSync(allocation.cwd)).toBe(false)
    })
  })
})

/**
 * CC-158. Nine spawns that never registered left nine worktrees and branches on
 * disk: the names refused ("still on disk and holds branch"), retire said it had
 * no record of what they held, and the repo's budget read 10/10 until someone
 * removed them by hand.
 */
describe('a spawn that never registers gives back its worktree', () => {
  beforeEach(() => {
    vi.useRealTimers()
    stopAutoAttach()
  })

  const worktreeCount = (repo: string): number =>
    git(['worktree', 'list', '--porcelain'], repo)
      .split('\n')
      .filter(line => line.startsWith('worktree ')).length

  const branchExists = (repo: string, branch: string): boolean =>
    git(['branch', '--list', branch], repo) !== ''

  /** A headless claude that exits before registering: evidence that nothing is left running in the tree. */
  const diesBeforeRegistering = () => ({
    pid: 4242,
    unref: () => undefined,
    once: (event: string, listener: (...args: unknown[]) => void) => {
      if (event === 'exit') queueMicrotask(() => listener(1, null))
    },
  })

  const neverRegisters = (repo: string, over: Record<string, unknown> = {}): Promise<SpawnOutcome> => {
    supervisor = new Supervisor(
      core,
      withShadow({ attachMs: 60_000, surface: { platform: 'linux', spawn: diesBeforeRegistering } }),
    )
    return supervisor.spawn(spawnReq({ cwd: repo, isolation: 'worktree', ...over }))
  }

  const releasedRows = (agentId: string) =>
    core.events.agentEvents().filter(r => r.kind === 'isolation_released' && r.ref === agentId)

  it('returns the budget and lets the same name spawn again', async () => {
    const repo = makeRepo()
    const before = worktreeCount(repo)

    const failed = await neverRegisters(repo)

    expect(failed.ok).toBe(false)
    expect(worktreeCount(repo)).toBe(before)
    expect(branchExists(repo, 'agent-chat/scout')).toBe(false)
    stopAutoAttach = autoAttach(core)
    const again = withStubbedSurface()
    expect((await again.spawn(spawnReq({ cwd: repo, isolation: 'worktree' }))).ok).toBe(true)
  })

  it('keeps the tree of a headless claude that is only slow to register', async () => {
    const repo = makeRepo()
    const tree = path.join(repo, '.worktrees', 'scout')

    const failed = await withStubbedSurface({ attachMs: 200 }).spawn(
      spawnReq({ cwd: repo, isolation: 'worktree' }),
    )

    expect(failed.ok).toBe(false)
    expect(fs.existsSync(tree)).toBe(true)
    expect(readRuntimeState(failed.agentId as string)?.isolation).toBe('worktree')
    expect(releasedRows(failed.agentId as string)).toHaveLength(0)
  })

  it('releases the tree of a pane whose run-agent never started, though the pane is still open', async () => {
    const repo = makeRepo()
    const tree = path.join(repo, '.worktrees', 'scout')
    supervisor = new Supervisor(
      core,
      withShadow({
        attachMs: 60_000,
        surface: {
          platform: 'darwin',
          runAppleScript: async script =>
            script.includes('is running')
              ? 'true'
              : script.includes('return tty of s')
                ? '/dev/ttys042'
                : script.includes('return contents of s')
                  ? ''
                  : script.includes('@@present@@')
                    ? '@@present@@'
                    : 'PANE-1',
          probeProcesses: async () => ['-zsh'],
          launchCheck: { deadlineMs: 10, pollMs: 5 },
        },
      }),
    )

    const failed = await supervisor.spawn(
      spawnReq({ cwd: repo, isolation: 'worktree', surface: 'iterm-pane' }),
    )

    expect(failed.reason).toMatch(/run-agent .* was not running in its pane/)
    expect(fs.existsSync(tree)).toBe(false)
    expect(releasedRows(failed.agentId as string)).toHaveLength(1)
  })

  it('never releases the tree a second time when the failed agent is retired', async () => {
    const failed = await neverRegisters(makeRepo())

    const retired = await supervisor.retire('scout')

    expect(retired).toEqual({ ok: true })
    expect(releasedRows(failed.agentId as string).map(r => r.meta)).toEqual([
      { strategy: 'worktree', released: 'true' },
    ])
  })

  it('releases it when the surface refuses before anything launched, and frees the name', async () => {
    const repo = makeRepo()
    const before = worktreeCount(repo)

    const failed = await neverRegisters(repo, { surface: 'iterm-pane' })

    expect(failed.ok).toBe(false)
    expect(worktreeCount(repo)).toBe(before)
    expect(core.agents.nameIsClaimed('scout')).toBe(false)
  })

  it('keeps a reused branch holding commits nowhere else, for retire --force', async () => {
    const repo = makeRepo()
    git(['switch', '-c', 'agent-chat/scout'], repo)
    fs.writeFileSync(path.join(repo, 'earlier.ts'), 'work\n')
    git(['add', 'earlier.ts'], repo)
    git(['commit', '-m', 'earlier run'], repo)
    git(['switch', 'main'], repo)

    const failed = await neverRegisters(repo)
    const tree = path.join(repo, '.worktrees', 'scout')

    expect(failed.ok).toBe(false)
    expect(fs.existsSync(tree)).toBe(true)
    const retired = await supervisor.retire('scout', true)
    expect(retired).toEqual({ ok: true })
    expect(fs.existsSync(tree)).toBe(false)
  })

  it('never releases a worktree it was assigned', async () => {
    const repo = makeRepo()
    const assigned = path.join(repo, '.worktrees', 'task')
    git(['worktree', 'add', '-b', 'task', assigned], repo)

    const failed = await neverRegisters(repo, { worktree: assigned })

    expect(failed.ok).toBe(false)
    expect(fs.existsSync(assigned)).toBe(true)
    expect(branchExists(repo, 'task')).toBe(true)
  })

  it('keeps the tree while the pane that may be running in it is still open', async () => {
    const repo = makeRepo()
    supervisor = new Supervisor(
      core,
      withShadow({
        attachMs: 100,
        attachCeilingMs: 300,
        surface: {
          platform: 'darwin',
          runAppleScript: async script =>
            script.includes('is running')
              ? 'true'
              : script.includes('@@present@@')
                ? '@@present@@'
                : 'PANE-1',
        },
      }),
    )

    const pending = await supervisor.spawn(
      spawnReq({ cwd: repo, isolation: 'worktree', surface: 'iterm-window' }),
    )
    const agentId = pending.agentId as string
    const log = path.join(process.env.AGENT_CHAT_HOME as string, 'broker.log')
    await vi.waitFor(() => expect(fs.readFileSync(log, 'utf8')).toContain('"agent_spawn_failed"'))

    expect(core.agents.get(agentId)?.exit?.failedToStart).toBe(true)
    expect(fs.existsSync(path.join(repo, '.worktrees', 'scout'))).toBe(true)
    expect(readRuntimeState(agentId)?.isolation).toBe('worktree')
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
    const runAppleScript = async (script: string): Promise<string> => {
      scripts.push(script)
      if (script.includes('is running')) return 'true'
      // CC-95: a close is followed by a second read of the session list, and an
      // iTerm2 that never answers it would make every teardown "unconfirmed".
      if (script.includes('@@present@@')) return '@@gone@@'
      if (script.includes('to close')) return '@@closed@@'
      return 'PANE-1'
    }
    supervisor = new Supervisor(
      core,
      withShadow({ settleMs, surface: { platform: 'darwin', runAppleScript } }),
    )
    return { scripts, sup: supervisor, closes: () => scripts.filter(s => s.includes('to close')) }
  }

  const liveOn = (
    sup: Supervisor,
    handle: Record<string, unknown>,
    id = 'a1',
    lifetime = 'close-on-exit',
  ): void => {
    // No spawn ran, so the stand-in registration must not fire: it would land
    // AFTER the detach these tests append and cancel the settle they depend on.
    stopAutoAttach()
    core.append({
      kind: 'agent_spawned',
      actor: 'human',
      target: 'scout',
      msgId: id,
      body: 'work',
      // The exit path reads the lifetime off this row, so a hand-built agent has
      // to declare one the way a real spawn does.
      meta: { surface_lifetime: lifetime },
    })
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
   * CC-95, and a reversal. This used to assert the opposite — an agent finishing
   * is not an instruction to throw away what it printed — and the panes decided
   * it: four agents reached `finished`, their panes sat at `-zsh` for six and a
   * half hours, and a human retired them by hand purely to reclaim the screen.
   *
   * The inferred path is the one that matters, because it is the ONLY exit a
   * visible agent ever gets: nothing calls back into agent-chat when a human
   * types /exit in a pane, so a detach with no reattach is all there is.
   */
  it('closes the pane when a close-on-exit agent exits, even on an inferred exit', async () => {
    const { sup, closes } = fakeIterm(500)
    liveOn(sup, { surface: 'iterm-pane', paneRef: 'PANE-1', ownsSurface: true })

    core.append({ kind: 'agent_detached', actor: 'scout', ref: 'a1' })
    await vi.advanceTimersByTimeAsync(500)

    expect(kindsFor('a1')).toContain('agent_exited')
    expect(closes()).toHaveLength(1)
    expect(closes()[0]).toContain('is "PANE-1"')
  })

  /**
   * The other lifetime, and the case the retire-only rule was written for: a
   * long-lived collaborator whose last output somebody is still reading. Its
   * pane survives the exit — and retire still closes it, as it always has.
   */
  it('leaves a keep agent’s pane open when it exits, and still closes it on retire', async () => {
    const { sup, closes } = fakeIterm(500)
    liveOn(sup, { surface: 'iterm-pane', paneRef: 'PANE-1', ownsSurface: true }, 'a1', 'keep')

    core.append({ kind: 'agent_detached', actor: 'scout', ref: 'a1' })
    await vi.advanceTimersByTimeAsync(500)

    expect(kindsFor('a1')).toContain('agent_exited')
    expect(closes()).toEqual([])

    // `keep` is about the agent's own death, never about retire. Retire is the
    // explicit "I am done with this agent" and takes the pane with it as before.
    ;(sup as unknown as { live: Map<string, unknown> }).live.set('a1', {
      agentId: 'a1',
      name: 'scout',
      handle: { surface: 'iterm-pane', paneRef: 'PANE-1', ownsSurface: true },
      allocation: { cwd: '/tmp' },
      isolation: 'none',
    })
    expect((await sup.retire('scout')).ok).toBe(true)
    expect(closes()).toHaveLength(1)
  })

  /**
   * A profile written before the field existed says nothing, and its pane stays.
   * A silent upgrade to close-on-exit would start destroying panes belonging to
   * agents nobody opted in for.
   */
  it('keeps the pane when the spawn row names no lifetime at all', async () => {
    const { sup, closes } = fakeIterm(500)
    liveOn(sup, { surface: 'iterm-pane', paneRef: 'PANE-1', ownsSurface: true }, 'a1', '')

    core.append({ kind: 'agent_detached', actor: 'scout', ref: 'a1' })
    await vi.advanceTimersByTimeAsync(500)

    expect(kindsFor('a1')).toContain('agent_exited')
    expect(closes()).toEqual([])
  })

  /** The constraint that did NOT move: an exit closes only what the broker opened. */
  it('leaves a pane the broker never opened alone when the agent exits', async () => {
    const { sup, closes } = fakeIterm(500)
    liveOn(sup, { surface: 'iterm-pane', paneRef: 'HUMANS-OWN-PANE' })

    core.append({ kind: 'agent_detached', actor: 'scout', ref: 'a1' })
    await vi.advanceTimersByTimeAsync(500)

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
 * CC-163. On 2026-09-26 a coordinator two coordinators deep could not spawn at
 * all under a flat depth cap of 2, while any depth-1 worker still could. The
 * bound belongs to the role: workers never spawn, and only coordinator links count.
 */
describe('agent roles', () => {
  /** Installs a profile whose only notable property is its role. */
  const installProfile = (name: string, role?: string): string => {
    const dir = path.join(process.env.AGENT_CHAT_HOME as string, 'profiles')
    fs.mkdirSync(dir, { recursive: true })
    const body = { model: 'opus', allowedTools: ['Read'], isolation: 'none', surface: 'headless' }
    fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(role ? { ...body, role } : body))
    return name
  }

  /** A registered agent whose own spawn row carries `meta`, so it may ask for spawns. */
  const recordedAgent = (name: string, cwd: string, meta: Record<string, string>): string => {
    const { msgId } = core.append({
      kind: 'agent_spawned',
      actor: 'human',
      target: name,
      meta: { name, ...meta },
    })
    core.register(fakeConn(), { t: 'register', name, workingOn: '', cwd, pid: 1 })
    return msgId
  }

  const spawnedRow = (name: string) =>
    core.events.agentEvents().find(r => r.kind === 'agent_spawned' && r.target === name)

  it("refuses a worker's spawn with a message that says what to do instead", async () => {
    const sup = withStubbedSurface()
    const shared = workspace()
    const worker = await sup.spawn(spawnReq({ name: 'digger', cwd: shared }))
    core.register(fakeConn(), { t: 'register', name: 'digger', workingOn: '', cwd: shared, pid: 1 })

    const result = await sup.spawn(
      spawnReq({ name: 'helper', requestedBy: 'digger', parentAgentId: worker.agentId, cwd: shared }),
    )

    expect(result.ok).toBe(false)
    expect(result.reason).toBe(
      'digger is a worker (profile explorer) and cannot spawn agents; report the need to your spawner via chat_send',
    )
    expect(spawnedRow('helper')).toBeUndefined()
  })

  it('lets a coordinator two coordinators deep spawn a worker, the 2026-09-26 case', async () => {
    const sup = withStubbedSurface()
    const shared = workspace()
    const lead = installProfile('lead', 'coordinator')
    const parentAgentId = recordedAgent('coordinator', shared, {
      profile: lead,
      role: 'coordinator',
      depth: '2',
      coordinator_depth: '2',
    })

    const result = await sup.spawn(spawnReq({ requestedBy: 'coordinator', parentAgentId, cwd: shared }))

    expect(result.ok).toBe(true)
    expect(spawnedRow('scout')?.meta).toMatchObject({ role: 'worker', coordinator_depth: '2', depth: '3' })
  })

  it(`caps a coordinator chain at ${MAX_COORDINATOR_DEPTH} and still lets the last coordinator spawn workers`, async () => {
    const sup = withStubbedSurface()
    const shared = workspace()
    const lead = installProfile('lead', 'coordinator')
    const parentAgentId = recordedAgent('deepest', shared, {
      profile: lead,
      role: 'coordinator',
      coordinator_depth: String(MAX_COORDINATOR_DEPTH),
    })

    const another = await sup.spawn(
      spawnReq({ name: 'sub-lead', profile: lead, requestedBy: 'deepest', parentAgentId, cwd: shared }),
    )
    const worker = await sup.spawn(spawnReq({ requestedBy: 'deepest', parentAgentId, cwd: shared }))

    expect(another.ok).toBe(false)
    expect(another.reason).toMatch(`coordinator depth 4 exceeds the cap of ${MAX_COORDINATOR_DEPTH}`)
    expect(worker.ok).toBe(true)
  })

  it('never refuses the human, and counts their coordinator as the first link', async () => {
    const sup = withStubbedSurface()
    const lead = installProfile('lead', 'coordinator')

    const result = await sup.spawn(spawnReq({ profile: lead }))

    expect(result.ok).toBe(true)
    expect(spawnedRow('scout')?.meta).toMatchObject({ role: 'coordinator', coordinator_depth: '1' })
  })

  it('refuses Remote Control for a worker profile and allows it for a coordinator', async () => {
    const sup = withStubbedSurface()
    const lead = installProfile('lead', 'coordinator')

    const worker = await sup.spawn(spawnReq({ name: 'rc-worker', remoteControl: true }))
    const coordinator = await sup.spawn(spawnReq({ name: 'rc-lead', profile: lead, remoteControl: true }))

    expect(worker.ok).toBe(false)
    expect(worker.reason).toMatch(/"explorer" is a worker and cannot run with Remote Control/)
    expect(coordinator.ok).toBe(true)
  })

  it('treats a profile file with no role as a worker', async () => {
    const sup = withStubbedSurface()
    const plain = installProfile('plain')

    const result = await sup.spawn(spawnReq({ profile: plain, remoteControl: true }))

    expect(result.reason).toMatch(/"plain" is a worker/)
  })

  it('resolves a pre-role spawn row from its profile name', async () => {
    const sup = withStubbedSurface()
    const shared = workspace()
    const lead = installProfile('lead', 'coordinator')
    const legacyLead = recordedAgent('old-lead', shared, { profile: lead, depth: '2' })
    const legacyWorker = recordedAgent('old-worker', shared, { profile: 'implementer', depth: '1' })

    const fromLead = await sup.spawn(
      spawnReq({ requestedBy: 'old-lead', parentAgentId: legacyLead, cwd: shared }),
    )
    const fromWorker = await sup.spawn(
      spawnReq({ name: 'other', requestedBy: 'old-worker', parentAgentId: legacyWorker, cwd: shared }),
    )

    expect(fromLead.ok).toBe(true)
    expect(fromWorker.reason).toMatch(/old-worker is a worker \(profile implementer\)/)
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
  /** A spawned coordinator that was itself granted `tools`, and is registered so it may spawn. */
  const spawnedParent = (name: string, cwd: string, tools: string[]): string => {
    const { msgId } = core.append({
      kind: 'agent_spawned',
      actor: 'human',
      target: name,
      meta: { name, depth: '1', role: 'coordinator', allowed_tools: tools.join(',') },
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
      meta: {
        name,
        depth: '1',
        role: 'coordinator',
        allowed_tools: tools.join(','),
        disallowed_tools: denied.join(','),
      },
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

  /**
   * CC-69: a parent denied only scoped Bash sub-patterns (as `peer` is) can
   * spawn a child whose deny list denies ALL of Bash (as `explorer` does) — the
   * blanket deny is strictly stronger, so it is not actually a weaker deny list
   * even though none of the scoped strings appear in it literally.
   */
  it('treats a blanket deny as covering the scoped sub-patterns it subsumes', async () => {
    const sup = withStubbedSurface()
    const shared = workspace()
    const parentAgentId = spawnedParentWithDeny(
      'peer-agent',
      shared,
      ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'],
      ['Bash(agent-chat endorse:*)', 'Bash(agent-chat dismiss:*)', 'AskUserQuestion'],
    )

    const result = await sup.spawn(
      spawnReq({ profile: 'explorer', requestedBy: 'peer-agent', parentAgentId, cwd: shared }),
    )

    expect(result.ok).toBe(true)
  })

  /**
   * The fix above must not become "any deny satisfies any deny" — a child that
   * only denies a scoped sub-pattern still does not satisfy a parent that was
   * denied the blanket tool.
   */
  it('still refuses a scoped child deny against a blanket parent deny', async () => {
    const sup = withStubbedSurface()
    const shared = workspace()
    fs.writeFileSync(
      path.join(profilesDirFor(), 'scoped-denier.json'),
      JSON.stringify({
        model: 'sonnet',
        allowedTools: ['Read', 'Grep', 'Glob', 'Bash'],
        disallowedTools: ['Bash(git:*)'],
        isolation: 'toolset-limited',
        surface: 'headless',
      }),
    )
    const parentAgentId = spawnedParentWithDeny(
      'blanket-denied-agent',
      shared,
      ['Read', 'Grep', 'Glob', 'Bash'],
      ['Bash'],
    )

    const result = await sup.spawn(
      spawnReq({ profile: 'scoped-denier', requestedBy: 'blanket-denied-agent', parentAgentId, cwd: shared }),
    )

    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/weaker deny list/)
  })
})

/** CC-71: on_spawn/on_complete lifecycle hooks. */
describe('lifecycle hooks', () => {
  interface Captured {
    command: string
    stdin: string
  }

  function writeHooksConfig(config: unknown): void {
    fs.writeFileSync(path.join(process.env.AGENT_CHAT_HOME as string, 'hooks.json'), JSON.stringify(config))
  }

  function capturingHookSpawn(): { spawn: HookSpawnFn; calls: Captured[] } {
    const calls: Captured[] = []
    const spawn: HookSpawnFn = command => {
      const call: Captured = { command, stdin: '' }
      calls.push(call)
      const proc: HookProcess = {
        stdin: {
          write: chunk => {
            call.stdin += chunk
          },
          end: () => undefined,
        },
        on: () => undefined,
      }
      return proc
    }
    return { spawn, calls }
  }

  it('fires on_spawn with the agent, session and cwd on a successful spawn', async () => {
    writeHooksConfig({ on_spawn: ['/bin/on-spawn.sh'] })
    const { spawn, calls } = capturingHookSpawn()
    const sup = withStubbedSurface({ hookSpawn: spawn })

    const result = await sup.spawn(spawnReq({ name: 'scout', requestedBy: 'human' }))

    expect(result.ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.command).toBe('/bin/on-spawn.sh')
    const payload = JSON.parse(calls[0]?.stdin ?? '{}')
    expect(payload).toMatchObject({ agentId: result.agentId, name: 'scout', parent: null })
    expect(typeof payload.session_id).toBe('string')
    expect(typeof payload.cwd).toBe('string')
  })

  it('does not fire on_spawn when the spawn is refused', async () => {
    writeHooksConfig({ on_spawn: ['/bin/on-spawn.sh'] })
    const { spawn, calls } = capturingHookSpawn()
    const sup = withStubbedSurface({ hookSpawn: spawn })

    const result = await sup.spawn(spawnReq({ requestedBy: 'peer', cwd: isolatedHome() }))

    expect(result.ok).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('is a no-op when no hooks.json is registered', async () => {
    const { spawn, calls } = capturingHookSpawn()
    const sup = withStubbedSurface({ hookSpawn: spawn })

    const result = await sup.spawn(spawnReq({ requestedBy: 'human' }))

    expect(result.ok).toBe(true)
    expect(calls).toHaveLength(0)
  })

  it('fires on_complete with the exit code on a real exit', async () => {
    writeHooksConfig({ on_complete: ['/bin/on-complete.sh'] })
    const { spawn, calls } = capturingHookSpawn()
    const sup = withStubbedSurface({ hookSpawn: spawn })
    stopAutoAttach()
    core.append({ kind: 'agent_spawned', actor: 'human', target: 'scout', msgId: 'a1', body: 'work' })
    ;(sup as unknown as { live: Map<string, unknown> }).live.set('a1', {
      agentId: 'a1',
      name: 'scout',
      handle: { surface: 'iterm-pane' },
      allocation: { cwd: '/tmp' },
      isolation: 'none',
    })

    core.append({ kind: 'agent_detached', actor: 'scout', ref: 'a1' })
    await (sup as unknown as { recordExit: (id: string, o: unknown) => Promise<void> }).recordExit('a1', {
      code: 0,
      signal: null,
    })

    expect(calls).toHaveLength(1)
    expect(JSON.parse(calls[0]?.stdin ?? '{}')).toEqual({
      agentId: 'a1',
      code: 0,
      signal: null,
      inferred: false,
    })
  })

  it('fires on_complete with inferred: true on a synthesised exit', async () => {
    writeHooksConfig({ on_complete: ['/bin/on-complete.sh'] })
    const { spawn, calls } = capturingHookSpawn()
    const sup = withStubbedSurface({ settleMs: 1000, hookSpawn: spawn })
    stopAutoAttach()
    core.append({ kind: 'agent_spawned', actor: 'human', target: 'scout', msgId: 'a1', body: 'work' })
    ;(sup as unknown as { live: Map<string, unknown> }).live.set('a1', {
      agentId: 'a1',
      name: 'scout',
      handle: { surface: 'iterm-pane' },
      allocation: { cwd: '/tmp' },
      isolation: 'none',
    })

    core.append({ kind: 'agent_detached', actor: 'scout', ref: 'a1' })
    await vi.advanceTimersByTimeAsync(1000)

    expect(calls).toHaveLength(1)
    expect(JSON.parse(calls[0]?.stdin ?? '{}')).toEqual({
      agentId: 'a1',
      code: null,
      signal: null,
      inferred: true,
    })
  })
})

/**
 * CC-95. `agent_spawn` reported "Spawned" as soon as AppleScript had written a
 * command line into a pane, which is a claim about iTerm2 rather than about the
 * agent. The evidence: `ff-fp-fix` spawned at 06:25:46Z, still reading `starting`
 * at 12:45Z, transcript never written, pane sitting at a bare shell — and the
 * spawn call had returned success six and a half hours earlier.
 */
describe('reporting a spawn only once the agent has attached', () => {
  /** A supervisor whose attach window is short enough to expire inside a test. */
  const withAttachWindow = (attachMs: number, over: Record<string, unknown> = {}): Supervisor =>
    withStubbedSurface({ attachMs, ...over })

  it('reports success once the agent registers', async () => {
    const sup = withAttachWindow(1000)

    const result = await sup.spawn(spawnReq())

    expect(result.ok).toBe(true)
    expect(kindsFor(result.agentId as string)).toContain('agent_attached')
  })

  /** The whole defect, in one assertion: a launch that lands nowhere is not a spawn. */
  it('refuses rather than reporting success when nothing ever registers', async () => {
    stopAutoAttach()
    const sup = withAttachWindow(1000)

    const spawning = sup.spawn(spawnReq())
    await vi.advanceTimersByTimeAsync(1000)
    const result = await spawning

    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/never registered/)
    expect(result.reason).toMatch(/no registration within 1s/)
  })

  /**
   * `starting` is what a coordinator reads on the roster, and it is indefinite:
   * nothing ages out of it. The failed spawn has to land in a terminal state, and
   * it has to be distinguishable from an agent that ran and finished.
   */
  it('marks the agent failed rather than leaving it starting', async () => {
    stopAutoAttach()
    const sup = withAttachWindow(1000)

    const spawning = sup.spawn(spawnReq())
    await vi.advanceTimersByTimeAsync(1000)
    const result = await spawning

    const agent = core.agents.get(result.agentId as string)
    expect(agent?.state).toBe('exited')
    expect(agent?.exit?.failedToStart).toBe(true)
    expect(pairPresence(agent as AgentIdentity, { connected: false }).status).toBe('failed')
  })

  /**
   * Freed, or the slot is lost to an agent that never existed — and with twenty
   * of them, enough failed spawns stop the machine accepting agents at all. That
   * is a worse failure than the one this task was opened for.
   *
   * Asserted against the semaphore itself rather than against a second spawn
   * succeeding. The second spawn does not attach either, so its `ok` answers a
   * different question — and answered it differently depending on whether the
   * machine running the suite had `claude` installed, which is what made this
   * green here and red on CI.
   */
  it('gives the slot back when the agent never attached', async () => {
    stopAutoAttach()
    const semaphore = new Semaphore(1)
    const sup = withAttachWindow(1000, { semaphore })

    const spawning = sup.spawn(spawnReq())
    await vi.advanceTimersByTimeAsync(1000)
    const result = await spawning

    expect(result.ok).toBe(false)
    expect(semaphore.has(result.agentId as string)).toBe(false)
    expect(semaphore.available).toBe(1)

    // And the slot is usable: the only thing left in a second spawn's way is its
    // own attach, never the budget.
    const second = sup.spawn(spawnReq({ name: 'second' }))
    await vi.advanceTimersByTimeAsync(1000)
    expect((await second).reason).not.toMatch(/no free agent slots/)
  })

  /**
   * The second half of the evidence: a pane was created, claude never started,
   * and the pane outlived the agent that was never there.
   */
  it('closes the pane it opened for an agent that never came up', async () => {
    stopAutoAttach()
    const scripts: string[] = []
    supervisor = new Supervisor(
      core,
      withShadow({
        attachMs: 1000,
        surface: {
          platform: 'darwin',
          runAppleScript: async script => {
            scripts.push(script)
            if (script.includes('is running')) return 'true'
            if (script.includes('@@present@@')) return '@@gone@@'
            if (script.includes('to close')) return '@@closed@@'
            return 'PANE-1'
          },
        },
      }),
    )

    const spawning = supervisor.spawn(spawnReq({ surface: 'iterm-window' }))
    await vi.advanceTimersByTimeAsync(1000)
    const result = await spawning

    expect(result.ok).toBe(false)
    expect(scripts.filter(s => s.includes('to close'))).toHaveLength(1)
  })

  /**
   * A headless agent's wrapper exit is direct evidence, and it arrives in
   * milliseconds — waiting the full window for something already known to be
   * dead helps nobody, and the exit code is the most useful thing there is to
   * report.
   */
  it('gives up early, with the exit code, when claude dies before registering', async () => {
    stopAutoAttach()
    supervisor = new Supervisor(
      core,
      withShadow({
        attachMs: 60_000,
        surface: {
          platform: 'linux',
          spawn: () => ({
            pid: 4242,
            unref: () => undefined,
            once: (event: string, listener: (...args: unknown[]) => void) => {
              if (event === 'exit') queueMicrotask(() => listener(127, null))
            },
          }),
        },
      }),
    )

    const result = await supervisor.spawn(spawnReq())

    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/exited before registering \(exit code 127\)/)
    // And the LOG says so too. Two listeners race for a headless child's exit and
    // `track`'s is registered first; when it won, the row said "exited, code 127"
    // with no failure marker, `failSpawn` found nothing live to amend, and the
    // roster read `finished` for a process that never came up.
    const agent = core.agents.get(result.agentId as string)
    expect(agent?.exit?.failedToStart).toBe(true)
    expect(pairPresence(agent as AgentIdentity, { connected: false }).status).toBe('failed')
  })

  /**
   * The same race from the other side: an agent that DID register and then
   * exited is a finished agent, not a failed one. Without this the derivation
   * above would relabel every normal completion.
   */
  it('still reads as finished when an agent that registered then exits', async () => {
    const sup = withAttachWindow(1000)

    const result = await sup.spawn(spawnReq())
    await (sup as unknown as { recordExit: (id: string, o: unknown) => Promise<void> }).recordExit(
      result.agentId as string,
      { code: 0, signal: null },
    )

    const agent = core.agents.get(result.agentId as string)
    expect(agent?.exit?.failedToStart).toBeUndefined()
    expect(pairPresence(agent as AgentIdentity, { connected: false }).status).toBe('finished')
  })

  /**
   * A freshly created worktree is a path Claude Code has never been run in, so it
   * has no trust entry — and the first thing it does there is ask a question
   * nobody in a spawned pane can answer. Named, because "the spawn failed" gives
   * a coordinator nothing to act on.
   */
  it('names the missing trust-dir entry as the likely cause', async () => {
    stopAutoAttach()
    const sup = withAttachWindow(1000)
    const configDir = path.join(workspace(), 'account')
    fs.mkdirSync(configDir)
    fs.writeFileSync(path.join(configDir, '.claude.json'), JSON.stringify({ projects: {} }))
    vi.spyOn(os, 'homedir').mockReturnValue(path.dirname(configDir))

    const spawning = sup.spawn(spawnReq({ configDir }))
    await vi.advanceTimersByTimeAsync(1000)
    const result = await spawning

    expect(result.reason).toMatch(/no accepted trust entry/)
    expect(result.reason).toMatch(/Do you trust the files in this folder\?/)
  })
})

/**
 * CC-124. Three iterm-pane spawns into a trusted directory hit the 30s window on
 * 2026-09-23. The one whose profile kept its pane registered 10m18s after launch
 * and worked normally; the two whose panes the broker closed never got the chance.
 * A timeout is not death while the pane is still there.
 */
describe('a visible spawn still starting at the attach window', () => {
  /** An iTerm2 that opens PANE-1, reports it present until closed, and records every script. */
  const fakeIterm = () => {
    const scripts: string[] = []
    let present = true
    const runAppleScript = async (script: string): Promise<string> => {
      scripts.push(script)
      if (script.includes('is running')) return 'true'
      if (script.includes('@@present@@')) return present ? '@@present@@' : '@@gone@@'
      if (script.includes('to close')) {
        present = false
        return '@@closed@@'
      }
      return 'PANE-1'
    }
    return { scripts, runAppleScript, closes: () => scripts.filter(s => s.includes('to close')).length }
  }

  const visibleSupervisor = (iterm: ReturnType<typeof fakeIterm>): Supervisor => {
    supervisor = new Supervisor(
      core,
      withShadow({
        attachMs: 1000,
        attachCeilingMs: 10_000,
        surface: { platform: 'darwin', runAppleScript: iterm.runAppleScript },
      }),
    )
    return supervisor
  }

  const brokerLog = (): string => {
    const file = path.join(process.env.AGENT_CHAT_HOME as string, 'broker.log')
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  }

  it('keeps the pane and reports the spawn pending when the pane still exists', async () => {
    stopAutoAttach()
    const iterm = fakeIterm()
    const sup = visibleSupervisor(iterm)

    const spawning = sup.spawn(spawnReq({ surface: 'iterm-window' }))
    await vi.advanceTimersByTimeAsync(1000)
    const result = await spawning

    expect(result.ok).toBe(true)
    expect(result.warnings?.join(' ')).toMatch(/still starting 1s after launching into iterm-window/)
    expect(result.warnings?.join(' ')).toMatch(/pane was kept open/)
    expect(iterm.closes()).toBe(0)
    expect(kindsFor(result.agentId as string)).not.toContain('agent_exited')
  })

  it('attaches normally on a late registration and logs how late it was', async () => {
    stopAutoAttach()
    const sup = visibleSupervisor(fakeIterm())
    const spawning = sup.spawn(spawnReq({ surface: 'iterm-window' }))
    await vi.advanceTimersByTimeAsync(1000)
    const agentId = (await spawning).agentId as string

    await vi.advanceTimersByTimeAsync(4000)
    core.append({ kind: 'agent_attached', actor: 'scout', ref: agentId })
    await vi.advanceTimersByTimeAsync(10_000)

    expect(core.agents.get(agentId)?.state).toBe('live')
    const late = brokerLog()
      .split('\n')
      .filter(line => line.includes('"agent_attach_late"'))
      .map(line => JSON.parse(line) as { agentId: string; elapsedMs: number })
    expect(late).toEqual([expect.objectContaining({ agentId, elapsedMs: 5000 })])
  })

  /** CC-175: the pane whose shell ran `s aAGENT_CHAT_HOME=...` and was then waited on for ten minutes. */
  it('fails at once, quoting the pane, when run-agent never started in it', async () => {
    stopAutoAttach()
    const iterm = fakeIterm()
    supervisor = new Supervisor(
      core,
      withShadow({
        attachMs: 30_000,
        attachCeilingMs: 600_000,
        surface: {
          platform: 'darwin',
          runAppleScript: async script => {
            if (script.includes('return tty of s')) return '/dev/ttys042'
            if (script.includes('return contents of s'))
              return '% s aAGENT_CHAT_HOME=/x node cli.js\nzsh: command not found: s'
            return iterm.runAppleScript(script)
          },
          probeProcesses: async () => ['-zsh'],
          launchCheck: { deadlineMs: 5000, pollMs: 500 },
        },
      }),
    )

    const spawning = supervisor.spawn(spawnReq({ surface: 'iterm-window' }))
    await vi.advanceTimersByTimeAsync(5000)
    const result = await spawning

    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/run-agent \w+ was not running in its pane 5s after launch/)
    expect(result.reason).toContain('zsh: command not found: s')
    expect(core.agents.get(result.agentId as string)?.exit?.failedToStart).toBe(true)
    expect(iterm.closes()).toBe(1)
  })

  it('fails the spawn as before once the ceiling passes without a registration', async () => {
    stopAutoAttach()
    const iterm = fakeIterm()
    const sup = visibleSupervisor(iterm)
    const spawning = sup.spawn(spawnReq({ surface: 'iterm-window' }))
    await vi.advanceTimersByTimeAsync(1000)
    const agentId = (await spawning).agentId as string

    await vi.advanceTimersByTimeAsync(9000)

    const agent = core.agents.get(agentId)
    expect(agent?.exit?.failedToStart).toBe(true)
    expect(agent?.exit?.summary).toMatch(/no registration within 10s of launching into iterm-window/)
    expect(iterm.closes()).toBe(1)
  })

  it('still fails a headless spawn at once when claude exits before registering', async () => {
    stopAutoAttach()
    supervisor = new Supervisor(
      core,
      withShadow({
        attachMs: 60_000,
        attachCeilingMs: 600_000,
        surface: {
          platform: 'linux',
          spawn: () => ({
            pid: 4242,
            unref: () => undefined,
            once: (event: string, listener: (...args: unknown[]) => void) => {
              if (event === 'exit') queueMicrotask(() => listener(1, null))
            },
          }),
        },
      }),
    )

    const result = await supervisor.spawn(spawnReq())

    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/exited before registering \(exit code 1\)/)
  })

  /** CC-161: a headless claude that exits with `stderr` on the wrapper's tail file, in a folder with the given config. */
  const headlessExitingWith = (stderr: string, configDir: string) => {
    stopAutoAttach()
    fs.writeFileSync(path.join(configDir, '.claude.json'), JSON.stringify({ projects: {} }))
    vi.spyOn(os, 'homedir').mockReturnValue(path.dirname(configDir))
    return new Supervisor(
      core,
      withShadow({
        attachMs: 60_000,
        surface: {
          platform: 'linux',
          spawn: (_bin: string, argv: string[]) => {
            if (stderr !== '') writeOutputTail(argv[argv.length - 1] as string, stderr)
            return {
              pid: 4242,
              unref: () => undefined,
              once: (event: string, listener: (...args: unknown[]) => void) => {
                if (event === 'exit') queueMicrotask(() => listener(1, null))
              },
            }
          },
        },
      }),
    )
  }

  it('names the missing login, with the config dir, when claude exits saying it is not logged in', async () => {
    const configDir = path.join(workspace(), 'account')
    fs.mkdirSync(configDir)
    const sup = headlessExitingWith('Not logged in\n', configDir)

    const result = await sup.spawn(spawnReq({ configDir }))

    expect(result.reason).toMatch(
      /exited before registering \(exit code 1\)\. Claude Code reported it is not logged in/,
    )
    expect(result.reason).toContain(`claude /login`)
    expect(result.reason).toContain(configDir)
    expect(result.reason).not.toMatch(/trust/i)
  })

  it('names the missing login when only the /login instruction is printed', async () => {
    const configDir = path.join(workspace(), 'account')
    fs.mkdirSync(configDir)
    const sup = headlessExitingWith('Please run /login\n', configDir)

    const result = await sup.spawn(spawnReq({ configDir }))

    expect(result.reason).toMatch(/not logged in/)
  })

  it('still gives trust advice when claude exits without a login complaint in an untrusted folder', async () => {
    const configDir = path.join(workspace(), 'account')
    fs.mkdirSync(configDir)
    const sup = headlessExitingWith('something else went wrong\n', configDir)

    const result = await sup.spawn(spawnReq({ configDir }))

    expect(result.reason).toMatch(/no accepted trust entry/)
    expect(result.reason).not.toMatch(/logged in/)
  })

  it('falls back to the generic message when claude exits with unrecognised output and trust is unknown', async () => {
    stopAutoAttach()
    const configDir = path.join(workspace(), 'account')
    fs.mkdirSync(configDir)
    vi.spyOn(os, 'homedir').mockReturnValue(path.dirname(configDir))
    const sup = new Supervisor(
      core,
      withShadow({
        attachMs: 60_000,
        surface: {
          platform: 'linux',
          spawn: (_bin: string, argv: string[]) => {
            writeOutputTail(argv[argv.length - 1] as string, 'segfault\n')
            return {
              pid: 4242,
              unref: () => undefined,
              once: (event: string, listener: (...args: unknown[]) => void) => {
                if (event === 'exit') queueMicrotask(() => listener(1, null))
              },
            }
          },
        },
      }),
    )

    const result = await sup.spawn(spawnReq({ configDir }))

    expect(result.reason).toContain(
      "claude exited before registering (exit code 1). Look at the surface itself (headless) and at ~/.claude for this agent's transcript.",
    )
  })

  it('says the directory is trusted instead of guessing at the trust prompt', async () => {
    stopAutoAttach()
    const cwd = workspace()
    const configDir = path.join(workspace(), 'account')
    fs.mkdirSync(configDir)
    const trusted = JSON.stringify({ projects: { [cwd]: { hasTrustDialogAccepted: true } } })
    fs.writeFileSync(path.join(configDir, '.claude.json'), trusted)
    vi.spyOn(os, 'homedir').mockReturnValue(path.dirname(configDir))
    const sup = visibleSupervisor(fakeIterm())

    const spawning = sup.spawn(spawnReq({ surface: 'iterm-window', cwd, configDir }))
    await vi.advanceTimersByTimeAsync(1000)
    const warning = (await spawning).warnings?.join(' ')

    expect(warning).toMatch(
      /The directory is trusted, so this is not the trust prompt; Claude Code is still starting/,
    )
    expect(warning).not.toMatch(/Do you trust the files/)
  })

  // CC-200: an unset child reads ~/.claude.json, so ~/.claude/.claude.json saying untrusted must not decide it.
  it('reads trust from ~/.claude.json for a child that runs with CLAUDE_CONFIG_DIR unset', async () => {
    stopAutoAttach()
    const cwd = workspace()
    const home = workspace()
    fs.writeFileSync(
      path.join(home, '.claude.json'),
      JSON.stringify({ projects: { [cwd]: { hasTrustDialogAccepted: true } } }),
    )
    fs.mkdirSync(path.join(home, '.claude'))
    fs.writeFileSync(path.join(home, '.claude', '.claude.json'), JSON.stringify({ projects: {} }))
    vi.spyOn(os, 'homedir').mockReturnValue(home)
    const sup = visibleSupervisor(fakeIterm())

    const spawning = sup.spawn(spawnReq({ surface: 'iterm-window', cwd, spawnerIsSession: true }))
    await vi.advanceTimersByTimeAsync(1000)
    const warning = (await spawning).warnings?.join(' ')

    expect(warning).toMatch(/The directory is trusted, so this is not the trust prompt/)
  })
})

describe('a failed spawn and its name', () => {
  /** The 05:05:15Z refusal: a spawn that failed 40s earlier still held its name. */
  it('releases the name so the same name can be spawned again', async () => {
    stopAutoAttach()
    const sup = withStubbedSurface({ attachMs: 1000 })
    const failing = sup.spawn(spawnReq({ name: 'retry-me' }))
    await vi.advanceTimersByTimeAsync(1000)
    expect((await failing).ok).toBe(false)

    stopAutoAttach = autoAttach(core)
    const retry = await sup.spawn(spawnReq({ name: 'retry-me' }))

    expect(retry.reason).toBeUndefined()
    expect(retry.ok).toBe(true)
  })

  it('still holds the name of an agent that ran and finished', async () => {
    const sup = withStubbedSurface({ attachMs: 1000 })
    const first = await sup.spawn(spawnReq({ name: 'done' }))
    await (sup as unknown as { recordExit: (id: string, o: unknown) => Promise<void> }).recordExit(
      first.agentId as string,
      { code: 0, signal: null },
    )

    const again = await sup.spawn(spawnReq({ name: 'done' }))

    expect(again.ok).toBe(false)
    expect(again.reason).toMatch(/held by a live agent/)
  })
})

/**
 * CC-126: a coordinator brings a stopped agent back WITH its conversation, and
 * is always told whether the transcript was there.
 */
describe('resuming an agent on its own conversation', () => {
  const finishedAgent = async (sup: Supervisor, name = 'scout'): Promise<AgentIdentity> => {
    const spawned = await sup.spawn(spawnReq({ name, spawnerConfigDir: workspace() }))
    const exit = (sup as unknown as { recordExit: (id: string, o: unknown) => Promise<void> }).recordExit
    await exit.call(sup, spawned.agentId as string, { code: 0, signal: null })
    return core.agents.get(spawned.agentId as string)!
  }

  it('relaunches a finished agent headless on --resume with its own session id', async () => {
    const sup = withStubbedSurface()
    const agent = await finishedAgent(sup)
    const file = writeTranscriptFor(agent)

    const result = await sup.resume('scout')

    expect(result).toMatchObject({ ok: true, transcript: { path: file, found: true } })
    const plan = readLaunchPlan(agent.agentId)
    expect(plan.args[plan.args.indexOf('--resume') + 1]).toBe(agent.sessionId)
    expect(plan.args).not.toContain('--session-id')
    expect(plan.surface).toBe('headless')
    expect(plan.stdin).toBe(RESUMED_BRIEF)
  })

  it('keeps CLAUDE_CONFIG_DIR unset for an agent a default-account session spawned (CC-200)', async () => {
    vi.spyOn(os, 'homedir').mockReturnValue(workspace())
    const sup = withStubbedSurface()
    const spawned = await sup.spawn(spawnReq({ spawnerIsSession: true }))
    await (sup as unknown as { recordExit: (id: string, o: unknown) => Promise<void> }).recordExit(
      spawned.agentId as string,
      { code: 0, signal: null },
    )
    writeTranscriptFor(core.agents.get(spawned.agentId as string)!)

    expect((await sup.resume('scout')).ok).toBe(true)

    const plan = readLaunchPlan(spawned.agentId as string)
    expect('CLAUDE_CONFIG_DIR' in plan.env).toBe(false)
    expect(plan.unsetEnv).toEqual(['CLAUDE_CONFIG_DIR'])
  })

  it('refuses a live agent', async () => {
    const sup = withStubbedSurface()
    const spawned = await sup.spawn(spawnReq({ spawnerConfigDir: workspace() }))
    writeTranscriptFor(core.agents.get(spawned.agentId as string)!)

    const result = await sup.resume('scout')

    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/already live/)
  })

  it('refuses when the transcript is gone, and names where it looked', async () => {
    const sup = withStubbedSurface()
    const agent = await finishedAgent(sup)

    const result = await sup.resume('scout')

    expect(result.ok).toBe(false)
    expect(result.transcript).toEqual({
      path: transcriptPath(agent.cwd, agent.sessionId, agent.configDir),
      found: false,
    })
    expect(kindsFor(agent.agentId)).not.toContain('agent_resumed')
  })

  it('points a retired name at a spawn with its session id', async () => {
    const sup = withStubbedSurface()
    const agent = await finishedAgent(sup)
    await sup.retire('scout')

    const result = await sup.resume('scout')

    expect(result.ok).toBe(false)
    expect(result.reason).toContain(`resume_session="${agent.sessionId}"`)
  })

  it('records the session id and transcript path when retiring', async () => {
    const sup = withStubbedSurface()
    const agent = await finishedAgent(sup)
    const file = writeTranscriptFor(agent)

    await sup.retire('scout')

    const row = core.events.agentEvents().find(r => r.kind === 'agent_retired' && r.ref === agent.agentId)
    expect(row?.meta).toMatchObject({
      session_id: agent.sessionId,
      transcript: file,
      transcript_found: 'true',
    })
  })
})

describe('spawning onto an existing session', () => {
  const SESSION = '0f8fad5b-d9cb-469f-a165-70867728950e'

  it('refuses a session whose transcript is not under the chosen account and cwd, naming the path', async () => {
    const sup = withStubbedSurface()
    const account = workspace()
    const cwd = workspace()

    const result = await sup.spawn(spawnReq({ cwd, spawnerConfigDir: account, resumeSession: SESSION }))

    expect(result.ok).toBe(false)
    expect(result.reason).toContain(`no transcript found at ${transcriptPath(cwd, SESSION, account)}`)
  })

  it('launches on --resume with that session id when the transcript is there', async () => {
    const sup = withStubbedSurface()
    const account = workspace()
    const cwd = workspace()
    const file = transcriptPath(cwd, SESSION, account)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '{}\n')

    const result = await sup.spawn(spawnReq({ cwd, spawnerConfigDir: account, resumeSession: SESSION }))

    expect(result).toMatchObject({ ok: true, transcript: { path: file, found: true } })
    const plan = readLaunchPlan(result.agentId as string)
    expect(plan.args.slice(plan.args.indexOf('--resume'), plan.args.indexOf('--resume') + 2)).toEqual([
      '--resume',
      SESSION,
    ])
    expect(plan.args).not.toContain('--session-id')
    expect(core.agents.get(result.agentId as string)?.sessionId).toBe(SESSION)
  })

  it('refuses a freshly allocated worktree, which cannot hold the transcript', async () => {
    const sup = withStubbedSurface()

    const result = await sup.spawn(
      spawnReq({ isolation: 'worktree', spawnerConfigDir: workspace(), resumeSession: SESSION }),
    )

    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/freshly allocated worktree/)
  })
})

/**
 * CC-140: retire removes an agent's worktree, and `claude --resume` finds a
 * transcript only under the project dir of the cwd it starts in, so the
 * worktree comes back at its recorded path before the session does.
 */
describe('resuming an agent whose worktree was removed', () => {
  const SCOUT_BRANCH = 'agent-chat/scout'

  beforeEach(() => vi.useRealTimers())

  const branchExists = (repo: string, branch: string): boolean =>
    git(['branch', '--list', branch], repo) !== ''

  /** A worktree agent that ran, wrote its transcript, and finished. */
  async function finishedInWorktree(
    sup: Supervisor,
    repo: string,
    account: string,
    over: Record<string, unknown> = {},
  ): Promise<AgentIdentity> {
    const spawned = await sup.spawn(
      spawnReq({ cwd: repo, isolation: 'worktree', spawnerConfigDir: account, ...over }),
    )
    expect(spawned.reason).toBeUndefined()
    const agent = core.agents.get(spawned.agentId as string)!
    writeTranscriptFor(agent)
    const exit = (sup as unknown as { recordExit: (id: string, o: unknown) => Promise<void> }).recordExit
    await exit.call(sup, agent.agentId, { code: 0, signal: null })
    return agent
  }

  const commitIn = (dir: string, file: string): string => {
    fs.writeFileSync(path.join(dir, file), 'work\n')
    git(['add', file], dir)
    git(['commit', '-m', `add ${file}`], dir)
    return git(['rev-parse', 'HEAD'], dir)
  }

  const resumeSpawn = (sup: Supervisor, repo: string, account: string, sessionId: string) =>
    sup.spawn(
      spawnReq({ cwd: repo, isolation: 'worktree', spawnerConfigDir: account, resumeSession: sessionId }),
    )

  it('re-creates the worktree on a fresh branch when retire deleted the branch', async () => {
    const sup = withStubbedSurface()
    const repo = makeRepo()
    const account = workspace()
    const agent = await finishedInWorktree(sup, repo, account)
    expect((await sup.retire('scout', true)).ok).toBe(true)
    expect(fs.existsSync(agent.cwd)).toBe(false)
    expect(branchExists(repo, SCOUT_BRANCH)).toBe(false)

    const result = await resumeSpawn(sup, repo, account, agent.sessionId)

    expect(result).toMatchObject({ ok: true, transcript: { found: true } })
    expect(core.agents.get(result.agentId as string)?.cwd).toBe(agent.cwd)
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], agent.cwd)).toBe(SCOUT_BRANCH)
    expect(result.warnings?.join('\n')).toMatch(/no longer exists locally or on origin/)
    expect(result.warnings?.join('\n')).toMatch(/because the repository has no origin remote/)
    const plan = readLaunchPlan(result.agentId as string)
    expect(plan.args[plan.args.indexOf('--resume') + 1]).toBe(agent.sessionId)
    expect(plan.cwd).toBe(agent.cwd)
  })

  it('adopts the branch origin still holds after retire deleted the local one', async () => {
    const sup = withStubbedSurface()
    const repo = repoWithOrigin()
    const account = workspace()
    const agent = await finishedInWorktree(sup, repo, account)
    const pushed = commitIn(agent.cwd, 'feature.ts')
    git(['push', '-q', 'origin', SCOUT_BRANCH], agent.cwd)
    expect((await sup.retire('scout', true)).ok).toBe(true)

    const result = await resumeSpawn(sup, repo, account, agent.sessionId)

    expect(result.reason).toBeUndefined()
    expect(git(['rev-parse', 'HEAD'], agent.cwd)).toBe(pushed)
    expect(result.warnings?.join('\n') ?? '').not.toMatch(/no longer exists/)
  })

  /** A repository whose origin holds main, for a worktree agent to push its branch to. */
  function repoWithOrigin(): string {
    const repo = makeRepo()
    const origin = workspace()
    git(['init', '--bare', '-b', 'main'], origin)
    git(['remote', 'add', 'origin', origin], repo)
    git(['push', '-q', 'origin', 'main'], repo)
    return repo
  }

  it('refuses rather than forking fresh when origin cannot be reached to look for the branch', async () => {
    const sup = withStubbedSurface()
    const repo = repoWithOrigin()
    const account = workspace()
    const agent = await finishedInWorktree(sup, repo, account)
    commitIn(agent.cwd, 'feature.ts')
    git(['push', '-q', 'origin', SCOUT_BRANCH], agent.cwd)
    expect((await sup.retire('scout', true)).ok).toBe(true)
    git(['remote', 'set-url', 'origin', path.join(workspace(), 'nonexistent', 'x.git')], repo)

    const result = await resumeSpawn(sup, repo, account, agent.sessionId)

    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/cannot reach origin to look for branch agent-chat\/scout/)
    expect(fs.existsSync(agent.cwd)).toBe(false)
    expect(branchExists(repo, SCOUT_BRANCH)).toBe(false)
  })

  it('refuses a recorded worktree outside the repository worktree base', async () => {
    const sup = withStubbedSurface()
    const repo = makeRepo()
    const account = workspace()
    const agent = await finishedInWorktree(sup, repo, account)
    await sup.retire('scout', true)
    const elsewhere = path.join(workspace(), 'elsewhere')
    const meta = { strategy: 'worktree', gitRoot: repo, worktree: elsewhere, branch: SCOUT_BRANCH }
    core.append({ kind: 'isolation_allocated', actor: 'human', ref: agent.agentId, body: '', meta })
    writeTranscriptFor({ ...agent, cwd: elsewhere })

    const result = await resumeSpawn(sup, repo, account, agent.sessionId)

    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/is not under/)
    expect(fs.existsSync(elsewhere)).toBe(false)
  })

  it('refuses a recorded worktree at a sibling of the worktree base that shares its name prefix', async () => {
    const sup = withStubbedSurface()
    const repo = makeRepo()
    const account = workspace()
    const agent = await finishedInWorktree(sup, repo, account)
    await sup.retire('scout', true)
    const sibling = path.join(repo, '.worktrees-x', 'f')
    const meta = { strategy: 'worktree', gitRoot: repo, worktree: sibling, branch: SCOUT_BRANCH }
    core.append({ kind: 'isolation_allocated', actor: 'human', ref: agent.agentId, body: '', meta })
    writeTranscriptFor({ ...agent, cwd: sibling })

    const result = await resumeSpawn(sup, repo, account, agent.sessionId)

    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/is not under/)
    expect(fs.existsSync(sibling)).toBe(false)
    expect(branchExists(repo, SCOUT_BRANCH)).toBe(false)
  })

  /** Origin still lists the branch, but a lock on its tracking ref makes the fetch that follows the listing fail. */
  async function retiredWithUnfetchableOrigin(sup: Supervisor, staleTracking: boolean) {
    const repo = repoWithOrigin()
    const account = workspace()
    const agent = await finishedInWorktree(sup, repo, account)
    commitIn(agent.cwd, 'feature.ts')
    git(['push', '-q', 'origin', SCOUT_BRANCH], agent.cwd)
    expect((await sup.retire('scout', true)).ok).toBe(true)
    const tracking = `refs/remotes/origin/${SCOUT_BRANCH}`
    // The agent's push already created the tracking ref; leave it stale or remove it, never current.
    if (staleTracking) git(['update-ref', tracking, git(['rev-parse', 'main'], repo)], repo)
    else git(['update-ref', '-d', tracking], repo)
    const gitDir = path.resolve(repo, git(['rev-parse', '--git-common-dir'], repo))
    fs.mkdirSync(path.join(gitDir, path.dirname(tracking)), { recursive: true })
    fs.writeFileSync(path.join(gitDir, `${tracking}.lock`), '')
    return { repo, account, agent }
  }

  it('refuses and creates nothing when origin lists the branch but fetching it fails', async () => {
    const sup = withStubbedSurface()
    const { repo, account, agent } = await retiredWithUnfetchableOrigin(sup, false)

    const result = await resumeSpawn(sup, repo, account, agent.sessionId)

    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/origin lists it but fetching it failed/)
    expect(fs.existsSync(agent.cwd)).toBe(false)
    expect(branchExists(repo, SCOUT_BRANCH)).toBe(false)
  })

  it('does not fall back to a stale origin tracking ref when the fetch fails', async () => {
    const sup = withStubbedSurface()
    const { repo, account, agent } = await retiredWithUnfetchableOrigin(sup, true)

    const result = await resumeSpawn(sup, repo, account, agent.sessionId)

    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/origin lists it but fetching it failed/)
    expect(fs.existsSync(agent.cwd)).toBe(false)
    expect(branchExists(repo, SCOUT_BRANCH)).toBe(false)
  })

  it('releases the agent slot when the re-attach fails', async () => {
    const semaphore = new Semaphore(1)
    const sup = withStubbedSurface({ semaphore })
    const repo = makeRepo()
    const agent = await finishedInWorktree(sup, repo, workspace())
    git(['worktree', 'remove', '--force', agent.cwd], repo)
    fs.writeFileSync(path.join(process.env.AGENT_CHAT_HOME!, 'config.json'), '{"worktreeBudget": 1}')
    await worktreeStrategy.allocate({ agentId: 'other', agentName: 'other', baseCwd: repo })

    const result = await sup.resume('scout')

    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/resume failed: .*budget exhausted/)
    expect(semaphore.has(agent.agentId)).toBe(false)
    expect(semaphore.available).toBe(1)
  })

  it('refuses a spawn whose cwd is in a different repository from the recorded worktree', async () => {
    const sup = withStubbedSurface()
    const repo = makeRepo()
    const account = workspace()
    const agent = await finishedInWorktree(sup, repo, account)
    await sup.retire('scout', true)

    const result = await resumeSpawn(sup, makeRepo(), account, agent.sessionId)

    expect(result.ok).toBe(false)
    expect(result.reason).toContain(`ran in a worktree of ${repo}`)
    expect(fs.existsSync(agent.cwd)).toBe(false)
  })

  it('never re-creates a worktree the task system assigned', async () => {
    const sup = withStubbedSurface()
    const repo = makeRepo()
    const assigned = path.join(repo, '.worktrees', 'task')
    git(['worktree', 'add', '-q', '-b', 'task', assigned], repo)
    const agent = await finishedInWorktree(sup, repo, workspace(), { worktree: assigned })
    git(['worktree', 'remove', '--force', assigned], repo)

    const result = await sup.resume('scout')

    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/no longer exists/)
    expect(fs.existsSync(agent.cwd)).toBe(false)
  })

  it('records an agent_resume re-attach, and a later retire releases it', async () => {
    const sup = withStubbedSurface()
    const repo = makeRepo()
    const agent = await finishedInWorktree(sup, repo, workspace())
    git(['worktree', 'remove', '--force', agent.cwd], repo)
    expect((await sup.resume('scout')).ok).toBe(true)

    const rows = core.events
      .agentEvents()
      .filter(r => r.kind === 'isolation_allocated' && r.ref === agent.agentId)
    expect(rows.at(-1)?.meta).toMatchObject({
      strategy: 'worktree',
      worktree: agent.cwd,
      reattached: 'local',
    })
    expect((await sup.retire('scout', true)).ok).toBe(true)
    expect(fs.existsSync(agent.cwd)).toBe(false)
    expect(branchExists(repo, SCOUT_BRANCH)).toBe(false)
  })

  it('brings back a finished agent through agent_resume on the branch its removed worktree left behind', async () => {
    const sup = withStubbedSurface()
    const repo = makeRepo()
    const agent = await finishedInWorktree(sup, repo, workspace())
    const committed = commitIn(agent.cwd, 'feature.ts')
    git(['worktree', 'remove', '--force', agent.cwd], repo)

    const result = await sup.resume('scout')

    expect(result.reason).toBeUndefined()
    expect(result.ok).toBe(true)
    expect(git(['rev-parse', 'HEAD'], agent.cwd)).toBe(committed)
    expect(readLaunchPlan(agent.agentId).cwd).toBe(agent.cwd)
  })

  it('refuses when the worktree budget is full, as a spawn would', async () => {
    const sup = withStubbedSurface()
    const repo = makeRepo()
    const account = workspace()
    const agent = await finishedInWorktree(sup, repo, account)
    expect((await sup.retire('scout', true)).ok).toBe(true)
    fs.writeFileSync(path.join(process.env.AGENT_CHAT_HOME!, 'config.json'), '{"worktreeBudget": 1}')
    await worktreeStrategy.allocate({ agentId: 'other', agentName: 'other', baseCwd: repo })

    const result = await resumeSpawn(sup, repo, account, agent.sessionId)

    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/budget exhausted/)
    expect(fs.existsSync(agent.cwd)).toBe(false)
  })

  it('still refuses when the transcript itself is gone', async () => {
    const sup = withStubbedSurface()
    const repo = makeRepo()
    const account = workspace()
    const agent = await finishedInWorktree(sup, repo, account)
    expect((await sup.retire('scout', true)).ok).toBe(true)
    fs.rmSync(transcriptPath(agent.cwd, agent.sessionId, agent.configDir))

    const result = await resumeSpawn(sup, repo, account, agent.sessionId)

    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/no transcript found/)
    expect(fs.existsSync(agent.cwd)).toBe(false)
  })

  it('points a retired worktree agent at its repository, not its removed worktree', async () => {
    const sup = withStubbedSurface()
    const repo = makeRepo()
    const agent = await finishedInWorktree(sup, repo, workspace())
    await sup.retire('scout', true)

    const result = await sup.resume('scout')

    expect(result.reason).toContain(`resume_session="${agent.sessionId}" and isolation="worktree"`)
    expect(result.reason).toContain(`cwd="${repo}"`)
  })
})
