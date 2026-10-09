import { brokerHost, isLocalHost } from '../broker/host-guard.js'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import type { BrokerCore } from '../broker/core.js'
import { hostRemoteControl, psArgvReader, type ArgvReader } from '../broker/host-channels.js'
import { newMsgId } from '../broker/event-log.js'
import { logEvent } from '../broker/log.js'
import {
  HUMAN,
  isInteractiveSurface,
  SURFACE_NAMES,
  type AgentIdentity,
  type IsolationName,
  type RemoteLaunch,
  type Subscription,
  type SurfaceName,
  type TeleportReason,
} from '../protocol.js'
import type { Allocation } from './isolation/index.js'
import { loadProfile, recordedRole } from './profiles.js'
import { resolveSurface } from './surface-resolution.js'
import { shepherdRowsAsync } from './burndown/shepherd.js'
import { latestTeleportSection } from './seats/boot-read.js'
import { defaultAutonomyRoot } from './seats/io.js'
import { renderTeleportHandoff } from './seats/relaunch-handoff.js'
import { readSeatFile, writeTeleportState, type SeatTeleportDeps } from './seats/teleport-state.js'
import {
  appendixFacts,
  renderAppendix,
  reportsSinceWrap,
  runningSpawnedBy,
  type WrapGap,
} from './teleport-appendix.js'
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

/** CC-402: how long a reused pane waits for the predecessor's pid to exit; past the SIGKILL grace, so only a stuck kill hits it. */
export const PANE_EXIT_TIMEOUT_MS = 10_000
const PANE_EXIT_POLL_MS = 100

/** CC-881: how long a remote caller has to report its launch before the successor is released. */
export const REMOTE_LAUNCH_TIMEOUT_MS = 60_000

/** CC-913: how long an armed successor's helper may report it unplaced; well past its pane wait and two launches. */
export const LAND_WINDOW_MS = 5 * 60_000

export interface LandFailedReply {
  ok: boolean
  reason?: string
  /** Whether the predecessor was kept rather than retired; only on an accepted report. */
  predecessorLive?: boolean
}

/** CC-913: a helper's failure reason becomes a human notice, so it is bounded. */
const LAND_REASON_MAX = 1000

/** Thrown by a host that already told the human its successor did not start, so `finish` does not tell them twice. */
export class SuccessorNotStarted extends Error {
  override name = 'SuccessorNotStarted'
}

/** EPERM means the pid exists under another user, which still counts as running. */
const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** What every descendant is told about its own origin, in place of PEER_PREAMBLE. */
export const TELEPORT_PREAMBLE = [
  'You are the continuation of a session that handed off to you and then ended. You keep its',
  'name, its peers and its working directory, and you are running on the current build — which',
  'is why it teleported. Its handoff is your first turn: it was written by the session itself,',
  'about its own mid-flight state, and nothing verifies that it matches the disk. Trust it as a',
  'starting point and check it as you go. Your predecessor is gone; do not report back to it.',
].join(' ')

/** Put ahead of a park handoff, so the successor re-asks before it starts working (CC-135). */
export const PARK_LINE =
  'Your predecessor parked while waiting on the human. Ask the open question from its handoff first, then wait.'

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
  /** The machine `hostPid` lives on; absent means unreported, which is never treated as local (CC-880). */
  host?: string
  anchor?: string
  tags: string[]
  subscriptions: Subscription[]
  /**
   * The session's own `CLAUDE_CONFIG_DIR`, resolved by the socket layer from this
   * connection's registration rather than from the request (CC-100).
   *
   * A descendant continues its predecessor's work, which means continuing to
   * spend the same account. Without it a teleport quietly moved a session onto the
   * broker's account — and for an ADOPTED session it is the only place the answer
   * exists, since there is no launch plan that ever recorded one.
   */
  configDir?: string
}

export interface TeleportRequest {
  subject: TeleportSubject
  handoff: string
  /** The one negotiable field: succeeding yourself onto a different model, on purpose. */
  model?: string
  /** Overrides argv detection, for a session that enabled Remote Control with `/remote-control` (H-12). */
  remoteControl?: boolean
  /** CC-883: what the caller read from its own argv; read here instead when absent and on this host. */
  remoteControlSeen?: boolean
  reason?: TeleportReason
}

export interface TeleportOutcome {
  ok: boolean
  reason?: string
  name?: string
  agentId?: string
  countdownMs?: number
  warnings?: string[]
  remote?: boolean
}

/** CC-881: what a remote caller is handed: the successor to launch, or why there is none. */
export interface RemotePlanReply {
  ok: boolean
  reason?: string
  launch?: RemoteLaunch
}

/** CC-881: the remote caller's report on the launch it was handed. */
export interface RemoteLaunchReport {
  /** The successor the report is about, so a report can only settle the teleport it names. */
  successor: string
  ok: boolean
  reason?: string
}

type LaunchOutcome = Omit<RemoteLaunchReport, 'successor'>

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
  /** The account the predecessor was spending, carried across unchanged (CC-100). */
  configDir?: string
  /** CC-200: the predecessor ran with `CLAUDE_CONFIG_DIR` unset, so its successor does too. */
  configDirUnset?: boolean
  remoteControl?: boolean
}

/** CC-881: a reported host that is not the broker's; its pid and its terminal are that host's to act on. */
const onAnotherHost = (subject: TeleportSubject): boolean =>
  subject.host !== undefined && !isLocalHost(subject.host)

function hostReason(subject: TeleportSubject): string {
  return (
    `${subject.name} runs on host ${subject.host ?? 'unknown'}, not on the broker's host ${brokerHost()}, ` +
    'so the broker cannot end it or relaunch it there'
  )
}

/** What teleport borrows from the supervisor: process control and the launch path. */
export interface TeleportHost {
  inheritedIsolation(agentId: string): InheritedIsolation | undefined
  /** SIGTERM then SIGKILL, on the pid that ends Claude Code itself. */
  endSession(name: string, hostPid: number, host: string | undefined): { ok: boolean; reason?: string }
  /** Why a surface cannot launch on this broker's platform, if it cannot. */
  surfaceBlocker(surface: SurfaceName): string | undefined
  relaunch(input: RelaunchInput): Promise<void>
  /** CC-881: record the successor and build its launch for another host, launching nothing here. */
  prepareRemoteRelaunch(input: RelaunchInput): RemoteLaunch
  /** CC-881: the other host launched it, so the successor's execution opens. */
  confirmRemoteRelaunch(input: RelaunchInput): void
  /** CC-881: the other host did not launch it, so the successor's row is retired unused. */
  releaseRemoteRelaunch(input: RelaunchInput, reason: string): void
}

interface RemoteWait {
  plan: Promise<RemotePlanReply>
  answer: (reply: RemotePlanReply) => void
  report?: (report: LaunchOutcome) => void
}

const remoteWait = (): RemoteWait => {
  let answer: (reply: RemotePlanReply) => void = () => undefined
  const plan = new Promise<RemotePlanReply>(resolve => (answer = resolve))
  return { plan, answer }
}

interface Pending {
  subject: TeleportSubject
  descendantId: string
  profile: AgentProfile
  surface: SurfaceName
  handoff: string
  inherited: InheritedIsolation | undefined
  remoteControl: boolean
  reason?: TeleportReason
  /** When the predecessor's session began: the window the appendix counts inbox arrivals over. */
  since: number
  /** The predecessor's Claude session id, which names its active-work session record. */
  sessionId: string
  /** CC-863: the newest inbox row when it asked to teleport, which a seat's State block names as handled. */
  inboxThrough: string | undefined
  timer?: NodeJS.Timeout
  remote?: RemoteWait
  /** CC-913: its successor could not be placed before this predecessor was retired, so it is kept. */
  landFailed?: boolean
}

/** CC-913: an armed successor not yet registered; only the holder of `token` may report it unplaced. */
interface Landing {
  token: string
  entry: Pending
  timer: NodeJS.Timeout
}

const sameToken = (a: string, b: string): boolean =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

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
  role: 'coordinator',
  promptPrelude: '',
})

const isSurfaceName = (value: string): value is SurfaceName =>
  (SURFACE_NAMES as readonly string[]).includes(value)

/**
 * Which account this session is on: what it is observably running under now,
 * falling back to what its spawn row recorded (CC-100).
 *
 * Observed first because it is the live fact — a session that came back through a
 * mode switch or a previous teleport is authoritative about its own environment,
 * and a spawn row several generations old is not.
 */
const accountOf = (subject: TeleportSubject, identity: AgentIdentity): string | undefined =>
  subject.configDir ?? identity.configDir

/** The successor waits on this read, so it gets less time than burndown's. */
const TELEPORT_SHEPHERD_MS = 5_000

export const defaultSeatTeleportDeps = (): SeatTeleportDeps => ({
  autonomyRoot: defaultAutonomyRoot(),
  now: () => new Date(),
  shepherd: () => shepherdRowsAsync(undefined, TELEPORT_SHEPHERD_MS),
})

export class Teleport {
  private readonly pending = new Map<string, Pending>()
  /** CC-913: armed remote successors by id, each cleared when it registers or its window ends. */
  private readonly landings = new Map<string, Landing>()
  private readonly unwatch: () => void

  constructor(
    private readonly core: BrokerCore,
    private readonly host: TeleportHost,
    private readonly countdownMs: number = COUNTDOWN_MS,
    private readonly readArgv: ArgvReader = psArgvReader,
    private readonly seatTeleport: SeatTeleportDeps = defaultSeatTeleportDeps(),
  ) {
    this.unwatch = core.onAppend(row => {
      if (row.kind === 'agent_attached' && row.ref !== undefined) this.closeLanding(row.ref)
    })
  }

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
    const remote = onAnotherHost(subject)
    const impossible = remote ? undefined : this.host.surfaceBlocker(config.surface)
    if (impossible !== undefined) return this.cannotComplete(subject, impossible)
    const worker = recordedRole(this.core.agents.spawnMeta(subject.agentId)) === 'worker'
    if (worker && req.remoteControl === true)
      return {
        ok: false,
        reason: `${subject.name} is a worker, so its successor cannot run with Remote Control; only a coordinator may`,
      }

    const descendantId = newMsgId()
    // Stored verbatim, and the broker templates nothing: the moment it does, a
    // handoff becomes a form to fill in and stops being what the session knew.
    this.core.append({
      kind: 'agent_handoff',
      actor: subject.name,
      ref: subject.agentId,
      body: req.handoff,
      meta: { successor: descendantId, ...(req.reason === undefined ? {} : { reason: req.reason }) },
    })

    const entry: Pending = {
      subject,
      descendantId,
      handoff: req.handoff,
      profile: config.profile,
      surface: config.surface,
      // CC-881: a remote predecessor's pid names a process on its own host, not one here.
      inherited: remote ? undefined : this.host.inheritedIsolation(subject.agentId),
      // CC-163: a worker's successor never inherits Remote Control, even one its argv shows.
      remoteControl: worker ? false : (req.remoteControl ?? this.carriedRemoteControl(req)),
      ...(remote ? { remote: remoteWait() } : {}),
      since: identity.spawnedAt,
      sessionId: identity.sessionId,
      inboxThrough: this.inboxCursor(subject.name),
      ...(req.reason === undefined ? {} : { reason: req.reason }),
    }
    this.pending.set(subject.agentId, entry)
    logEvent('teleport_started', {
      name: subject.name,
      from: subject.agentId,
      to: descendantId,
      ...(req.reason === undefined ? {} : { reason: req.reason }),
    })

    const warnings = this.warningsFor(identity, subject.name)
    const result: TeleportOutcome = {
      ok: true,
      name: subject.name,
      agentId: descendantId,
      ...(warnings.length > 0 ? { warnings } : {}),
      ...(remote ? { remote: true } : {}),
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

  /** CC-863: the handoff is already stored when this runs, so a failed read drops the cursor and never the teleport. */
  private inboxCursor(name: string): string | undefined {
    try {
      return this.core.events.inboxFor(name, 1)[0]?.msgId
    } catch (err) {
      logEvent('teleport_inbox_cursor_failed', { name, error: (err as Error).message })
      return undefined
    }
  }

  /** CC-883: a coordinator seat runs with Remote Control (10-06 plan D6); anyone else keeps what it launched with. */
  private carriedRemoteControl(req: TeleportRequest): boolean {
    if (readSeatFile(this.seatTeleport.autonomyRoot, req.subject.name) !== undefined) return true
    return req.remoteControlSeen ?? this.predecessorRemoteControl(req.subject)
  }

  /** Read now, while the predecessor is still running: once it ends there is no argv left to read. */
  private predecessorRemoteControl(subject: TeleportSubject): boolean {
    if (onAnotherHost(subject)) return false
    const found = hostRemoteControl(subject.hostPid, this.readArgv)
    if (found === undefined)
      logEvent('teleport_remote_control_unknown', {
        name: subject.name,
        reason: `could not read the argv of pid ${subject.hostPid}; successor starts without Remote Control`,
      })
    return found ?? false
  }

  /**
   * CC-880: a teleport this broker cannot finish is refused up front, to the caller and to the
   * human, because failing after the predecessor ended is silent and leaves nobody in the session.
   */
  private cannotComplete(subject: TeleportSubject, why: string): { ok: false; reason: string } {
    const reason = `teleport cannot be completed: ${why}. ${subject.name} was not ended.`
    this.core.append({
      kind: 'notice',
      actor: 'agent-chat',
      target: HUMAN,
      body: `${subject.name} asked to teleport and the broker refused: ${why}`,
    })
    logEvent('teleport_refused', { name: subject.name, reason: why })
    return { ok: false, reason }
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

    // CC-881: a reported other host runs its own relaunch; an unreported one cannot, so it is refused.
    if (subject.host === undefined) return this.cannotComplete(subject, hostReason(subject)).reason

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
      // The transcript is under the session's OWN config dir, which for a session
      // on a dedicated account is not the broker's: without it the model could not
      // be observed and every teleport of such a session silently fell back to the
      // harness default (CC-100).
      const observed = observedModel(subject.cwd, identity.sessionId, accountOf(subject, identity))
      const inherited = inheritedProfile(model ?? observed)
      return { profile: inherited, surface: resolveSurface(inherited.surface) }
    }
    const profile = loadProfile(identity.profile)
    if ('error' in profile) return { error: `cannot reload profile "${identity.profile}": ${profile.error}` }
    return {
      profile: model === undefined ? profile : { ...profile, model },
      surface: resolveSurface(isSurfaceName(identity.surface) ? identity.surface : profile.surface),
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
      ...this.wrapWarning(identity, name),
    ]
  }

  /**
   * CC-524: a wrap records what the session knew when it ran, so a report that arrived later is in no record.
   * The handoff is already stored when this runs, so a failed read drops the warning and never the teleport.
   */
  private wrapWarning(identity: AgentIdentity, name: string): string[] {
    const gap = this.wrapGap(identity, name)
    if (gap === undefined) return []
    return [
      `${gap.reports} agent report(s) arrived after your last active-work wrap ` +
        `(${new Date(gap.wrapAt).toISOString()}), so no session record holds them. Your successor ` +
        'is told the count, not what they said.',
    ]
  }

  private wrapGap(identity: AgentIdentity, name: string): WrapGap | undefined {
    try {
      return reportsSinceWrap(this.core.agents, this.core.events, { name, sessionId: identity.sessionId })
    } catch (err) {
      logEvent('teleport_wrap_check_failed', { name, error: (err as Error).message })
      return undefined
    }
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
      entry.remote?.answer({ ok: false, reason: 'the human aborted this teleport' })
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
    if (entry.remote !== undefined) return this.finishRemote(entry, entry.remote)

    this.core.append({ kind: 'agent_stood_down', actor: subject.name, ref: agentId })
    // Non-null because `preflight` refuses a subject without one, and a pending
    // entry only exists once preflight has passed.
    const ended = this.host.endSession(subject.name, subject.hostPid as number, subject.host)
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
      const paneFree = subject.anchor !== undefined && (await this.waitForPaneFree(subject))
      await this.host.relaunch(this.relaunchFor(entry, paneFree, await this.briefFor(entry)))
      logEvent('teleport_completed', { name: subject.name, from: agentId, to: entry.descendantId })
    } catch (err) {
      if (err instanceof SuccessorNotStarted) return
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

  /** CC-881: the plan a remote caller waits on; refused when this session is not teleporting from another host. */
  remotePlan(agentId: string): Promise<RemotePlanReply> {
    const remote = this.pending.get(agentId)?.remote
    if (remote === undefined)
      return Promise.resolve({
        ok: false,
        reason: 'no teleport from another host is pending for this session',
      })
    return remote.plan
  }

  /** CC-881: the caller's report, accepted only while a handed-out plan awaits one. */
  remoteLaunched(agentId: string, report: RemoteLaunchReport): { ok: boolean; reason?: string } {
    const entry = this.pending.get(agentId)
    const remote = entry?.remote
    // One winner: the timeout clears `report`, so a late report is refused here and never acted on.
    if (remote?.report === undefined || entry?.descendantId !== report.successor)
      return { ok: false, reason: 'no teleport launch is awaiting a report for that successor' }
    remote.report(report)
    return { ok: true }
  }

  /**
   * CC-913: an armed successor its host could not place, reported with the landing's token by the
   * helper or the caller that armed it. Its row is retired so the name frees. A predecessor not yet
   * retired is kept and told; otherwise nobody is left in the session, so the human is told.
   */
  landFailed(agentId: string, token: string, reason: string): LandFailedReply {
    const landing = this.landings.get(agentId)
    if (landing === undefined || !sameToken(landing.token, token))
      return { ok: false, reason: 'no armed teleport landing matches that successor and token' }
    this.closeLanding(agentId)
    const successor = this.core.agents.get(agentId)
    if (successor === undefined || successor.state !== 'spawning')
      return { ok: false, reason: 'that successor already registered, so it did start' }
    const said = reason.slice(0, LAND_REASON_MAX)
    const { entry } = landing
    const { name } = entry.subject
    this.core.append({
      kind: 'agent_retired',
      actor: 'agent-chat',
      target: name,
      ref: agentId,
      body: `teleport successor not placed on its caller's host: ${said}`,
    })
    logEvent('teleport_failed', { name, from: entry.subject.agentId, reason: said, remote: true })
    const predecessorLive = this.pending.get(entry.subject.agentId) === entry
    if (predecessorLive) {
      entry.landFailed = true
      this.tell(name, `Your teleport did not happen: ${said}. You are still live, on the old build.`)
    } else this.noticeUnplaced(name, said)
    return { ok: true, predecessorLive }
  }

  private noticeUnplaced(name: string, reason: string): void {
    this.core.append({
      kind: 'notice',
      actor: 'agent-chat',
      target: HUMAN,
      body: `${name} shut down for a teleport and its successor failed to start: ${reason}`,
    })
  }

  private openLanding(entry: Pending, token: string): void {
    const timer = setTimeout(() => this.landings.delete(entry.descendantId), LAND_WINDOW_MS)
    timer.unref?.()
    this.landings.set(entry.descendantId, { token, entry, timer })
  }

  private closeLanding(agentId: string): void {
    const landing = this.landings.get(agentId)
    if (landing === undefined) return
    clearTimeout(landing.timer)
    this.landings.delete(agentId)
  }

  /**
   * CC-881: the broker can neither signal nor open a terminal on another host, so it records the
   * successor, hands its launch to the caller and waits for the report. The predecessor stands
   * down only once its host says the successor launched; anything else releases the successor.
   */
  private async finishRemote(entry: Pending, remote: RemoteWait): Promise<void> {
    const { subject } = entry
    let input: RelaunchInput
    let launch: RemoteLaunch
    try {
      input = this.relaunchFor(entry, false, await this.briefFor(entry))
      launch = { ...this.host.prepareRemoteRelaunch(input), landToken: randomUUID() }
    } catch (err) {
      return this.remoteFailed(entry, undefined, (err as Error).message)
    }
    const report = await this.awaitReport(remote, launch)
    if (!report.ok) return this.remoteFailed(entry, input, report.reason ?? 'no reason given')
    this.host.confirmRemoteRelaunch(input)
    this.openLanding(entry, launch.landToken as string)
    this.core.append({ kind: 'agent_stood_down', actor: subject.name, ref: subject.agentId })
    await this.waitForNameFree(subject.name)
    if (entry.landFailed === true) return void this.pending.delete(subject.agentId)
    this.core.append({
      kind: 'agent_retired',
      actor: 'agent-chat',
      target: subject.name,
      ref: subject.agentId,
      body: 'superseded by teleport',
    })
    this.pending.delete(subject.agentId)
    logEvent('teleport_completed', {
      name: subject.name,
      from: subject.agentId,
      to: entry.descendantId,
      remote: true,
    })
  }

  private awaitReport(remote: RemoteWait, launch: RemoteLaunch): Promise<LaunchOutcome> {
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        delete remote.report
        resolve({
          ok: false,
          reason: `its host did not report a launch within ${REMOTE_LAUNCH_TIMEOUT_MS / 1000}s`,
        })
      }, REMOTE_LAUNCH_TIMEOUT_MS)
      timer.unref?.()
      remote.report = report => {
        clearTimeout(timer)
        delete remote.report
        resolve(report)
      }
      remote.answer({ ok: true, launch })
    })
  }

  /** Fail closed: the predecessor was never signalled, so it is told it is still live and may try again. */
  private remoteFailed(entry: Pending, input: RelaunchInput | undefined, reason: string): void {
    const { subject } = entry
    this.pending.delete(subject.agentId)
    entry.remote?.answer({ ok: false, reason })
    if (input !== undefined) this.host.releaseRemoteRelaunch(input, reason)
    this.tell(
      subject.name,
      `Your teleport did not happen: ${reason}. You are still live, on the old build, and your successor was released.`,
    )
    logEvent('teleport_failed', { name: subject.name, from: subject.agentId, reason, remote: true })
  }

  /** `paneFree` false keeps the anchor but opens beside it: typing into a pane the predecessor still holds reaches its prompt. */
  private relaunchFor(entry: Pending, paneFree: boolean, brief: string): RelaunchInput {
    const { subject } = entry
    const previous = this.core.agents.spawnMeta(subject.agentId)
    const generation = Number.parseInt(previous.generation ?? '1', 10)
    // Same rule as `accountOf`, against the row rather than the folded identity:
    // what the predecessor is observably on, then what it was launched on.
    const configDir = subject.configDir ?? previous.config_dir
    const unset = subject.configDir === undefined && previous.config_dir_unset === 'true'
    return {
      agentId: entry.descendantId,
      name: subject.name,
      profile: entry.profile,
      brief,
      cwd: entry.inherited?.allocation.cwd ?? subject.cwd,
      surface: entry.surface,
      preamble: TELEPORT_PREAMBLE,
      meta: {
        // Succession is not branching: DEPTH IS INHERITED, NOT INCREMENTED. The
        // obvious implementation reuses the ordinary parent path, and then a
        // long-running agent loses the ability to pick up its own improvements
        // precisely because it has run long enough to need it.
        depth: previous.depth ?? '1',
        role: recordedRole(previous),
        coordinator_depth: previous.coordinator_depth ?? previous.depth ?? '1',
        parent: previous.parent ?? '',
        origin: previous.origin === 'adopted' ? 'adopted' : 'spawned',
        teleport_from: subject.agentId,
        generation: String((Number.isFinite(generation) ? generation : 1) + 1),
      },
      ...(configDir ? { configDir } : {}),
      ...(unset ? { configDirUnset: true } : {}),
      ...(entry.remoteControl ? { remoteControl: true } : {}),
      ...(subject.tags.length > 0 ? { tags: subject.tags } : {}),
      ...(subject.subscriptions.length > 0 ? { subscriptions: subject.subscriptions } : {}),
      ...(subject.anchor === undefined ? {} : { anchor: subject.anchor }),
      ...(paneFree ? { reuseAnchor: true } : {}),
      ...(entry.inherited === undefined ? {} : { inherited: entry.inherited }),
      ...(entry.inherited === undefined ? {} : { inheritedFrom: subject.agentId }),
    }
  }

  /**
   * CC-524: the handoff, then what the broker knows that the handoff may have left out.
   * This runs after the predecessor stood down, so a failed read costs the appendix and never the successor.
   */
  private async briefFor(entry: Pending): Promise<string> {
    const own = entry.reason === 'park' ? `${PARK_LINE}\n\n${entry.handoff}` : entry.handoff
    const seat = await this.seatHandoff(entry)
    const handoff = seat === undefined ? own : `${seat}\n\nYour predecessor's handoff:\n\n${own}`
    try {
      const facts = appendixFacts(this.core.agents, this.core.events, {
        name: entry.subject.name,
        since: entry.since,
        sessionId: entry.sessionId,
      })
      return `${handoff}\n\n${renderAppendix(facts)}`
    } catch (err) {
      logEvent('teleport_appendix_failed', { name: entry.subject.name, error: (err as Error).message })
      return handoff
    }
  }

  /**
   * CC-863: for a seat, append its `State at teleport N` (or keep the one it wrote this session)
   * and render the handoff that boots from it. Undefined for any other name, and on a failed
   * write, which costs the block and never the successor.
   */
  private async seatHandoff(entry: Pending): Promise<string | undefined> {
    const seat = entry.subject.name
    try {
      const written = await writeTeleportState(this.seatTeleport, {
        seat,
        running: runningSpawnedBy(this.core.agents, seat),
        inboxThrough: entry.inboxThrough,
        sessionStart: entry.since,
      })
      if (written === undefined) return undefined
      const { autonomyRoot: root, now } = this.seatTeleport
      const found = latestTeleportSection(root, seat, now())
      const { after, cursorMissing } = written
      return renderTeleportHandoff({ root, seat, found, after, cursorMissing })
    } catch (err) {
      logEvent('teleport_seat_state_failed', { name: seat, error: (err as Error).message })
      return undefined
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

  /** CC-402: a command typed while the predecessor still owns the pane is swallowed, so wait for its pid to exit. */
  private async waitForPaneFree(subject: TeleportSubject): Promise<boolean> {
    const pid = subject.hostPid as number
    const deadline = Date.now() + PANE_EXIT_TIMEOUT_MS
    while (pidAlive(pid)) {
      if (Date.now() >= deadline) {
        logEvent('teleport_pane_held', { name: subject.name, pid, waitedMs: PANE_EXIT_TIMEOUT_MS })
        return false
      }
      await sleep(PANE_EXIT_POLL_MS)
    }
    await sleep(PANE_SETTLE_MS)
    return true
  }

  /** Session ids are minted per descendant, never reused: a teleport is not a resume. */
  static newSessionId(): string {
    return randomUUID()
  }

  close(): void {
    for (const entry of this.pending.values()) if (entry.timer) clearTimeout(entry.timer)
    this.pending.clear()
    for (const agentId of [...this.landings.keys()]) this.closeLanding(agentId)
    this.unwatch()
  }
}
