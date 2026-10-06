import {
  MAX_WORKER_REPORT_LENGTH,
  WorkerFactsSchema,
  type WorkerFacts,
} from '@titan-design/agent-protocol/worker-facts'
import { logEvent } from '../broker/log.js'
import { reportKindOf } from '../broker/event-log.js'
import { reportPr } from './seats/retire-outcome.js'
import type { TranscriptSpendRead } from './transcript-spend.js'

/**
 * CC-763: the `on_complete` hook's payload. The legacy fields stay exactly as they were, `facts` is
 * a `WorkerFactsSchema` block, and `lastAction` names what a worker that sent no report did last.
 * Pure: the supervisor gathers the inputs, so a fixture can drive every field.
 */

export interface ExitFacts {
  code: number | null
  signal: string | null
  inferred: boolean
}

export interface CompletionInput {
  agentId: string
  agent: string
  profile: string
  spawner: string
  exit: ExitFacts
  /** The run's newest Status or Verdict message to its spawner, if it sent one. */
  report?: { msgId: string; text: string }
  spend?: TranscriptSpendRead
  /** exit-report.ts's last action; carried only when there is no report. */
  lastAction?: string
}

export interface CompletionPayload extends ExitFacts {
  agentId: string
  facts?: WorkerFacts
  lastAction?: string
}

/** `<prefix>-<task id>-<slug>`: the first `letters-digits` pair after the prefix, upper-cased. */
const TASK_ID = /^[a-z0-9]+-([a-z]+-\d+)(?:-|$)/i

export const taskIdOf = (name: string): string | null => TASK_ID.exec(name)?.[1]?.toUpperCase() ?? null

const ELLIPSIS = '…'

const capped = (text: string): string =>
  text.length <= MAX_WORKER_REPORT_LENGTH
    ? text
    : `${text.slice(0, MAX_WORKER_REPORT_LENGTH - ELLIPSIS.length)}${ELLIPSIS}`

function reportOf(report: CompletionInput['report']): WorkerFacts['report'] {
  const kind = report === undefined ? undefined : reportKindOf(report.text)
  if (report === undefined || kind === undefined) return null
  return { messageId: report.msgId, kind, text: capped(report.text) }
}

function prOf(report: CompletionInput['report']): WorkerFacts['pr'] {
  const ref = report === undefined ? null : reportPr(report.text)
  const [repo, number] = ref?.split('#') ?? []
  return repo === undefined || number === undefined ? null : { repo, number: Number(number) }
}

/** The same transcript sum the retire row records; input is every non-output class. */
function spendOf(spend: TranscriptSpendRead | undefined): Pick<WorkerFacts, 'tokens' | 'costUsd'> {
  if (spend === undefined || !spend.ok) return { tokens: null, costUsd: null }
  const output = spend.usage.output
  return {
    tokens: { input: spend.tokens - output, output, total: spend.tokens },
    costUsd: spend.usd_est,
  }
}

export function workerFactsOf(input: CompletionInput): WorkerFacts {
  return {
    agent: input.agent,
    profile: input.profile,
    spawner: input.spawner,
    taskId: taskIdOf(input.agent),
    report: reportOf(input.report),
    pr: prOf(input.report),
    ...spendOf(input.spend),
    exit: input.exit,
  }
}

/** A facts block that fails the schema is logged and dropped; the legacy fields always go. */
export function completionPayload(input: CompletionInput): CompletionPayload {
  const legacy = { agentId: input.agentId, ...input.exit }
  const parsed = WorkerFactsSchema.safeParse(workerFactsOf(input))
  if (!parsed.success) {
    logEvent('worker_facts_invalid', { agentId: input.agentId, error: parsed.error.message.slice(0, 500) })
    return legacy
  }
  const lastAction = parsed.data.report == null ? input.lastAction : undefined
  return { ...legacy, facts: parsed.data, ...(lastAction === undefined ? {} : { lastAction }) }
}
