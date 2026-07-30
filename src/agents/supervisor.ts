import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { BrokerCore } from '../broker/core.js'
import { newMsgId } from '../broker/event-log.js'
import {
  HUMAN,
  RESERVED_NAMES,
  type AgentIdentity,
  type IsolationName,
  type Subscription,
  type SurfaceName,
} from '../protocol.js'
import {
  BACKGROUNDED_BRIEF,
  checkBackgroundable,
  checkSurfaceable,
  placementFor,
  SURFACED_NOTICE,
  type SwitchOutcome,
} from './mode-switch.js'
import { buildLaunchPlan, permModeFor } from './launch-plan.js'
import { buildMcpConfig, mcpConfigPath, readLaunchPlan, writeLaunchFiles } from './launch-files.js'
import { loadProfile } from './profiles.js'
import { resolve as resolveIsolation, type Allocation, type IsolationContext } from './isolation/index.js'
import { surfaceFor } from './surfaces/index.js'
import { SurfaceRefused, type SurfaceOptions } from './surfaces/options.js'
import { Semaphore } from './semaphore.js'
import { SpawnRateBudget } from './spawn-rate.js'
import { cliEntry, home } from '../paths.js'
import { logEvent } from '../broker/log.js'
import {
  Teleport,
  type InheritedIsolation,
  type RelaunchInput,
  type TeleportHost,
  type TeleportOutcome,
  type TeleportRequest,
} from './teleport.js'
import type { AgentProfile, LaunchHandle, LaunchPlan } from './types.js'

/**
 * Spawn, supervise and retire agents. Runs inside the BROKER, never inside a
 * requesting session, and that placement carries the whole feature:
 *
 * - the broker outlives every session, so an agent is not orphaned when whoever
 *   asked for it exits — which is the point of agent teams;
 * - `core.append` is the single write path, and a spawn writes 2-4 rows;
 * - the semaphore and depth cap need exactly one enforcement point, because
 *   per-session enforcement is not enforcement.
 */

/**
 * How long a detached agent has to come back before its exit is inferred.
 *
 * Visible surfaces give no exit signal at all — the broker does not own the
 * pane's process — so a detach with no reattach is the only evidence there is.
 * It must clear the client's reconnect ladder, whose worst case is 8.85s, by
 * enough that a slow machine is not declared dead.
 */
export const SETTLE_MS = 30_000

/** Spawn depth cap. Without it an agent team is a fork bomb with a model picking the branching factor. */
export const MAX_DEPTH = 2

/** How long a process gets to exit on SIGTERM before the ladder reaches SIGKILL. */
const KILL_GRACE_MS = 3000

/** How long to wait for a stopped agent's socket to go before reclaiming its name. */
const NAME_FREE_TIMEOUT_MS = 8_000
const NAME_FREE_POLL_MS = 100

/**
 * Did this descendant land in the very pane its predecessor was closing, and was
 * that pane one the broker opened?
 *
 * The subtle half of CC-37. A teleport reuses the predecessor's own session, so
 * the launch itself cannot tell whether the broker created it — that fact may be
 * several generations old. Carrying it forward is what stops an agent that has
 * teleported once ending up in a pane nothing is ever allowed to close; matching
 * on the pane ref is what stops it being carried when the descendant fell back to
 * a fresh window, or when the predecessor was sitting in a human's own pane.
 */
const succeedsInto = (handle: LaunchHandle, predecessor: LaunchHandle | undefined): boolean =>
  predecessor?.ownsSurface === true && handle.paneRef !== undefined && handle.paneRef === predecessor.paneRef

/**
 * A mode switch, resolved by the socket layer before it reaches here.
 *
 * `hostPid` is present only for backgrounding, where it comes from the caller's
 * OWN registry entry — which is what makes "background someone else" impossible
 * rather than merely refused. Surfacing does not need it: the broker owns the
 * headless child it is about to stop.
 */
export interface SwitchRequest {
  name: string
  to: 'headless' | 'interactive'
  requestedBy: string
  /** The requester's own pane. Decides same-window placement; absent is not an error. */
  anchor?: string
  hostPid?: number
}

export interface SpawnRequest {
  name: string
  profile: string
  brief: string
  cwd?: string
  isolation?: IsolationName
  surface?: SurfaceName
  /** Empty for a human-initiated spawn; otherwise the requesting agent's id. */
  parentAgentId?: string
  requestedBy: string
  forceReset?: boolean
  /** Applied at the spawned agent's own registration, before its first turn. */
  tags?: string[]
  subscriptions?: Subscription[]
  /**
   * The requester's pane, resolved by the caller from its OWN connection. Passed
   * in rather than looked up here because only the socket layer holds the
   * connection — which is also what stops a request naming someone else's pane.
   */
  anchor?: string
}

export interface SpawnOutcome {
  ok: boolean
  agentId?: string
  name?: string
  reason?: string
  warnings?: string[]
  /** The profile's own deny list. See protocol.ts's `spawn_result` for why this matters. */
  disallowedTools?: string[]
}

interface Live {
  agentId: string
  name: string
  handle: LaunchHandle
  allocation: Allocation
  isolation: IsolationName
  /** Which anchor this agent was placed beside, so later spawns can stack on it. */
  anchor?: string
  settle?: NodeJS.Timeout
}

export interface SupervisorOptions {
  semaphore?: Semaphore
  spawnRateBudget?: SpawnRateBudget
  settleMs?: number
  /**
   * Merged into every surface built here. Without it a test naming `iterm-pane`
   * reaches the real AppleScript and opens a real window on any machine that
   * happens to be running iTerm — passing on CI and spawning panes on a laptop.
   */
  surface?: Pick<SurfaceOptions, 'runAppleScript' | 'spawn' | 'platform'>
  /** Teleport's human-veto window. Shortened in tests; never shortened in production. */
  countdownMs?: number
  /**
   * How long a mode switch waits for the stopped process's socket to go before
   * reclaiming its name. Shortened in tests, where nothing ever closes a fake
   * connection and the full window would just be dead time.
   */
  nameFreeMs?: number
}

export class Supervisor implements TeleportHost {
  private readonly live = new Map<string, Live>()
  private readonly semaphore: Semaphore
  private readonly spawnRateBudget: SpawnRateBudget
  private readonly settleMs: number
  private readonly nameFreeMs: number
  private readonly surfaceOptions: SupervisorOptions['surface']
  private readonly unwatch: () => void
  private readonly teleporter: Teleport

  constructor(
    private readonly core: BrokerCore,
    options: SupervisorOptions = {},
  ) {
    this.semaphore = options.semaphore ?? new Semaphore()
    this.spawnRateBudget = options.spawnRateBudget ?? new SpawnRateBudget()
    this.settleMs = options.settleMs ?? SETTLE_MS
    this.nameFreeMs = options.nameFreeMs ?? NAME_FREE_TIMEOUT_MS
    this.surfaceOptions = options.surface ?? {}
    this.unwatch = core.onAppend(row => this.onRow(row))
    this.teleporter = new Teleport(core, this, options.countdownMs)
  }

  /**
   * Presence changes are the only exit signal a visible agent gives, so the
   * supervisor listens to the log rather than to processes. Reattach cancels a
   * pending settle, which is what stops a broker restart from reading as a room
   * full of dead agents.
   */
  private onRow(row: { kind: string; ref?: string }): void {
    const agentId = row.ref
    if (agentId === undefined) return
    const entry = this.live.get(agentId)
    if (!entry) return

    if (row.kind === 'agent_attached' && entry.settle) {
      clearTimeout(entry.settle)
      delete entry.settle
    }
    if (row.kind === 'agent_detached') this.scheduleSettle(entry)
  }

  private scheduleSettle(entry: Live): void {
    if (entry.settle) clearTimeout(entry.settle)
    entry.settle = setTimeout(() => {
      // Still detached after the window: infer the exit. No code and no cost,
      // and the roster says so rather than showing zeros it did not measure.
      this.recordExit(entry.agentId, { code: null, signal: null, inferred: true })
    }, this.settleMs)
    entry.settle.unref?.()
  }

  /** Idempotent: a headless child's exit and its detach settle can both arrive. */
  private recordExit(
    agentId: string,
    outcome: { code: number | null; signal: string | null; inferred?: boolean },
  ): void {
    const entry = this.live.get(agentId)
    if (!entry) return
    if (entry.settle) clearTimeout(entry.settle)
    this.live.delete(agentId)
    this.semaphore.release(agentId)

    this.core.append({
      kind: 'agent_exited',
      actor: entry.name,
      ref: agentId,
      body: outcome.inferred ? 'exit inferred from presence; no exit code available' : '',
      meta: {
        ...(outcome.code === null ? {} : { code: String(outcome.code) }),
        ...(outcome.signal === null ? {} : { signal: outcome.signal }),
        ...(outcome.inferred ? { inferred: 'true' } : {}),
      },
    })
    logEvent('agent_exited', { agentId, name: entry.name, code: outcome.code, inferred: outcome.inferred })
  }

  private refuse(req: SpawnRequest, reason: string): SpawnOutcome {
    // An event, not just a reply string: refusals are the security-relevant
    // thing and belong in the log whether or not anyone was watching.
    this.core.append({
      kind: 'agent_spawn_refused',
      actor: req.requestedBy,
      target: req.name,
      body: reason,
      meta: { profile: req.profile },
    })
    logEvent('agent_spawn_refused', { name: req.name, by: req.requestedBy, reason })
    return { ok: false, reason }
  }

  /**
   * §11.2: the spawn request is attacker-controlled, and `cwd` decides where a
   * process with the profile's tools gets to read. The spec promised this check
   * and the code never had it — a peer could spawn an agent in `~/.ssh`, which is
   * the exact example the spec uses to say it cannot.
   *
   * Containment is to directories some registered session is already working in:
   * a peer may spawn where work is happening, nowhere else. Resolved through
   * realpath first, so `..` and a symlink pointing out of the tree are both
   * caught rather than passing a string comparison.
   *
   * The human at the CLI is exempt from containment, not from existence. They
   * hold no registry entry to be contained by, and reaching a 0600 socket already
   * means being the local user — the same reasoning that lets them spawn at all.
   */
  private checkCwd(cwd: string, requestedBy: string): string | undefined {
    let real: string
    try {
      const stat = fs.statSync(cwd)
      if (!stat.isDirectory()) return `cwd is not a directory: ${cwd}`
      real = fs.realpathSync(cwd)
    } catch {
      return `cwd does not exist: ${cwd}`
    }
    if (requestedBy === HUMAN) return undefined

    const contained = this.core.registry.list().some(session => {
      let root: string
      try {
        root = fs.realpathSync(session.cwd)
      } catch {
        return false
      }
      return real === root || real.startsWith(root + path.sep)
    })
    return contained ? undefined : `cwd must be at or under a directory some session is working in: ${cwd}`
  }

  /** Everything checkable before anything is allocated or written. */
  private preflight(req: SpawnRequest, depth: number): string | undefined {
    if (RESERVED_NAMES.has(req.name.toLowerCase()))
      return `"${req.name}" is reserved and cannot be used as an agent name`
    if (this.core.agents.nameIsClaimed(req.name))
      return `the name "${req.name}" is held by a live agent; retire it or choose another`
    if (this.core.registry.connFor(req.name) !== undefined)
      return `a session is already registered as "${req.name}"`
    if (depth > MAX_DEPTH) return `spawn depth ${depth} exceeds the cap of ${MAX_DEPTH}`
    // Checked last of the cheap gates and first of the stateful ones: the human
    // at the CLI is exempt, same reasoning as checkCwd's exemption — they hold
    // no registry entry to be rate-limited by and reaching the socket already
    // means being the local user.
    if (req.requestedBy !== HUMAN) {
      const rate = this.spawnRateBudget.check(req.requestedBy)
      if (!rate.ok) return rate.reason
    }
    return undefined
  }

  /**
   * Depth of a spawn requested by `parentAgentId`, read from the parent's own
   * recorded depth rather than recomputed by walking the chain — the parent may
   * itself be retired, and a cap that stops working once an ancestor is gone is
   * not a cap.
   */
  private depthOf(parentAgentId: string | undefined): number {
    if (!parentAgentId) return 1
    const spawn = this.core.events
      .agentEvents()
      .find(row => row.kind === 'agent_spawned' && row.msgId === parentAgentId)
    const parentDepth = Number.parseInt(spawn?.meta.depth ?? '1', 10)
    return (Number.isFinite(parentDepth) ? parentDepth : 1) + 1
  }

  async spawn(req: SpawnRequest): Promise<SpawnOutcome> {
    const depth = this.depthOf(req.parentAgentId)
    const blocked = this.preflight(req, depth)
    if (blocked) return this.refuse(req, blocked)

    const profile = loadProfile(req.profile)
    if ('error' in profile) return this.refuse(req, profile.error)

    const cwd = req.cwd ?? process.cwd()
    const cwdError = this.checkCwd(cwd, req.requestedBy)
    if (cwdError) return this.refuse(req, cwdError)
    const isolationName = req.isolation ?? profile.isolation
    // Minted before the slot is taken so that acquire and release are keyed the
    // same way. Keying acquire on the name and release on the id leaks a slot on
    // every exit, and the leak is invisible until spawning stops working.
    const agentId = newMsgId()
    const ctx: IsolationContext = {
      agentId,
      agentName: req.name,
      baseCwd: cwd,
      // Without this the toolset strategy sees no tool lists and warns on every
      // spawn. It is the DENY list that silences the warning, because that is the
      // only one that confines — an earlier version of this comment argued the
      // warning was false because --allowed-tools was passed regardless, which was
      // the exact misreading that let a read-only profile keep a shell.
      toolset: {
        allowedTools: [...profile.allowedTools],
        ...(profile.disallowedTools ? { disallowedTools: [...profile.disallowedTools] } : {}),
      },
      ...(req.forceReset ? { forceReset: true } : {}),
    }

    const warnings = await resolveIsolation([isolationName]).check(ctx)
    if (!this.semaphore.acquire(agentId))
      return this.refuse(req, `no free agent slots (${this.semaphore.summary()}); retire one first`)

    try {
      return await this.launch(req, ctx, agentId, isolationName, warnings, profile, depth)
    } catch (err) {
      this.semaphore.release(agentId)
      const reason = err instanceof SurfaceRefused ? err.message : `spawn failed: ${(err as Error).message}`
      return this.refuse(req, reason)
    }
  }

  /** The write-and-launch half, after every check has passed. */
  private async launch(
    req: SpawnRequest,
    ctx: IsolationContext,
    agentId: string,
    isolationName: IsolationName,
    warnings: string[],
    profile: AgentProfile,
    depth: number,
  ): Promise<SpawnOutcome> {
    const allocation = await resolveIsolation([isolationName]).allocate(ctx)
    this.core.append({
      kind: 'isolation_allocated',
      actor: req.name,
      ref: agentId,
      body: allocation.note ?? '',
      meta: { strategy: isolationName, ...(allocation.ref ?? {}) },
    })

    const surface = req.surface ?? profile.surface
    const sessionId = randomUUID()
    const plan = buildLaunchPlan({
      agentId,
      sessionId,
      name: req.name,
      profile,
      brief: [req.brief, allocation.note].filter(Boolean).join('\n\n'),
      cwd: allocation.cwd,
      surface,
      mcpConfigPath: mcpConfigPath(agentId),
      ...(allocation.addDirs ? { extraDirs: allocation.addDirs } : {}),
      ...(req.tags?.length ? { tags: req.tags } : {}),
      ...(req.subscriptions?.length ? { subscriptions: req.subscriptions } : {}),
      agentChatHome: home(),
    })
    writeLaunchFiles(plan, buildMcpConfig(profile, cliEntry()))

    // Appended BEFORE the launch. If the launch then fails, the identity exists
    // in `spawning` with a refusal beside it, which is exactly what you want when
    // debugging why a pane never opened. The reverse order loses failed spawns.
    this.core.append({
      kind: 'agent_spawned',
      actor: req.requestedBy,
      target: req.name,
      msgId: agentId,
      body: req.brief,
      meta: {
        name: req.name,
        parent: req.parentAgentId ?? '',
        profile: profile.name,
        model: profile.model,
        surface,
        isolation: isolationName,
        cwd: allocation.cwd,
        session_id: sessionId,
        allowed_tools: profile.allowedTools.join(','),
        perm_mode: permModeFor(surface),
        depth: String(depth),
      },
    })

    const handle = await this.launchOn(surface, plan, req.anchor)
    this.track(agentId, req.name, handle, allocation, isolationName, req.anchor)
    logEvent('agent_spawned', { agentId, name: req.name, surface: handle.surface, cwd: allocation.cwd })
    return {
      ok: true,
      agentId,
      name: req.name,
      ...(warnings.length > 0 ? { warnings } : {}),
      ...(profile.disallowedTools?.length ? { disallowedTools: [...profile.disallowedTools] } : {}),
    }
  }

  /**
   * The newest live agent already stacked beside this anchor. Insertion order is
   * spawn order, so the last match is the bottom of the column — the pane a new
   * agent should split. Nothing is persisted: a column is a fact about panes that
   * currently exist, and after a broker restart the next spawn starts a new one.
   */
  private columnFor(anchor: string): string | undefined {
    let bottom: string | undefined
    for (const entry of this.live.values()) {
      if (entry.anchor === anchor && entry.handle.paneRef) bottom = entry.handle.paneRef
    }
    return bottom
  }

  private async launchOn(
    surface: SurfaceName,
    plan: LaunchPlan,
    anchor?: string,
    reuseAnchor = false,
  ): Promise<LaunchHandle> {
    const columnAfter = anchor === undefined ? undefined : this.columnFor(anchor)
    return surfaceFor(surface, {
      ...this.surfaceOptions,
      ...(anchor === undefined ? {} : { anchor }),
      ...(columnAfter === undefined ? {} : { columnAfter }),
      ...(reuseAnchor ? { reuseAnchor } : {}),
      onNotice: text => {
        this.core.append({ kind: 'notice', actor: 'agent-chat', target: 'human', body: text })
      },
    }).launch(plan)
  }

  private track(
    agentId: string,
    name: string,
    handle: LaunchHandle,
    allocation: Allocation,
    isolation: IsolationName,
    anchor?: string,
  ): void {
    // A settle timer from a previous life closes over the OLD Live object, but
    // `recordExit` resolves the entry by id against the current map — so a timer
    // left armed here would fire against the agent that just came back, delete
    // it, free its slot, and record an exit for a running process. Replacing the
    // entry has to cancel the timer that belonged to it.
    const previous = this.live.get(agentId)
    if (previous?.settle) clearTimeout(previous.settle)

    const entry: Live = { agentId, name, handle, allocation, isolation, ...(anchor ? { anchor } : {}) }
    this.live.set(agentId, entry)
    // Headless only. A visible agent has no such promise, by design, and falls
    // through to the presence-inferred path instead.
    void handle.exited?.then(outcome => this.recordExit(agentId, outcome))
  }

  /**
   * End the process, keeping the identity. Refuses on a visible surface: killing
   * a pane a human is looking at, from a bus any peer model can reach, is not a
   * thing to build.
   */
  kill(name: string): { ok: boolean; reason?: string } {
    const entry = this.find(name)
    if (!entry) return { ok: false, reason: `no live agent named "${name}"` }
    if (entry.handle.surface !== 'headless')
      return {
        ok: false,
        reason: `${name} is running in an iTerm pane; exit it there, or \`agent-chat agent attach ${name}\` to go to it.`,
      }
    const { pid } = entry.handle
    if (pid === undefined) return { ok: false, reason: `${name} has no recorded pid` }

    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      return { ok: false, reason: `${name} (pid ${pid}) was already gone` }
    }
    setTimeout(() => {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // exited on the polite signal, which is the good case
      }
    }, KILL_GRACE_MS).unref?.()
    return { ok: true }
  }

  /**
   * Close the identity: release isolation, free the name. Retire is the ONLY
   * thing that frees a name, so a detached agent stays addressable and its
   * peers' remembered addressing keeps working until someone decides otherwise.
   */
  async retire(name: string, force = false): Promise<{ ok: boolean; reason?: string }> {
    const identity = this.core.agents.byName(name)
    if (!identity) return { ok: false, reason: `no agent named "${name}"` }
    const entry = this.live.get(identity.agentId)

    if (entry) {
      const ctx: IsolationContext = {
        agentId: identity.agentId,
        agentName: name,
        baseCwd: identity.cwd,
        ...(identity.exit ? { exitedAt: identity.lastEventAt } : {}),
      }
      const strategy = resolveIsolation([entry.isolation])
      const released = await strategy.release(ctx, entry.allocation, { force })
      this.core.append({
        kind: 'isolation_released',
        actor: name,
        ref: identity.agentId,
        body: released ? '' : 'refused: uncommitted or unmerged work, or inside the reclaim window',
        meta: { strategy: entry.isolation, released: String(released) },
      })
      if (!released)
        return {
          ok: false,
          reason: `${name}'s isolation still holds work. Merge or discard it, or retire with --force.`,
        }
      await this.closeSurface(entry)
      this.live.delete(identity.agentId)
    }

    this.semaphore.release(identity.agentId)
    this.core.append({ kind: 'agent_retired', actor: 'human', target: name, ref: identity.agentId })
    return { ok: true }
  }

  /**
   * Close the pane, tab or window a retiring agent was given.
   *
   * RETIRE ONLY, and the two halves of that are both deliberate. An exit does not
   * close anything: an agent finishing is not an instruction to throw away what it
   * printed, and a human reading its last output should not have the pane vanish
   * from under them. Retire is the explicit "I am done with this agent" — the same
   * act that frees the name and releases the isolation, so the surface goes with
   * them. `kill` needs nothing here: it already refuses on any visible surface.
   *
   * What is closed is decided by `ownsSurface`, one layer down. A pane the broker
   * merely split off, or an adopted session's own window, has no such mark and
   * survives — which is the whole constraint.
   */
  private async closeSurface(entry: Live): Promise<void> {
    if (entry.handle.ownsSurface !== true) return
    const closed = await surfaceFor(entry.handle.surface, { ...this.surfaceOptions }).close(entry.handle)
    logEvent('agent_surface_closed', { name: entry.name, surface: entry.handle.surface, closed })
  }

  /**
   * Relaunch an identity against its existing isolation.
   *
   * Honest about what this restores: `--resume` replays a transcript that lives
   * in Claude Code's own state, not in agent-chat. If that has been cleaned up
   * the agent comes back with its identity, brief and worktree but no memory of
   * the conversation. Durable identity is not durable context, and the caller is
   * told which one it is getting.
   */
  async resume(name: string): Promise<SpawnOutcome> {
    const identity = this.core.agents.byName(name)
    if (!identity) return { ok: false, reason: `no agent named "${name}"` }
    if (identity.state === 'live') return { ok: false, reason: `${name} is already live` }
    if (!this.semaphore.acquire(identity.agentId))
      return { ok: false, reason: `no free agent slots (${this.semaphore.summary()})` }

    const plan = readLaunchPlan(identity.agentId)
    const args = plan.args.map(arg => arg)
    const at = args.indexOf('--session-id')
    if (at !== -1) args[at] = '--resume'
    const resumed: LaunchPlan = { ...plan, args }

    this.core.append({
      kind: 'agent_resumed',
      actor: 'human',
      target: name,
      ref: identity.agentId,
      meta: { session_id: identity.sessionId },
    })
    const handle = await this.launchOn(resumed.surface, resumed)
    // Isolation is deliberately NOT reallocated: the existing handle is reused,
    // so a resumed worktree agent lands back in its own worktree, branch intact.
    this.track(identity.agentId, name, handle, { cwd: plan.cwd }, identity.isolation as IsolationName)
    return { ok: true, agentId: identity.agentId, name }
  }

  /**
   * Move a live agent between headless and a terminal, keeping its conversation.
   * Policy — who may aim this, and where it lands — is `mode-switch.ts`; this is
   * the mechanism only.
   */
  async switchSurface(req: SwitchRequest): Promise<SwitchOutcome> {
    const identity = this.core.agents.byName(req.name)
    const blocked =
      req.to === 'headless'
        ? checkBackgroundable(identity, req.name, req.hostPid)
        : checkSurfaceable(identity, req.name)
    if (blocked) return { ok: false, reason: blocked }

    const agent = identity as AgentIdentity
    const profile = loadProfile(agent.profile)
    if ('error' in profile)
      return { ok: false, reason: `cannot reload profile "${agent.profile}": ${profile.error}` }
    if (agent.sessionId === '')
      return { ok: false, reason: `${req.name} has no recorded session id, so it cannot be resumed` }

    const stopped = this.stopFor(req, agent)
    if (!stopped.ok) return { ok: false, reason: stopped.reason as string }
    await this.waitForNameFree(req.name)
    return this.resumeOnto(req, agent, profile)
  }

  /**
   * End the running process, by the route that direction is allowed to use.
   *
   * Surfacing reaches `kill`, which refuses anything but a headless agent — and
   * a headless agent is the only thing surfacing applies to, so the guard that
   * protects a human's pane from a peer stays fully intact. Backgrounding reaches
   * `endSession`, on a pid the caller reported about its OWN process.
   *
   * An agent that is not live is not an error: it is already stopped, and the
   * resume below is exactly what it needed anyway.
   */
  private stopFor(req: SwitchRequest, agent: AgentIdentity): { ok: boolean; reason?: string } {
    if (!this.live.has(agent.agentId)) return { ok: true }
    if (req.to === 'headless') return this.endSession(req.name, req.hostPid as number)
    return this.kill(req.name)
  }

  /** Rebuild the plan against the new surface and reattach to the same conversation. */
  private async resumeOnto(
    req: SwitchRequest,
    agent: AgentIdentity,
    profile: AgentProfile,
  ): Promise<SwitchOutcome> {
    const entry = this.live.get(agent.agentId)
    const surface = req.to === 'headless' ? 'headless' : placementFor(req.anchor)
    const allocation = entry?.allocation ?? { cwd: agent.cwd }
    const isolation = entry?.isolation ?? (agent.isolation as IsolationName)

    const plan = buildLaunchPlan({
      agentId: agent.agentId,
      sessionId: agent.sessionId,
      resume: true,
      name: req.name,
      profile,
      brief: req.to === 'headless' ? BACKGROUNDED_BRIEF : agent.brief,
      cwd: allocation.cwd,
      surface,
      mcpConfigPath: mcpConfigPath(agent.agentId),
      ...(allocation.addDirs ? { extraDirs: allocation.addDirs } : {}),
      agentChatHome: home(),
    })
    writeLaunchFiles(plan, buildMcpConfig(profile, cliEntry()))

    // `surface` in meta is what stops the roster reporting the pane this agent no
    // longer has — `foldAgent` reads it, and only a switch ever writes it.
    this.core.append({
      kind: 'agent_resumed',
      actor: req.requestedBy,
      target: req.name,
      ref: agent.agentId,
      body: req.to === 'headless' ? 'backgrounded' : 'surfaced',
      meta: { session_id: agent.sessionId, surface, from_surface: agent.surface },
    })

    const handle = await this.launchOn(surface, plan, req.anchor)
    this.track(agent.agentId, req.name, handle, allocation, isolation, req.anchor)
    logEvent('agent_surface_switched', { name: req.name, to: handle.surface, from: agent.surface })
    // Delivered after the relaunch so it lands in the session that came back,
    // rather than the one that was about to be signalled.
    if (req.to !== 'headless') this.tellAgent(req.name, SURFACED_NOTICE)
    return { ok: true, name: req.name, agentId: agent.agentId, surface: handle.surface }
  }

  /**
   * A `message` rather than a `notice`: notices are not pushed and are not an
   * inbox kind, so one aimed at a session is simply never seen — the defect the
   * teleport live runs found, and the same trap is open here.
   */
  private tellAgent(name: string, body: string): void {
    const { msgId } = this.core.append({ kind: 'message', actor: 'agent-chat', target: name, body })
    this.core.deliverTo(name, { msgId, from: 'agent-chat', text: body, at: Date.now() })
  }

  /**
   * Registration is what holds a name, and the resumed process registers under
   * the name the stopped one still holds. Timing out is not fatal — the launch
   * proceeds and the agent's own registration reports the collision.
   */
  private async waitForNameFree(name: string): Promise<void> {
    const deadline = Date.now() + this.nameFreeMs
    while (Date.now() < deadline) {
      if (this.core.registry.connFor(name) === undefined) return
      await new Promise(resolve => setTimeout(resolve, NAME_FREE_POLL_MS))
    }
    logEvent('switch_name_held', { name, waitedMs: this.nameFreeMs })
  }

  /** Hand off to a successor and end this session. See `teleport.ts`. */
  async teleport(req: TeleportRequest): Promise<TeleportOutcome> {
    return this.teleporter.start(req)
  }

  /** The human's veto on a countdown. No agent-facing path reaches this. */
  abortTeleport(name: string): { ok: boolean; reason?: string } {
    return this.teleporter.abort(name)
  }

  /**
   * The predecessor's isolation, for the descendant to STAND IN rather than
   * re-allocate. Undefined for an ordinary session, which never had one.
   */
  inheritedIsolation(agentId: string): InheritedIsolation | undefined {
    const entry = this.live.get(agentId)
    if (!entry) return undefined
    return { allocation: entry.allocation, isolation: entry.isolation, slot: this.semaphore.has(agentId) }
  }

  /**
   * End Claude Code itself, on a pid the session reported about its own process.
   *
   * Deliberately NOT `kill(name)`: that refuses on a visible surface, because
   * killing a pane a human is looking at from a bus any peer can reach is not a
   * thing to build. This is the other case — the session asked to end itself, a
   * human was offered 30 seconds to say no, and nothing here can be aimed at
   * anyone else, since the pid came from the caller's own registration.
   */
  endSession(name: string, hostPid: number): { ok: boolean; reason?: string } {
    try {
      process.kill(hostPid, 'SIGTERM')
    } catch {
      return { ok: false, reason: `${name} (pid ${hostPid}) was already gone` }
    }
    setTimeout(() => {
      try {
        process.kill(hostPid, 'SIGKILL')
      } catch {
        // exited on the polite signal, which is the good case
      }
    }, KILL_GRACE_MS).unref?.()
    return { ok: true }
  }

  /**
   * Launch a descendant into a name and an isolation that already exist.
   *
   * Everything the ordinary spawn path decides — a fresh allocation, a slot, a
   * depth one greater than its parent — is pinned by the caller here instead,
   * because a teleport is a continuation of one agent rather than the creation
   * of another. What it does NOT skip is rebuilding the launch plan and the MCP
   * config: that is what makes the descendant exec the current `dist/cli.js` and
   * read the current instructions, which is the entire payoff of the feature.
   */
  async relaunch(input: RelaunchInput): Promise<void> {
    // The descendant occupies exactly what the predecessor did, so the budget
    // sees one agent throughout rather than two for the length of a launch.
    if (input.inheritedFrom !== undefined) this.semaphore.release(input.inheritedFrom)
    if (input.inherited?.slot) this.semaphore.acquire(input.agentId)
    // The predecessor's entry is dropped here rather than left for its own exit
    // to clear: `find(name)` scans by name, and for as long as both entries sit
    // in the map, "the live agent called scout" resolves to the dead one — so a
    // kill or an `agent attach` would be aimed at a process that is already gone.
    const predecessor = input.inheritedFrom === undefined ? undefined : this.live.get(input.inheritedFrom)
    if (predecessor !== undefined) {
      if (predecessor.settle) clearTimeout(predecessor.settle)
      this.live.delete(predecessor.agentId)
    }

    const isolation = input.inherited?.isolation ?? 'none'
    const allocation = input.inherited?.allocation ?? { cwd: input.cwd }
    if (input.inherited !== undefined)
      this.core.append({
        kind: 'isolation_allocated',
        actor: input.name,
        ref: input.agentId,
        body: allocation.note ?? '',
        meta: {
          strategy: isolation,
          ...(allocation.ref ?? {}),
          // So a later release still finds the branch, worktree path and git root
          // it needs — without this the tree survives every retirement forever.
          ...(input.inheritedFrom === undefined ? {} : { inherited_from: input.inheritedFrom }),
        },
      })

    const sessionId = Teleport.newSessionId()
    const plan = buildLaunchPlan({
      agentId: input.agentId,
      sessionId,
      name: input.name,
      profile: input.profile,
      brief: input.brief,
      cwd: allocation.cwd,
      surface: input.surface,
      preamble: input.preamble,
      mcpConfigPath: mcpConfigPath(input.agentId),
      ...(allocation.addDirs ? { extraDirs: allocation.addDirs } : {}),
      ...(input.tags?.length ? { tags: input.tags } : {}),
      ...(input.subscriptions?.length ? { subscriptions: input.subscriptions } : {}),
      agentChatHome: home(),
    })
    writeLaunchFiles(plan, buildMcpConfig(input.profile, cliEntry()))

    this.core.append({
      kind: 'agent_spawned',
      actor: input.name,
      target: input.name,
      msgId: input.agentId,
      body: input.brief,
      meta: {
        name: input.name,
        profile: input.profile.name,
        model: input.profile.model,
        surface: input.surface,
        isolation,
        cwd: allocation.cwd,
        session_id: sessionId,
        allowed_tools: input.profile.allowedTools.join(','),
        perm_mode: permModeFor(input.surface),
        ...input.meta,
      },
    })

    // The descendant takes the pane its predecessor vacated, rather than a tab
    // beside it. Safe here and nowhere else: this anchor is the predecessor's
    // own pane, and the predecessor is already gone.
    const launched = await this.launchOn(input.surface, plan, input.anchor, input.reuseAnchor ?? false)
    const handle = succeedsInto(launched, predecessor?.handle) ? { ...launched, ownsSurface: true } : launched
    // Transfers the allocation to the descendant's id, so ITS eventual retire
    // releases the real strategy rather than a no-op one.
    this.track(input.agentId, input.name, handle, allocation, isolation, input.anchor)
    logEvent('agent_teleported', { agentId: input.agentId, name: input.name, from: input.inheritedFrom })
  }

  /** Live agents, for `agent ls` and the slot summary. */
  liveIds(): string[] {
    return [...this.live.keys()]
  }

  slots(blocked = 0): string {
    return this.semaphore.summary(blocked)
  }

  paneRefFor(name: string): string | undefined {
    return this.find(name)?.handle.paneRef
  }

  private find(name: string): Live | undefined {
    for (const entry of this.live.values()) if (entry.name === name) return entry
    return undefined
  }

  close(): void {
    this.unwatch()
    this.teleporter.close()
    for (const entry of this.live.values()) if (entry.settle) clearTimeout(entry.settle)
  }
}
