import { createHash } from 'node:crypto'
import { claimKey, type ClaimKey } from './advance.js'
import type { Ledger, LivenessRecord } from './ledger.js'

export const LIVENESS_LIMIT = 3
export const LIVENESS_TTL_MS = 24 * 60 * 60 * 1000

const STAMPED_KEY = /^\s*(?:updated|created|[A-Za-z0-9]*_at|[A-Za-z0-9]*At)\s*:/
const ISO_DATETIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g
const MSG_ID = /\bmsg[_-][A-Za-z0-9-]+/g
const PID = /\bpid[ =:]+\d+/gi
const HEX_SHA = /\b[0-9a-f]{7,40}\b/g

/** Drops the lines a tool stamps on every write and replaces ISO datetimes, so a clock tick is not a fact. */
export const stripTimestamps = (text: string): string =>
  text
    .split('\n')
    .filter(line => !STAMPED_KEY.test(line))
    .join('\n')
    .replace(ISO_DATETIME, '<ts>')

/** `stripTimestamps` plus the ids that differ on every refusal, so two refusals of one cause read alike. */
export const maskText = (text: string): string =>
  stripTimestamps(text).replace(MSG_ID, '<msg>').replace(PID, 'pid <pid>').replace(HEX_SHA, '<sha>')

const VOLATILE_KEY = /^(?:name|.*At|.*_at)$/

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([k]) => !VOLATILE_KEY.test(k))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => [k, canonical(v)]),
  )
}

/** A stable hash of an action's facts; strings are stripped of timestamps, and names and `*At` keys are left out. */
export function factFingerprint(facts: unknown): string {
  const stripped = JSON.parse(JSON.stringify(facts), (_k, v: unknown) =>
    typeof v === 'string' ? stripTimestamps(v) : v,
  ) as unknown
  return createHash('sha256')
    .update(JSON.stringify(canonical(stripped)))
    .digest('hex')
}

const recordKey = (key: ClaimKey, action: string): string => `${claimKey(key)}|${action}`

/** Counts one failure of `action` for `fp`; the third with unchanged facts is a park. */
export function spend(
  ledger: Ledger,
  key: ClaimKey,
  action: string,
  fp: string,
  text: string,
  now: Date,
): { ledger: Ledger; verdict: 'retry' | 'park'; n: number } {
  const id = recordKey(key, action)
  const at = now.toISOString()
  const prior = ledger.liveness?.[id]?.byFact[fp]
  const n = (prior?.n ?? 0) + 1
  const record: LivenessRecord = {
    byFact: {
      ...ledger.liveness?.[id]?.byFact,
      [fp]: { n, firstAt: prior?.firstAt ?? at, lastAt: at, lastText: maskText(text) },
    },
  }
  return {
    ledger: { ...ledger, liveness: { ...ledger.liveness, [id]: record } },
    verdict: n >= LIVENESS_LIMIT ? 'park' : 'retry',
    n,
  }
}

/** Forgets an action's failures once it succeeds. */
export function clearLiveness(ledger: Ledger, key: ClaimKey, action: string): Ledger {
  const { [recordKey(key, action)]: _gone, ...rest } = ledger.liveness ?? {}
  return { ...ledger, liveness: rest }
}

/** Drops each fingerprint 24 h after its last failure, whether or not a claim is held. */
export function pruneLiveness(ledger: Ledger, now: Date): Ledger {
  if (ledger.liveness === undefined) return ledger
  const live = Object.entries(ledger.liveness).flatMap(([id, record]) => {
    const byFact = Object.fromEntries(
      Object.entries(record.byFact).filter(([, f]) => now.getTime() - Date.parse(f.lastAt) < LIVENESS_TTL_MS),
    )
    return Object.keys(byFact).length === 0 ? [] : [[id, { byFact }] as const]
  })
  return { ...ledger, liveness: Object.fromEntries(live) }
}
