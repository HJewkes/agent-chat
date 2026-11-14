import { z } from 'zod'
import type { PushHold } from '../../broker/push-hold.js'

/**
 * The held-message relay: mail that sits unanswered in a coordinator's inbox past a threshold
 * becomes one human-queue notice. Pure; the reads and the effects live in the verb.
 */

const MINUTE_MS = 60_000

const validPattern = (source: string): boolean => {
  try {
    new RegExp(source, 'i')
    return true
  } catch {
    return false
  }
}

const minutes = z.number().int().positive()

const HeldRelaySchema = z
  .object({
    enabled: z.boolean().default(false),
    everyMinutes: minutes.default(10),
    thresholdMinutes: minutes.default(15),
    patterns: z
      .array(z.string().refine(validPattern, 'not a valid regular expression'))
      .default(['^Status:', '\\bsheet\\b', '\\bmerged?\\b', '\\bowner\\b']),
    recipients: z.array(z.string().min(1)).default([]),
    includeCoordinators: z.boolean().default(true),
    heldOnly: z.boolean().default(true),
    wakeParked: z.boolean().default(false),
    renotifyMinutes: minutes.default(120),
  })
  .strict()

export type HeldRelayConfig = z.infer<typeof HeldRelaySchema>

export const DEFAULT_HELD_RELAY: HeldRelayConfig = HeldRelaySchema.parse({})

/** `heldRelay` from config.json, or the reason it is invalid. */
export function parseHeldRelay(value: unknown): HeldRelayConfig | string {
  const parsed = HeldRelaySchema.safeParse(value)
  if (parsed.success) return parsed.data
  return parsed.error.issues.map(i => `${i.path.join('.') || 'heldRelay'}: ${i.message}`).join('; ')
}

/** One message waiting for `recipient` since before the recipient's last turn row. */
export interface HeldItem {
  recipient: string
  msgId: string
  from: string
  ts: number
  body: string
  hold: PushHold | undefined
}

/** Dedupe state: item key to the epoch ms it was last noticed. */
export type Notified = Record<string, number>

export const itemKey = (item: Pick<HeldItem, 'recipient' | 'msgId'>): string =>
  `${item.recipient}:${item.msgId}`

export interface PickInput {
  items: readonly HeldItem[]
  rules: HeldRelayConfig
  notified: Notified
  nowMs: number
}

export interface PickResult {
  notify: HeldItem[]
  /** Parked recipients to wake; empty unless `wakeParked`. */
  wake: string[]
  /** The state to save: still-stuck items only, so answered ones drop out. */
  notified: Notified
}

const matches = (patterns: readonly string[], body: string): boolean =>
  patterns.length === 0 || patterns.some(p => new RegExp(p, 'i').test(body))

const stuck = (item: HeldItem, rules: HeldRelayConfig, nowMs: number): boolean =>
  nowMs - item.ts >= rules.thresholdMinutes * MINUTE_MS &&
  matches(rules.patterns, item.body) &&
  (!rules.heldOnly || item.hold !== undefined)

export function pickHeld({ items, rules, notified, nowMs }: PickInput): PickResult {
  const due = items.filter(item => stuck(item, rules, nowMs))
  const renotifyMs = rules.renotifyMinutes * MINUTE_MS
  const notify = due.filter(item => {
    const last = notified[itemKey(item)]
    return last === undefined || nowMs - last >= renotifyMs
  })
  const next: Notified = {}
  for (const item of due) next[itemKey(item)] = notified[itemKey(item)] ?? nowMs
  for (const item of notify) next[itemKey(item)] = nowMs
  const wake = rules.wakeParked
    ? [...new Set(notify.filter(i => i.hold === 'parked').map(i => i.recipient))]
    : []
  return { notify, wake, notified: next }
}

const PREVIEW_CHARS = 120

const preview = (body: string): string => {
  const line = body.split('\n')[0] ?? ''
  return line.length > PREVIEW_CHARS ? `${line.slice(0, PREVIEW_CHARS)}…` : line
}

/** One human-queue notice for one stuck message. */
export function noticeText(item: HeldItem, nowMs: number): string {
  const age = Math.floor((nowMs - item.ts) / MINUTE_MS)
  const why = item.hold ?? 'not held, no turn since'
  const answer = item.hold === 'parked' ? ' Write to it to unpark it.' : ''
  return (
    `Held ${age} min for ${item.recipient} (${why}): ${item.from} wrote "${preview(item.body)}" ` +
    `[${item.msgId}].${answer}`
  )
}
