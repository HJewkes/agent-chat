import type { AgentIdentity } from '../../protocol.js'
import type { ShepherdFlight } from './in-flight-read.js'
import { rowOfSeat } from './in-flight-read.js'
import {
  STALE_AGENT_MS,
  firstLine,
  type AgentItem,
  type BudgetItem,
  type InboxItem,
  type Packet,
  type SenderClass,
  type ShepherdItem,
} from './seat-watch.js'

/** CC-1661: the W2 state packet from one pass's raw readings. Pure. */

/** An exited agent leaves the packet a day after it exits, so a long-parked one stops firing R2. */
export const EXITED_LOOKBACK_MS = 24 * 3_600_000

export interface WatchSeat {
  name: string
  /** From the seat file; absent, only `spawnedBy` marks the seat's agents. */
  prefix?: string
}

export interface RawMessage {
  from: string
  kind: string
  msgId: string | null
  ts: number
  body: string
}

export interface PacketInput {
  seat: WatchSeat
  /** The owner's names: the charter's owner seat and the human queue. */
  owners: ReadonlySet<string>
  operator: string
  /** Messages to the seat since its own last turn, oldest first. */
  inbox: readonly RawMessage[]
  /** The broker's folded roster, retired agents included or not. */
  roster: readonly AgentIdentity[]
  /** Epoch ms of each agent's newest row as actor in events.db. */
  activityAt: ReadonlyMap<string, number>
  /** Epoch ms of each agent's newest message to the seat. */
  lastWordAt: ReadonlyMap<string, number>
  flights: readonly ShepherdFlight[] | null
  budget: BudgetItem | null
  queue: number | null
  dispatcherCovers: boolean
  digestDue: boolean
  nowMs: number
}

export const ownsAgent = (seat: WatchSeat, agent: Pick<AgentIdentity, 'name' | 'spawnedBy'>): boolean =>
  agent.spawnedBy === seat.name || (seat.prefix !== undefined && agent.name.startsWith(`${seat.prefix}-`))

const ownsName = (seat: WatchSeat, name: string, roster: readonly AgentIdentity[]): boolean =>
  (seat.prefix !== undefined && name.startsWith(`${seat.prefix}-`)) ||
  roster.some(a => a.name === name && a.spawnedBy === seat.name)

function senderClass(from: string, input: PacketInput): SenderClass {
  if (input.owners.has(from)) return 'owner'
  if (from === input.operator && from !== input.seat.name) return 'operator'
  return ownsName(input.seat, from, input.roster) ? 'own-agent' : 'other'
}

const inboxItems = (input: PacketInput): InboxItem[] =>
  input.inbox.map(m => ({
    from: m.from,
    class: senderClass(m.from, input),
    kind: m.kind,
    msgId: m.msgId,
    ts: m.ts,
    firstLine: firstLine(m.body),
  }))

const RUNNING = new Set(['spawning', 'live', 'detached'])

const flightRef = (f: Pick<ShepherdFlight, 'repo' | 'pr'>): string => `${f.repo}#${f.pr ?? '?'}`

function inPacket(agent: AgentIdentity, nowMs: number): boolean {
  if (RUNNING.has(agent.state)) return true
  return agent.state === 'exited' && nowMs - (agent.exitedAt ?? agent.lastEventAt) <= EXITED_LOOKBACK_MS
}

function agentItem(agent: AgentIdentity, input: PacketInput): AgentItem {
  const flight = input.flights?.find(f => f.implementer === agent.name)
  const spoke = (input.lastWordAt.get(agent.name) ?? -1) >= agent.spawnedAt
  const lastSeen = Math.max(agent.lastEventAt, input.activityAt.get(agent.name) ?? 0)
  return {
    name: agent.name,
    state: agent.state,
    role: agent.workRole ?? agent.profile,
    exitedWithoutReport: agent.state === 'exited' && !spoke,
    stale: RUNNING.has(agent.state) && input.nowMs - lastSeen > STALE_AGENT_MS,
    openPr: flight === undefined ? null : flightRef(flight),
  }
}

const agentItems = (input: PacketInput): AgentItem[] =>
  input.roster
    .filter(a => a.name !== input.seat.name && ownsAgent(input.seat, a) && inPacket(a, input.nowMs))
    .map(a => agentItem(a, input))
    .sort((a, b) => a.name.localeCompare(b.name))

/** A gate, a stall, or a fix round whose fixer is not running: something only the seat can move. */
function needsSeat(flight: ShepherdFlight, running: ReadonlySet<string>): boolean {
  if (flight.pendingGate !== null || flight.stalled) return true
  return flight.phase === 'fixing' && (flight.implementer === null || !running.has(flight.implementer))
}

function seatFlights(input: PacketInput, agents: readonly AgentItem[]): ShepherdItem[] | null {
  if (input.flights === null) return null
  const prefix = input.seat.prefix
  const mine = new Set(agents.map(a => a.name))
  const running = new Set(agents.filter(a => RUNNING.has(a.state)).map(a => a.name))
  return input.flights
    .filter(f => (prefix !== undefined && rowOfSeat(f, prefix)) || mine.has(f.implementer ?? ''))
    .map(f => ({
      ref: flightRef(f),
      phase: f.phase,
      implementer: f.implementer,
      pendingGate: f.pendingGate,
      stalled: f.stalled,
      held: f.held,
      needsSeat: needsSeat(f, running),
    }))
    .sort((a, b) => a.ref.localeCompare(b.ref))
}

export function buildPacket(input: PacketInput): Packet {
  const agents = agentItems(input)
  return {
    seat: input.seat.name,
    inbox: inboxItems(input),
    agents,
    shepherd: seatFlights(input, agents),
    budget: input.budget,
    queue: input.queue,
    dispatcherCovers: input.dispatcherCovers,
    digestDue: input.digestDue,
  }
}
