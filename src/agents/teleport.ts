import { randomUUID } from 'node:crypto'
import type { BrokerCore } from '../broker/core.js'
import { newMsgId } from '../broker/event-log.js'
import { logEvent } from '../broker/log.js'
import {
  HUMAN,
  isInteractiveSurface,
  SURFACE_NAMES,
  type AgentIdentity,
  type IsolationName,
  type Subscription,
  type SurfaceName,
} from '../protocol.js'
import type { Allocation } from './isolation/index.js'
import { loadProfile } from './profiles.js'
import { observedModel } from './transcript.js'
import type { AgentProfile } from './types.js'

/**
 * Teleport: a session ends itself deliberately and starts a successor that boots
 * from the current build. `docs/teleport.md` is the design; this is v0 of it, and
 * v0 has NO overlap window — the predecessor is gone before the descendant is
 * launched. Almost everything simple about this file follows from that one
 * decision, so read §5.1 before reintroducing an overlap.
 *
 * The two properties worth restating here, because both are load-bearing and
 * neither is obvious from the code alone:
 *
 * - **The request names no agent.** The subject is resolved by the socket layer
 *   from the requesting connection, the way `anchor` and `parentAgentId` already
 *   are. Nothing here takes a target, so no caller can end a process other than
 *   its own — not by a check that can erode, but because there is no field.
 * - **Abort is human-only.** The countdown is cancelled through a wire message
 *   the broker refuses from any registered connection, and no MCP tool exposes
 *   it. A descendant suppressing its predecessor's veto would turn a human
 *   safety valve into a formality.
 */

/** How long a human gets to stop a visible session ending itself. */
export const COUNTDOWN_MS = 30_000

/**
 * Refused rather than truncated, and that is the whole point of a cap here: a
 * truncated handoff loses its tail, and the tail is "what I already tried that
 * did not work" — the most expensive thing in the document to lose.
 */
export const HANDOFF_MAX_BYTES = 8 * 1024

/** How long to wait for the predecessor's socket to go before claiming its name. */
const NAME_FREE_TIMEOUT_MS = 8_000
const NAME_FREE_POLL_MS = 100

/**
 * A beat for the vacated pane's shell to get back to a prompt.
 *
 * Only matters when the descendant reuses the predecessor's pane: the command
 * is TYPED into that session, and one written while Claude Code is still tearing
 * its TUI down is swallowed — leaving a pane that just sits there, with no error
 * anywhere, which is the worst way for this to fail.
 */
export const PANE_SETTLE_MS = 750

/** What every descendant is told about its own origin, in place of PEER_PREAMBLE. */
export const TELEPORT_PREAMBLE = [
  'You are the continuation of a session that handed off to you and then ended. You keep its',
  'name, its peers and its working directory, and you are running on the current build — which',
  'is why it teleported. Its handoff is your first turn: it was written by the session itself,',
  'about its own mid-flight state, and nothing verifies that it matches the disk. Trust it as a',
  'starting point and check it as you go. Your predecessor is gone; do not report back to it.',
].join(' ')

/**
 * What the socket layer resolved from the requesting connection, never from the
 * request. `hostPid` is Claude Code's own pid — signalling the MCP subprocess
 * instead severs the bus and leaves a live session that no peer can reach and
 * that cannot tell (docs/teleport.md §5.1, measured).
 */
export interface TeleportSubject {
  agentId: string
  name: string
  cwd: string
  hostPid?: number
  anchor?: string
  tags: string[]
  subscriptions: Subscription[]
}

export interface TeleportRequest {
  subject: TeleportSubject
  handoff: string
  /** The one negotiable field: succeeding yourself onto a different model, on purpose. */
  model?: string
}

export interface TeleportOutcome {
  ok: boolean
  reason?: string
  name?: string
  agentId?: string
  countdownMs?: number
  warnings?: string[]
}

/** The predecessor's isolation, carried across rather than re-allocated (§9). */
export interface InheritedIsolation {
  allocation: Allocation
  isolation: IsolationName
  /** True when the predecessor held an agent slot, so the descendant takes exactly one too. */
  slot: boolean
}

export interface RelaunchInput {
  agentId: string
  name: string
  profile: AgentProfile
  brief: string
  cwd: string
  surface: SurfaceName
  preamble: string
  meta: Record<string, string>
  tags?: string[]
  subscriptions?: Subscription[]
  anchor?: string
  /** Land in the predecessor's own pane rather than beside it. */
  reuseAnchor?: boolean
  inherited?: InheritedIsolation
  /** For the descendant's `isolation_allocated` row, so a later release finds the real tree. */
  inheritedFrom?: string
}

/** What teleport borrows from the supervisor: process control and the launch path. */
export interface TeleportHost {
  inheritedIsolation(agentId: string): InheritedIsolation | undefined
  /** SIGTERM then SIGKILL, on the pid that ends Claude Code itself. */
  endSession(name: string, hostPid: number): { ok: boolean; reason?: string }
  relaunch(input: RelaunchInput): Promise<void>
}

interface Pending {
  subject: TeleportSubject
  descendantId: string
  profile: AgentProfile
  surface: SurfaceName
  handoff: string
  inherited: InheritedIsolation | undefined
  timer?: NodeJS.Timeout
}

const bytes = (text: string): number => Buffer.byteLength(text, 'utf8')

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/**
 * A descendant of an ordinary human-started session, which has no profile to
 * copy: empty `model` and empty `allowedTools` mean INHERIT in `buildLaunchPlan`
 * — the model the session is observably running on, and the permission posture
 * the human's own settings give it. Emitting flags here would not reproduce the
 * session's configuration, it would invent one and call it continuity.
 */
const inheritedProfile = (model: string | undefined): AgentProfile => ({
  name: 'inherited',
  description: 'the configuration the predecessor session was already running under',
  model: model ?? '',
  allowedTools: [],
  isolation: 'none',
  surface: 'iterm-tab',
  promptPrelude: '',
})

const isSurfaceName = (value: string): value is SurfaceName =>
  (SURFACE_NAMES as readonly string[]).includes(value)

export class Teleport {
  private readonly pending = new Map<string, Pending>()

  constructor(
    private readonly core: BrokerCore,
    private readonly host: TeleportHost,
    private readonly countdownMs: number = COUNTDOWN_MS,
  ) {}

  /**
   * Record the handoff and commit to the sequence. Answers immediately: a
   * visible predecessor still has its countdown to run, and the model that
   * called this needs to know it succeeded long before then.
   */
  async start(req: TeleportRequest): Promise<TeleportOutcome> {
    const { subject } = req
    const blocked = this.preflight(req)
    if (blocked) return { ok: false, reason: blocked }

    const identity = this.core.agents.get(subject.agentId)
    if (!identity) return { ok: false, reason: `no durable identity for ${subject.agentId}` }

    const config = this.configFor(identity, subject, req.model)
    if ('error' in config) return { ok: false, reason: config.error }

    const descendantId = newMsgId()
    // Stored verbatim, and the broker templates nothing: the moment it does, a
    // handoff becomes a form to fill in and stops being what the session knew.
    this.core.append({
      kind: 'agent_handoff',
      actor: subject.name,
      ref: subject.agentId,
      body: req.handoff,
      meta: { successor: descendantId },
    })

    const entry: Pending = {
      subject,
      descendantId,
      handoff: req.handoff,
      profile: config.profile,
      surface: config.surface,
      inherited: this.host.inheritedIsolation(subject.agentId),
    }
    this.pending.set(subject.agentId, entry)
    logEvent('teleport_started', { name: subject.name, from: subject.agentId, to: descendantId })

    const warnings = this.warningsFor(identity, subject.name)
    const result: TeleportOutcome = {
      ok: true,
      name: subject.name,
      agentId: descendantId,
      ...(warnings.length > 0 ? { warnings } : {}),
    }
    // A headless predecessor has no pane and no human watching it in the moment,
    // so a countdown would be latency bought in exchange for a veto nobody is
    // positioned to exercise. The asymmetry is deliberate; see §4.2.
    if (!isInteractiveSurface(config.surface)) {
      void this.finish(subject.agentId)
      return result
    }
    this.notifyCountdown(subject.name)
    entry.timer = setTimeout(() => void this.finish(subject.agentId), this.countdownMs)
    entry.timer.unref?.()
    return { ...result, countdownMs: this.countdownMs }
  }

  /** Everything checkable before the handoff is written and the sequence is entered. */
  private preflight(req: TeleportRequest): string | undefined {
    const { subject } = req
    if (this.pending.has(subject.agentId)) return `${subject.name} is already teleporting`
    // Without it there is no way to end the predecessor that does not sever the
    // bus and leave a live session no peer can reach — the failure §5.1 measured.
    // Every current client sends it on `register`; an older one does not, and
    // teleporting from one would produce two live processes on one name.
    if (subject.hostPid === undefined)
      return (
        'this session did not report the pid of Claude Code itself, so the broker cannot end it ' +
        'without severing the bus and leaving it running. Its MCP server predates teleport — ' +
        'restart the session (or run /mcp reconnect) and try again.'
      )

    const size = bytes(req.handoff)
    if (size > HANDOFF_MAX_BYTES)
      return (
        `handoff is ${size} bytes, over the ${HANDOFF_MAX_BYTES}-byte cap. It is refused rather ` +
        'than truncated, because truncation would drop the end — what you already tried, who you ' +
        'owe a reply to, and what to read first. Point at files with @-prefixed absolute paths ' +
        'instead of pasting their contents.'
      )

    // The mechanical reason, unchanged from §4.1: an answer is delivered BY NAME
    // to whoever holds it. If this name stops being held while a question is
    // open, the human's answer is appended to the log and delivered to nothing.
    const open = this.core.events.openQuestions(subject.name)
    if (open.length > 0) {
      const listed = open.map(q => `${q.msgId} (${q.text.slice(0, 60)})`).join('; ')
      return (
        `you have ${open.length} unanswered question(s) with the human: ${listed}. ` +
        'Answer, dismiss (agent-chat dismiss <id>), or restate them in the handoff first — ' +
        'teleport does not get to abandon them by leaving.'
      )
    }
    return undefined
  }

  /**
   * The descendant's launch configuration, inherited rather than chosen.
   *
   * A spawned agent has a profile recorded and keeps it. An adopted session has
   * none — there was never a launch plan — so it gets the harness's own defaults
   * plus whatever model it is observably running on. Neither path takes a
   * profile, surface or tool list from the request.
   */
  private configFor(
    identity: AgentIdentity,
    subject: TeleportSubject,
    model: string | undefined,
  ): { profile: AgentProfile; surface: SurfaceName } | { error: string } {
    if (identity.origin === 'adopted') {
      const inherited = inheritedProfile(model ?? observedModel(subject.cwd, identity.sessionId))
      return { profile: inherited, surface: inherited.surface }
    }
    const profile = loadProfile(identity.profile)
    if ('error' in profile) return { error: `cannot reload profile "${identity.profile}": ${profile.error}` }
    return {
      profile: model === undefined ? profile : { ...profile, model },
      surface: isSurfaceName(identity.surface) ? identity.surface : profile.surface,
    }
  }

  /**
   * Warn-only, per D5. Unread inbox items stay addressed to the name, and the
   * descendant keeps the name — so `chat_inbox` still returns them after the
   * hop. Refusing on them would make teleport unreachable for exactly the agents
   * people are actively talking to.
   */
  private warningsFor(identity: AgentIdentity, name: string): string[] {
    const arrived = this.core.events.inboxCountSince(name, identity.spawnedAt)
    if (arrived === 0) return []
    return [
      `${arrived} message(s) arrived for ${name} during this session. They stay addressed to the ` +
        'name, so your successor can read them with chat_inbox — but it will not know which you ' +
        'had already handled. Say so in the handoff.',
    ]
  }

  /**
   * Tell a session something it MUST act on, and actually deliver it.
   *
   * Found live: an abort was appended as a `notice` targeted at the session and
   * the session never saw it. Notices are not pushed, and `notice` is not an
   * inbox kind either — so the predecessor sat there believing it was about to
   * be shut down, which is the one thing an abort exists to stop it believing.
   * A `message` from `agent-chat` is delivered on the next turn and survives in
   * the inbox if the session is mid-turn when it lands.
   */
  private tell(name: string, body: string): void {
    const { msgId } = this.core.append({ kind: 'message', actor: 'agent-chat', target: name, body })
    this.core.deliverTo(name, { msgId, from: 'agent-chat', text: body, at: Date.now() })
  }

  private notifyCountdown(name: string): void {
    this.core.append({
      kind: 'notice',
      actor: 'agent-chat',
      target: HUMAN,
      body:
        `${name} is teleporting: it will be shut down in ${Math.round(this.countdownMs / 1000)}s and ` +
        `reopened from the current build, keeping its name. Stop it with: agent-chat teleport abort ${name}`,
    })
  }

  /**
   * The human's veto. Resolved by name because that is what a human has in front
   * of them; there is no agent-facing path to here (see the header).
   */
  abort(name: string): { ok: boolean; reason?: string } {
    for (const [agentId, entry] of this.pending) {
      if (entry.subject.name !== name) continue
      if (entry.timer === undefined)
        return { ok: false, reason: `${name}'s teleport is already under way and cannot be stopped` }
      clearTimeout(entry.timer)
      this.pending.delete(agentId)
      this.tell(name, 'Your teleport was aborted by the human. You are still live, still on the old build.')
      logEvent('teleport_aborted', { name, agentId })
      return { ok: true }
    }
    return { ok: false, reason: `no teleport is counting down for "${name}"` }
  }

  /**
   * Stand down, end the predecessor, then launch the descendant into the name it
   * just freed. Order is not negotiable — see §4.3 — and step 3 appends
   * `agent_retired` DIRECTLY rather than calling `Supervisor.retire`, which would
   * also release the isolation the descendant is about to stand in.
   */
  private async finish(agentId: string): Promise<void> {
    const entry = this.pending.get(agentId)
    if (entry === undefined) return
    delete entry.timer
    const { subject } = entry

    this.core.append({ kind: 'agent_stood_down', actor: subject.name, ref: agentId })
    // Non-null because `preflight` refuses a subject without one, and a pending
    // entry only exists once preflight has passed.
    const ended = this.host.endSession(subject.name, subject.hostPid as number)
    await this.waitForNameFree(subject.name)
    this.core.append({
      kind: 'agent_retired',
      actor: 'agent-chat',
      target: subject.name,
      ref: agentId,
      body: 'superseded by teleport',
      ...(ended.ok ? {} : { meta: { shutdown: ended.reason ?? 'failed' } }),
    })

    try {
      if (subject.anchor !== undefined) await sleep(PANE_SETTLE_MS)
      await this.host.relaunch(this.relaunchFor(entry))
      logEvent('teleport_completed', { name: subject.name, from: agentId, to: entry.descendantId })
    } catch (err) {
      // The one genuinely bad state this feature can reach: predecessor gone,
      // descendant never started. Nobody is left inside the session to notice,
      // so it goes to the only party outside it.
      const reason = (err as Error).message
      this.core.append({
        kind: 'notice',
        actor: 'agent-chat',
        target: HUMAN,
        body: `${subject.name} shut down for a teleport and its successor failed to start: ${reason}`,
      })
      logEvent('teleport_failed', { name: subject.name, from: agentId, reason })
    } finally {
      this.pending.delete(agentId)
    }
  }

  private relaunchFor(entry: Pending): RelaunchInput {
    const { subject } = entry
    const previous = this.core.agents.spawnMeta(subject.agentId)
    const generation = Number.parseInt(previous.generation ?? '1', 10)
    return {
      agentId: entry.descendantId,
      name: subject.name,
      profile: entry.profile,
      brief: entry.handoff,
      cwd: entry.inherited?.allocation.cwd ?? subject.cwd,
      surface: entry.surface,
      preamble: TELEPORT_PREAMBLE,
      meta: {
        // Succession is not branching: DEPTH IS INHERITED, NOT INCREMENTED. The
        // obvious implementation reuses the ordinary parent path, and then a
        // long-running agent loses the ability to pick up its own improvements
        // precisely because it has run long enough to need it.
        depth: previous.depth ?? '1',
        parent: previous.parent ?? '',
        origin: previous.origin === 'adopted' ? 'adopted' : 'spawned',
        teleport_from: subject.agentId,
        generation: String((Number.isFinite(generation) ? generation : 1) + 1),
      },
      ...(subject.tags.length > 0 ? { tags: subject.tags } : {}),
      ...(subject.subscriptions.length > 0 ? { subscriptions: subject.subscriptions } : {}),
      ...(subject.anchor === undefined ? {} : { anchor: subject.anchor, reuseAnchor: true }),
      ...(entry.inherited === undefined ? {} : { inherited: entry.inherited }),
      ...(entry.inherited === undefined ? {} : { inheritedFrom: subject.agentId }),
    }
  }

  /**
   * Wait for the predecessor's socket to actually go.
   *
   * Registration is what holds a name, and the descendant registers under the
   * predecessor's own name. Racing that would hit the same-agentId takeover path
   * or a flat "held by another session" — so this waits for presence to end
   * rather than assuming a signal is instant. Timing out is not fatal: the
   * launch proceeds and the descendant's own registration reports the collision.
   */
  private async waitForNameFree(name: string): Promise<void> {
    const deadline = Date.now() + NAME_FREE_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (this.core.registry.connFor(name) === undefined) return
      await sleep(NAME_FREE_POLL_MS)
    }
    logEvent('teleport_name_held', { name, waitedMs: NAME_FREE_TIMEOUT_MS })
  }

  /** Session ids are minted per descendant, never reused: a teleport is not a resume. */
  static newSessionId(): string {
    return randomUUID()
  }

  close(): void {
    for (const entry of this.pending.values()) if (entry.timer) clearTimeout(entry.timer)
    this.pending.clear()
  }
}
