import { execFile } from 'node:child_process'
import type { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'
import { SqliteExecutionLedger } from '@titan-design/agent-lifecycle'
import type { ExecutionRecord } from '@titan-design/agent-protocol'
import type { LifecycleHealth, LifecycleReport } from '../../api-contract.js'
import { logEvent } from '../../broker/log.js'
import type { EventStore } from '../../broker/event-store.js'
import { AgentLog } from '../identity.js'
import { heldByRuntimeState } from '../isolation/sweep.js'
import { ledgerDbOver } from './db-shim.js'
import {
  BACKFILL_KEY_PREFIX,
  classify,
  tally,
  type BrokerSide,
  type FoldEntry,
  type GitListing,
  type LedgerRow,
  type RuntimeRef,
  type VerifyInput,
} from './verify.js'

const FIRST_RUN_MS = 60_000
const EVERY_MS = 5 * 60_000
const GIT_TIMEOUT_MS = 2_000
/** agent-lifecycle 0.1 has no listActive; every non-terminal row fits well under this. */
const RECOVERABLE_LIMIT = 10_000
const TERMINAL_PHASES = "('succeeded','failed','cancelled','cancellation_unknown')"

/** Resolves to `git worktree list --porcelain` output, or null when git is absent, slow or refuses. */
export type WorktreeLister = (gitRoot: string) => Promise<string | null>

export const listWorktrees: WorktreeLister = async gitRoot => {
  try {
    const { stdout } = await promisify(execFile)('git', ['worktree', 'list', '--porcelain'], {
      cwd: gitRoot,
      timeout: GIT_TIMEOUT_MS,
    })
    return stdout
  } catch {
    return null
  }
}

interface LedgerReading {
  active: LedgerRow[]
  terminalByAgent: Map<string, string>
  /** The first spawn the ledger saw, backfilled rows excluded. */
  firstWriteAt?: number
}

const hasLedger = (db: DatabaseSync): boolean =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_execution'").get() !==
  undefined

const toRow = (record: ExecutionRecord): LedgerRow => ({
  executionId: record.execution.executionId,
  ...(record.agent ? { agentId: record.agent.agentId } : {}),
  requestKey: record.requestKey,
  preparedAt: Date.parse(record.preparedAt),
})

/** Undefined when the ledger tables were never created, which is a home the flag has never been on in. */
export function readLedger(db: DatabaseSync): LedgerReading | undefined {
  if (!hasLedger(db)) return undefined
  // The package types `db` as better-sqlite3's Database; the shim serves only the calls it makes.
  const ledger = new SqliteExecutionLedger(ledgerDbOver(db) as never)
  const terminal = db
    .prepare(
      `SELECT json_extract(record, '$.agent.agentId') AS agent, phase FROM agent_execution
       WHERE phase IN ${TERMINAL_PHASES} AND agent IS NOT NULL ORDER BY updated_at`,
    )
    .all() as { agent: string; phase: string }[]
  const first = db
    .prepare('SELECT min(prepared_at) AS at FROM agent_execution WHERE request_key NOT LIKE ?')
    .get(`${BACKFILL_KEY_PREFIX}%`) as { at: string | null }
  return {
    active: ledger.listRecoverable(RECOVERABLE_LIMIT).map(toRow),
    terminalByAgent: new Map(terminal.map(row => [row.agent, row.phase])),
    ...(first.at === null ? {} : { firstWriteAt: Date.parse(first.at) }),
  }
}

/** The identity fold, plus the attach and handoff facts it folds away. */
export function readFold(events: EventStore): FoldEntry[] {
  const lastAttach = new Map<string, number>()
  const handedOff = new Set<string>()
  for (const row of events.agentEvents()) {
    if (row.ref === null) continue
    if (row.kind === 'agent_attached') lastAttach.set(row.ref, row.ts)
    if (row.kind === 'agent_handoff') handedOff.add(row.ref)
  }
  return new AgentLog(events).roster({ includeRetired: true }).map(agent => {
    const lastAttachedAt = lastAttach.get(agent.agentId)
    return {
      agentId: agent.agentId,
      name: agent.name,
      state: agent.state,
      spawnedAt: agent.spawnedAt,
      ...(agent.teleportFrom === undefined ? {} : { teleportFrom: agent.teleportFrom }),
      ...(lastAttachedAt === undefined ? {} : { lastAttachedAt }),
      handedOff: handedOff.has(agent.agentId),
    }
  })
}

export function readRuntimeRefs(): RuntimeRef[] {
  return [...heldByRuntimeState()].map(([branch, { agentId, allocation }]) => ({
    agentId,
    branch,
    gitRoot: allocation.ref?.gitRoot as string,
  }))
}

/** Every checked-out branch, not only agent-chat's: an assigned worktree (`worktree:`) keeps its own name. */
const branchesIn = (porcelain: string): string[] =>
  [...porcelain.matchAll(/^branch refs\/heads\/(.+)$/gm)].map(match => (match[1] ?? '').trim())

/** Lists each repository once, concurrently, so one slow repo costs its own timeout and no more. */
export async function listGit(refs: readonly RuntimeRef[], list: WorktreeLister): Promise<GitListing[]> {
  const roots = [...new Set(refs.map(ref => ref.gitRoot))]
  return Promise.all(
    roots.map(async gitRoot => {
      const out = await list(gitRoot)
      return { gitRoot, branches: out === null ? null : branchesIn(out) }
    }),
  )
}

export interface VerifySources {
  db: DatabaseSync
  events: EventStore
  /** The supervisor's memory; omitted by `--offline`. */
  broker?: { liveIds(): string[]; slotIds(): string[]; bootAt: number }
  list?: WorktreeLister
}

export async function gather(sources: VerifySources): Promise<{ input: VerifyInput; shadow: 'on' | 'off' }> {
  const ledger = readLedger(sources.db)
  const runtimeRefs = readRuntimeRefs()
  const input: VerifyInput = {
    fold: readFold(sources.events),
    ledgerActive: ledger?.active ?? [],
    ledgerTerminalByAgent: ledger?.terminalByAgent ?? new Map(),
    runtimeRefs,
    gitListings: await listGit(runtimeRefs, sources.list ?? listWorktrees),
  }
  if (sources.broker) input.broker = brokerSide(sources.broker, ledger?.firstWriteAt)
  return { input, shadow: ledger === undefined ? 'off' : 'on' }
}

function brokerSide(
  broker: NonNullable<VerifySources['broker']>,
  firstWriteAt: number | undefined,
): BrokerSide {
  return {
    liveIds: broker.liveIds(),
    slotIds: broker.slotIds(),
    bootAt: broker.bootAt,
    shadowSince: Math.min(firstWriteAt ?? broker.bootAt, broker.bootAt),
  }
}

export function reportFrom(
  input: VerifyInput,
  shadow: 'on' | 'off',
  shadowErrors: number | null,
  now: number,
): LifecycleReport {
  const items = classify(input)
  return {
    checked_at: now,
    shadow,
    ...tally(items),
    shadow_errors: shadowErrors,
    items,
    unlisted_repos: input.gitListings
      .filter(listing => listing.branches === null)
      .map(listing => listing.gitRoot),
  }
}

export interface LifecycleVerifierOptions {
  gather: () => Promise<{ input: VerifyInput; shadow: 'on' | 'off' }>
  shadowErrors: () => number
  /** Lease renewal rides the tick so no per-row renewal timer exists. */
  renew?: () => Promise<void>
  now?: () => number
  log?: typeof logEvent
}

/**
 * The broker's periodic check. Off the dispatch path: every timer is unref'd,
 * every run is caught, and nothing it computes feeds a supervisor decision.
 */
export class LifecycleVerifier {
  private last: LifecycleReport | undefined
  private timer: NodeJS.Timeout | undefined
  private readonly now: () => number
  private readonly log: typeof logEvent

  constructor(private readonly options: LifecycleVerifierOptions) {
    this.now = options.now ?? Date.now
    this.log = options.log ?? logEvent
  }

  /** First run a minute after listen, when the reconnect ladder (worst case 8.85 s) is over. */
  start(): void {
    this.timer = setTimeout(() => {
      this.timer = setInterval(() => void this.tick(), EVERY_MS)
      this.timer.unref()
      void this.tick()
    }, FIRST_RUN_MS)
    this.timer.unref()
  }

  stop(): void {
    clearTimeout(this.timer)
  }

  async run(): Promise<LifecycleReport> {
    const { input, shadow } = await this.options.gather()
    const report = reportFrom(input, shadow, this.options.shadowErrors(), this.now())
    this.last = report
    this.log('lifecycle_verify', {
      classified: report.items.length - report.unclassified,
      unclassified: report.unclassified,
      shadowErrors: report.shadow_errors,
    })
    return report
  }

  summary(): LifecycleHealth | undefined {
    if (this.last === undefined) return undefined
    const { checked_at, shadow, divergences, unclassified, shadow_errors } = this.last
    return { checked_at, shadow, divergences, unclassified, shadow_errors: shadow_errors ?? 0 }
  }

  private async tick(): Promise<void> {
    try {
      await this.options.renew?.()
      await this.run()
    } catch (err) {
      this.log('lifecycle_verify_error', { reason: String(err) })
    }
  }
}
