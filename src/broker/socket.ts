import { AsyncLocalStorage } from 'node:async_hooks'
import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import {
  encode,
  lineReader,
  HUMAN,
  isAnswerChannel,
  isAgentTeleportReason,
  LAUNCH_REASON_MAX,
  launcherOf,
  SURFACE_NAMES,
  type Launcher,
  type ClientMessage,
  type Correlated,
  type DeliveredMessage,
  type HostProbeMissing,
  type ItemShape,
  type PermissionBehavior,
  type ServerMessage,
  type SpawnResultFields,
  type WakeSource,
  wakeSource,
} from '../protocol.js'
import { requestFingerprint, type KeyedFrame } from '../protocol-fingerprint.js'
import { dedupeKey, nonceRefusal, RequestDedupe } from './request-dedupe.js'
import { agentsDir, cliEntry, socketPath } from '../paths.js'
import { logEvent, loggedCount } from './log.js'
import { selfGrantFrameRefusal } from './self-grant-frame.js'
import { integrityFrameRefusal } from './integrity-frame.js'
import { IntegrityLedger } from './integrity-ledger.js'
import { INTEGRITY_MODE } from './integrity-wired.js'
import { verdictReason, wouldDenyWriter, type NoteWouldDeny } from './integrity-shadow.js'
import { INTEGRITY_QUARANTINE, INTEGRITY_WIRED_SINCE } from './event-log.js'
import { SettingsWatch } from './settings-watch.js'
import { sendMeta, sendMetaRefusal } from './send-meta.js'
import { type Escalation, type IdentityBinding, type RouteResult } from './registry.js'
import { sanitizeCarried, type CarriedFlags } from './host-channels.js'
import {
  BrokerCore,
  readoptRegistration,
  type Conn,
  type EndorseApproval,
  type VerdictResult,
} from './core.js'
import type { OpenApproval } from './event-store.js'
import { recoverHandoff, returningSession } from './handoff-recovery.js'
import type { SlotUsage } from '../agents/semaphore.js'
import { viewRoster } from '../agents/roster-filter.js'
import {
  Supervisor,
  type SpawnOutcome,
  type SpawnRequest,
  type SupervisorOptions,
} from '../agents/supervisor.js'
import { asPlatform } from '../agents/teleport-config.js'
import { refused, type RefusalStage, type TeleportOutcome, type TeleportSubject } from '../agents/teleport.js'
import { gather, LifecycleVerifier } from '../agents/ledger/verifier.js'
import type { HttpAppOptions } from './http.js'
import type { SwitchOutcome } from '../agents/mode-switch.js'
import { SystemEventFeed } from './subscriptions.js'
import { nextWatchCursor } from './watch-cursor.js'
import { newestBuildMtime, stalenessWarning } from './staleness.js'
import { findGitRoot } from '../git.js'
import { resolveSpawnCwd } from './spawn-default-cwd.js'
import { readMeta } from './lifecycle.js'
import { knownMachineAliases } from '../agents/machine-registry.js'
import { resolveDeciderAgentId, resolveHostProofMode } from '../config.js'
import { shapeMeta } from '../inbox/item-shape.js'
import { fileServiceAsk } from './service-ask.js'
import { PERMISSION_WAITING, permissionNoticeText } from './permission-notice.js'
import { brokerHost } from './host-guard.js'
import {
  claudeCodeAncestorOf,
  humanProofGap,
  linuxPeerPorts,
  provePeerLocal,
  type PeerPorts,
} from './peer-locality.js'
import { HostDirectory, type LauncherHello } from './host-directory.js'
import { brokerKeyFor, proofMatches } from './launcher-key.js'
import { jobKickRequest, type JobKick } from './job-kick.js'
import { noticeWakeCapped } from './codex-wake-cap.js'
import { DeclaredCallers, declaredIdOf, resolveDeclared, type Caller } from './declared-callers.js'
import { class2RequesterOf, isRefusal, type Class2Asker, type Class2Requester } from './class2-requester.js'
import { classOf } from './frame-classes.js'

/**
 * Ceiling on one `inbox_since` read, so a watcher arming against an old cursor
 * pulls a stranded session's backlog in ordered batches instead of one burst.
 * The caller keeps polling, so nothing is lost — it just arrives in order.
 */
const WATCH_MAX_BATCH = 50

/**
 * Endorsement requests one session may have waiting at once.
 *
 * Questions have no such budget (CC-1503): the human queue already holds every
 * session's questions together, and a refused question is one the asker carries
 * silently instead. An endorsement differs: each one asks the human to read a
 * whole message word for word and take responsibility for it, which is a more
 * expensive ask than answering a question — and a backlog of them is exactly the
 * condition under which they stop being read carefully and start being
 * rubber-stamped.
 */
const MAX_OPEN_ENDORSEMENTS = 2

/** A path check on the realpath of a broker-owned root, never a match on the text a caller sent. */
function insideDir(candidate: string, root: string): boolean {
  let real = path.resolve(root)
  try {
    real = fs.realpathSync(root)
  } catch {
    // No agents root yet: compare against the path it will have.
  }
  const relative = path.relative(real, path.resolve(candidate))
  const outside = relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
  return !outside
}

/**
 * Files written for another host's broker: the dir lies outside this broker's agents root, and the
 * broker's own entry for the agent is no symlink, so a link out of the root cannot claim it.
 */
function offBrokerDir(agentId: string, dir: string): boolean {
  if (agentId !== path.basename(agentId) || agentId === '.' || agentId === '..') return false
  try {
    if (fs.lstatSync(path.join(agentsDir(), agentId)).isSymbolicLink()) return false
  } catch {
    // No local entry: nothing here to redirect.
  }
  return !insideDir(dir, agentsDir())
}

/** Shepherd names a fix-round successor with `-s<N>`; a caller that sends no marker is still read by it. */
const FIX_ROUND = /-s\d+$/

/** CC-802: the marker the CLI caller sent, else `shepherd` for a fix-round name, else none. */
const spawnedAsOf = (msg: {
  name: string
  spawnedAs?: 'burndown' | 'shepherd'
}): { spawnedAs?: 'burndown' | 'shepherd' } => {
  const claimed = msg.spawnedAs === 'burndown' || msg.spawnedAs === 'shepherd' ? msg.spawnedAs : undefined
  const spawnedAs = claimed ?? (FIX_ROUND.test(msg.name) ? 'shepherd' : undefined)
  return spawnedAs === undefined ? {} : { spawnedAs }
}

/** CC-1466: an allow-listed launcher and its reason, cut to one bounded line; a reason alone is dropped. */
export const launchFieldsOf = (msg: {
  launchedBy?: unknown
  launchReason?: unknown
}): { launchedBy?: Launcher; launchReason?: string } => {
  const launchedBy = launcherOf(msg.launchedBy)
  if (launchedBy === undefined) return {}
  const reason = typeof msg.launchReason === 'string' ? msg.launchReason.replace(/\s+/g, ' ').trim() : ''
  return { launchedBy, ...(reason === '' ? {} : { launchReason: reason.slice(0, LAUNCH_REASON_MAX) }) }
}

/**
 * The request being handled, carried across its awaits (CC-1343), so every one of
 * the reply sites echoes its id without threading it through each handler. Only a
 * reply to the requesting connection carries it; a frame to another one does not.
 */
const requestScope = new AsyncLocalStorage<{
  conn: Conn
  rid?: number
  /** CC-1454: a keyed request's nonce, and the hook that keeps its reply for a retry. */
  nonce?: string
  record?: (message: ServerMessage) => void
}>()

const reply = (conn: Conn, message: ServerMessage): void => {
  const scope = requestScope.getStore()
  if (scope?.conn !== conn) return void conn.write(encode(message))
  conn.write(encode(scope.rid === undefined ? message : { ...message, rid: scope.rid }))
  scope.record?.(message)
}

/** A verdict from a non-socket human channel (TP-1989: `owner-console`) names it on the row it writes. */
const auditMeta = (channel: string | undefined): { meta?: { channel: string } } =>
  channel === undefined ? {} : { meta: { channel } }

type KeyedReply = Extract<ServerMessage, { t: 'send_result' | 'spawn_result' }>
interface KeyedJoiner {
  conn: Conn
  rid?: number
}
const KEYED_REPLY = { send: 'send_result', resume: 'spawn_result' } as const

const keyedRefusal = (verb: KeyedFrame['t'], reason: string): KeyedReply =>
  verb === 'send'
    ? { t: 'send_result', ok: false, recipients: [], reason }
    : { t: 'spawn_result', ok: false, reason }

/** A retry gets the first request's reply under its own rid, marked so it is not read as a second action. */
const answerKeyed = (joiner: KeyedJoiner, message: KeyedReply): void => {
  const deduped = { ...message, deduped: true }
  joiner.conn.write(encode(joiner.rid === undefined ? deduped : { ...deduped, rid: joiner.rid }))
}

/** CC-320: the sender learns the message waits for the seat, so it neither resends nor reads it as delivered. */
const replyHeld = (conn: Conn, to: string, msgId: string): void => {
  const reason =
    `"${to}" has no active session. The message is held and will be pushed when it registers; ` +
    'it has not been delivered or read, so do not resend it.'
  reply(conn, {
    t: 'send_result',
    ok: true,
    held: true,
    msgId,
    recipients: [to],
    results: [{ name: to, status: 'held', reason }],
    reason,
  })
}

/**
 * CC-1455: the route row's `delivered` says whether any recipient will see the push, not just that
 * one was resolved. A print-mode host takes the row but never shows it, so it counts for nothing;
 * one that spools it for its inbox hook is named in `queued`, still not delivered yet.
 */
const routeDelivery = (
  result: RouteResult<Conn>,
): { delivered: boolean; reason?: string; unwoken?: string[]; queued?: string[] } => {
  const named = (status: string): string[] => result.results.filter(r => r.status === status).map(r => r.name)
  const unwoken = named('headless_no_channel')
  const queued = named('queued')
  const delivered = result.ok && result.recipients.length > unwoken.length + queued.length
  const spooled = queued.length === 0 ? {} : { queued }
  if (unwoken.length === 0) return { delivered, ...spooled }
  return result.recipients.length === 1
    ? { delivered, reason: 'headless_no_channel' }
    : { delivered, unwoken, ...spooled }
}

/** CC-1501: the sender learns the message for a non-resident seat went to the owner queue. */
const replyQueuedForSeat = (conn: Conn, to: string, msgId: string): void => {
  const reason = `"${to}" has no resident session; the message went to the owner queue.`
  reply(conn, {
    t: 'send_result',
    ok: true,
    msgId,
    recipients: [HUMAN],
    results: [{ name: HUMAN, status: 'delivered', reason }],
    reason,
  })
}

/**
 * Frames that only a registered session can mean anything by (CC-83).
 *
 * Named explicitly rather than derived from "is this connection registered",
 * because an UNREGISTERED connection is the normal shape of the human at the CLI
 * — `admits` takes the human to be a connection with no name. A blanket check would fire
 * on every ordinary CLI command. Each frame here already refuses when there is no
 * name behind it; the list only says which refusals mean "you should have had a
 * registration", as opposed to "the human may not do this".
 *
 * The human's own frames — `human_send`, `answer`, `dismiss`, `endorse_approve`,
 * `approve_permission`, `queue`, `teleport_abort` — are deliberately absent, and
 * must stay absent.
 */
const SESSION_FRAMES: ReadonlySet<ClientMessage['t']> = new Set([
  'send',
  'broadcast',
  'ask',
  'notify',
  'endorse',
  'subscribe',
  'unsubscribe',
  'tag',
  'claim',
  'release',
  'status',
  'approval',
  'decided',
])

/** A blocked PermissionRequest hook (CC-144): the connection its verdict goes back on, and who it asked for. */
interface HookWait {
  conn: Conn
  session: string
}

/** A directed send's reply ref and CC-168 row meta, carried through its hold and forward paths. */
interface SendExtras {
  inReplyTo?: string | undefined
  meta?: Record<string, string> | undefined
}

/** What a routed send's rows carry beyond the message itself. */
interface RouteExtras {
  tag?: string
  meta?: Record<string, string> | undefined
}

/** The body a hook row closes with when nobody answered it; the mirror renders it as expired at the agent. */
const HOOK_WITHDRAWN = 'withdrawn'

/**
 * The transport half of `BrokerCore`'s injected `deliver`. Exported because
 * `daemon.ts` is what composes a core with this server — the core must stay free
 * of socket I/O for the same reason the HTTP layer must: one write path, several
 * transports.
 */
export const deliver = (conn: Conn, message: DeliveredMessage): boolean => {
  if (conn.destroyed || conn.writableEnded) return false
  reply(conn, { t: 'deliver', message })
  return true
}

/** Both switch directions answer on one frame, so they serialise it the same way. */
const replySwitch = (conn: Conn, outcome: SwitchOutcome): void => {
  reply(conn, {
    t: 'switch_result',
    ok: outcome.ok,
    ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
    ...(outcome.name === undefined ? {} : { name: outcome.name }),
    ...(outcome.agentId === undefined ? {} : { agentId: outcome.agentId }),
    ...(outcome.surface === undefined ? {} : { surface: outcome.surface }),
    ...(outcome.warnings === undefined ? {} : { warnings: outcome.warnings }),
  })
}

const replyTeleport = (conn: Conn, outcome: TeleportOutcome): void =>
  reply(conn, {
    t: 'teleport_result',
    ok: outcome.ok,
    ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
    ...(outcome.name === undefined ? {} : { name: outcome.name }),
    ...(outcome.agentId === undefined ? {} : { agentId: outcome.agentId }),
    ...(outcome.countdownMs === undefined ? {} : { countdownMs: outcome.countdownMs }),
    ...(outcome.warnings === undefined ? {} : { warnings: outcome.warnings }),
    ...(outcome.remote === undefined ? {} : { remote: outcome.remote }),
    ...(outcome.placement === undefined ? {} : { placement: outcome.placement }),
  })

const optionalHost = (host: string | undefined): { host?: string } => (host === undefined ? {} : { host })
const optionalCallerHost = (callerHost: string | undefined): { callerHost?: string } =>
  callerHost === undefined ? {} : { callerHost }
/** CC-1614: read from the requester's own entry, never from a frame. */
const requesterBindingOf = (entry: Class2Requester | undefined): { requesterBinding?: IdentityBinding } =>
  entry?.binding === undefined ? {} : { requesterBinding: entry.binding }
/** CC-1059: a launch report's verdict, with only a string reason kept. */
const reportOf = (msg: { ok: unknown; reason?: unknown }): { ok: boolean; reason?: string } => ({
  ok: msg.ok === true,
  ...(typeof msg.reason === 'string' ? { reason: msg.reason } : {}),
})
const optionalCarried = (launchSeen: CarriedFlags | undefined): { launchSeen?: CarriedFlags } =>
  launchSeen === undefined ? {} : { launchSeen }

/** CC-951: a hello's fields come off the wire, so each is checked rather than trusted to be typed. */
function launcherHello(
  msg: Extract<ClientMessage, { t: 'host_hello' }>,
  machines: readonly string[],
): LauncherHello | string {
  if (typeof msg.host !== 'string' || msg.host.trim() === '') return 'host_hello needs a host name'
  const host = msg.host.trim().toLowerCase()
  if (machines.length > 0 && !machines.some(machine => machine.toLowerCase() === host))
    return `${msg.host.trim()} is not one of the configured machines (${machines.join(', ')})`
  const platform = asPlatform(msg.platform)
  if (platform === undefined) return `unknown platform "${String(msg.platform)}"`
  const offered: unknown[] = Array.isArray(msg.surfaces) ? msg.surfaces : []
  const surfaces = SURFACE_NAMES.filter(surface => offered.includes(surface))
  // CC-1646: kept only as an absolute path; teleport checks it lexically and the launcher on its own disk.
  const landing = typeof msg.landing === 'string' && path.isAbsolute(msg.landing) ? msg.landing : undefined
  return { host: msg.host.trim(), platform, surfaces, ...(landing === undefined ? {} : { landing }) }
}

/** CC-1646: a probe's missing path, kept only when it names one, so a garbled one reads as none. */
const missingOf = (msg: object): { missing?: HostProbeMissing } => {
  const missing = (msg as { missing?: unknown }).missing
  return missing === 'cwd' || missing === 'configDir' ? { missing } : {}
}

/**
 * CC-1063: why a hello's proof does not let it hold `host`, or undefined when it does. Every host
 * needs its broker key and a proof over this connection's nonce, connected holder or not, and with no
 * broker key it fails closed (CC-1317); `machines` only bounds which names may be announced.
 */
export function proofRefusal(
  host: string,
  proof: unknown,
  nonce: string | undefined,
  keyFor: (host: string) => string | null,
): string | undefined {
  const key = keyFor(host)
  if (key === null)
    return `no launcher key for ${host} on the broker; provision the launcher key (CC-1063 slice d)`
  if (nonce === undefined) return `no valid launcher proof for ${host}: send host_challenge first`
  return proofMatches(key, host, nonce, proof) ? undefined : `no valid launcher proof for ${host}`
}

const optionalPlatform = (hostPlatform: NodeJS.Platform | undefined): { hostPlatform?: NodeJS.Platform } =>
  hostPlatform === undefined ? {} : { hostPlatform }

const nonBlank = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined

/** CC-1666: the router's inputs, trimmed; a blank one is no input, as the MCP tool's `present()` reads it. */
function routeFields(msg: { slice?: unknown; routeOverride?: unknown }): {
  slice?: string
  routeOverride?: string
} {
  const slice = nonBlank(msg.slice)
  const routeOverride = nonBlank(msg.routeOverride)
  return {
    ...(slice === undefined ? {} : { slice }),
    ...(routeOverride === undefined ? {} : { routeOverride }),
  }
}

/** CC-1206: a real agent name or id is far shorter; the cap keeps a claim from bloating the row. */
export const CALLER_AGENT_MAX = 64

/** CC-1206: a claimed caller with control and format characters stripped, trimmed and capped; blank is none. */
export const sanitizeCallerAgent = (value: unknown): string | undefined =>
  nonBlank(typeof value === 'string' ? value.replace(/[\p{Cc}\p{Cf}]/gu, '') : undefined)?.slice(
    0,
    CALLER_AGENT_MAX,
  )

/**
 * CC-1206: the agent behind an unregistered spawn, from the CLI's env claim, else from a Claude
 * Code ancestor of the socket peer. It only ever lowers trust, so its absence proves no human:
 * `env -u AGENT_CHAT_NAME` drops the claim, and a caller detached from its own tree (`setsid`,
 * `nohup … &`, `tmux new -d`, `systemd-run --user`) or a raw socket write from such a process has
 * no Claude Code ancestor. So CC-1246 adds positive proof: with no agent found, the spawn is the
 * human's only when `humanProofGap` finds none, and otherwise carries the gap as `humanUnproven`.
 */
const callerAgentOf = (
  conn: Conn,
  msg: { callerAgent?: unknown },
  peer: PeerPorts,
): Pick<SpawnRequest, 'callerAgent' | 'humanUnproven'> => {
  const claimed = sanitizeCallerAgent(msg.callerAgent)
  if (claimed !== undefined) return { callerAgent: claimed }
  const peerPid = peer.peerPid(conn)
  const agent = claudeCodeAncestorOf(peerPid, peer)
  if (agent !== undefined) return { callerAgent: `claude-code:${agent}` }
  const gap = humanProofGap(peerPid, peer)
  return gap === undefined ? {} : { humanUnproven: gap }
}

/** CC-1472: a launcher's transcript verdict, kept only when well formed, so a garbled one reads as none. */
const transcriptVerdictOf = (msg: object): { transcript?: { path: string; found: boolean } } => {
  const verdict = (msg as { transcript?: { path?: unknown; found?: unknown } | null }).transcript
  if (typeof verdict?.path !== 'string' || typeof verdict.found !== 'boolean') return {}
  return { transcript: { path: verdict.path, found: verdict.found } }
}

/** CC-1059: the spawn frame's launch-site fields, each dropped unless well formed. */
const spawnSiteFields = (
  msg: Extract<ClientMessage, { t: 'spawn' }>,
): Pick<SpawnRequest, 'hostPlatform' | 'launchesHere' | 'host' | 'callerHome'> => {
  const host = nonBlank(msg.host)
  const callerHome = nonBlank(msg.callerHome)
  return {
    ...optionalPlatform(asPlatform(msg.hostPlatform)),
    ...(msg.launchesHere === true ? { launchesHere: true } : {}),
    ...(host === undefined ? {} : { host }),
    ...(callerHome === undefined ? {} : { callerHome }),
  }
}

/** A spawn outcome on the wire, for `spawn_result` and a remote spawn's `spawn_placed_result` alike. */
const spawnResultFields = (outcome: SpawnOutcome, warnings: readonly string[] = []): SpawnResultFields => ({
  ok: outcome.ok,
  ...(outcome.agentId === undefined ? {} : { agentId: outcome.agentId }),
  ...(outcome.name === undefined ? {} : { name: outcome.name }),
  ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
  ...(outcome.code === undefined ? {} : { code: outcome.code }),
  ...(outcome.retryable === undefined ? {} : { retryable: outcome.retryable }),
  ...(warnings.length === 0 ? {} : { warnings: [...warnings] }),
  ...(outcome.disallowedTools === undefined ? {} : { disallowedTools: outcome.disallowedTools }),
  ...(outcome.transcript === undefined ? {} : { transcript: outcome.transcript }),
  ...(outcome.base === undefined ? {} : { base: outcome.base }),
  ...(outcome.launch === undefined ? {} : { launch: outcome.launch }),
  ...(outcome.host === undefined ? {} : { host: outcome.host }),
  ...(outcome.account === undefined ? {} : { account: outcome.account }),
})

/**
 * The socket transport. Everything here is about turning bytes into `core`
 * calls and results back into bytes; all state and every write to the log lives
 * in `BrokerCore`.
 */
export class SocketServer {
  private readonly supervisor: Supervisor
  private readonly feed: SystemEventFeed<Conn>
  private readonly unwatch: () => void
  private readonly verifier: LifecycleVerifier | undefined
  /** Open hook rows by msg_id. Memory only: a restart drops every hook connection, so none can outlive it. */
  private readonly hooks = new Map<string, HookWait>()
  /** Each connection's open service asks, for the per-connection cap; dies with the connection. */
  private readonly serviceAsks = new WeakMap<Conn, Set<string>>()
  /** CC-951: connected host launchers, each dropped with its connection. */
  private readonly hosts = new HostDirectory<Conn>()
  /** CC-1059: each pending remote spawn's requesting connection, the only one that may report on it. */
  private readonly remoteSpawners = new Map<string, Conn>()
  /** CC-1138: the agent id each connection's `hello` declared; `admits` gates Class 1 and 3 frames on it. */
  private readonly declared = new DeclaredCallers<Conn>()
  /** CC-1454: keyed sends and resumes by requester and nonce. Memory only: a restart forgets them. */
  private readonly dedupe = new RequestDedupe<KeyedJoiner, KeyedReply>()
  /** CC-1151: runs a kicked job in the broker's env; unset until the daemon attaches it. */
  private jobKick: JobKick | undefined
  /** TP-4256: agent principals, launch nonces and their baselines. Memory only, so a restart forgets them all. */
  readonly integrity = new IntegrityLedger((agentId, mismatch) => this.noticeQuarantine(agentId, mismatch))
  /** TP-4256 A5: re-hashes the launch files the broker wrote, on every check and on a timer. */
  readonly settingsWatch: SettingsWatch = this.integrity.watch
  /** TP-4347: set only in `shadow`, where every refusal the ledger would make is written here instead. */
  private readonly wouldDeny: NoteWouldDeny | undefined

  /** `ledgerDb` is the shadow ledger's connection, passed only while `ledgerShadow` is on. */
  constructor(
    private readonly core: BrokerCore,
    supervisorOptions: SupervisorOptions = {},
    ledgerDb?: DatabaseSync,
    private readonly peer: PeerPorts = linuxPeerPorts,
  ) {
    this.feed = new SystemEventFeed<Conn>(
      core.registry,
      (conn, events) => reply(conn, { t: 'system_events', events }),
      undefined,
      (agentId, exit, later) => core.reportedSpawner(agentId, exit, later),
    )
    // Fed from the single write path, so a subscriber sees exactly what the log
    // recorded rather than a second notion of what happened.
    this.unwatch = core.onAppend(row => this.feed.offer(row))
    // The broker owns the supervisor, not the requesting session: an agent must
    // outlive whoever asked for it, and the semaphore and depth cap need exactly
    // one enforcement point. The anchor comes from the requester's OWN registry
    // entry, so nobody can spawn into a pane they do not hold.
    this.wouldDeny =
      INTEGRITY_MODE === 'shadow'
        ? wouldDenyWriter(
            input => core.append(input),
            agentId => core.agents.get(agentId)?.name,
          )
        : undefined
    this.supervisor = new Supervisor(core, {
      ...supervisorOptions,
      hosts: this.hosts,
      ...(INTEGRITY_MODE === 'off' ? {} : { integrity: this.integrity }),
      ...(this.wouldDeny === undefined ? {} : { wouldDeny: this.wouldDeny }),
    })
    this.verifier = ledgerDb && this.lifecycleVerifier(ledgerDb, supervisorOptions.ledger)
    if (INTEGRITY_MODE !== 'off') this.markIntegrityWired()
    this.closeOrphanedHookRows()
    this.settingsWatch.start()
  }

  /**
   * TP-4341: written once, at the first start that arms launches, `shadow` included: a launch it
   * armed and an agent later stripped of its nonce must not pass as unarmed at the `enforce` start.
   * A launch unarmed before it was written by an unwired broker; one changed at or after it had its
   * nonce stripped.
   */
  private markIntegrityWired(): void {
    if (this.core.events.integrityWiredSince() !== undefined) return
    this.core.append({
      kind: 'notice',
      actor: 'agent-chat',
      target: 'agent-chat',
      body: 'the integrity ledger is wired from here on',
      meta: { event: INTEGRITY_WIRED_SINCE },
    })
  }

  attachJobKick(port: JobKick): void {
    this.jobKick = port
  }

  /**
   * CC-1151, Class 4: accepted from any connection, since it grants nothing the timers do not already do. The
   * request is rebuilt from `job` and `seat` alone, so nothing else the caller put on the frame reaches the job.
   */
  private handleJobKick(conn: Conn, msg: Extract<ClientMessage, { t: 'job_kick' }>): void {
    const request = jobKickRequest(msg)
    if (typeof request === 'string') return reply(conn, { t: 'job_kick_result', ok: false, detail: request })
    if (this.jobKick === undefined)
      return reply(conn, { t: 'job_kick_result', ok: false, detail: 'this broker runs no kicked jobs' })
    reply(conn, { t: 'job_kick_result', ...this.jobKick(request) })
  }

  /** Hook rows open at boot belong to connections the previous broker held; nothing can answer them now. */
  private closeOrphanedHookRows(): void {
    for (const item of this.core.events.humanQueue()) {
      if (item.kind !== 'approval_request' || item.meta.source !== 'hook') continue
      this.core.append({
        kind: 'resolution',
        actor: item.from,
        ref: item.msgId,
        body: HOOK_WITHDRAWN,
        meta: { reason: 'broker restarted' },
      })
    }
  }

  private lifecycleVerifier(db: DatabaseSync, ledger: SupervisorOptions['ledger']): LifecycleVerifier {
    const broker = {
      liveIds: () => this.supervisor.liveIds(),
      slotIds: () => this.supervisor.slotIds(),
      bootAt: this.core.startedAt,
    }
    return new LifecycleVerifier({
      gather: () => gather({ db, events: this.core.events, broker }),
      shadowErrors: () => loggedCount('ledger_shadow_error'),
      ...(ledger === undefined ? {} : { renew: () => ledger.renewIfDue() }),
    })
  }

  /** Called once the socket is listening; a no-op while the ledger shadow is off. */
  startLifecycleVerifier(): void {
    this.verifier?.start()
  }

  /** CC-1669 S2: called once the socket is listening; `close` stops it with the supervisor. */
  startIdlePrintWake(): void {
    this.supervisor.startIdlePrintWake()
  }

  /** CC-1671 S1: called once the socket is listening; `close` stops it with the supervisor. */
  startFootprintSampling(): void {
    this.supervisor.startFootprintSampling()
  }

  /** CC-1678: called once the socket is listening; `close` stops it with the supervisor. */
  startMergedRetire(): void {
    this.supervisor.startMergedRetire()
  }

  /** `/health` and `/api/lifecycle` readings, absent while the ledger shadow is off. */
  lifecycle(): HttpAppOptions['lifecycle'] {
    const verifier = this.verifier
    return verifier && { summary: () => verifier.summary(), report: () => verifier.run() }
  }

  close(): void {
    this.settingsWatch.stop()
    this.verifier?.stop()
    this.unwatch()
    this.feed.close()
    this.supervisor.close()
  }

  /** For `/health` (CC-139): the broker owns the supervisor, `daemon.ts` does not. */
  slotUsage(): SlotUsage {
    return this.supervisor.slotUsage()
  }

  /** Spawn on behalf of `conn`, resolving its pane anchor from its own entry. */
  private async handleSpawn(conn: Conn, msg: Extract<ClientMessage, { t: 'spawn' }>): Promise<void> {
    // An unregistered connection is the human at the CLI (§6.4) — they spawn
    // without being a session, and the socket is 0600, so reaching it at all
    // already means being the user. They hold no registry entry and therefore no
    // anchor, which §5.4 resolves as the new-window fallback rather than an error.
    const requester = this.class2RequesterOf(conn)
    if (isRefusal(requester)) return reply(conn, { t: 'spawn_result', ok: false, reason: requester.refusal })
    const requestedBy = requester?.name ?? HUMAN
    const anchor = this.core.registry.anchorFor(conn)
    const cwd = resolveSpawnCwd(msg, this.core.registry.cwdFor(conn))
    const observed = this.core.registry.observedFor(conn)
    const spawnerConfigDir = msg.spawnerConfigDir ?? observed?.configDir
    const outcome = await this.supervisor.spawn({
      name: msg.name,
      profile: msg.profile,
      brief: msg.brief,
      requestedBy,
      // The requester's cwd, not the broker's. The broker is autostarted by
      // whichever client happened to connect first, so ITS cwd is an arbitrary
      // repo — spawning without this put an agent in an unrelated checkout.
      ...(cwd === undefined ? {} : { cwd }),
      ...(msg.isolation === undefined ? {} : { isolation: msg.isolation }),
      ...(msg.surface === undefined ? {} : { surface: msg.surface }),
      ...(msg.briefing === undefined ? {} : { briefing: msg.briefing }),
      ...(msg.worktree === undefined ? {} : { worktree: msg.worktree }),
      ...(msg.owns === undefined ? {} : { owns: msg.owns }),
      ...(msg.claimPaths === undefined ? {} : { claimPaths: msg.claimPaths }),
      ...(typeof msg.baseRef === 'string' ? { baseRef: msg.baseRef } : {}),
      // Passed through rather than resolved here: WHOSE conversation a fork
      // copies is decided in the supervisor, from this requester's own registry
      // entry, so the refusals land in the log with every other spawn refusal.
      ...(msg.inherit === undefined ? {} : { inherit: msg.inherit }),
      ...(msg.remoteControl === undefined ? {} : { remoteControl: msg.remoteControl }),
      ...(msg.forkFrom === undefined ? {} : { forkFrom: msg.forkFrom }),
      ...(msg.resumeSession === undefined ? {} : { resumeSession: msg.resumeSession }),
      ...(msg.predecessor === undefined ? {} : { predecessor: msg.predecessor }),
      ...(msg.experiment === undefined ? {} : { experiment: msg.experiment }),
      ...(msg.returnContract === undefined ? {} : { returnContract: msg.returnContract }),
      ...(Number.isInteger(msg.tier) ? { tier: msg.tier } : {}),
      ...this.humanClaims(conn, msg, requestedBy),
      ...(typeof msg.lineageFrom === 'string' ? { lineageFrom: msg.lineageFrom } : {}),
      // A blank task from the CLI is no task, as the MCP tool's `present()` already reads it.
      ...(typeof msg.task === 'string' && msg.task.trim() !== '' ? { task: msg.task.trim() } : {}),
      ...(typeof msg.workRole === 'string' ? { workRole: msg.workRole } : {}),
      ...(msg.override === 'fix-round' ? { override: msg.override } : {}),
      ...routeFields(msg),
      ...(msg.tags === undefined ? {} : { tags: msg.tags }),
      ...(msg.subscriptions === undefined ? {} : { subscriptions: msg.subscriptions }),
      // CC-100. The explicit ask is the request's to make; the spawner's own
      // account is not — it falls back to what this connection REPORTED at
      // registration, which the broker observed rather than took on trust. The
      // frame's copy exists for the human at the CLI, who holds no entry to read.
      ...(msg.configDir === undefined ? {} : { configDir: msg.configDir }),
      ...(typeof msg.account === 'string' && msg.account !== '' ? { account: msg.account } : {}),
      ...(spawnerConfigDir === undefined ? {} : { spawnerConfigDir }),
      // CC-156: an observed Claude session id proves the requester is a session, whose unset var means ~/.claude.
      ...(observed?.claudeSessionId === undefined ? {} : { spawnerIsSession: true }),
      ...(requester?.agentId === undefined ? {} : { parentAgentId: requester.agentId }),
      ...requesterBindingOf(requester),
      ...(anchor === undefined ? {} : { anchor }),
      ...optionalCallerHost(this.callerHostOf(conn, msg)),
      ...spawnSiteFields(msg),
    })
    // Recorded so a `spawned` subscription can find this agent, but no longer
    // subscribed by default (CC-1500): most attach and exit pushes woke a
    // coordinator for nothing. The roster still shows both; a spawner that wants
    // the pushes opts in with chat_subscribe scope "spawned".
    if (outcome.ok && outcome.name !== undefined) this.core.registry.recordSpawn(conn, outcome.name)
    // Spawn is the moment staleness stops being cosmetic: argv is fixed here and
    // now, so an agent launched from an out-of-date broker carries the old
    // behaviour for its whole life, and a later restart cannot correct it. This
    // is the one place the warning has to reach a reader (CC-57).
    const stale = stalenessWarning(readMeta()?.buildMtime, newestBuildMtime())
    const warnings = [...(outcome.warnings ?? []), ...(stale === null ? [] : [stale])]

    // CC-1059: only the connection handed the launch may report on it.
    if (outcome.launch !== undefined && outcome.agentId !== undefined)
      this.remoteSpawners.set(outcome.agentId, conn)
    reply(conn, { t: 'spawn_result', ...spawnResultFields(outcome, warnings) })
  }

  /**
   * CC-1059: the host a spawn's requester runs on. A session's comes from its registration, never
   * its frame; only the CLI, which holds no registration, names its own.
   */
  /**
   * What only an unregistered (HUMAN) connection's frame may set; a registered one's are ignored.
   * The caller lookup skips a `spawnedAs` spawn, which is never human, so burndown and Shepherd
   * spawns never pay its synchronous `ss` read.
   */
  private humanClaims(
    conn: Conn,
    msg: Extract<ClientMessage, { t: 'spawn' }>,
    requestedBy: string,
  ): Pick<SpawnRequest, 'spawnedAs' | 'callerAgent' | 'humanUnproven' | 'launchedBy' | 'launchReason'> {
    if (requestedBy !== HUMAN) return {}
    const spawnedAs = spawnedAsOf(msg)
    const caller = spawnedAs.spawnedAs === undefined ? callerAgentOf(conn, msg, this.peer) : {}
    return { ...spawnedAs, ...caller, ...launchFieldsOf(msg) }
  }

  private callerHostOf(conn: Conn, msg: Extract<ClientMessage, { t: 'spawn' }>): string | undefined {
    const entry = this.core.registry.entryFor(conn)
    return entry === undefined ? nonBlank(msg.callerHost) : this.hostOf(conn, entry)
  }

  /** CC-1059: why `conn` may not report on `agentId`'s launch, or nothing when it is the requester. */
  private remoteReportRefusal(conn: Conn, agentId: unknown): string | undefined {
    if (typeof agentId === 'string' && this.remoteSpawners.get(agentId) === conn) return undefined
    return `this connection was not handed the launch of ${String(agentId)}, so it cannot report on it`
  }

  private handleSpawnLaunched(conn: Conn, msg: Extract<ClientMessage, { t: 'spawn_launched' }>): void {
    const refusal = this.remoteReportRefusal(conn, msg.agentId)
    if (refusal !== undefined) return reply(conn, { t: 'spawn_launched_result', ok: false, reason: refusal })
    const result = this.supervisor.remoteSpawnReady(msg.agentId, reportOf(msg))
    if (!result.ok) this.remoteSpawners.delete(msg.agentId)
    reply(conn, { t: 'spawn_launched_result', ...result })
  }

  private async handleSpawnPlaced(
    conn: Conn,
    msg: Extract<ClientMessage, { t: 'spawn_placed' }>,
  ): Promise<void> {
    const refusal = this.remoteReportRefusal(conn, msg.agentId)
    if (refusal !== undefined) return reply(conn, { t: 'spawn_placed_result', ok: false, reason: refusal })
    this.remoteSpawners.delete(msg.agentId)
    const outcome = await this.supervisor.remoteSpawnPlaced(msg.agentId, reportOf(msg))
    reply(conn, { t: 'spawn_placed_result', ...spawnResultFields(outcome, outcome.warnings) })
  }

  /**
   * Take a claim for `conn` (CC-56).
   *
   * The OWNER is read from the connection, never from the message: a claim is a
   * statement about who is working somewhere, and letting one be made in another
   * session's name would turn an advisory signal into a way to fence peers out
   * of a checkout they are entitled to.
   *
   * The worktree, by contrast, may be named — an agent working across several
   * projects at once has to claim in a checkout that is not its own cwd. What it
   * cannot do is hold two worktrees of the SAME repository, which the ledger
   * enforces from the repo path resolved here.
   */
  private async handleClaim(conn: Conn, msg: Extract<ClientMessage, { t: 'claim' }>): Promise<void> {
    const owner = this.core.registry.nameOf(conn)
    if (owner === undefined)
      return reply(conn, {
        t: 'claim_result',
        ok: false,
        reason: 'register before claiming — a claim is held by a named session, and you have no name yet.',
      })

    const observed = this.core.registry.observedFor(conn)
    const worktreePath = msg.worktreePath ?? observed?.worktreePath
    if (worktreePath === undefined)
      return reply(conn, {
        t: 'claim_result',
        ok: false,
        reason:
          'no worktree to claim: this session is not in a git checkout, so pass worktreePath explicitly.',
      })

    // Resolved rather than taken on trust, and re-resolved even for the
    // session's own worktree: the one-worktree-per-repo rule is only meaningful
    // if the repository is identified the same way for every claim.
    const repoPath =
      worktreePath === observed?.worktreePath && observed.repoPath !== undefined
        ? observed.repoPath
        : ((await findGitRoot(worktreePath)) ?? undefined)

    const outcome = this.core.claims.claim({
      owner,
      worktreePath,
      ...(repoPath === undefined ? {} : { repoPath }),
      ...(msg.patterns === undefined ? {} : { patterns: msg.patterns }),
    })

    reply(
      conn,
      outcome.ok
        ? { t: 'claim_result', ok: true, claim: outcome.claim }
        : { t: 'claim_result', ok: false, reason: outcome.reason, conflicts: outcome.conflicts },
    )
  }

  /** Release this session's claim in one worktree, or everywhere it holds one. */
  private handleRelease(conn: Conn, msg: Extract<ClientMessage, { t: 'release' }>): void {
    const owner = this.core.registry.nameOf(conn)
    if (owner === undefined) return reply(conn, { t: 'release_result', released: false })
    const released =
      msg.worktreePath === undefined
        ? this.core.claims.releaseAll(owner)
        : this.core.claims.releaseIn(owner, msg.worktreePath)
    reply(conn, { t: 'release_result', released })
  }

  /**
   * CC-896: the host a signal on `conn`'s session is judged against. A reported host
   * (CC-880) is taken as given; for a session that reported none, locality is proven
   * from the kernel's view of its socket, and anything short of proof stays unreported.
   */
  private hostOf(conn: Conn, entry: { host?: string; hostPid?: number }): string | undefined {
    if (entry.host !== undefined) return entry.host
    return provePeerLocal(conn, entry.hostPid, this.peer) ? brokerHost() : undefined
  }

  /**
   * Teleport on behalf of `conn`, resolving WHO from its own registry entry.
   *
   * Every field the supervisor acts on — the identity to retire, the pid to
   * signal, the pane to reopen in, the tags and subscriptions to carry — is read
   * from the requester's own connection. The wire message carries none of them,
   * so there is no version of this call that ends someone else's session.
   */
  private async handleTeleport(conn: Conn, msg: Extract<ClientMessage, { t: 'teleport' }>): Promise<void> {
    const { registry } = this.core
    const entry = registry.entryFor(conn)
    const turnedAway = (stage: RefusalStage, reason: string): void =>
      reply(conn, {
        t: 'teleport_result',
        ...refused({ name: entry?.name ?? 'unregistered' }, stage, reason),
      })
    if (msg.reason !== undefined && !isAgentTeleportReason(msg.reason))
      return turnedAway('preflight', `unknown teleport reason "${String(msg.reason)}"`)
    if (msg.surface !== undefined && !(SURFACE_NAMES as readonly string[]).includes(msg.surface))
      return turnedAway(
        'preflight',
        `unknown surface "${String(msg.surface)}"; one of ${SURFACE_NAMES.join(', ')}`,
      )
    if (msg.to !== undefined && typeof msg.to !== 'string')
      return turnedAway('preflight', 'teleport "to" must be a machine name')
    if (entry?.agentId === undefined) {
      return turnedAway(
        'identity',
        'teleport needs a durable identity, and this connection has none. Either you have not ' +
          'called chat_register yet (call it first), or your MCP server is older than the broker ' +
          'and did not send a session id (restart this session).',
      )
    }
    const outcome = await this.supervisor.teleport({
      subject: this.teleportSubject(conn, { ...entry, agentId: entry.agentId }),
      handoff: msg.handoff,
      ...(msg.model === undefined ? {} : { model: msg.model }),
      ...(msg.remoteControl === undefined ? {} : { remoteControl: msg.remoteControl }),
      ...(msg.remoteControlSeen === undefined ? {} : { remoteControlSeen: msg.remoteControlSeen }),
      ...(msg.reason === undefined ? {} : { reason: msg.reason }),
      ...(msg.surface === undefined ? {} : { surface: msg.surface }),
      ...optionalPlatform(asPlatform(msg.hostPlatform)),
      ...optionalCarried(sanitizeCarried(msg.launchSeen)),
      ...(msg.to === undefined ? {} : { to: msg.to }),
      ...(msg.endsSelf === true ? { endsSelf: true } : {}),
    })
    replyTeleport(conn, outcome)
  }

  /** Every field read from `conn`'s own registration, never from a frame. */
  private teleportSubject(
    conn: Conn,
    entry: { agentId: string; name: string; hostPid?: number; host?: string },
  ): TeleportSubject {
    const { registry } = this.core
    return {
      agentId: entry.agentId,
      name: entry.name,
      cwd: registry.cwdFor(conn) ?? process.cwd(),
      // SELF-declared tags only. A peer's label must not ride across a teleport
      // and reappear on a fresh identity as that identity's own declaration.
      tags: registry.selfTagsOf(conn),
      subscriptions: registry.subscriptionsOf(conn),
      ...(entry.hostPid === undefined ? {} : { hostPid: entry.hostPid }),
      ...optionalHost(this.hostOf(conn, entry)),
      ...(registry.anchorFor(conn) === undefined ? {} : { anchor: registry.anchorFor(conn) as string }),
      // CC-100: read from the registration, not from the message, exactly like
      // every other field here. A successor continues its predecessor's work and
      // therefore keeps spending the same account.
      ...(registry.observedFor(conn)?.configDir === undefined
        ? {}
        : { configDir: registry.observedFor(conn)?.configDir as string }),
    }
  }

  /**
   * CC-892: the human moving a live session to another account. Human-only on the same
   * `admits` gate as `teleport_abort`, and the subject is the named session's own registration,
   * read exactly as `teleport` reads its requester's. Decision 381: the target check in
   * `Teleport.begin` is the guard, not a deny rule.
   */
  private async handleAccountMove(
    conn: Conn,
    msg: Extract<ClientMessage, { t: 'account_move' | 'account_move_check' }>,
  ): Promise<void> {
    const name = typeof msg.name === 'string' ? msg.name : 'unnamed'
    const turnedAway = (stage: RefusalStage, reason: string): void =>
      reply(conn, { t: 'teleport_result', ...refused({ name }, stage, reason) })
    if (!this.admits(conn, msg.t)) {
      this.refuseToSession(conn, 'move a session to another account')
      const hint = this.refusalHint(conn, msg.t)
      return turnedAway('account', `moving a session to another account is the human’s call${hint}`)
    }
    if (typeof msg.to !== 'string' || (msg.force !== undefined && typeof msg.force !== 'boolean'))
      return turnedAway('preflight', 'account_move needs a "to" account and a boolean "force"')
    const { registry } = this.core
    const target = registry.connFor(name)
    const entry = target === undefined ? undefined : registry.entryFor(target)
    if (target === undefined || entry?.agentId === undefined)
      return turnedAway('identity', `no live session with a durable identity is named "${name}"`)
    const subject = this.teleportSubject(target, { ...entry, agentId: entry.agentId })
    const account = { to: msg.to, by: HUMAN, ...(msg.force === true ? { force: true } : {}) }
    // CC-1592: answered before teleport is reached, so a dry run records no handoff and ends nothing.
    if (msg.t === 'account_move_check')
      return replyTeleport(conn, this.supervisor.checkAccountMove(subject, account))
    const outcome = await this.supervisor.teleport({ subject, handoff: '', reason: 'account', account })
    replyTeleport(conn, outcome)
  }

  /**
   * True only for a connection with no registration — the human at the CLI, on
   * the theory that reaching a 0600 socket at all already means being the OS
   * account's owner.
   *
   * THIS IS A WEAKER GUARANTEE THAN THE FRAMES BUILT ON IT CLAIM. It stops a
   * session using ITS OWN registered connection to act with the human's
   * authority. It does NOT stop a process that opens a SECOND, unregistered
   * connection, or shells out to the `agent-chat` CLI, or writes raw bytes to
   * the socket with `nc` — none of those register, so all pass this check.
   * Verified empirically (CC-22 adversarial review, 2026-07-30): a `Bash`-
   * capable spawned agent self-approved its own endorsement three ways — a CLI
   * subprocess, a second in-process socket, and a bare `nc` pipe — because a
   * Unix socket carries no peer credentials for Node to check (`net.Socket`
   * exposes no pid/uid; `remoteAddress` is `undefined` on AF_UNIX). On this
   * machine every agent already runs under the human's own OS account, which
   * `agent-teams.md` §11.4 names as the actual trust boundary: "these controls
   * stop a confused agent, not an adversarial one." This check is exactly that
   * kind of control — real defense against an agent using its own established
   * session to act as the human, not a guarantee against a deliberately
   * adversarial co-resident process. See `profiles.ts` for the other half:
   * denying the builtin profiles' own `Bash` the ability to invoke these CLI
   * verbs at all, which is what actually stops the common case.
   *
   * CC-1138 narrows "no registration" to "no registration and no `hello` id": a CLI run
   * from an agent's own process tree declares `AGENT_CHAT_AGENT_ID` and is not the human.
   * A Class 1 frame is refused from it outright. A Class 3 frame is accepted from it only
   * when `subject`, the agent the frame speaks for, is the declared agent. The hello is
   * self-declared, so `env -u` still reads as the human; the bar is the same as above.
   */
  private admits(conn: Conn, t: ClientMessage['t'], subject?: string): boolean {
    const caller = this.callerOf(conn)
    if (caller.kind === 'human') return true
    if (caller.kind === 'session' || classOf(t) !== 3) return false
    return 'name' in caller && caller.name === subject
  }

  /** Record that a session or a declared agent reached for an action only the human may take. */
  private refuseToSession(conn: Conn, action: string): void {
    const caller = this.callerOf(conn)
    if (caller.kind !== 'declared') {
      const name = this.core.registry.nameOf(conn) ?? '?'
      this.core.append({ kind: 'verdict_refused', actor: name, body: `a session tried to ${action}` })
      return
    }
    this.core.append({
      kind: 'verdict_refused',
      actor: 'name' in caller ? caller.name : '?',
      body: `an agent's process tried to ${action}`,
      meta: { declared_agent_id: caller.agentId },
    })
  }

  /** CC-1138: the sentence a refusal's reason gains for a declared agent; nothing for a session. */
  private refusalHint(conn: Conn, t: ClientMessage['t']): string {
    if (this.callerOf(conn).kind !== 'declared') return ''
    return classOf(t) === 3
      ? '. This connection declared an agent id, so it may send this frame only for that agent'
      : '. This connection declared an agent id (AGENT_CHAT_AGENT_ID), so it is not the human: ' +
          'run the verb from a plain shell, not an agent’s pane'
  }

  /** The session's registered name, or a known declared agent's; undefined for the human or an unknown id. */
  private nameOfCaller(conn: Conn): string | undefined {
    const caller = this.callerOf(conn)
    if (caller.kind === 'session') return this.core.registry.nameOf(conn)
    return caller.kind === 'declared' && 'name' in caller ? caller.name : undefined
  }

  /** CC-1138: a registered connection is its session; otherwise the `hello`, if any, decides. */
  callerOf(conn: Conn): Caller {
    if (this.core.registry.nameOf(conn) !== undefined) return { kind: 'session' }
    const agentId = this.declared.idOf(conn)
    if (agentId === undefined) return { kind: 'human' }
    return { kind: 'declared', ...resolveDeclared(agentId, id => this.core.agents.get(id)) }
  }

  /** CC-1138: the declaration `callerOf` reads, logged once per connection. */
  private handleHello(conn: Conn, rawId: unknown): void {
    const agentId = declaredIdOf(rawId)
    if (agentId === undefined || !this.declared.declare(conn, agentId)) return
    const declared = resolveDeclared(agentId, id => this.core.agents.get(id))
    logEvent('caller_declared', {
      agentId,
      ...('name' in declared ? { name: declared.name } : { unknown: true }),
      registered: this.core.registry.nameOf(conn) ?? null,
    })
  }

  /**
   * The countdown's abort, and the one place a check stands in for a structural
   * defence — deliberately, because a human at the CLI and an agent reach the
   * broker over the same socket, and the human's veto has to be reachable.
   *
   * A REGISTERED connection is a session, and no session may cancel a shutdown
   * (its own or anyone's): a descendant suppressing its predecessor's veto would
   * make the human's 30 seconds a formality. What is left is the human at the
   * CLI. No MCP tool exposes this frame. See `admits` for what this check does
   * and does not guarantee.
   */
  private handleTeleportAbort(conn: Conn, name: string): void {
    if (!this.admits(conn, 'teleport_abort')) {
      this.refuseToSession(conn, 'cancel a teleport countdown')
      return reply(conn, {
        t: 'teleport_result',
        ok: false,
        reason:
          'aborting a teleport is the human’s call; a session cannot cancel a countdown' +
          this.refusalHint(conn, 'teleport_abort'),
      })
    }
    const result = this.supervisor.abortTeleport(name)
    reply(conn, {
      t: 'teleport_result',
      ok: result.ok,
      ...(result.reason === undefined ? {} : { reason: result.reason }),
      ...(result.ok ? { name } : {}),
    })
  }

  /**
   * CC-1545: from the supervisor's CLI socket only, so no session can put words in another's spawner
   * notice. CC-1138: a declared agent may report only the cap of the session its `hostPid` names.
   */
  private handleCodexWakeCapped(conn: Conn, msg: Extract<ClientMessage, { t: 'codex_wake_capped' }>): void {
    if (!this.admits(conn, msg.t, this.core.registry.nameOnHost(msg.hostPid, msg.host))) {
      this.refuseToSession(conn, 'report a Codex wake cap')
      return reply(conn, {
        t: 'send_result',
        ok: false,
        recipients: [],
        reason: `a wake cap is reported by agent-chat codex run, not by a session${this.refusalHint(conn, msg.t)}`,
      })
    }
    reply(conn, noticeWakeCapped(this.core, msg))
  }

  /** CC-881: like `teleport`, resolved from this connection's own registration and never from the frame. */
  private async handleTeleportPlanWait(conn: Conn): Promise<void> {
    const agentId = this.core.registry.entryFor(conn)?.agentId
    const plan =
      agentId === undefined
        ? { ok: false, reason: 'this connection has no durable identity to teleport' }
        : await this.supervisor.teleportPlan(agentId)
    reply(conn, { t: 'teleport_plan', ...plan })
  }

  private handleTeleportLaunched(conn: Conn, msg: Extract<ClientMessage, { t: 'teleport_launched' }>): void {
    const agentId = this.core.registry.entryFor(conn)?.agentId
    const result =
      agentId === undefined
        ? { ok: false, reason: 'this connection has no durable identity to teleport' }
        : this.supervisor.teleportLaunched(agentId, {
            successor: msg.agentId,
            ok: msg.ok,
            ...(msg.reason === undefined ? {} : { reason: msg.reason }),
          })
    reply(conn, { t: 'teleport_launched_result', ...result })
  }

  /**
   * CC-951: a host launcher is a connection of its own. The guard is per connection: one that
   * holds a registration may not announce a machine, and a launcher's may not register (see
   * `refuseLauncherRegister`). A session can still open a second connection; what stops it
   * taking over a machine is that the first live launcher holds it, that a configured
   * `machines` list bounds which machines may be announced at all, and (CC-1063) that under
   * `hostProof: enforce` every machine is held only with a proof of its launcher key over this
   * connection's single-use nonce, so the gap after the real launcher drops is closed too.
   */
  private handleHostHello(conn: Conn, msg: Extract<ClientMessage, { t: 'host_hello' }>): void {
    const nonce = this.hosts.takeNonce(conn)
    if (this.refuseSessionLauncher(conn)) return
    const machines = Object.values(knownMachineAliases())
    const hello = launcherHello(msg, machines)
    if (typeof hello === 'string') return reply(conn, { t: 'host_hello_result', ok: false, reason: hello })
    const verdict = proofRefusal(hello.host, msg.proof, nonce, brokerKeyFor)
    const refusal = this.enforcedProofRefusal(hello.host, msg.proof, verdict)
    const result =
      refusal === undefined
        ? this.hosts.hello(conn, hello, frame => reply(conn, frame), verdict === undefined)
        : { ok: false, reason: refusal }
    if (!result.ok) logEvent('host_launcher_refused', { host: hello.host, reason: result.reason })
    reply(conn, { t: 'host_hello_result', ...result })
  }

  /**
   * CC-1063: with `hostProof` off (the default until launchers answer the challenge), a hello without a
   * proof is accepted as before, and a bad proof is logged and accepted, so the check can be watched live.
   * `verdict` is `proofRefusal` over the hello's one nonce; off still records it, and routing reads it (CC-1331).
   */
  private enforcedProofRefusal(
    host: string,
    proof: unknown,
    verdict: string | undefined,
  ): string | undefined {
    const enforced = resolveHostProofMode() === 'enforce'
    if (!enforced && proof === undefined) return undefined
    if (enforced || verdict === undefined) return verdict
    logEvent('host_launcher_refused', { host, reason: 'proof-invalid (not enforced)' })
    return undefined
  }

  /** CC-1063: the challenge is the hello's first step, so a session is refused it with the hello's answer. */
  private handleHostChallenge(conn: Conn): void {
    if (this.refuseSessionLauncher(conn)) return
    reply(conn, { t: 'host_challenge_result', nonce: this.hosts.challenge(conn) })
  }

  private refuseSessionLauncher(conn: Conn): boolean {
    if (this.core.registry.nameOf(conn) === undefined) return false
    this.refuseToSession(conn, 'announce itself as a host launcher')
    reply(conn, {
      t: 'host_hello_result',
      ok: false,
      reason: 'a registered session cannot be a host launcher; a launcher needs a connection of its own',
    })
    return true
  }

  /** CC-951: a launcher's connection never holds a session's name; it takes launches, not messages. */
  private refuseLauncherRegister(conn: Conn): boolean {
    const host = this.hosts.hostOf(conn)
    if (host === undefined) return false
    reply(conn, {
      t: 'register_result',
      ok: false,
      reason: `this connection is the host launcher for ${host}, so it cannot register a session`,
    })
    return true
  }

  /** CC-913: the sender's own registration, never the frame, says whether it is the predecessor. */
  private handleTeleportLandFailed(
    conn: Conn,
    msg: Extract<ClientMessage, { t: 'teleport_land_failed' }>,
  ): void {
    const from = this.core.registry.entryFor(conn)?.agentId
    reply(conn, {
      t: 'teleport_land_failed_result',
      ...this.supervisor.teleportLandFailed(msg.agentId, msg.token, msg.reason, from),
    })
  }

  /**
   * Say out loud when a client is running a different build from the broker.
   *
   * CC-36: a session resolves its agent-chat entry through its own launcher, and
   * that need not be the entry the broker is running. The failure is invisible
   * from BOTH sides — the client registers normally, appears healthy on the
   * roster and answers messages, and only its TOOL LIST is stale. Two live
   * agents reported not having a tool the broker had shipped, and nothing said
   * the builds disagreed; it read as a feature defect for most of an hour.
   *
   * A notice rather than a refusal, because a mismatch is usually harmless — a
   * session started before a rebuild is running old code and working fine. What
   * is not acceptable is that it be SILENT.
   */
  private noteBuildMismatch(name: string, build: string | undefined): void {
    const ours = cliEntry()
    if (build === undefined || build === ours) return
    this.core.append({
      kind: 'notice',
      actor: 'agent-chat',
      target: HUMAN,
      body:
        `${name} is running a different agent-chat build from the broker. Its tools come from ` +
        `${build}; the broker is ${ours}. Tools added since that build will be missing from ` +
        `${name} even though it registered normally — restart it, or point its launcher at the ` +
        'same checkout.',
    })
    logEvent('build_mismatch', { name, client: build, broker: ours })
  }

  /**
   * Put a returning session back on the bus under the name it already held.
   *
   * The name comes from the LOG, never from the request — `bySession` matches
   * adopted identities only, so this cannot reach a spawned agent's name by
   * quoting its session id (the hole `BrokerCore.claimable` closes for agent
   * ids). A session with nothing to reclaim gets ok:false and carries on to the
   * ordinary `chat_register` path.
   */
  private handleReadopt(conn: Conn, msg: Extract<ClientMessage, { t: 'readopt' }>): void {
    const known = this.core.agents.bySession(msg.sessionId)
    if (known === undefined || known.name === '')
      return reply(conn, {
        t: 'register_result',
        ok: false,
        reason: 'no previous registration for this session',
      })
    // Already here: a live connection under this name means nothing was lost, and
    // re-registering would evict a healthy peer to fix a problem it does not have.
    if (this.core.registry.connFor(known.name) !== undefined)
      return reply(conn, { t: 'register_result', ok: false, reason: `${known.name} is already connected` })

    const dark = this.core.darkSeat(known.name)
    const result = this.core.register(conn, readoptRegistration(known, msg))
    if (result.ok) logEvent('readopted', { name: known.name, sessionId: msg.sessionId })
    reply(conn, { t: 'register_result', ...result, ...(result.ok ? { name: known.name } : {}) })
    if (result.ok) this.core.deliverStranded(known.name)
    if (result.ok && dark !== undefined) this.core.deliverHeld(known.name, dark)
  }

  /**
   * Pull a named headless agent into a terminal.
   *
   * The one field the request carries is WHO to surface. Everything about WHERE
   * it lands still comes from the requester's own connection: an anchored session
   * gets the agent beside it in the same window, and a background agent surfacing
   * itself has no anchor and opens its own window. Neither can be asked for.
   */
  /** CC-126. Answered on `spawn_result`, carrying the transcript verdict whatever the outcome. */
  private async handleResume(conn: Conn, msg: Extract<ClientMessage, { t: 'resume' }>): Promise<void> {
    // CC-1492: dropped, a garbled host would resume locally, against a transcript nobody asked about.
    if (msg.host !== undefined && typeof msg.host !== 'string')
      return reply(conn, { t: 'spawn_result', ok: false, reason: 'resume host must be a machine name' })
    const requester = this.class2RequesterOf(conn)
    if (isRefusal(requester)) return reply(conn, { t: 'spawn_result', ok: false, reason: requester.refusal })
    const anchor = this.core.registry.anchorFor(conn)
    const source = wakeSource(msg.source)
    const host = nonBlank(msg.host)
    const outcome = await this.supervisor.resume(msg.name, {
      ...(host === undefined ? {} : { host }),
      requestedBy: requester?.name ?? HUMAN,
      ...(anchor === undefined ? {} : { anchor }),
      ...(requester?.agentId === undefined ? {} : { requesterAgentId: requester.agentId }),
      ...requesterBindingOf(requester),
      ...(msg.surface === undefined ? {} : { surface: msg.surface }),
      ...(msg.message === undefined ? {} : { message: msg.message }),
      ...(source === undefined ? {} : { source }),
      ...(msg.remoteControl === undefined ? {} : { remoteControl: msg.remoteControl }),
      // TP-4256 A3: the same proof a spawn needs, since a human resume clears a quarantine.
      ...(requester === undefined ? { ...launchFieldsOf(msg), ...callerAgentOf(conn, msg, this.peer) } : {}),
    })
    reply(conn, { t: 'spawn_result', ...outcome })
  }

  private async handleSurface(conn: Conn, name: string): Promise<void> {
    const anchor = this.core.registry.anchorFor(conn)
    const requester = this.class2RequesterOf(conn)
    if (isRefusal(requester)) return replySwitch(conn, { ok: false, reason: requester.refusal })
    const outcome = await this.supervisor.switchSurface({
      name,
      to: 'interactive',
      requestedBy: requester?.name ?? HUMAN,
      ...(anchor === undefined ? {} : { anchor }),
      ...(requester?.agentId === undefined ? {} : { requesterAgentId: requester.agentId }),
      ...requesterBindingOf(requester),
    })
    replySwitch(conn, outcome)
  }

  /** CC-1138 e: who `conn`'s Class 2 frame asks as; see `class2RequesterOf`. */
  private class2RequesterOf(conn: Conn): Class2Asker {
    const claimable = (agentId: string, name: string) => this.core.claimable(agentId, name).ok
    return class2RequesterOf(this.core.registry.entryFor(conn), this.callerOf(conn), claimable)
  }

  /** CC-1138: the requester's id and binding, for the ownership rule. */
  private ownershipOf(requester: Class2Requester | undefined): {
    requesterAgentId?: string
    requesterBinding?: IdentityBinding
  } {
    return {
      ...(requester?.agentId === undefined ? {} : { requesterAgentId: requester.agentId }),
      ...requesterBindingOf(requester),
    }
  }

  /** CC-1505: a switch that throws answers the caller; left unhandled, the rejection ended the broker. */
  private answerSwitch(conn: Conn, switching: Promise<void>): void {
    switching.catch((err: unknown) => {
      const reason = err instanceof Error ? err.message : String(err)
      logEvent('switch_failed', { reason })
      replySwitch(conn, { ok: false, reason: `switch failed: ${reason}` })
    })
  }

  /** Go headless. The subject is the caller, resolved here and nowhere else. */
  private async handleBackground(conn: Conn): Promise<void> {
    const entry = this.core.registry.entryFor(conn)
    if (entry?.agentId === undefined) {
      return replySwitch(conn, {
        ok: false,
        reason:
          'going headless needs a durable identity, and this connection has none. Call ' +
          'chat_register first.',
      })
    }
    const outcome = await this.supervisor.switchSurface({
      name: entry.name,
      to: 'headless',
      requestedBy: entry.name,
      ...(entry.hostPid === undefined ? {} : { hostPid: entry.hostPid }),
      ...optionalHost(this.hostOf(conn, entry)),
    })
    replySwitch(conn, outcome)
  }

  /**
   * One named recipient. CC-320: a dark seat's message is held for it rather than failing to route.
   * CC-1552: a retired or parked seat is as non-resident as a dark one, so its steward mapping applies.
   */
  private handleSend(conn: Conn, to: string, text: string, extras: SendExtras): void {
    const { core } = this
    const { inReplyTo, meta } = extras
    const result = core.registry.send(conn, to, text, inReplyTo)
    const from = core.registry.nameOf(conn)
    const unrouted = from !== undefined && result.results[0]?.status === 'no_such_session'
    const nonResident = unrouted || (result.ok && core.registry.pushHold(to) !== undefined)
    const queued =
      from !== undefined && nonResident
        ? core.queueForSeat(from, to, text, { inReplyTo, sendMeta: meta })
        : undefined
    if (queued !== undefined) return replyQueuedForSeat(conn, to, queued)
    const held = unrouted ? core.holdForSeat(from, to, text, inReplyTo, undefined, meta) : undefined
    if (held === undefined) return this.handleRoute(conn, result, 'message', to, { meta })
    if (!held.ok) return this.handleRoute(conn, { ...result, reason: held.reason }, 'message', to, { meta })
    replyHeld(conn, to, held.msgId)
  }

  private handleRoute(
    conn: Conn,
    result: RouteResult<Conn>,
    kind: 'message' | 'broadcast',
    to: string,
    { tag, meta: sendMeta }: RouteExtras = {},
  ): void {
    const { core } = this
    const from = core.registry.nameOf(conn) ?? '?'
    const nonce = requestScope.getStore()?.nonce
    logEvent('route', {
      kind,
      msgId: result.msgId,
      from,
      to,
      ...(nonce === undefined ? {} : { nonce }),
      ...routeDelivery(result),
      recipients: result.recipients,
    })

    for (const delivery of result.deliveries) {
      // A multicast stays kind 'message' — it is directed, just to several
      // people — and carries who else got it, and the tag it was addressed by,
      // in meta. EventKind is frozen into the SSE contract, so a new member
      // there would break readers broadly.
      const meta = {
        ...sendMeta,
        ...(delivery.message.audience ? { audience: delivery.message.audience.join(',') } : {}),
        ...(tag ? { tag } : {}),
      }
      // One row per recipient so a session's inbox is a plain query on `target`.
      core.append({
        kind,
        actor: from,
        target: core.registry.nameOf(delivery.conn) ?? '?',
        msgId: delivery.message.msgId,
        ...(delivery.message.inReplyTo ? { ref: delivery.message.inReplyTo } : {}),
        body: delivery.message.text,
        ...(Object.keys(meta).length > 0 ? { meta } : {}),
      })
      // Held deliveries are logged above and simply not pushed. The inbox is a
      // query over the log, so chat_inbox still returns them. Two independent
      // reasons to hold: the sender is over budget (whole route) or this one
      // recipient is in do-not-disturb.
      if (!result.suppressLive && delivery.live) core.pushRouted(conn, delivery.conn, delivery.message)
      else if (!result.suppressLive && delivery.hold === 'parked')
        core.holdWhileParked(delivery.conn, delivery.message)
    }
    if (!result.ok) {
      core.append({ kind: 'route_failed', actor: from, target: to, body: result.reason ?? 'unknown' })
    }
    if (result.escalate) this.escalateThread(result.escalate)

    reply(conn, {
      t: 'send_result',
      ok: result.ok,
      recipients: result.recipients,
      results: result.results,
      ...(result.msgId === undefined ? {} : { msgId: result.msgId }),
      ...(result.reason === undefined ? {} : { reason: result.reason }),
      ...(result.suppressLive || (result.deliveries.length > 0 && result.deliveries.every(d => !d.live))
        ? { held: true }
        : {}),
    })
  }

  /**
   * Add or remove tags, on the caller or on a peer (CC-13).
   *
   * Two things are deliberately absent. There is NO push to the tagged session:
   * a peer's label must not lengthen a turn that had nothing to do with it (the
   * lesson `noteWorkingOnCollision` already follows), so it becomes visible on
   * that session's next chat_list and nowhere else. And there is NO new EventKind
   * — `notice` carries it, because EVENT_KINDS is frozen into the SSE contract.
   * The row is targeted at the SUBJECT rather than the human, so it lands in
   * chat_activity for both parties instead of in a queue nobody asked to fill.
   */
  private handleTag(conn: Conn, msg: Extract<ClientMessage, { t: 'tag' }>): void {
    const result = this.core.registry.applyTags(conn, msg)
    if (result.ok && result.subject !== undefined) {
      const applier = this.core.registry.nameOf(conn) ?? '?'
      const onSelf = result.subject === applier
      const parts = [
        result.added.length > 0 ? `+${result.added.join(' +')}` : '',
        result.removed.length > 0 ? `-${result.removed.join(' -')}` : '',
      ].filter(Boolean)
      if (parts.length > 0) {
        this.core.append({
          kind: 'notice',
          actor: applier,
          target: result.subject,
          body: `${applier} tagged ${onSelf ? 'itself' : result.subject}: ${parts.join(' ')}`,
          meta: {
            ...(result.added.length > 0 ? { tag_add: result.added.join(',') } : {}),
            ...(result.removed.length > 0 ? { tag_remove: result.removed.join(',') } : {}),
          },
        })
        logEvent('tag', { by: applier, subject: result.subject, add: result.added, remove: result.removed })
      }
    }
    reply(conn, {
      t: 'tag_result',
      ok: result.ok,
      tags: result.tags,
      ...(result.subject === undefined ? {} : { subject: result.subject }),
      ...(result.reason === undefined ? {} : { reason: result.reason }),
    })
  }

  /**
   * A broken thread is the one case where neither participant can raise the alarm:
   * the sender was refused and the recipient never heard anything. So it goes to the
   * human queue, which is the only party outside the loop.
   */
  private escalateThread(escalate: Escalation): void {
    const body =
      `${escalate.summary} Neither has been told anything the other can see; ` +
      'if the exchange was worthwhile, answer one of them.'
    const { msgId } = this.core.append({ kind: 'notice', actor: escalate.from, target: HUMAN, body })
    logEvent('exchange_breaker', {
      msgId,
      kind: escalate.kind,
      from: escalate.from,
      to: escalate.to,
      value: escalate.value,
    })
  }

  /** Messages to the human are logged, never delivered — nothing holds that socket. */
  private enqueueForHuman(
    conn: Conn,
    kind: 'message' | 'question' | 'notice',
    text: string,
    shape: ItemShape = {},
  ): void {
    const { core } = this
    const from = core.registry.nameOf(conn)
    if (!from) return reply(conn, { t: 'send_result', ok: false, recipients: [], reason: 'not registered' })

    const meta = shapeMeta(shape)
    const { msgId } = core.append({
      kind,
      actor: from,
      target: HUMAN,
      body: text,
      ...(Object.keys(meta).length > 0 ? { meta } : {}),
    })
    logEvent('route', { kind, msgId, from, to: HUMAN, delivered: true, recipients: [HUMAN] })
    reply(conn, { t: 'send_result', ok: true, msgId, recipients: [HUMAN] })
  }

  /**
   * Store a composed message for the human to read, and deliver NOTHING.
   *
   * The recipient is recorded now and read back from the log at approval time,
   * so the human's decision is bound to one body and one addressee together.
   */
  private handleEndorseRequest(conn: Conn, msg: Extract<ClientMessage, { t: 'endorse' }>): void {
    const { core } = this
    const from = core.registry.nameOf(conn)
    const refuse = (reason: string): void =>
      reply(conn, { t: 'send_result', ok: false, recipients: [], reason })
    if (!from) return refuse('not registered')
    // Endorsing a message to the human, or to yourself, is a request for a
    // signature on nothing: the value is entirely in what a THIRD party can tell
    // about where the authority came from.
    if (msg.to === HUMAN || msg.to === from)
      return refuse('an endorsement is relayed to a peer; your human is the one approving it')
    // The human is shown "would be delivered to X" and decides based on that
    // name. Refusing an unknown name here at least closes the case an adversarial
    // review found live: approving a request for a name nobody holds yet, which
    // then gets delivered to whoever happens to register it later. The narrower
    // race, where the name changes hands before the human approves, is closed at
    // approval by `recipient_agent_id` below (CC-420).
    const recipientConn = core.registry.connFor(msg.to)
    if (recipientConn === undefined) return refuse(`no session named "${msg.to}" is currently connected`)

    // Keyed by durable agent identity when this connection has one, so
    // re-registering under a new name cannot buy a fresh budget (CC-38). A
    // raw, never-adopted connection has nothing to key on and falls back to
    // the per-name count it always had.
    const composer = core.registry.entryFor(conn)
    const openEndorsements = composer?.agentId
      ? core.events.openCountByAgent(composer.agentId, 'endorse_request')
      : core.events.openCount(from, 'endorse_request')
    if (openEndorsements >= MAX_OPEN_ENDORSEMENTS)
      return refuse(
        `you already have ${MAX_OPEN_ENDORSEMENTS} messages waiting for endorsement; ` +
          'let those be read before composing another',
      )

    // CC-38: `msg.to` is whatever name won the race to register it — nothing
    // distinguishes a self-chosen, authoritative-sounding name ("lead") from
    // one actually assigned to someone. Recording whether the recipient has a
    // durable identity (minted by the broker, never self-asserted) and how
    // long they have held the name lets the human judge that for themself
    // when `inbox` shows "would be delivered to X, with your authority".
    const recipient = core.registry.entryFor(recipientConn)
    const { msgId } = core.append({
      kind: 'endorse_request',
      actor: from,
      target: HUMAN,
      body: msg.text,
      meta: {
        recipient: msg.to,
        ...(composer?.agentId ? { agent_id: composer.agentId } : {}),
        ...(recipient?.agentId ? { recipient_agent_id: recipient.agentId } : {}),
        recipient_durable: recipient?.agentId ? 'true' : 'false',
        recipient_registered_at: String(recipient?.registeredAt ?? Date.now()),
      },
    })
    logEvent('endorse_request', { msgId, from, to: msg.to })
    reply(conn, { t: 'send_result', ok: true, msgId, recipients: [HUMAN] })
  }

  /**
   * The human answering a queue item. CC-22's adversarial review found this had
   * NO sender check at all: any REGISTERED session could answer any OTHER
   * session's question and have it delivered as `from: HUMAN` — the single
   * cheapest forgery found, since it needs nothing but a frame on a connection
   * the caller already legitimately holds. No MCP tool exposes `answer`, so a
   * model reaches this only by talking to the socket directly; see `admits`.
   */
  private handleAnswer(conn: Conn, msgId: string, text: string, channel: unknown = 'cli'): void {
    if (!this.admits(conn, 'answer')) {
      this.refuseToSession(conn, 'answer a queue item')
      return reply(conn, {
        t: 'answer_result',
        ok: false,
        reason:
          'answering is the human’s call; a session cannot answer on the human’s behalf' +
          this.refusalHint(conn, 'answer'),
      })
    }
    if (!isAnswerChannel(channel)) {
      return reply(conn, {
        t: 'answer_result',
        ok: false,
        reason: `unknown answer channel ${String(channel)}`,
      })
    }
    const result = this.core.answer(msgId, text, channel)
    reply(conn, {
      t: 'answer_result',
      ok: result.ok,
      ...(result.reason === undefined ? {} : { reason: result.reason }),
    })
  }

  /**
   * The decider answering a question (autonomy slice 3). The gate is the
   * durable agent id the broker bound to this connection at registration,
   * compared with `decider.agentId` in config.json. A name is not enough: names
   * are first come, first served. An unregistered connection has no id, so the
   * CLI cannot decide either; the human answers instead.
   */
  private handleDecided(conn: Conn, msg: Extract<ClientMessage, { t: 'decided' }>): void {
    const entry = this.core.registry.entryFor(conn)
    const deciderId = resolveDeciderAgentId()
    if (!entry || deciderId === undefined || entry.agentId !== deciderId) {
      this.refuseToSession(conn, 'decide a question without being the configured decider')
      return reply(conn, {
        t: 'decided_result',
        ok: false,
        code: 'not_decider',
        reason:
          'only the configured decider may decide; file chat_ask and let the human or the decider answer',
      })
    }
    const { msgId, text, precedent, basis, reversible } = msg
    const result = this.core.decide(entry.name, msgId, text, {
      precedent,
      class: msg.class,
      basis,
      reversible,
    })
    if (!result.ok)
      this.core.append({ kind: 'verdict_refused', actor: entry.name, ref: msgId, body: result.reason })
    reply(conn, { t: 'decided_result', ...result })
  }

  /**
   * Close a queue item without answering it. Unlike `answer`, the item's own
   * AUTHOR may withdraw its own request — declining someone else's is still
   * human-only. CC-22's adversarial review found neither check present: any
   * registered session could silently dismiss any other session's pending item,
   * including one still waiting on human review. CC-1138: a declared agent is its
   * declared name here, so it too may withdraw its own item and nobody else's.
   */
  private handleDismiss(conn: Conn, msgId: string): void {
    const author = this.core.events.authorOf(msgId)
    const caller = this.nameOfCaller(conn)
    if (!this.admits(conn, 'dismiss') && (caller === undefined || caller !== author)) {
      this.refuseToSession(conn, 'dismiss another session’s queue item')
      return reply(conn, {
        t: 'answer_result',
        ok: false,
        reason:
          'dismissing someone else’s item is the human’s call; a session may withdraw its own' +
          this.refusalHint(conn, 'dismiss'),
      })
    }
    const result = this.core.dismiss(msgId)
    if (result.ok) this.settleHook(msgId, 'deny')
    reply(conn, {
      t: 'answer_result',
      ok: result.ok,
      ...(result.reason === undefined ? {} : { reason: result.reason }),
    })
  }

  /**
   * The human's approval, and the second half of what makes the marker
   * unforgeable AGAINST A SESSION USING ITS OWN CONNECTION — the first being
   * that no message shape carries the field itself. See `admits` for what this
   * check does and does not guarantee against a more determined bypass.
   */
  private handleEndorseApprove(conn: Conn, msgId: string, approval: EndorseApproval): void {
    if (!this.admits(conn, 'endorse_approve')) {
      this.refuseToSession(conn, 'endorse a message')
      return reply(conn, {
        t: 'answer_result',
        ok: false,
        reason:
          'endorsing is the human’s call; a session cannot endorse its own message or a peer’s' +
          this.refusalHint(conn, 'endorse_approve'),
      })
    }
    const result = this.core.endorse(msgId, approval)
    reply(conn, {
      t: 'answer_result',
      ok: result.ok,
      ...(result.reason === undefined ? {} : { reason: result.reason }),
    })
  }

  /**
   * The human answering a relayed permission prompt (CC-96).
   *
   * The guard is the load-bearing part of this verb, not an addition to it: an
   * agent that could reach this frame could grant itself or a peer any tool
   * call the human never approved, which is docs/ideas.md R1 and is declined.
   * Same `admits` gate as `endorse_approve` and `teleport_abort`, with the
   * same limits — see `admits`.
   *
   * The verdict goes to the prompting session ALONE, because `request_id` is
   * meaningful only in the process whose dialog is open. Nothing is retried and
   * nothing is stored against the host: it races the local dialog and the first
   * answer wins, so a late verdict is discarded there rather than here.
   */
  private handleApprovePermission(conn: Conn, msgId: string, behavior: PermissionBehavior): void {
    if (!this.admits(conn, 'approve_permission')) {
      this.refuseToSession(conn, 'answer a permission prompt')
      return reply(conn, {
        t: 'answer_result',
        ok: false,
        reason:
          'answering a permission prompt is the human’s call; no session may grant a tool call, ' +
          'its own or a peer’s' +
          this.refusalHint(conn, 'approve_permission'),
      })
    }
    reply(conn, { t: 'answer_result', ...this.permissionVerdict(msgId, behavior) })
  }

  /**
   * The one permission arbiter, shared by the socket's `approve_permission` and
   * the owner-console HTTP route (TP-1989). Who may reach it is the caller's
   * check; whether the prompt is still open is this one's, so a second verdict
   * loses here whichever channel sent it. `channel` labels the resolution row
   * and the log line for audit and changes no check.
   */
  permissionVerdict(msgId: string, behavior: PermissionBehavior, channel?: string): VerdictResult {
    const request = this.core.events.openApproval(msgId)
    if (!request) {
      return {
        ok: false,
        reason: `${msgId} is not an open permission prompt — it may have been answered already, or aged out`,
      }
    }
    if (request.source === 'hook') return this.answerHook(msgId, request.toolName, behavior, channel)
    return this.answerSession(msgId, request, behavior, channel)
  }

  /** The verdict on a channel-raised row goes to the prompting session ALONE; see `handleApprovePermission`. */
  private answerSession(
    msgId: string,
    request: Extract<OpenApproval, { source: 'channel' }>,
    behavior: PermissionBehavior,
    channel: string | undefined,
  ): VerdictResult {
    const target = this.core.registry.connFor(request.session)
    if (!target) {
      return {
        ok: false,
        reason: `${request.session} is no longer connected, so its prompt cannot be answered from here`,
      }
    }
    this.core.append({ kind: 'resolution', actor: HUMAN, ref: msgId, body: behavior, ...auditMeta(channel) })
    reply(target, { t: 'permission_verdict', requestId: request.requestId, behavior })
    this.core.registry.setAwaitingApproval(target, false)
    logEvent('permission_verdict', {
      msgId,
      to: request.session,
      tool: request.toolName,
      behavior,
      ...(channel === undefined ? {} : { channel }),
    })
    return { ok: true, reason: `${request.toolName} ${behavior} sent to ${request.session}` }
  }

  /** The verdict on a hook-raised row goes to the hook's own connection; the session's MCP server never asked. */
  private answerHook(
    msgId: string,
    toolName: string,
    behavior: PermissionBehavior,
    channel: string | undefined,
  ): VerdictResult {
    const wait = this.hooks.get(msgId)
    if (!wait) {
      return {
        ok: false,
        reason: `${msgId} has no hook waiting on it any more, so the verdict has nowhere to go`,
      }
    }
    this.core.append({ kind: 'resolution', actor: HUMAN, ref: msgId, body: behavior, ...auditMeta(channel) })
    this.settleHook(msgId, behavior)
    logEvent('permission_verdict', {
      msgId,
      to: wait.session,
      tool: toolName,
      behavior,
      source: 'hook',
      ...(channel === undefined ? {} : { channel }),
    })
    return { ok: true, reason: `${toolName} ${behavior} sent to ${wait.session}` }
  }

  /** Release a waiting hook with `behavior`, if one is waiting on `msgId`. The row is closed by the caller. */
  private settleHook(msgId: string, behavior: PermissionBehavior): void {
    const wait = this.hooks.get(msgId)
    if (!wait) return
    this.hooks.delete(msgId)
    reply(wait.conn, { t: 'permission_verdict', requestId: msgId, behavior })
    const session = this.core.registry.connFor(wait.session)
    if (session) this.core.registry.setAwaitingApproval(session, false)
  }

  /**
   * A headless agent's PermissionRequest hook, asking the human (CC-144).
   *
   * Only from an UNREGISTERED connection. The hook never registers, so it holds no
   * name to send or spawn with; a registered session is refused because it would be
   * using its own connection to file a prompt under whatever `session` it typed.
   * CC-1138: a hook that declared an agent id files only under that agent's name.
   */
  private handlePermissionHook(conn: Conn, msg: Extract<ClientMessage, { t: 'permission_hook' }>): void {
    if (!this.admits(conn, msg.t, msg.session)) {
      this.refuseToSession(conn, 'raise a permission prompt through the hook frame')
      return reply(conn, {
        t: 'permission_hook_result',
        ok: false,
        reason:
          'permission_hook comes from a PermissionRequest hook, which never registers; a session cannot send it' +
          this.refusalHint(conn, msg.t),
      })
    }
    const { core } = this
    const { msgId } = core.append({
      kind: 'approval_request',
      actor: msg.session,
      target: HUMAN,
      body: `${msg.toolName}: ${msg.description ?? ''}`,
      meta: { source: 'hook', tool_name: msg.toolName, input_preview: JSON.stringify(msg.toolInput) },
    })
    this.hooks.set(msgId, { conn, session: msg.session })
    const session = core.registry.connFor(msg.session)
    if (session) core.registry.setAwaitingApproval(session, true)
    logEvent('approval_request', { msgId, from: msg.session, tool: msg.toolName, source: 'hook' })
    this.noticePermissionWaiting(msg, msgId)
    reply(conn, { t: 'permission_hook_result', ok: true, msgId })
  }

  /**
   * The audit row for a call the hook allowed itself (CC-694). Nobody waits on it,
   * so the request is closed by an `allow` resolution in the same breath; the
   * resolution's actor is the agent, never HUMAN, because no human decided. It has
   * no target: the mirror, the queue view and the digest all key on target human,
   * and an open-then-close pair there would post an ask the owner never had.
   */
  private handlePermissionSelfGranted(
    conn: Conn,
    msg: Extract<ClientMessage, { t: 'permission_self_granted' }>,
  ): void {
    if (!this.admits(conn, msg.t, msg.session)) {
      this.refuseToSession(conn, 'record a self-granted permission')
      return reply(conn, {
        t: 'permission_hook_result',
        ok: false,
        reason:
          'permission_self_granted comes from a PermissionRequest hook; a session cannot send it' +
          this.refusalHint(conn, msg.t),
      })
    }
    const refusal = selfGrantFrameRefusal(msg as unknown as Record<string, unknown>)
    if (refusal !== undefined) {
      logEvent('bad_message', { t: 'permission_self_granted', error: refusal })
      return reply(conn, { t: 'permission_hook_result', ok: false, reason: refusal })
    }
    const { core } = this
    const { msgId } = core.append({
      kind: 'approval_request',
      actor: msg.session,
      body: `${msg.toolName}: self-granted (${msg.grant})`,
      meta: {
        source: 'self-grant',
        grant: msg.grant,
        tool_name: msg.toolName,
        input_preview: JSON.stringify(msg.toolInput),
      },
    })
    core.append({
      kind: 'resolution',
      actor: msg.session,
      ref: msgId,
      body: 'allow',
      meta: { reason: `self-grant: ${msg.grant}` },
    })
    logEvent('permission_self_granted', { msgId, from: msg.session, tool: msg.toolName, grant: msg.grant })
    reply(conn, { t: 'permission_hook_result', ok: true, msgId })
  }

  /** CC-610: the spawner of a parked agent hears about it; a human spawner already has the queue. */
  private noticePermissionWaiting(
    msg: Extract<ClientMessage, { t: 'permission_hook' }>,
    approvalRef: string,
  ): void {
    const { core } = this
    const session = core.registry.connFor(msg.session)
    const agentId = session === undefined ? undefined : core.registry.entryFor(session)?.agentId
    const identity = agentId === undefined ? core.agents.byName(msg.session) : core.agents.get(agentId)
    const spawner = identity?.spawnedBy
    if (spawner === undefined || spawner === HUMAN) return
    const text = permissionNoticeText({
      agent: msg.session,
      toolName: msg.toolName,
      toolInput: msg.toolInput,
    })
    const meta = {
      event: PERMISSION_WAITING,
      agent: msg.session,
      tool: msg.toolName,
      approval_ref: approvalRef,
    }
    const { msgId } = core.append({ kind: 'message', actor: 'agent-chat', target: spawner, body: text, meta })
    core.deliverTo(spawner, { msgId, from: 'agent-chat', text, at: Date.now(), event: PERMISSION_WAITING })
    logEvent(PERMISSION_WAITING, { msgId, agent: msg.session, spawner, tool: msg.toolName })
  }

  /**
   * A process that is not a session asks the human under a label (CC-169).
   *
   * Only from an UNREGISTERED connection, as `permission_hook`: a session asks
   * with `ask`, under its own name and budget. The label is not vouched for.
   */
  private handleServiceAsk(conn: Conn, msg: Extract<ClientMessage, { t: 'service_ask' }>): void {
    if (!this.admits(conn, msg.t)) {
      this.refuseToSession(conn, 'ask the human through the service_ask frame')
      return reply(conn, {
        t: 'service_ask_result',
        ok: false,
        reason:
          'service_ask is for processes that never register; a session asks with ask' +
          this.refusalHint(conn, msg.t),
      })
    }
    const held = this.serviceAsks.get(conn) ?? new Set<string>()
    this.serviceAsks.set(conn, held)
    reply(conn, { t: 'service_ask_result', ...fileServiceAsk(this.core, msg, held) })
  }

  /**
   * TP-4256, Class 4: the launch nonce is the guard, so any connection may send it. A malformed
   * frame denies without touching the ledger; a changed file denies, and the ledger files one owner
   * notice on the check that quarantines the agent.
   */
  private handleIntegrityCheck(conn: Conn, msg: Extract<ClientMessage, { t: 'integrity_check' }>): void {
    const refusal = integrityFrameRefusal(msg as unknown as Record<string, unknown>)
    if (refusal !== undefined) return reply(conn, { t: 'integrity_result', ok: false, reason: refusal })
    this.settingsWatch.sweep()
    const result = this.integrity.check(msg.nonce, msg.session, msg.records)
    if (!result.ok && this.wouldDeny !== undefined)
      this.wouldDeny({
        agentId: this.integrity.agentOf(msg.nonce) ?? '',
        reason: verdictReason(result),
        call: 'hook',
      })
    if (result.ok || this.wouldDeny !== undefined) return reply(conn, { t: 'integrity_result', ok: true })
    if (result.reason === 'no baseline')
      return reply(conn, { t: 'integrity_result', ok: false, reason: result.reason })
    reply(conn, {
      t: 'integrity_result',
      ok: false,
      reason: result.reason,
      file: result.file,
      field: result.field,
    })
  }

  /**
   * TP-4256 A3, Class 4: the sweep runs first, so a launch file changed since the last tick (a
   * plan.json that drops `--settings`) latches before the verdict is read. The ledger is consulted
   * before the caller's path: an agent it knows is always answered by `verdict`.
   */
  private handleIntegrityRelaunch(conn: Conn, msg: { agentId?: unknown; agentDir?: unknown }): void {
    const t = 'integrity_relaunch_result'
    if (typeof msg.agentId !== 'string' || typeof msg.agentDir !== 'string')
      return reply(conn, { t, ok: false, reason: 'malformed integrity_relaunch' })
    this.settingsWatch.sweep()
    if (!this.integrity.knows(msg.agentId) && offBrokerDir(msg.agentId, msg.agentDir))
      return reply(conn, { t, ok: true, offBroker: true })
    const verdict = this.integrity.verdict(msg.agentId)
    if (!verdict.ok && this.wouldDeny !== undefined)
      this.wouldDeny({ agentId: msg.agentId, reason: verdictReason(verdict), call: 'relaunch' })
    if (verdict.ok || this.wouldDeny !== undefined) return reply(conn, { t, ok: true })
    if (verdict.reason === 'no baseline') return reply(conn, { t, ok: false, reason: verdict.reason })
    reply(conn, { t, ok: false, reason: verdict.reason, file: verdict.file, field: verdict.field })
  }

  /**
   * Appended as the broker, like `noteBuildMismatch`: `enqueueForHuman` needs a registered sender and
   * answers with `send_result`, and the hook is neither.
   */
  private noticeQuarantine(agentId: string, mismatch: { file: string; field: string }): void {
    const agent = this.core.agents.get(agentId)?.name ?? agentId
    logEvent('integrity_quarantine', { agent, agentId, file: mismatch.file, field: mismatch.field })
    // TP-4347: a shadow latch files no owner notice; the refusal it leads to is the would_deny row.
    if (INTEGRITY_MODE === 'shadow') return
    this.core.append({
      kind: 'notice',
      actor: 'agent-chat',
      target: HUMAN,
      body:
        `${agent}: ${mismatch.file} changed (${mismatch.field}) between two tool calls. A later shell ` +
        'sources it, so every later Bash, Edit and Write call of this agent and its children is denied, ' +
        'whatever it relaunches as. Nothing was restored. Inspect the file, then your own ' +
        '`agent-chat agent resume` re-baselines.',
      meta: {
        event: INTEGRITY_QUARANTINE,
        agent,
        agent_id: agentId,
        file: mismatch.file,
        field: mismatch.field,
      },
    })
  }

  /** CC-169: a pure read like `activity`; an unknown `after` is an error, never a replay from row 0. */
  private answersSince(msg: Extract<ClientMessage, { t: 'answers_since' }>): ServerMessage {
    const events = this.core.events
    const afterId = msg.after === undefined ? 0 : events.rowIdOf(msg.after)
    if (afterId === undefined)
      return { t: 'answers_since_result', answers: [], error: `no message ${msg.after}` }
    const limit = Math.max(1, Math.min(msg.limit, WATCH_MAX_BATCH))
    const answers = events.answersFor(msg.name, afterId, limit)
    const next = answers.at(-1)?.msgId
    return { t: 'answers_since_result', answers, ...(next ? { next } : {}) }
  }

  /** Only the connection that raised a row may withdraw it; anyone else learns nothing about it. */
  private handlePermissionHookWithdrawn(conn: Conn, msgId: string): void {
    if (this.hooks.get(msgId)?.conn !== conn) {
      return reply(conn, {
        t: 'permission_hook_result',
        ok: false,
        reason: `${msgId} is not a prompt you raised`,
      })
    }
    this.withdrawHook(msgId, 'hook withdrew')
    reply(conn, { t: 'permission_hook_result', ok: true, msgId })
  }

  /** Close a hook row nobody answered, so it never waits on APPROVAL_TTL_MS to leave the queue. */
  private withdrawHook(msgId: string, reason: string): void {
    const wait = this.hooks.get(msgId)
    if (!wait) return
    this.hooks.delete(msgId)
    if (this.core.events.isOpen(msgId))
      this.core.append({
        kind: 'resolution',
        actor: wait.session,
        ref: msgId,
        body: HOOK_WITHDRAWN,
        meta: { reason },
      })
    const session = this.core.registry.connFor(wait.session)
    if (session) this.core.registry.setAwaitingApproval(session, false)
    logEvent('permission_hook_withdrawn', { msgId, session: wait.session, reason })
  }

  private dropHooks(conn: Conn): void {
    for (const [msgId, wait] of this.hooks)
      if (wait.conn === conn) this.withdrawHook(msgId, 'hook disconnected')
  }

  /**
   * The human has no registration to route from, so this bypasses the ordinary
   * registry sender check on `send` — which is exactly why it needs its OWN
   * check instead of none at all. CC-22's adversarial review found this had
   * NONE: any connection, registered or not, could forge `from: HUMAN` AND
   * override do-not-disturb, with no CLI or endorsement flow involved. See
   * `admits` for what the fix below does and does not guarantee.
   */
  private handleHumanSend(conn: Conn, to: string, text: string, source?: WakeSource): void {
    if (!this.admits(conn, 'human_send')) {
      this.refuseToSession(conn, 'send a message as the human')
      return reply(conn, {
        t: 'send_result',
        ok: false,
        recipients: [],
        reason:
          'sending as the human is the human’s call; a session cannot speak with that authority' +
          this.refusalHint(conn, 'human_send'),
      })
    }
    const { core } = this
    const target = core.registry.connFor(to)
    if (!target) {
      // CC-441: the watchdog's wake for a seat it just resumed visibly lands here before the seat registers.
      // CC-1501: every human send, mapped seat or not, keeps the seat's own hold; only peer mail is queued.
      const held = core.holdForSeat(HUMAN, to, text, undefined, source)
      if (held?.ok) return replyHeld(conn, to, held.msgId)
      return this.failHumanSend(conn, to, held?.reason)
    }
    const { msgId } = core.append({
      kind: 'message',
      actor: HUMAN,
      target: to,
      body: text,
      ...(source === undefined ? {} : { meta: { source } }),
    })
    // The human overrides do-not-disturb and no agent can. Scarcity has to be
    // structural: if any peer could mark a message urgent, every message would be
    // urgent within a day. There is simply no parameter for it on the agent path.
    core.deliverTo(to, {
      msgId,
      from: HUMAN,
      text,
      at: Date.now(),
      ...(source === undefined ? {} : { wakeSource: source }),
    })
    logEvent('route', { kind: 'message', msgId, from: HUMAN, to, delivered: true, recipients: [to] })
    reply(conn, { t: 'send_result', ok: true, msgId, recipients: [to] })
  }

  /**
   * CC-1452: a refused hold's reason reaches the row and the sender. The text stays out of the
   * row: the hold refused to keep it, so storing it here would be a hold with no bound.
   */
  private failHumanSend(conn: Conn, to: string, holdRefusal?: string): void {
    const reason = holdRefusal ?? `no active session named "${to}"`
    const { msgId } = this.core.append({
      kind: 'route_failed',
      actor: HUMAN,
      target: to,
      body: holdRefusal ?? 'no active session',
      ...(holdRefusal === undefined ? {} : { meta: { held: 'refused' } }),
    })
    logEvent('route', {
      kind: 'message',
      msgId,
      from: HUMAN,
      to,
      delivered: false,
      recipients: [],
      ...(holdRefusal === undefined ? {} : { held: 'refused' }),
    })
    reply(conn, { t: 'send_result', ok: false, recipients: [], reason })
  }

  /**
   * A permission dialog opened in this session. Recorded, never answered from
   * here: the only verdict path is `approve_permission`, which a session cannot
   * reach. Because `request_id` is never rendered in the terminal dialog, a
   * channel server is the only thing on the machine that can enumerate these.
   */
  private handleApproval(conn: Conn, msg: Extract<ClientMessage, { t: 'approval' }>): void {
    const { core } = this
    const from = core.registry.nameOf(conn)
    if (!from) return
    core.registry.setAwaitingApproval(conn, true)

    const { msgId } = core.append({
      kind: 'approval_request',
      actor: from,
      target: HUMAN,
      body: `${msg.toolName}: ${msg.description}`,
      meta: { request_id: msg.requestId, tool_name: msg.toolName, input_preview: msg.inputPreview },
    })
    logEvent('approval_request', { msgId, from, requestId: msg.requestId, tool: msg.toolName })
  }

  /**
   * Tell a session that the broker has no registration for it (CC-83).
   *
   * THE FAILURE THIS CLOSES. `BrokerClient.onDrop()` already replays the identity,
   * but it fires only from the socket's own close/error handlers. A connection the
   * BROKER dropped without the client observing a close leaves `onDrop` unfired,
   * the client believing it is registered, and the session invisible to every peer
   * while looking perfectly healthy from inside. Observed live 2026-08-11:
   * voltras-bench deregistered at 06:39:12 with its MCP subprocess still connected,
   * and never came back.
   *
   * Sent ALONGSIDE the ordinary typed refusal rather than instead of it, so no
   * result shape changes and the caller's pending request still gets its answer.
   * The frame is advice to the client library, not an answer to the request.
   *
   * Costs nothing when healthy: a registered connection never reaches the reply.
   */
  private hintUnregistered(conn: Conn, msg: ClientMessage): void {
    if (!SESSION_FRAMES.has(msg.t)) return
    if (this.core.registry.nameOf(conn) !== undefined) return
    reply(conn, {
      t: 'error',
      code: 'not_registered',
      reason:
        `the broker has no registration for this connection, so "${msg.t}" was refused. ` +
        'If you hold an identity, register again — nothing about your session has to restart.',
    })
  }

  /** CC-886: oldest-first read of what followed `after`; one extra row detects truncation. */
  private inboxAfter(
    name: string | undefined,
    after: string,
    limit: number,
  ): Extract<ServerMessage, { t: 'inbox_result' }> {
    const events = this.core.events
    const afterId = name ? events.inboxRowId(name, after) : undefined
    if (!name || afterId === undefined) {
      return { t: 'inbox_result', messages: [], error: `no message ${after} in your inbox` }
    }
    const rows = events.inboxSince(name, afterId, limit + 1)
    const messages = rows.slice(0, limit).map(({ id: _id, ...message }) => message)
    return { t: 'inbox_result', messages, ...(rows.length > limit ? { truncated: true } : {}) }
  }

  /** CC-524: read before `core.register`, which mints an identity for a session that has none. */
  private returning(msg: Extract<ClientMessage, { t: 'register' }>): boolean {
    try {
      return returningSession(this.core, msg)
    } catch (err) {
      logEvent('handoff_recovery_failed', { name: msg.name, error: (err as Error).message })
      // Unknown reads as returning: a name match still shows, and no directory match goes out on a guess.
      return true
    }
  }

  /** CC-524: recovery adds to a registration that already succeeded, so a failed read is logged and dropped. */
  private showUndeliveredHandoff(msg: Extract<ClientMessage, { t: 'register' }>, returning: boolean): void {
    try {
      recoverHandoff(this.core, msg, { returning })
    } catch (err) {
      logEvent('handoff_recovery_failed', { name: msg.name, error: (err as Error).message })
    }
  }

  handleMessage(conn: Conn, msg: ClientMessage): void {
    const { core } = this
    core.registry.touch(conn)
    // A session blocked on a dialog cannot call tools, so anything else it sends
    // proves the dialog closed — the only unblock signal Claude Code gives us.
    if (msg.t !== 'approval' && core.registry.isAwaitingApproval(conn))
      core.registry.setAwaitingApproval(conn, false)
    this.hintUnregistered(conn, msg)
    switch (msg.t) {
      case 'register': {
        if (this.refuseLauncherRegister(conn)) return
        // Closing the displaced socket is what makes a takeover final: leaving it
        // open would let the predecessor keep writing under a name it no longer
        // holds. `end` rather than `destroy` so the fatal frame is flushed first
        // — the predecessor has to learn why, or it just reconnects and takes the
        // name back. CC-951: a tick later, so a remote predecessor's `endSelf`,
        // answered on this registration's attach, is written ahead of the close.
        const dark = core.darkSeat(msg.name)
        const returning = this.returning(msg)
        const result = core.register(conn, msg, stale =>
          setImmediate(() =>
            stale.end(encode({ t: 'error', reason: `superseded by a resume of "${msg.name}"`, fatal: true })),
          ),
        )
        if (result.ok) this.noteBuildMismatch(msg.name, msg.build)
        reply(conn, { t: 'register_result', ...result })
        if (result.ok) core.deliverStranded(msg.name)
        if (result.ok && dark !== undefined) core.deliverHeld(msg.name, dark)
        if (result.ok) this.showUndeliveredHandoff(msg, returning)
        return
      }
      case 'readopt':
        if (this.refuseLauncherRegister(conn)) return
        return this.handleReadopt(conn, msg)
      case 'status':
        return reply(conn, {
          t: 'status_result',
          ok: core.registry.setStatus(conn, msg.status, msg.workingOn, msg.dnd, msg.declared),
        })
      case 'list': {
        const claims = core.claims.list()
        return reply(conn, {
          t: 'list_result',
          sessions: core.registry.list(),
          slots: this.supervisor.slotUsage(),
          ...(claims.length === 0 ? {} : { claims }),
        })
      }
      case 'claim':
        void this.handleClaim(conn, msg)
        return
      case 'release':
        return this.handleRelease(conn, msg)
      case 'tag':
        return this.handleTag(conn, msg)
      case 'subscribe':
        return reply(conn, { t: 'subscribe_result', ...core.registry.subscribe(conn, msg.subscriptions) })
      case 'unsubscribe':
        return reply(conn, { t: 'subscribe_result', ...core.registry.unsubscribe(conn, msg.selector) })
      case 'send':
        return this.keyed(conn, msg, () => this.routeSend(conn, msg))
      case 'broadcast':
        return this.handleRoute(conn, core.registry.broadcast(conn, msg.text), 'broadcast', '*')
      case 'ask':
        return this.enqueueForHuman(conn, 'question', msg.text, msg)
      case 'notify':
        return this.enqueueForHuman(conn, 'notice', msg.text, { kind: msg.kind, task: msg.task })
      case 'endorse':
        return this.handleEndorseRequest(conn, msg)
      case 'endorse_approve':
        return this.handleEndorseApprove(conn, msg.msgId, { text: msg.text, to: msg.to })
      case 'inbox': {
        const name = core.registry.nameOf(conn)
        if (msg.after !== undefined) return reply(conn, this.inboxAfter(name, msg.after, msg.limit))
        return reply(conn, { t: 'inbox_result', messages: name ? core.events.inboxFor(name, msg.limit) : [] })
      }
      case 'queue':
        return reply(conn, {
          t: 'queue_result',
          items: core.events.humanQueue(),
          decided: core.events.decidedQueue(),
        })
      case 'decided':
        return this.handleDecided(conn, msg)
      case 'answer':
        return this.handleAnswer(conn, msg.msgId, msg.text, msg.channel)
      case 'dismiss':
        return this.handleDismiss(conn, msg.msgId)
      case 'approve_permission':
        return this.handleApprovePermission(conn, msg.msgId, msg.behavior)
      case 'history':
        return reply(conn, { t: 'history_result', items: core.events.history(msg.limit) })
      case 'inbox_since': {
        // Head read BEFORE the rows, never after. Read after, a message landing
        // between the two would sit below a cursor that had already advanced
        // past it, and a watcher would never show it — the exact silent loss
        // this command exists to end.
        const head = core.events.latestId()
        const limit = Math.max(1, Math.min(msg.limit, WATCH_MAX_BATCH))
        const messages = core.events.inboxSince(msg.name, msg.afterId, limit)
        return reply(conn, {
          t: 'inbox_since_result',
          messages,
          nextCursor: nextWatchCursor({
            head,
            // Falls back to 0, never to `afterId`: an empty read must resolve to
            // the head so a quiet inbox still advances, and carrying `afterId`
            // forward would pin the cursor wherever a caller pointed it.
            lastReturned: messages.at(-1)?.id ?? 0,
            truncated: messages.length === limit,
          }),
        })
      }
      case 'message_by_id': {
        const message = core.events.messageById(msg.msgId)
        return reply(conn, { t: 'message_by_id_result', ...(message ? { message } : {}) })
      }
      case 'activity': {
        // Deliberately no deliver() anywhere on this path: reading a peer must
        // cost that peer nothing, or observing and interrupting stay the same act.
        const session = core.registry.list().find(s => s.name === msg.name)
        return reply(conn, {
          t: 'activity_result',
          ...(session ? { session } : {}),
          events: core.events.activityFor(msg.name, msg.limit),
        })
      }
      case 'reported':
        return reply(conn, {
          t: 'reported_result',
          reported: core.events.hasStatusReport(msg.from, [msg.to], msg.since),
        })
      case 'human_send':
        return this.handleHumanSend(conn, msg.to, msg.text, wakeSource(msg.source))
      case 'approval':
        return this.handleApproval(conn, msg)
      case 'permission_hook':
        return this.handlePermissionHook(conn, msg)
      case 'permission_hook_withdrawn':
        return this.handlePermissionHookWithdrawn(conn, msg.msgId)
      case 'permission_self_granted':
        return this.handlePermissionSelfGranted(conn, msg)
      case 'service_ask':
        return this.handleServiceAsk(conn, msg)
      case 'integrity_check':
        return this.handleIntegrityCheck(conn, msg)
      case 'integrity_relaunch':
        return this.handleIntegrityRelaunch(conn, msg)
      case 'answers_since':
        return reply(conn, this.answersSince(msg))
      case 'spawn':
        void this.handleSpawn(conn, msg)
        return
      case 'agents':
        return reply(conn, {
          t: 'agents_result',
          ...(msg.view === undefined
            ? { agents: core.agents.roster({ includeRetired: msg.includeRetired ?? false }) }
            : viewRoster(core.agents.roster({ includeRetired: true }), msg.view)),
          slots: this.supervisor.slotUsage(),
          ...(msg.costs === true ? { costs: this.supervisor.agentCosts() } : {}),
        })
      case 'teleport':
        void this.handleTeleport(conn, msg)
        return
      case 'teleport_abort':
        return this.handleTeleportAbort(conn, msg.name)
      case 'account_move':
      case 'account_move_check':
        void this.handleAccountMove(conn, msg)
        return
      case 'codex_wake_capped':
        return this.handleCodexWakeCapped(conn, msg)
      case 'teleport_plan_wait':
        void this.handleTeleportPlanWait(conn)
        return
      case 'teleport_launched':
        return this.handleTeleportLaunched(conn, msg)
      case 'spawn_launched':
        return this.handleSpawnLaunched(conn, msg)
      case 'spawn_placed':
        void this.handleSpawnPlaced(conn, msg)
        return
      case 'teleport_land_failed':
        return this.handleTeleportLandFailed(conn, msg)
      case 'host_challenge':
        return this.handleHostChallenge(conn)
      case 'host_hello':
        return this.handleHostHello(conn, msg)
      case 'host_probe_result':
      case 'host_launch_result':
        this.hosts.answer(conn, msg.id, {
          ok: msg.ok === true,
          ...(msg.reason === undefined ? {} : { reason: String(msg.reason) }),
          ...transcriptVerdictOf(msg),
          ...missingOf(msg),
        })
        return
      case 'hosts':
        return reply(conn, { t: 'hosts_result', hosts: this.hosts.list() })
      case 'job_kick':
        return this.handleJobKick(conn, msg)
      case 'hello':
        return this.handleHello(conn, msg.agentId)
      case 'surface':
        return this.answerSwitch(conn, this.handleSurface(conn, msg.name))
      case 'background':
        return this.answerSwitch(conn, this.handleBackground(conn))
      case 'resume':
        return this.keyed(conn, msg, () => this.handleResume(conn, msg))
      case 'park': {
        const requester = this.class2RequesterOf(conn)
        if (isRefusal(requester))
          return reply(conn, { t: 'spawn_result', ok: false, reason: requester.refusal })
        void this.supervisor
          .park(msg.name, {
            requestedBy: requester?.name ?? HUMAN,
            ...this.ownershipOf(requester),
            ...(msg.noFixRoundCheck === true ? { noFixRoundCheck: true } : {}),
          })
          .then(result =>
            reply(conn, {
              t: 'spawn_result',
              ok: result.ok,
              ...(result.reason === undefined ? {} : { reason: result.reason }),
            }),
          )
        return
      }
      case 'retire_finished': {
        // CC-1138: the requester fields come from the connection only, never from the frame.
        const {
          t: _kind,
          requesterAgentId: _id,
          requesterBinding: _binding,
          ...req
        } = msg as typeof msg & Record<'requesterAgentId' | 'requesterBinding', unknown>
        const requester = this.class2RequesterOf(conn)
        if (isRefusal(requester))
          return reply(conn, {
            t: 'retire_finished_result',
            ok: false,
            reason: requester.refusal,
            plan: [],
            results: [],
          })
        const caller = requester?.name
        void this.supervisor
          .retireFinished({
            ...req,
            ...(caller === undefined ? {} : { caller }),
            ...this.ownershipOf(requester),
          })
          .then(outcome => reply(conn, { t: 'retire_finished_result', ...outcome }))
          .catch((err: Error) =>
            reply(conn, {
              t: 'retire_finished_result',
              ok: false,
              reason: err.message,
              plan: [],
              results: [],
            }),
          )
        return
      }
      case 'retire': {
        const requester = this.class2RequesterOf(conn)
        if (isRefusal(requester))
          return reply(conn, { t: 'spawn_result', ok: false, reason: requester.refusal })
        const actor = requester?.name ?? (msg.caller || undefined)
        const agentId = msg.agentId
        const claim = {
          ...(actor === undefined ? {} : { requestedBy: actor }),
          ...this.ownershipOf(requester),
        }
        void (
          agentId === undefined
            ? this.supervisor.retire(msg.name, msg.force === true, actor, claim)
            : this.supervisor.retireStale(agentId, msg.name, actor, claim)
        ).then(result =>
          reply(conn, {
            t: 'spawn_result',
            ok: result.ok,
            ...(agentId === undefined ? {} : { agentId, name: msg.name }),
            ...(result.reason === undefined ? {} : { reason: result.reason }),
          }),
        )
        return
      }
    }
  }

  private routeSend(conn: Conn, msg: Extract<ClientMessage, { t: 'send' }>): void {
    const { core } = this
    const refusal = sendMetaRefusal(msg)
    if (refusal !== undefined)
      return reply(conn, { t: 'send_result', ok: false, recipients: [], reason: refusal })
    const meta = sendMeta(msg)
    // Tag addressing resolves to a set of names and then goes down the very
    // same multicast path, so there is exactly one fanout implementation to
    // keep budgeted. A tag matching nobody comes back ok:false from there.
    if (msg.toTag !== undefined) {
      return this.handleRoute(
        conn,
        core.registry.multicastTag(conn, msg.toTag, msg.text, msg.inReplyTo),
        'message',
        `tag ${msg.toTag}`,
        { tag: msg.toTag, meta },
      )
    }
    if (msg.to === undefined) {
      return reply(conn, {
        t: 'send_result',
        ok: false,
        recipients: [],
        reason: 'name a recipient in `to`, or a tag in `toTag`',
      })
    }
    if (msg.to === HUMAN) return this.enqueueForHuman(conn, 'message', msg.text)
    if (!Array.isArray(msg.to))
      return this.handleSend(conn, msg.to, msg.text, { inReplyTo: msg.inReplyTo, meta })
    // The human is a queue, not a session, and a multicast is a fan-out to
    // sessions. Splitting one call across both write paths is where the bugs
    // would live, so the whole call is refused rather than half-honoured.
    if (msg.to.includes(HUMAN)) {
      return reply(conn, {
        t: 'send_result',
        ok: false,
        recipients: [],
        reason:
          `"${HUMAN}" cannot be one of several recipients — the human is a queue, not a session. ` +
          'Send to the peers in one call and use chat_notify or chat_ask for the human.',
      })
    }
    return this.handleRoute(
      conn,
      core.registry.multicast(conn, msg.to, msg.text, msg.inReplyTo),
      'message',
      msg.to.join(', '),
      { meta },
    )
  }

  /** CC-1454: a frame with a nonce runs once per requester and key; a retry joins or replays it. */
  private keyed(conn: Conn, msg: KeyedFrame, run: () => void | Promise<void>): void {
    if (msg.nonce === undefined) return void run()
    const refusal = nonceRefusal(msg.nonce)
    if (refusal !== undefined) return reply(conn, keyedRefusal(msg.t, refusal))
    const requester = this.core.registry.entryFor(conn)
    const key = dedupeKey(msg.t, requester?.agentId ?? requester?.name ?? HUMAN, msg.nonce)
    const outer = requestScope.getStore()
    const joiner: KeyedJoiner =
      outer?.conn === conn && outer.rid !== undefined ? { conn, rid: outer.rid } : { conn }
    const begun = this.dedupe.begin(key, requestFingerprint(msg), joiner)
    if (begun.kind !== 'run') logEvent('dedupe', { verb: msg.t, nonce: msg.nonce, outcome: begun.kind })
    if (begun.kind === 'replay') return answerKeyed(joiner, begun.reply)
    if (begun.kind === 'mismatch') {
      const reason = `idempotency key ${msg.nonce} was already used for a different request`
      return reply(conn, keyedRefusal(msg.t, reason))
    }
    if (begun.kind === 'run')
      this.runKeyed({ ...outer, conn, nonce: msg.nonce }, key, KEYED_REPLY[msg.t], run)
  }

  /** Runs the first keyed request, keeping its first reply of `replyType` for the retries. */
  private runKeyed(
    scope: { conn: Conn; rid?: number; nonce: string },
    key: string,
    replyType: KeyedReply['t'],
    run: () => void | Promise<void>,
  ): void {
    let settled = false
    const record = (message: ServerMessage): void => {
      if (settled || message.t !== replyType) return
      settled = true
      for (const joiner of this.dedupe.settle(key, message as KeyedReply))
        answerKeyed(joiner, message as KeyedReply)
    }
    const done = (): void => {
      if (!settled) this.dedupe.abandon(key)
    }
    requestScope.run({ ...scope, record }, () => {
      const result = run()
      if (result instanceof Promise) void result.finally(done)
      else done()
    })
  }

  /** CC-1059: a closed requester reports nothing more; its pending spawns expire on their own timers. */
  private dropRemoteSpawners(conn: Conn): void {
    for (const [agentId, owner] of this.remoteSpawners)
      if (owner === conn) this.remoteSpawners.delete(agentId)
  }

  onConnection(conn: Conn): void {
    const { core } = this
    const read = lineReader<ClientMessage & Correlated>(
      ({ rid, ...msg }) =>
        typeof rid === 'number'
          ? requestScope.run({ conn, rid }, () => this.handleMessage(conn, msg as ClientMessage))
          : this.handleMessage(conn, msg as ClientMessage),
      err => logEvent('bad_message', { error: err.message }),
    )
    conn.on('data', read)

    const drop = (): void => {
      this.declared.drop(conn)
      this.dropHooks(conn)
      this.hosts.drop(conn)
      this.dropRemoteSpawners(conn)
      core.drop(conn)
    }
    conn.on('close', drop)
    conn.on('error', drop)
  }
}
