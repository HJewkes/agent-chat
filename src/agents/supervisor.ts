import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { BrokerCore } from '../broker/core.js'
import { newMsgId } from '../broker/event-log.js'
import {
  HUMAN,
  RESERVED_NAMES,
  type IsolationName,
  type Subscription,
  type SurfaceName,
} from '../protocol.js'
import { buildLaunchPlan, permModeFor } from './launch-plan.js'
import { buildMcpConfig, mcpConfigPath, readLaunchPlan, writeLaunchFiles } from './launch-files.js'
import { loadProfile } from './profiles.js'
import { resolve as resolveIsolation, type Allocation, type IsolationContext } from './isolation/index.js'
import { surfaceFor } from './surfaces/index.js'
import { SurfaceRefused, type SurfaceOptions } from './surfaces/options.js'
import { Semaphore } from './semaphore.js'
import { cliEntry, home } from '../paths.js'
import { logEvent } from '../broker/log.js'
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
  settleMs?: number
  /**
   * Merged into every surface built here. Without it a test naming `iterm-pane`
   * reaches the real AppleScript and opens a real window on any machine that
   * happens to be running iTerm — passing on CI and spawning panes on a laptop.
   */
  surface?: Pick<SurfaceOptions, 'runAppleScript' | 'spawn' | 'platform'>
}

export class Supervisor {
  private readonly live = new Map<string, Live>()
  private readonly semaphore: Semaphore
  private readonly settleMs: number
  private readonly surfaceOptions: SupervisorOptions['surface']
  private readonly unwatch: () => void

  constructor(
    private readonly core: BrokerCore,
    options: SupervisorOptions = {},
  ) {
    this.semaphore = options.semaphore ?? new Semaphore()
    this.settleMs = options.settleMs ?? SETTLE_MS
    this.surfaceOptions = options.surface ?? {}
    this.unwatch = core.onAppend(row => this.onRow(row))
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
      // Without this the toolset strategy sees no tool lists and warns that the
      // agent "runs at full capability" on every explorer and reviewer spawn —
      // false, since the launch plan passes --allowed-tools from the profile
      // regardless. A warning that cries wolf on the read-only profiles is worse
      // than none: it is the same channel a real over-permission has to use.
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

  private async launchOn(surface: SurfaceName, plan: LaunchPlan, anchor?: string): Promise<LaunchHandle> {
    const columnAfter = anchor === undefined ? undefined : this.columnFor(anchor)
    return surfaceFor(surface, {
      ...this.surfaceOptions,
      ...(anchor === undefined ? {} : { anchor }),
      ...(columnAfter === undefined ? {} : { columnAfter }),
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
    }, 3000).unref?.()
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
      this.live.delete(identity.agentId)
    }

    this.semaphore.release(identity.agentId)
    this.core.append({ kind: 'agent_retired', actor: 'human', target: name, ref: identity.agentId })
    return { ok: true }
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
    for (const entry of this.live.values()) if (entry.settle) clearTimeout(entry.settle)
  }
}
