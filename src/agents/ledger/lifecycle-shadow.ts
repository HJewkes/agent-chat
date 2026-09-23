import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import type { ExecutionTerminal } from '@titan-design/agent-protocol'
import { logEvent } from '../../broker/log.js'
import type { LaunchHandle } from '../types.js'
import type { ShadowLedger, ShadowStep } from './shadow-ledger.js'

export interface ExitOutcome {
  code: number | null
  signal: string | null
  inferred?: boolean
}

/** agent-lifecycle 0.1 has no `ended`, so a clean or inferred exit is `succeeded` until TP-192 re-maps it. */
export function exitTerminal(
  outcome: ExitOutcome,
  failed: string | undefined,
  cancelRequested: boolean,
): ExecutionTerminal {
  if (failed !== undefined) return { outcome: 'failed', reason: failed, retryable: false }
  if (cancelRequested) return { outcome: 'cancelled', reason: 'exited after a cancellation request' }
  const inferred = outcome.inferred === true
  if (outcome.code === 0 || inferred)
    return { outcome: 'succeeded', result: { code: outcome.code, signal: outcome.signal, inferred } }
  const reason = `exit code ${outcome.code ?? 'none'} / signal ${outcome.signal ?? 'none'}`
  return { outcome: 'failed', reason, retryable: false }
}

/**
 * The supervisor's side of CC-118's write-beside. Every call is fire-and-forget
 * and guarded against a synchronous throw as well as a rejection, so no ledger
 * fault can change a spawn, exit or retire. Without a ledger every call is a no-op.
 */
export class LifecycleShadow {
  constructor(private readonly ledger: ShadowLedger | undefined) {}

  /** Opens a fresh execution and returns its id, or undefined when shadowing is off. */
  open(agentId: string, namespace: string): string | undefined {
    if (this.ledger === undefined) return undefined
    const executionId = randomUUID()
    this.fire('prepare', ledger =>
      ledger.apply({
        kind: 'prepare',
        executionId,
        eventId: randomUUID(),
        expectedRevision: 0,
        occurredAt: new Date().toISOString(),
        execution: { executionId },
        agent: { agentId },
        harness: 'claude-code',
        requestKey: `spawn:${agentId}`,
        target: { kind: 'fresh', namespace },
        owner: ledger.newLease(),
      }),
    )
    this.step(executionId, { kind: 'begin_dispatch' })
    return executionId
  }

  running(executionId: string | undefined, handle: LaunchHandle, sessionId: string, configDir: string): void {
    const nativeId = handle.paneRef ?? String(handle.pid)
    const conversation = { harness: 'claude-code', namespace: configDir, nativeId: sessionId }
    this.step(executionId, {
      kind: 'observe_running',
      runnerRef: nativeId,
      adapterExecution: { executionId: sessionId, conversation },
      surface: { kind: handle.surface, host: hostname(), nativeId, owned: handle.ownsSurface === true },
      evidence: 'agent_attached row',
    })
  }

  requestCancellation(executionId: string | undefined, reason: string): void {
    this.step(executionId, { kind: 'request_cancellation', reason })
  }

  finish(executionId: string | undefined, terminal: ExecutionTerminal): void {
    this.step(executionId, { kind: 'finish', terminal })
  }

  finishByAgent(agentId: string, terminal: ExecutionTerminal): void {
    this.fire('finish_by_agent', ledger => ledger.finishByAgent(agentId, terminal))
  }

  private step(executionId: string | undefined, step: ShadowStep): void {
    if (executionId === undefined) return
    this.fire(step.kind, ledger => ledger.advance(executionId, step))
  }

  private fire(op: string, write: (ledger: ShadowLedger) => Promise<unknown>): void {
    if (this.ledger === undefined) return
    const report = (err: unknown): void =>
      logEvent('ledger_shadow_error', { kind: 'thrown', op, reason: String(err) })
    try {
      write(this.ledger).catch(report)
    } catch (err) {
      report(err)
    }
  }
}
