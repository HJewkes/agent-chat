import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { distDir } from '../../paths.js'
import type { BriefApproval, BriefRoute } from './brief-approve.js'
import type { DeciderVerdict } from './decider.js'
import type { NoDispatchReason, SeatOutcome } from './no-dispatch.js'
import type { Dispatch } from './plan.js'
import type { TickConfig } from './source.js'
import type { TriageVerdict } from './triage.js'

/**
 * CC-1193 S0a: one record per real tick of what it read and decided, for the dispatch-workflow shadow diff.
 * Records live in `records/<ms>-<ledger sha>.json`; the ledger each read lives once in `ledgers/<sha>.json`.
 */

export const SHADOW_RETENTION_MS = 72 * 3_600_000
export const SHADOW_MAX_RECORDS = 500

const opt = z.string().optional()
const Pair = z.object({ slug: z.string(), taskId: z.string() })

export const ShadowDecisionsV1 = z.object({
  steps: z.array(z.string()),
  dispatches: z.array(
    z.object({
      seat: opt,
      initiative: z.string(),
      task: z.string(),
      slice: opt,
      profile: z.string(),
      account: z.string(),
      name: z.string(),
    }),
  ),
  refusals: z.array(
    z.object({ seat: z.string(), initiative: z.string(), task: opt, kind: z.string(), reason: z.string() }),
  ),
  triage: z.array(
    z.object({
      kind: z.enum(['start', 'wait', 'owner']),
      taskId: z.string(),
      slice: opt,
      occurrence: z.string(),
      name: opt,
      reason: opt,
    }),
  ),
  decider: z
    .object({ wake: z.boolean(), waiting: z.number().optional(), briefs: z.number().optional(), reason: opt })
    .optional(),
  briefs: z.object({ approved: z.array(Pair), routed: z.array(Pair) }),
  closing: z.array(z.object({ initiative: z.string(), id: z.string() })),
  reasons: z.array(z.object({ seat: z.string(), text: z.string() })),
})
export type ShadowDecisions = z.infer<typeof ShadowDecisionsV1>

export const ShadowRecordV1 = z.object({
  v: z.literal(1),
  /** The tick's `now`, the same value as its summary row's `ts`. */
  ts: z.string(),
  agentChatSha: opt,
  /** The sha256 of the ledger as the tick read it, before any write; its text is `ledgers/<sha>.json`. */
  ledgerSha: z.string(),
  config: z.record(z.string(), z.unknown()),
  decisions: ShadowDecisionsV1,
})
export type ShadowRecord = z.infer<typeof ShadowRecordV1>

/** What `runTick` hands back for the record: the ledger text as read, and the decisions it acted on. */
export interface ShadowCapture {
  ledgerText: string
  config: TickConfig
  decisions: ShadowDecisions
}

export interface DecisionInputs {
  steps: string[]
  briefs: { approved: readonly BriefApproval[]; routes: readonly BriefRoute[] }
  decided: {
    summary: { dispatch: readonly Dispatch[]; outcomes: readonly SeatOutcome[] }
    triage: { verdicts: readonly TriageVerdict[] }
    decider?: DeciderVerdict
    closing: readonly { initiative: string; id: string }[]
    reasons: readonly NoDispatchReason[]
  }
}

export function shadowDecisions({ steps, briefs, decided }: DecisionInputs): ShadowDecisions {
  const { decider } = decided
  return {
    steps,
    dispatches: decided.summary.dispatch.map(d => ({
      ...(d.seat === undefined ? {} : { seat: d.seat }),
      initiative: d.initiative,
      task: d.task,
      ...(d.slice === undefined ? {} : { slice: d.slice }),
      profile: d.profile,
      account: d.account,
      name: d.agentName,
    })),
    refusals: decided.summary.outcomes.flatMap(o =>
      o.refusals.map(({ initiative, task, kind, reason }) => ({
        seat: o.seat,
        initiative,
        ...(task === undefined ? {} : { task }),
        kind,
        reason,
      })),
    ),
    triage: decided.triage.verdicts.map(({ key, ...v }) => ({ ...v, ...key })),
    ...(decider === undefined ? {} : { decider: deciderOf(decider) }),
    briefs: {
      approved: briefs.approved.map(({ slug, taskId }) => ({ slug, taskId })),
      routed: briefs.routes.map(({ slug, taskId }) => ({ slug, taskId })),
    },
    closing: decided.closing.map(({ initiative, id }) => ({ initiative, id })),
    reasons: decided.reasons.map(({ seat, text }) => ({ seat, text })),
  }
}

const deciderOf = (d: DeciderVerdict): ShadowDecisions['decider'] =>
  d.wake ? { wake: true, waiting: d.waiting, briefs: d.briefs } : { wake: false, reason: d.reason }

let sha: { value: string | undefined } | undefined

/** The agent-chat checkout's HEAD, read once per process; undefined outside a git checkout. */
export function agentChatSha(): string | undefined {
  sha ??= { value: readHead(path.dirname(distDir())) }
  return sha.value
}

function readHead(root: string): string | undefined {
  try {
    const out = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return out.trim() || undefined
  } catch {
    return undefined
  }
}

const writeAtomic = (file: string, text: string): void => {
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, text, { mode: 0o600 })
  fs.renameSync(tmp, file)
}

/** Writes one tick's record, its ledger unless that sha is already stored, then applies retention. */
export function writeShadowRecord(dir: string, capture: ShadowCapture, now: Date): void {
  const ledgerSha = createHash('sha256').update(capture.ledgerText).digest('hex')
  const record = ShadowRecordV1.parse({
    v: 1,
    ts: now.toISOString(),
    agentChatSha: agentChatSha(),
    ledgerSha,
    config: capture.config,
    decisions: capture.decisions,
  })
  const ledgers = path.join(dir, 'ledgers')
  const records = path.join(dir, 'records')
  fs.mkdirSync(ledgers, { recursive: true, mode: 0o700 })
  fs.mkdirSync(records, { recursive: true, mode: 0o700 })
  const ledgerFile = path.join(ledgers, `${ledgerSha}.json`)
  if (!fs.existsSync(ledgerFile)) writeAtomic(ledgerFile, capture.ledgerText)
  writeAtomic(path.join(records, recordName(now, ledgerSha)), `${JSON.stringify(record)}\n`)
  pruneShadow(dir, now)
}

/** Zero-padded ms first, so names sort by time; the ledger sha second, so pruning reads no record. */
const recordName = (at: Date, ledgerSha: string): string =>
  `${String(at.getTime()).padStart(15, '0')}-${ledgerSha}.json`

const parseName = (name: string): { ms: number; ledgerSha: string } | undefined => {
  const m = /^(\d+)-([0-9a-f]{64})\.json$/.exec(name)
  return m === null ? undefined : { ms: Number(m[1]), ledgerSha: m[2]! }
}

/** Keeps the newest records within 72 h, at most 500, and the ledgers they still name. */
export function pruneShadow(dir: string, now: Date): void {
  const records = path.join(dir, 'records')
  const ledgers = path.join(dir, 'ledgers')
  const cutoff = now.getTime() - SHADOW_RETENTION_MS
  const names = fs
    .readdirSync(records)
    .filter(n => parseName(n) !== undefined)
    .sort()
  const kept = names.filter(n => parseName(n)!.ms >= cutoff).slice(-SHADOW_MAX_RECORDS)
  const keep = new Set(kept)
  for (const name of names) if (!keep.has(name)) fs.rmSync(path.join(records, name), { force: true })
  const named = new Set(kept.map(n => parseName(n)!.ledgerSha))
  for (const name of fs.readdirSync(ledgers))
    if (name.endsWith('.json') && !named.has(name.slice(0, -'.json'.length)))
      fs.rmSync(path.join(ledgers, name), { force: true })
}
