import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  executionLedgerDdl,
  SqliteExecutionLedger,
  type ApplyExecutionTransitionResult,
} from '@titan-design/agent-lifecycle'
import {
  isTerminalExecutionPhase,
  type ExecutionOwnerFence,
  type ExecutionOwnerLease,
  type ExecutionRecord,
  type ExecutionTerminal,
  type ExecutionTransition,
} from '@titan-design/agent-protocol'
import { logEvent } from '../../broker/log.js'
import { resolveLedgerShadow } from '../../config.js'
import { home } from '../../paths.js'
import { ledgerDbOver } from './db-shim.js'

const DAY_MS = 24 * 60 * 60 * 1000
const LEASE_MS = 30 * DAY_MS
const RENEW_BELOW_MS = 7 * DAY_MS
/** agent-lifecycle 0.1 has no listActive; every non-terminal row fits well under this. */
const RECOVERABLE_LIMIT = 10_000

type MaybePromise<T> = T | Promise<T>

/** What the shadow writer needs of an execution ledger. Async-tolerant so TP-199's async ports drop in. */
export interface ExecutionLedgerPort {
  get(executionId: string): MaybePromise<ExecutionRecord | undefined>
  listRecoverable(limit?: number): MaybePromise<ExecutionRecord[]>
  apply(transition: ExecutionTransition): MaybePromise<ApplyExecutionTransitionResult>
}

export interface ShadowLedgerOptions {
  supervisorId: string
  now?: () => number
  log?: typeof logEvent
}

type Step = () => MaybePromise<ApplyExecutionTransitionResult | undefined>

type Envelope = 'executionId' | 'eventId' | 'expectedRevision' | 'occurredAt' | 'fence'
type WithoutEnvelope<T> = T extends { fence: ExecutionOwnerFence } ? Omit<T, Envelope> : never
/** A fenced transition as the caller states it; the ledger fills in the revision it was issued against. */
export type ShadowStep = WithoutEnvelope<ExecutionTransition>

/**
 * CC-118's write-beside ledger. Write-only by construction: no method returns a
 * record, so nothing the supervisor holds can read lifecycle state back. Every
 * method resolves and never rejects, because a shadow failure must not change
 * a spawn, exit or retire outcome; failures become `ledger_shadow_error` lines.
 */
export class ShadowLedger {
  /** Static in shadow: fencing across brokers is not exercised until TP-199's supervisor lease. */
  readonly fence: ExecutionOwnerFence
  private readonly now: () => number
  private readonly log: typeof logEvent
  private readonly chains = new Map<string, Promise<void>>()

  constructor(
    private readonly port: ExecutionLedgerPort,
    options: ShadowLedgerOptions,
  ) {
    this.fence = { supervisorId: options.supervisorId, generation: 1 }
    this.now = options.now ?? Date.now
    this.log = options.log ?? logEvent
  }

  apply(transition: ExecutionTransition): Promise<void> {
    return this.enqueue(transition.executionId, transition.kind, () => this.port.apply(transition))
  }

  /** Applies a fenced step to a row's current revision, so the caller never tracks revisions itself. */
  advance(executionId: string, step: ShadowStep): Promise<void> {
    return this.enqueue(executionId, step.kind, () =>
      this.applyToCurrent(
        executionId,
        () => true,
        current => ({ ...this.envelope(current), fence: this.fence, ...step }) as ExecutionTransition,
      ),
    )
  }

  newLease(): ExecutionOwnerLease {
    return { ...this.fence, leaseUntil: this.iso(LEASE_MS) }
  }

  /** Closes the rows a pre-restart broker opened for an agent it no longer holds in memory. */
  finishByAgent(agentId: string, terminal: ExecutionTerminal): Promise<void> {
    return this.forEachActive(
      'finish_by_agent',
      record => record.agent?.agentId === agentId,
      current => ({
        ...this.envelope(current),
        kind: 'finish',
        fence: this.fence,
        terminal,
      }),
    )
  }

  renewIfDue(): Promise<void> {
    return this.forEachActive(
      'renew_if_due',
      record => this.leaseDue(record),
      current => ({
        ...this.envelope(current),
        kind: 'renew_owner',
        fence: this.fence,
        leaseUntil: this.iso(LEASE_MS),
      }),
    )
  }

  private async forEachActive(
    op: string,
    matches: (record: ExecutionRecord) => boolean,
    build: (current: ExecutionRecord) => ExecutionTransition,
  ): Promise<void> {
    let active: ExecutionRecord[]
    try {
      active = await this.port.listRecoverable(RECOVERABLE_LIMIT)
    } catch (err) {
      this.log('ledger_shadow_error', { kind: 'thrown', op, reason: String(err) })
      return
    }
    const ids = active.filter(matches).map(record => record.execution.executionId)
    await Promise.all(ids.map(id => this.enqueue(id, op, () => this.applyToCurrent(id, matches, build))))
  }

  /** Re-reads inside the chain so `expectedRevision` reflects every transition queued before it. */
  private async applyToCurrent(
    executionId: string,
    stillMatches: (record: ExecutionRecord) => boolean,
    build: (current: ExecutionRecord) => ExecutionTransition,
  ): Promise<ApplyExecutionTransitionResult | undefined> {
    const current = await this.port.get(executionId)
    if (!current || isTerminalExecutionPhase(current.phase) || !stillMatches(current)) return undefined
    return this.port.apply(build(current))
  }

  /** One chain per execution, so two transitions for a row apply in the order they were issued. */
  private enqueue(executionId: string, op: string, step: Step): Promise<void> {
    const previous = this.chains.get(executionId) ?? Promise.resolve()
    const next = previous.then(step).then(
      result => this.report(result, executionId, op),
      (err: unknown) =>
        this.log('ledger_shadow_error', { kind: 'thrown', op, executionId, reason: String(err) }),
    )
    this.chains.set(executionId, next)
    void next.then(() => {
      if (this.chains.get(executionId) === next) this.chains.delete(executionId)
    })
    return next
  }

  private report(result: ApplyExecutionTransitionResult | undefined, executionId: string, op: string): void {
    if (result === undefined || result.ok) return
    this.log('ledger_shadow_error', { kind: result.kind, op, executionId, reason: result.reason })
  }

  private envelope(current: ExecutionRecord) {
    return {
      executionId: current.execution.executionId,
      eventId: randomUUID(),
      expectedRevision: current.revision,
      occurredAt: this.iso(0),
    }
  }

  private leaseDue(record: ExecutionRecord): boolean {
    const until = record.owner ? Date.parse(record.owner.leaseUntil) : 0
    return until - this.now() < RENEW_BELOW_MS
  }

  private iso(offsetMs: number): string {
    return new Date(this.now() + offsetMs).toISOString()
  }
}

/** Creates the ledger tables on the event log's own connection and wraps the published ledger over it. */
export function openShadowLedger(db: DatabaseSync, options: ShadowLedgerOptions): ShadowLedger {
  const ledgerDb = ledgerDbOver(db)
  ledgerDb.exec(executionLedgerDdl())
  const clock = options.now ?? Date.now
  // The package types `db` as better-sqlite3's Database; the shim serves only the calls it makes.
  const ledger = new SqliteExecutionLedger(ledgerDb as never, { now: () => new Date(clock()).toISOString() })
  return new ShadowLedger(ledger, options)
}

/** The static fence owner; the offline backfill must write rows this broker can later finish. */
export const shadowSupervisorId = (): string => `agent-chat@${home()}`

/**
 * The broker's one entry point. With the flag off the handle is never asked for,
 * so no table is created and no ledger code runs. A ledger that cannot open is
 * logged and skipped rather than allowed to stop the broker booting.
 */
export function shadowLedgerFromConfig(handle: () => DatabaseSync): ShadowLedger | undefined {
  if (!resolveLedgerShadow()) return undefined
  try {
    return openShadowLedger(handle(), { supervisorId: shadowSupervisorId() })
  } catch (err) {
    logEvent('ledger_shadow_error', { kind: 'thrown', op: 'open', reason: String(err) })
    return undefined
  }
}
