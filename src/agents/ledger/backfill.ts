import type {
  ExecutionOwnerFence,
  ExecutionPhase,
  ExecutionTerminal,
  ExecutionTransition,
} from '@titan-design/agent-protocol'
import type { AgentEventRow } from '../../broker/event-store.js'
import type { AgentIdentity } from '../../protocol.js'
import { foldAgent, groupByAgent } from '../identity.js'

const DAY_MS = 24 * 60 * 60 * 1000
const LEASE_MS = 30 * DAY_MS
const EVIDENCE = 'backfilled from event log'

/** What `runtime.json` can tell the planner about a runner; absent when the file is gone. */
export interface RuntimeRef {
  pid?: number | undefined
  paneRef?: string | undefined
}

export interface BackfillOptions {
  now: number
  fence: ExecutionOwnerFence
  /** `target.namespace` of the fresh execution: the broker's home. */
  namespace: string
  /** Skip agents whose last event is older than this many days. Unbounded when absent. */
  sinceDays?: number | undefined
}

/** Where one planned timestamp or ref came from, for the dry-run line. */
export interface PlanSource {
  field: string
  value: string
  from: 'event log' | 'runtime.json' | 'default'
}

export interface PlannedRow {
  agentId: string
  name: string
  requestKey: string
  phases: ExecutionPhase[]
  sources: PlanSource[]
  transitions: ExecutionTransition[]
}

export const backfillRequestKey = (agentId: string): string => `backfill:${agentId}`
/** Slice 1's key: an agent spawned with the flag on already has its row. */
const spawnRequestKey = (agentId: string): string => `spawn:${agentId}`

/**
 * CC-118 slice 3: one ledger row per non-retired spawned identity that has none.
 *
 * Pure: rows, runtime refs and existing keys in, transitions out. Timestamps are
 * clamped to be non-decreasing within a row and never past `now`, because the
 * reducer rejects an observation older than the last and the ledger one newer
 * than its clock.
 */
export function planBackfill(
  rows: readonly AgentEventRow[],
  runtimeStates: ReadonlyMap<string, RuntimeRef>,
  existingRequestKeys: ReadonlySet<string>,
  options: BackfillOptions,
): PlannedRow[] {
  const cutoff = options.sinceDays === undefined ? -Infinity : options.now - options.sinceDays * DAY_MS
  const planned: PlannedRow[] = []
  for (const [agentId, agentRows] of groupByAgent(rows)) {
    const agent = foldAgent(agentRows)
    if (!agent || agent.origin !== 'spawned' || agent.state === 'retired') continue
    if (agent.lastEventAt < cutoff) continue
    if (
      existingRequestKeys.has(backfillRequestKey(agentId)) ||
      existingRequestKeys.has(spawnRequestKey(agentId))
    )
      continue
    planned.push(planRow(agent, agentRows, runtimeStates.get(agentId), options))
  }
  return planned
}

interface Observed {
  attachedAt: number | undefined
  endedAt?: number | undefined
  terminal?: ExecutionTerminal | undefined
}

/** The first attach, and the last event that ends the execution: a stand-down beats an exit. */
function observe(agent: AgentIdentity, rows: readonly AgentEventRow[]): Observed {
  const attachedAt = rows.find(row => row.kind === 'agent_attached')?.ts
  const stoodDown = rows.findLast(row => row.kind === 'agent_stood_down')
  if (stoodDown) return { attachedAt, endedAt: stoodDown.ts, terminal: supersededTerminal }
  if (agent.state !== 'exited') return { attachedAt }
  const exited = rows.findLast(row => row.kind === 'agent_exited')
  return { attachedAt, endedAt: exited?.ts, terminal: exited && exitTerminal(exited) }
}

const supersededTerminal: ExecutionTerminal = { outcome: 'cancelled', reason: 'superseded by teleport' }

/** Slice 1's mapping: an exit without `ended` finishes `succeeded` when clean or inferred. */
export function exitTerminal(row: AgentEventRow): ExecutionTerminal {
  const code = row.meta.code === undefined ? null : Number(row.meta.code)
  const signal = row.meta.signal ?? null
  const inferred = row.meta.inferred === 'true'
  if (row.meta.failed === 'true')
    return { outcome: 'failed', reason: row.body || 'never registered', retryable: false }
  if (code === 0 || inferred) return { outcome: 'succeeded', result: { code, signal, inferred } }
  return {
    outcome: 'failed',
    reason: `exit code ${code ?? 'none'} / signal ${signal ?? 'none'}`,
    retryable: false,
  }
}

function runnerRefOf(runtime: RuntimeRef | undefined): PlanSource {
  if (runtime?.pid !== undefined)
    return { field: 'runnerRef', value: `pid:${runtime.pid}`, from: 'runtime.json' }
  if (runtime?.paneRef) return { field: 'runnerRef', value: `pane:${runtime.paneRef}`, from: 'runtime.json' }
  return { field: 'runnerRef', value: 'unknown', from: 'default' }
}

function planRow(
  agent: AgentIdentity,
  rows: readonly AgentEventRow[],
  runtime: RuntimeRef | undefined,
  options: BackfillOptions,
): PlannedRow {
  const builder = new RowBuilder(agent, options)
  const seen = observe(agent, rows)
  builder.prepare()
  if (seen.attachedAt !== undefined) builder.running(seen.attachedAt, runnerRefOf(runtime))
  if (seen.terminal && seen.endedAt !== undefined) builder.finish(seen.endedAt, seen.terminal)
  return builder.row()
}

/** Accumulates one row's transitions, holding the clock that keeps them in order. */
class RowBuilder {
  private readonly executionId: string
  private readonly transitions: ExecutionTransition[] = []
  private readonly phases: ExecutionPhase[] = []
  private readonly sources: PlanSource[] = []
  private clock = -Infinity

  constructor(
    private readonly agent: AgentIdentity,
    private readonly options: BackfillOptions,
  ) {
    this.executionId = backfillRequestKey(agent.agentId)
  }

  prepare(): void {
    const occurredAt = this.at('spawnedAt', this.agent.spawnedAt)
    this.push('prepared', {
      kind: 'prepare',
      ...this.envelope('prepare', occurredAt),
      expectedRevision: 0,
      execution: { executionId: this.executionId },
      agent: { agentId: this.agent.agentId },
      harness: 'claude-code',
      requestKey: this.executionId,
      target: { kind: 'fresh', namespace: this.options.namespace },
      owner: { ...this.options.fence, leaseUntil: new Date(this.options.now + LEASE_MS).toISOString() },
    })
    this.push('dispatching', { kind: 'begin_dispatch', ...this.fenced('begin_dispatch', occurredAt) })
  }

  running(attachedAt: number, runnerRef: PlanSource): void {
    this.sources.push(runnerRef)
    this.push('running', {
      kind: 'observe_running',
      ...this.fenced('observe_running', this.at('attachedAt', attachedAt)),
      runnerRef: runnerRef.value,
      adapterExecution: { executionId: this.agent.sessionId || this.agent.agentId },
      evidence: EVIDENCE,
    })
  }

  finish(endedAt: number, terminal: ExecutionTerminal): void {
    const occurredAt = this.at('endedAt', endedAt)
    this.push(terminal.outcome, { kind: 'finish', ...this.fenced('finish', occurredAt), terminal })
  }

  row(): PlannedRow {
    const { agentId, name } = this.agent
    const { executionId: requestKey, phases, sources, transitions } = this
    return { agentId, name, requestKey, phases, sources, transitions }
  }

  /** Non-decreasing and never past `now`: the two orderings the reducer and the ledger enforce. */
  private at(field: string, ts: number): string {
    this.clock = Math.min(Math.max(this.clock, ts), this.options.now)
    const value = new Date(this.clock).toISOString()
    this.sources.push({ field, value, from: 'event log' })
    return value
  }

  private envelope(kind: string, occurredAt: string) {
    return { executionId: this.executionId, eventId: `${this.executionId}:${kind}`, occurredAt }
  }

  private fenced(kind: string, occurredAt: string) {
    return {
      ...this.envelope(kind, occurredAt),
      expectedRevision: this.transitions.length,
      fence: this.options.fence,
    }
  }

  private push(phase: ExecutionPhase, transition: ExecutionTransition): void {
    this.phases.push(phase)
    this.transitions.push(transition)
  }
}
