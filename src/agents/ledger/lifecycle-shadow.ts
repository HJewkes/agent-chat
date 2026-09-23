import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import type {
  ConversationIdentity,
  ExecutionTerminal,
  LifecycleExecutionTarget,
} from '@titan-design/agent-protocol'
import { logEvent } from '../../broker/log.js'
import type { LaunchHandle } from '../types.js'
import type { ShadowLedger, ShadowStep } from './shadow-ledger.js'

/**
 * CC-147: a fresh execution's `target.namespace` is the agent's `CLAUDE_CONFIG_DIR`, the corpus its
 * transcript lives in, because the reducer requires it to equal the observed conversation's namespace.
 * Live and backfilled rows both build it here; an unknown session id yields no conversation, since
 * the reducer rejects an empty `nativeId`.
 */
export function claudeConversation(configDir: string, sessionId: string): ConversationIdentity | undefined {
  return sessionId === '' ? undefined : { harness: 'claude-code', namespace: configDir, nativeId: sessionId }
}

export interface ExitOutcome {
  code: number | null
  signal: string | null
  inferred?: boolean
}

/** agent-lifecycle 0.1 has no `ended`, so a clean or inferred exit is `succeeded` until TP-192 re-maps it. */
export function exitTerminal(
  outcome: ExitOutcome,
  failed: string | undefined,
  cancelReason: string | undefined,
): ExecutionTerminal {
  if (failed !== undefined) return { outcome: 'failed', reason: failed, retryable: false }
  if (cancelReason !== undefined) return { outcome: 'cancelled', reason: cancelReason }
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
  private lastStamp = 0

  constructor(private readonly ledger: ShadowLedger | undefined) {}

  /** Opens a fresh execution and returns its id, or undefined when shadowing is off. */
  open(agentId: string, namespace: string): string | undefined {
    return this.prepare(agentId, `spawn:${agentId}`, { kind: 'fresh', namespace })
  }

  /** Opens an execution on an existing conversation; each resume gets its own request key. */
  resume(agentId: string, namespace: string, sessionId: string): string | undefined {
    const conversation = { harness: 'claude-code', namespace, nativeId: sessionId }
    return this.prepare(agentId, `resume:${agentId}:${this.stamp()}`, { kind: 'resume', conversation })
  }

  private prepare(agentId: string, requestKey: string, target: LifecycleExecutionTarget): string | undefined {
    if (this.ledger === undefined) return undefined
    const executionId = randomUUID()
    const conversation = target.kind === 'resume' ? { conversation: target.conversation } : {}
    this.fire('prepare', ledger =>
      ledger.apply({
        kind: 'prepare',
        executionId,
        eventId: randomUUID(),
        expectedRevision: 0,
        occurredAt: new Date().toISOString(),
        execution: { executionId, ...conversation },
        agent: { agentId },
        harness: 'claude-code',
        requestKey,
        target,
        owner: ledger.newLease(),
      }),
    )
    this.step(executionId, { kind: 'begin_dispatch' })
    return executionId
  }

  /** `Date.now()`, bumped past the last one issued so two resumes in one millisecond stay distinct. */
  private stamp(): number {
    this.lastStamp = Math.max(Date.now(), this.lastStamp + 1)
    return this.lastStamp
  }

  running(executionId: string | undefined, handle: LaunchHandle, sessionId: string, configDir: string): void {
    const nativeId = handle.paneRef ?? String(handle.pid)
    const conversation = claudeConversation(configDir, sessionId)
    this.step(executionId, {
      kind: 'observe_running',
      runnerRef: nativeId,
      adapterExecution: { executionId: sessionId, ...(conversation && { conversation }) },
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
