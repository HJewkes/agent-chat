import { z } from 'zod'
import type { AgentIdentity } from '../../protocol.js'
import { REMOTE_UNPROBED } from '../detached-reap.js'
import { SAFE_TOKEN } from './block-page.js'
import type { Notified } from './notified-state.js'

/**
 * OWNER-2: an agent whose MCP connection to the broker closed and stayed closed past a threshold.
 * Pure; the seat watchdog's sub-pass pages it to the human queue and the operator brief lists it.
 */

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
/** Remote detaches this close together on one host read as one dropped tunnel, not a closed pane. */
export const BURST_WINDOW_MS = 2 * MINUTE_MS

const DetachedAlertSchema = z
  .object({
    enabled: z.boolean().default(true),
    thresholdMinutes: z.number().int().positive().default(15),
    renotifyMinutes: z.number().int().positive().default(120),
    maxAgeHours: z.number().positive().default(24),
    remoteBurst: z.number().int().positive().default(2),
  })
  .strict()

export type DetachedAlertConfig = z.infer<typeof DetachedAlertSchema>

export const DEFAULT_DETACHED_ALERT: DetachedAlertConfig = DetachedAlertSchema.parse({})

/** `detachedAlert` from config.json, or the reason it is invalid. */
export function parseDetachedAlert(value: unknown): DetachedAlertConfig | string {
  const parsed = DetachedAlertSchema.safeParse(value)
  if (parsed.success) return parsed.data
  return parsed.error.issues.map(i => `${i.path.join('.') || 'detachedAlert'}: ${i.message}`).join('; ')
}

export interface DetachedCandidate {
  agentId: string
  name: string
  host?: string
  detachedAt: number
  minutes: number
  /** On a host the broker cannot probe: the reaper inferred its exit from silence alone. */
  remote: boolean
}

/** The reaper could not prove the process dead, so the row stays detached. */
const localDetached = (a: AgentIdentity): boolean => a.state === 'detached'

/** The reaper wrote the exit only because the row's host is out of its reach. */
const remoteInferred = (a: AgentIdentity): boolean =>
  a.state === 'exited' &&
  a.exit?.inferred === true &&
  a.exit.summary.includes(REMOTE_UNPROBED) &&
  a.exitedAt !== undefined &&
  a.detachedAt !== undefined &&
  a.exitedAt >= a.detachedAt

/** Names a teleport successor or a resume now holds. */
const heldNames = (roster: readonly AgentIdentity[]): Set<string> =>
  new Set(roster.filter(a => a.state === 'live' || a.state === 'spawning').map(a => a.name))

const withinAge = (detachedAt: number, rules: DetachedAlertConfig, nowMs: number): boolean =>
  nowMs - detachedAt >= rules.thresholdMinutes * MINUTE_MS &&
  nowMs - detachedAt <= rules.maxAgeHours * HOUR_MS

export function detachedCandidates(
  roster: readonly AgentIdentity[],
  rules: DetachedAlertConfig,
  nowMs: number,
): DetachedCandidate[] {
  const held = heldNames(roster)
  return roster.flatMap(a => {
    const at = a.detachedAt
    if (at === undefined || held.has(a.name) || !withinAge(at, rules, nowMs)) return []
    const remote = remoteInferred(a)
    if (!remote && !localDetached(a)) return []
    const minutes = Math.floor((nowMs - at) / MINUTE_MS)
    return [{ agentId: a.agentId, name: a.name, ...hostOf(a), detachedAt: at, minutes, remote }]
  })
}

const hostOf = (a: AgentIdentity): { host?: string } => (a.host === undefined ? {} : { host: a.host })

/** One machine under several spellings (`mac.local`, `mac.localdomain`) is one burst. */
export const hostKey = (host: string | undefined): string =>
  (host ?? '').toLowerCase().replace(/\.(local|localdomain|lan)$/, '')

/** Local rows always; a remote row only with `remoteBurst` rows on its host detached within the burst window. */
export function burstFilter(
  candidates: readonly DetachedCandidate[],
  rules: DetachedAlertConfig,
): DetachedCandidate[] {
  return candidates.filter(c => {
    if (!c.remote) return true
    const near = candidates.filter(
      o =>
        o.remote &&
        hostKey(o.host) === hostKey(c.host) &&
        Math.abs(o.detachedAt - c.detachedAt) <= BURST_WINDOW_MS,
    )
    return near.length >= rules.remoteBurst
  })
}

export const candidateKey = (c: Pick<DetachedCandidate, 'agentId' | 'detachedAt'>): string =>
  `${c.agentId}@${c.detachedAt}`

export interface DetachedPick {
  notify: DetachedCandidate[]
  /** Still-detached keys only, so a reattached row drops out. */
  notified: Notified
}

export function pickDetached(
  due: readonly DetachedCandidate[],
  rules: DetachedAlertConfig,
  notified: Notified,
  nowMs: number,
): DetachedPick {
  const renotifyMs = rules.renotifyMinutes * MINUTE_MS
  const notify = due.filter(c => {
    const last = notified[candidateKey(c)]
    return last === undefined || nowMs - last >= renotifyMs
  })
  const next: Notified = {}
  for (const c of due) next[candidateKey(c)] = notified[candidateKey(c)] ?? nowMs
  for (const c of notify) next[candidateKey(c)] = nowMs
  return { notify, notified: next }
}

const safeName = (c: DetachedCandidate): string => (SAFE_TOKEN.test(c.name) ? c.name : c.agentId.slice(0, 8))
const safeHost = (host: string | undefined): string =>
  host !== undefined && SAFE_TOKEN.test(host) ? host : '?'

const names = (list: readonly DetachedCandidate[]): string =>
  list.map(c => `${safeName(c)} ${c.minutes}m`).join(', ')

/** Remote rows grouped by host and marked unverified; local rows last, marked with `localNote` if given. */
function candidateList(candidates: readonly DetachedCandidate[], localNote: string | undefined): string {
  const hosts = new Map<string, DetachedCandidate[]>()
  for (const c of candidates.filter(c => c.remote)) {
    const host = safeHost(c.host)
    hosts.set(host, [...(hosts.get(host) ?? []), c])
  }
  const parts = [...hosts].map(([host, list]) => `${names(list)} (host ${host}, unverified)`)
  const local = candidates.filter(c => !c.remote)
  if (local.length > 0) parts.push(localNote === undefined ? names(local) : `${names(local)} (${localNote})`)
  return parts.join(', ')
}

/** The pass's one human-queue notice; local rows reach it only after a live probe. */
export function noticeText(candidates: readonly DetachedCandidate[], rules: DetachedAlertConfig): string {
  return (
    `Detached over ${rules.thresholdMinutes} min, MCP connection to the broker gone: ` +
    `${candidateList(candidates, 'process alive')}. Run /mcp in each pane.`
  )
}

/** The operator-brief header line; unprobed, so local rows carry no note. */
export function briefText(candidates: readonly DetachedCandidate[], rules: DetachedAlertConfig): string {
  return `detached >${rules.thresholdMinutes}m: ${candidateList(candidates, undefined)}`
}
