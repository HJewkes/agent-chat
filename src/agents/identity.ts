import type { AgentEventRow, EventStore } from '../broker/event-store.js'
import {
  launcherOf,
  type AgentIdentity,
  type AgentLifecycle,
  type AgentOrigin,
  type Launcher,
} from '../protocol.js'
import { inferWorkRole } from './spawn-provenance.js'
import { crashLoopOf } from './crash-loop.js'

/**
 * The durable half of an agent: who it is, not whether it is currently plugged
 * in. A pure projection of the event log, in the same spirit as `humanQueue()`
 * and `openCount()` — nothing here is stored state.
 *
 * The split is the whole design. Presence lives in the registry and dies with a
 * socket; identity lives in the log and outlives the process. Pairing them is
 * `pairPresence()` below, and it happens at render time so that a broker restart
 * changes an agent's presence without ever making it disappear from the roster.
 */

/** Which row carries the agent id, by kind: the spawn row mints it, the rest cite it. */
const agentIdOf = (row: AgentEventRow): string | null => (row.kind === 'agent_spawned' ? row.msgId : row.ref)

const numberOrUndefined = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}

/** `agent_exited.meta.code` is absent for a signal death, which is not the same as 0. */
const exitFrom = (row: AgentEventRow): NonNullable<AgentIdentity['exit']> => {
  const code = numberOrUndefined(row.meta.code)
  const costUsd = numberOrUndefined(row.meta.cost_usd)
  return {
    code: code ?? null,
    summary: row.body ?? '',
    ...(costUsd === undefined ? {} : { costUsd }),
    // CC-95: written only by the supervisor's attach verification, so the roster
    // can say `failed` rather than `finished` for a process that never came up.
    ...(row.meta.failed === 'true' ? { failedToStart: true } : {}),
    ...(row.meta.inferred === 'true' ? { inferred: true } : {}),
  }
}

/**
 * Anything without the marker is a supervisor spawn. Rows written before this
 * field existed are all supervisor spawns, so the default is not a guess.
 */
const originOf = (row: AgentEventRow): AgentOrigin => (row.meta.origin === 'adopted' ? 'adopted' : 'spawned')

/**
 * Generation is 1 unless the spawn row was stamped by a teleport. Rows written
 * before teleport existed have no stamp, and 1 is the truth for them rather than
 * a guess: an identity nothing ever succeeded IS the first of its line.
 */
const generationOf = (row: AgentEventRow): number => {
  const value = Number.parseInt(row.meta.generation ?? '1', 10)
  return Number.isFinite(value) && value > 0 ? value : 1
}

/** Where an identity's spawn row is kept for its `brief` getter: not enumerable, so no frame or spread carries it. */
const SPAWN_ROW = Symbol('spawnRow')

/**
 * One getter for every identity, so they share V8 hidden classes; a closure apiece gave each its own.
 * CC-1484: not enumerable, because a long brief is a db read and every `agents` reply is stringified.
 * Its readers run in the broker, on the identity itself.
 */
const BRIEF: PropertyDescriptor = {
  get(this: { [SPAWN_ROW]: AgentEventRow }) {
    return this[SPAWN_ROW].body ?? ''
  },
  enumerable: false,
}

/** CC-1463: `brief` reads the spawn row's body when asked, so a fold held between reads holds no briefs. */
function spawnedFrom(row: AgentEventRow, id: string): AgentIdentity {
  const agent = spawnedFields(row, id)
  Object.defineProperty(agent, SPAWN_ROW, { value: row })
  return Object.defineProperty(agent, 'brief', BRIEF) as AgentIdentity
}

const spawnedFields = (row: AgentEventRow, id: string): Omit<AgentIdentity, 'brief'> => ({
  agentId: id,
  name: row.target ?? row.meta.name ?? '',
  profile: row.meta.profile ?? '',
  state: 'spawning',
  origin: originOf(row),
  spawnedBy: row.actor,
  ...launchedByOf(row),
  spawnedAt: row.ts,
  cwd: row.meta.cwd ?? '',
  isolation: row.meta.isolation ?? '',
  surface: row.meta.surface ?? '',
  sessionId: row.meta.session_id ?? '',
  // CC-100: which account this agent runs on, and therefore where its transcript
  // and status-cache are. Absent on rows written before the field existed, which
  // reads as "the broker's own dir" — exactly what those agents actually used.
  ...(row.meta.config_dir ? { configDir: row.meta.config_dir } : {}),
  ...(row.meta.config_dir_unset === 'true' ? { configDirUnset: true } : {}),
  ...(row.meta.host ? { host: row.meta.host } : {}),
  ...(originOf(row) === 'adopted' && derivedName(row, true) ? { provisionalName: true as const } : {}),
  ...provenanceOf(row),
  lastEventAt: row.ts,
  generation: generationOf(row),
  ...inheritedStreak(row),
  ...(row.meta.teleport_from ? { teleportFrom: row.meta.teleport_from } : {}),
  ...predecessorOf(row),
})

/**
 * CC-1579: whose work this agent took over, for independence checks. A teleport successor
 * keeps its predecessor's name. A spawn row records `predecessor` only when one was asked for,
 * so its absence means none only on rows from a binary that wrote it: `coordinator_depth`
 * (CC-163) landed after `predecessor` (CC-133) and is on every spawn row since. An adopted
 * session can take over through a handoff without a row saying so, so it stays unknown.
 */
function predecessorOf(row: AgentEventRow): { predecessor?: string | null } {
  const { meta } = row
  if (meta.teleport_from) return { predecessor: row.target ?? meta.name ?? '' }
  if (meta.predecessor) return { predecessor: meta.predecessor }
  if (originOf(row) === 'adopted' || meta.coordinator_depth === undefined) return {}
  return { predecessor: null }
}

/** CC-1671 S4: a row with no streak is an exit that broke one. */
function applyCrashStreak(agent: AgentIdentity, row: AgentEventRow): void {
  const streak = numberOrUndefined(row.meta.crash_streak)
  if (streak === undefined) delete agent.crashStreak
  else agent.crashStreak = streak
  const loop = crashLoopOf(row.meta, agent.exit?.code ?? null, row.ts)
  if (loop === undefined) delete agent.crashLoop
  else agent.crashLoop = loop
}

const inheritedStreak = (row: AgentEventRow): { crashStreak?: number } => {
  const streak = numberOrUndefined(row.meta.crash_streak)
  return streak === undefined ? {} : { crashStreak: streak }
}

/** CC-1466: the automation that ran a human-requested spawn, beside `spawnedBy` and never in place of it. */
function launchedByOf(row: AgentEventRow): { launchedBy?: Launcher } {
  const launchedBy = launcherOf(row.meta.launched_by)
  return launchedBy === undefined ? {} : { launchedBy }
}

/** CC-915: rows written before the fields existed get an inferred role and no worktree provenance. */
function provenanceOf(row: AgentEventRow): Partial<AgentIdentity> {
  const { meta } = row
  const stated = meta.work_role !== undefined && meta.work_role_inferred !== 'true'
  return {
    ...(meta.repo ? { repo: meta.repo } : {}),
    ...(meta.branch ? { branch: meta.branch } : {}),
    ...baseOf(row),
    ...(meta.task ? { task: meta.task } : {}),
    workRole: meta.work_role ?? inferWorkRole(meta.profile ?? '', row.target ?? meta.name ?? ''),
    ...(stated ? {} : { workRoleInferred: true as const }),
  }
}

const baseOf = (row: AgentEventRow): { base?: { sha: string; ref: string } } =>
  row.meta.base_sha && row.meta.base_ref ? { base: { sha: row.meta.base_sha, ref: row.meta.base_ref } } : {}

/** A resume row carries a base only when it cut a fresh branch; a surviving branch keeps its first one. */
function applyResumeProvenance(agent: AgentIdentity, row: AgentEventRow): void {
  const base = baseOf(row).base
  if (base !== undefined) agent.base = base
  if (row.meta.repo) agent.repo = row.meta.repo
  if (row.meta.branch) agent.branch = row.meta.branch
}

/** The working-on text a provisional registration sends (`src/server/index.ts`). */
const DERIVED_WORKING_ON = 'unregistered session in '

/**
 * CC-959: the broker states on each adopt and attach row whether the name was
 * derived. An adopt row without the field predates it, and only its first
 * name can be recognised, by the text a provisional registration sends. A
 * readopt carries that text on as the brief under whatever name the session
 * later chose, so the text alone says nothing about a later name.
 */
const derivedName = (row: AgentEventRow, firstName: boolean): boolean =>
  row.meta.provisional === undefined
    ? firstName && (row.body ?? '').startsWith(DERIVED_WORKING_ON)
    : row.meta.provisional === 'true'

/** The first name of an adopted identity minted before the broker recorded `provisional`, if it is one. */
function legacyAdoptedName(rows: readonly AgentEventRow[]): string | undefined {
  const row = rows.find(r => r.kind === 'agent_spawned')
  if (row === undefined || originOf(row) !== 'adopted' || row.meta.provisional !== undefined) return undefined
  return row.target ?? row.meta.name
}

/** An adopted name follows its latest attach, and so does whether that name was derived or chosen. */
function attachAdopted(agent: AgentIdentity, row: AgentEventRow, legacyName: string | undefined): void {
  agent.name = row.actor
  if (derivedName(row, legacyName !== undefined && row.actor === legacyName)) agent.provisionalName = true
  else delete agent.provisionalName
}

/** Lifecycle transitions, keyed by kind. Kinds absent here only bump `lastEventAt`. */
const TRANSITIONS: Partial<Record<AgentEventRow['kind'], AgentLifecycle>> = {
  agent_attached: 'live',
  agent_detached: 'detached',
  agent_resumed: 'spawning',
  agent_exited: 'exited',
  agent_retired: 'retired',
}

/**
 * Fold one agent's rows, oldest first, into its identity.
 *
 * Pure: no database, no clock, no process. Returns undefined when the rows never
 * establish an identity — an `agent_attached` citing an id with no spawn row is
 * a corrupt or truncated log, and inventing a half-agent from it would put a row
 * on the roster that nothing can ever resume or retire.
 *
 * `retired` is absorbing. It is the one terminal state: it frees the name, so
 * honouring a later row would resurrect an identity whose name another agent may
 * already hold.
 */
export function foldAgent(rows: readonly AgentEventRow[]): AgentIdentity | undefined {
  let agent: AgentIdentity | undefined
  let exitInferred = false
  const legacyName = legacyAdoptedName(rows)

  for (const row of rows) {
    const id = agentIdOf(row)
    if (id === null) continue

    if (row.kind === 'agent_spawned') {
      // A second spawn row for one id cannot happen through the supervisor, and
      // if it does the first one is the identity everything else already cites.
      agent ??= spawnedFrom(row, id)
      continue
    }
    if (agent === undefined || agent.state === 'retired') continue

    agent.lastEventAt = row.ts
    // A self-reported name can move: nothing stops an ordinary session calling
    // chat_register twice under a different one, and the attach row carries what
    // it last called itself. A spawned name never moves — it came from the launch
    // plan and peers were told it before the agent had a turn.
    if (agent.origin === 'adopted' && row.kind === 'agent_attached') attachAdopted(agent, row, legacyName)
    // Presentation is not fixed at spawn: a mode switch resumes the SAME identity
    // into a different surface, and a roster reading `surface` off the spawn row
    // would keep reporting the pane an agent no longer has. Only `agent_resumed`
    // carries it, and only when a switch actually changed it — an ordinary resume
    // omits the field and leaves this alone.
    if (row.kind === 'agent_resumed' && row.meta.surface) agent.surface = row.meta.surface
    if (row.kind === 'agent_resumed') applyResumeProvenance(agent, row)
    // CC-1472: a resume relaunches on one machine, so the agent is wherever the newest one put it.
    if (row.kind === 'agent_resumed' && row.meta.host) agent.host = row.meta.host
    else if (row.kind === 'agent_resumed') delete agent.host
    if (row.kind === 'agent_exited') {
      agent.exit = exitFrom(row)
      agent.exitedAt = row.ts
      exitInferred = row.meta.inferred === 'true' || row.meta.failed === 'true'
      applyCrashStreak(agent, row)
    }
    if (row.kind === 'agent_resumed' && row.meta.crash_cleared === 'true') {
      delete agent.crashStreak
      delete agent.crashLoop
    }
    // CC-454: an inferred exit can be false (the launcher died, claude did not); a real one is final.
    // CC-450: so can a failed start, when the registration lands after the attach check gave up.
    if (row.kind === 'agent_attached' && exitInferred) {
      delete agent.exitedAt
      delete agent.exit
      exitInferred = false
    }
    if (row.kind === 'agent_resumed') delete agent.exitedAt
    if (row.kind === 'agent_detached') agent.detachedAt = row.ts
    if (row.kind === 'agent_resumed' || row.kind === 'agent_attached') delete agent.detachedAt
    const next = TRANSITIONS[row.kind]
    // CC-450: a socket closing just after the process exited does not reopen a finished agent.
    const closesAfterExit = row.kind === 'agent_detached' && agent.exitedAt !== undefined
    if (next !== undefined) agent.state = closesAfterExit ? 'exited' : next
  }

  return agent
}

/**
 * When an agent stopped, for the reclaim grace window: its exit, else its last detach.
 * Never `lastEventAt`, which every refused retire's own `isolation_released` row advances.
 */
export const stoppedAt = (agent: Pick<AgentIdentity, 'exitedAt' | 'detachedAt'>): number | undefined =>
  agent.exitedAt ?? agent.detachedAt

/** Group rows by the agent id they carry, preserving log order within each group. */
export function groupByAgent(rows: readonly AgentEventRow[]): Map<string, AgentEventRow[]> {
  const groups = new Map<string, AgentEventRow[]>()
  for (const row of rows) {
    const id = agentIdOf(row)
    if (id === null) continue
    const group = groups.get(id)
    if (group) group.push(row)
    else groups.set(id, [row])
  }
  return groups
}

/** Every status the roster can show; `failed` is spawned but never registered: the process is gone and did no work (CC-95). */
export const ROSTER_STATUSES = [
  'starting',
  'running',
  'blocked',
  'stalled?',
  'reconnecting',
  'detached',
  'finished',
  'failed',
  'retired',
] as const

/** How a paired identity and presence should render on the roster. */
export type RosterStatus = (typeof ROSTER_STATUSES)[number]

export interface PresenceInput {
  /** `registry.connFor(name) !== undefined`. */
  connected: boolean
  /** Derived, never stored: the agent has an open `approval_request`. */
  blocked?: boolean
  /** Registry idle time. Omit to opt out of stall reporting entirely. */
  idleMs?: number
  /**
   * Idle time past which a connected agent reads as `stalled?`. No default: the
   * threshold is unvalidated policy and the spec section that was to define it
   * (§11.6) was never written, so a caller that has not chosen one gets no
   * guess — it gets `running`.
   */
  stalledAfterMs?: number
}

export interface RosterEntry {
  agent: AgentIdentity
  status: RosterStatus
  /**
   * Set when lifecycle and presence disagree in a way that should not be
   * possible. Not an event: there is no `agent_state_anomaly` kind, and adding
   * one would unfreeze the SSE contract. Callers surface it on the routing log.
   */
  anomaly?: string
}

/**
 * Pair the durable lifecycle with ephemeral presence.
 *
 * Where the two disagree, presence wins — a live socket is direct evidence and a
 * lifecycle is an inference from rows that may have been missed. That choice is
 * what makes the agents view more truthful than the sessions view: during the
 * reconnect ladder a durable agent can only change presence, never vanish.
 */
export function pairPresence(agent: AgentIdentity, presence: PresenceInput): RosterEntry {
  const { connected, blocked = false, idleMs, stalledAfterMs } = presence

  const connectedStatus = (): RosterStatus => {
    if (blocked) return 'blocked'
    if (stalledAfterMs !== undefined && idleMs !== undefined && idleMs >= stalledAfterMs) return 'stalled?'
    return 'running'
  }

  switch (agent.state) {
    case 'spawning':
      return { agent, status: connected ? connectedStatus() : 'starting' }
    case 'live':
      return { agent, status: connected ? connectedStatus() : 'reconnecting' }
    case 'detached':
      return connected
        ? {
            agent,
            status: connectedStatus(),
            anomaly: 'detached identity holds a live connection; trusting presence',
          }
        : { agent, status: 'detached' }
    case 'exited':
      return connected
        ? {
            agent,
            status: connectedStatus(),
            anomaly: 'exited identity holds a live connection; the exit handler fired while a socket lives',
          }
        : { agent, status: agent.exit?.failedToStart === true ? 'failed' : 'finished' }
    case 'retired':
      return { agent, status: 'retired' }
  }
}

/**
 * CC-1453: the broker launched this identity from a plan it can rebuild: a
 * spawn, or any teleport successor. A successor of a hand-started session is
 * recorded as adopted, because it keeps that session's inherited configuration,
 * but it was still launched here, so it resolves by name like a spawn does.
 */
export const launchedByBroker = (agent: AgentIdentity): boolean =>
  agent.origin === 'spawned' || agent.teleportFrom !== undefined

/** Every identity the rows establish, frozen because a reused fold hands the same ones to every caller. */
function foldAll(rows: readonly AgentEventRow[]): readonly AgentIdentity[] {
  const agents: AgentIdentity[] = []
  for (const group of groupByAgent(rows).values()) {
    const agent = foldAgent(group)
    if (agent) agents.push(deepFreeze(agent))
  }
  // Newest first: a roster is read top-down and the agent just spawned is the
  // one being looked for.
  return agents.sort((a, b) => b.spawnedAt - a.spawnedAt)
}

/** `exit` and `base` are an identity's only nested objects. */
function deepFreeze(agent: AgentIdentity): AgentIdentity {
  if (agent.exit) Object.freeze(agent.exit)
  if (agent.base) Object.freeze(agent.base)
  return Object.freeze(agent)
}

/**
 * Query surface over the identity rows. Every call re-reads the rows, so it can
 * never drift from the log the way a cached aggregate would.
 *
 * CC-1463: the fold is reused while the read returns the same rows. The log only
 * appends, so the same count ending in the same row object is the same list; a
 * store that builds fresh rows per read (a fake, a tail read inside a transaction)
 * just refolds.
 */
export class AgentLog {
  private folded:
    { count: number; last: AgentEventRow | undefined; agents: readonly AgentIdentity[] } | undefined

  constructor(private readonly events: EventStore) {}

  private all(): AgentIdentity[] {
    const rows = this.events.agentEvents()
    const last = rows.at(-1)
    if (this.folded?.count !== rows.length || this.folded.last !== last)
      this.folded = { count: rows.length, last, agents: foldAll(rows) }
    return this.folded.agents.slice()
  }

  roster(opts: { includeRetired?: boolean } = {}): AgentIdentity[] {
    const agents = this.all()
    return opts.includeRetired ? agents : agents.filter(a => a.state !== 'retired')
  }

  get(id: string): AgentIdentity | undefined {
    return foldAgent(this.events.agentEventsFor(id))
  }

  /**
   * The most recently spawned identity still holding `name`.
   *
   * Only identities the broker launched are matched (`launchedByBroker`). This
   * is what `retire` and `resume` resolve through, and neither is meaningful for
   * a session the broker did not launch: there is no launch plan to relaunch and
   * no isolation to release. It also keeps them out of the name lease below —
   * nothing can bring a hand-started session back under its name, so leasing one
   * past its process would block a spawn on that name forever.
   */
  byName(name: string): AgentIdentity | undefined {
    return this.all().find(a => a.name === name && launchedByBroker(a) && a.state !== 'retired')
  }

  /**
   * CC-408: a newer identity under the same name, retired or not.
   *
   * Teleport successors keep the name, so once the newest is retired `byName`
   * falls back to an older generation; resuming that would wake a stale session.
   * CC-959: an adopted successor counts too. A seat restarted by hand is adopted,
   * and `byName` cannot see it, so it would otherwise resume the older spawned row.
   * Not one whose name was derived from its directory: a session merely opened in
   * an agent's worktree takes the agent's name without meaning to replace it.
   */
  supersededBy(agent: AgentIdentity): AgentIdentity | undefined {
    return this.all().find(
      a =>
        a.name === agent.name &&
        a.spawnedAt > agent.spawnedAt &&
        a.provisionalName !== true &&
        !this.neverRan(a),
    )
  }

  /** CC-1453: a teleport successor retired before it ever attached never held the conversation, so it supersedes nothing. */
  private neverRan(agent: AgentIdentity): boolean {
    return (
      agent.state === 'retired' &&
      !this.events.agentEventsFor(agent.agentId).some(row => row.kind === 'agent_attached')
    )
  }

  /**
   * The identity adopted for a Claude Code session id, so a session that
   * reconnects or outlives a broker restart re-attaches instead of accumulating
   * one identity per registration.
   *
   * Matches adopted identities only. A spawned agent's session id is recorded in
   * the log, where every session on the machine can read it, so matching one
   * would make adoption a way to claim an agent's identity by quoting a field —
   * the hole `BrokerCore.claimable` closes for agent ids.
   */
  bySession(sessionId: string): AgentIdentity | undefined {
    if (sessionId === '') return undefined
    return this.all().find(a => a.origin === 'adopted' && a.sessionId === sessionId && a.state !== 'retired')
  }

  /**
   * The uniqueness the schema no longer provides: a name is leased for as long
   * as any non-retired identity holds it, so a detached or finished agent still
   * owns its name and stays resumable under it.
   *
   * CC-124: except one that failed to start. It never ran, so there is nothing
   * to resume, and holding its name made the obvious retry refuse until someone
   * retired a corpse by hand.
   */
  nameIsClaimed(name: string): boolean {
    return this.nameHolder(name) !== undefined
  }

  /** The identity holding the name lease `nameIsClaimed` describes, so a refusal can say who it is. */
  nameHolder(name: string): AgentIdentity | undefined {
    return this.all().find(
      a =>
        a.name === name &&
        launchedByBroker(a) &&
        a.state !== 'retired' &&
        !(a.state === 'exited' && a.exit?.failedToStart === true),
    )
  }

  /**
   * Has this identity stood down for a successor?
   *
   * A query, not a lifecycle state, and deliberately: standing down lasts
   * seconds, so making it a state would put it in `pairPresence`'s switch and
   * force a rendering decision for a condition nobody will ever see on screen.
   */
  stoodDown(agentId: string): boolean {
    return this.events.agentEvents().some(row => row.kind === 'agent_stood_down' && row.ref === agentId)
  }

  /** The identity this one teleported into, if it has one. */
  successorOf(agentId: string): AgentIdentity | undefined {
    return this.all().find(a => a.teleportFrom === agentId)
  }

  /** An identity followed by each teleport successor in turn, oldest first; empty when it is unknown. */
  lineageFrom(agentId: string): AgentIdentity[] {
    const agents = this.all()
    const line: AgentIdentity[] = []
    let next = agents.find(a => a.agentId === agentId)
    while (next !== undefined && !line.includes(next)) {
      line.push(next)
      const from = next.agentId
      next = agents.find(a => a.teleportFrom === from)
    }
    return line
  }

  /**
   * The raw `meta` of an identity's spawn row.
   *
   * For the fields `AgentIdentity` deliberately does not model — `depth` and
   * `parent` are enforcement inputs rather than things a roster should show, and
   * teleport has to carry both across UNCHANGED (succession is not branching,
   * so an inherited depth is the whole point).
   */
  spawnMeta(agentId: string): Record<string, string> {
    const row = this.events.agentEvents().find(r => r.kind === 'agent_spawned' && r.msgId === agentId)
    return row?.meta ?? {}
  }
}
