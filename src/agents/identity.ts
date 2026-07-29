import type { AgentEventRow, EventLog } from '../broker/event-log.js'
import type { AgentIdentity, AgentLifecycle, AgentOrigin } from '../protocol.js'

/**
 * The durable half of an agent: who it is, not whether it is currently plugged
 * in. A pure projection of the event log, in the same spirit as `humanQueue()`
 * and `openQuestionCount()` — nothing here is stored state.
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

const spawnedFrom = (row: AgentEventRow, id: string): AgentIdentity => ({
  agentId: id,
  name: row.target ?? row.meta.name ?? '',
  profile: row.meta.profile ?? '',
  state: 'spawning',
  origin: originOf(row),
  spawnedBy: row.actor,
  spawnedAt: row.ts,
  brief: row.body ?? '',
  cwd: row.meta.cwd ?? '',
  isolation: row.meta.isolation ?? '',
  surface: row.meta.surface ?? '',
  sessionId: row.meta.session_id ?? '',
  lastEventAt: row.ts,
  generation: generationOf(row),
  ...(row.meta.teleport_from ? { teleportFrom: row.meta.teleport_from } : {}),
})

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
    if (agent.origin === 'adopted' && row.kind === 'agent_attached') agent.name = row.actor
    if (row.kind === 'agent_exited') agent.exit = exitFrom(row)
    const next = TRANSITIONS[row.kind]
    if (next !== undefined) agent.state = next
  }

  return agent
}

/** Group rows by the agent id they carry, preserving log order within each group. */
function groupByAgent(rows: readonly AgentEventRow[]): Map<string, AgentEventRow[]> {
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

/** How a paired identity and presence should render on the roster. */
export type RosterStatus =
  'starting' | 'running' | 'blocked' | 'stalled?' | 'reconnecting' | 'detached' | 'finished' | 'retired'

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
        : { agent, status: 'finished' }
    case 'retired':
      return { agent, status: 'retired' }
  }
}

/**
 * Query surface over the identity rows. Holds no state: every call re-reads and
 * re-folds, so it can never drift from the log the way a cached aggregate would.
 */
export class AgentLog {
  constructor(private readonly events: EventLog) {}

  private all(): AgentIdentity[] {
    const agents: AgentIdentity[] = []
    for (const rows of groupByAgent(this.events.agentEvents()).values()) {
      const agent = foldAgent(rows)
      if (agent) agents.push(agent)
    }
    // Newest first: a roster is read top-down and the agent just spawned is the
    // one being looked for.
    return agents.sort((a, b) => b.spawnedAt - a.spawnedAt)
  }

  roster(opts: { includeRetired?: boolean } = {}): AgentIdentity[] {
    const agents = this.all()
    return opts.includeRetired ? agents : agents.filter(a => a.state !== 'retired')
  }

  get(id: string): AgentIdentity | undefined {
    return this.all().find(a => a.agentId === id)
  }

  /**
   * The most recently spawned identity still holding `name`.
   *
   * Adopted identities are deliberately not matched. This is what `retire` and
   * `resume` resolve through, and neither is meaningful for a session the broker
   * did not launch: there is no launch plan to relaunch and no isolation to
   * release. It also keeps them out of the name lease below — nothing can bring
   * an adopted identity back under its name, so leasing one past its process
   * would block a spawn on that name forever.
   */
  byName(name: string): AgentIdentity | undefined {
    return this.all().find(a => a.name === name && a.origin === 'spawned' && a.state !== 'retired')
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
   */
  nameIsClaimed(name: string): boolean {
    return this.byName(name) !== undefined
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
