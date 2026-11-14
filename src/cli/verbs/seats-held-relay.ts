import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import {
  itemKey,
  noticeText,
  pickHeld,
  type HeldItem,
  type HeldRelayConfig,
  type Notified,
} from '../../agents/seats/held-relay.js'
import { readHeldCandidates, readHolds } from '../../agents/seats/held-relay-read.js'
import type { WakeResult } from '../../agents/seats/run.js'
import { logEvent } from '../../broker/log.js'
import { resolveAutoStart, resolveHeldRelay } from '../../config.js'
import { home } from '../../paths.js'
import { defineVerb, Report } from '../command.js'
import { notifyAsWatchdog, sendAsOwner, withRunningBroker } from './seat-broker.js'

/** The relay reads the broker's events.db, so on a `remoteBroker` host it reads a stale copy. */
const REMOTE_WARNING =
  "warning: config remoteBroker is true; this events.db is not the broker host's, so the pass reads stale mail"

const WAKE_TEXT = 'Held-message relay: peer mail has waited past the threshold; read your inbox.'

export interface RelayPorts {
  rules: HeldRelayConfig
  /** Waiting messages as of `untilMs`, before the rules filter them. */
  read(untilMs: number): HeldItem[]
  loadState(): Notified
  saveState(notified: Notified): void
  notify(text: string): Promise<WakeResult>
  wake(recipient: string, text: string): Promise<WakeResult>
  log(detail: Record<string, unknown>): void
}

/** A dry run sends nothing and saves nothing, and starts from empty state so a replay lists every stuck item. */
function dryRun(ports: RelayPorts, nowMs: number): Report {
  const items = ports.read(nowMs)
  const picked = pickHeld({ items, rules: ports.rules, notified: {}, nowMs })
  const lines = picked.notify.map(item => noticeText(item, nowMs))
  const wakes = picked.wake.map(name => `would wake ${name}`)
  return { ok: true, lines: [...lines, ...wakes, `${picked.notify.length} held (dry run; nothing sent)`] }
}

async function deliver(ports: RelayPorts, notify: HeldItem[], nowMs: number): Promise<HeldItem[]> {
  const failed: HeldItem[] = []
  for (const item of notify) if (!(await ports.notify(noticeText(item, nowMs))).ok) failed.push(item)
  return failed
}

export async function runHeldRelay(
  ports: RelayPorts,
  opts: { dryRun: boolean; nowMs: number },
): Promise<Report> {
  if (opts.dryRun) return dryRun(ports, opts.nowMs)
  if (!ports.rules.enabled) return { ok: true, lines: ['heldRelay.enabled is false; nothing done'] }
  const previous = ports.loadState()
  const items = ports.read(opts.nowMs)
  const picked = pickHeld({ items, rules: ports.rules, notified: previous, nowMs: opts.nowMs })
  const failed = await deliver(ports, picked.notify, opts.nowMs)
  const saved = { ...picked.notified }
  for (const item of failed) {
    const before = previous[itemKey(item)]
    if (before === undefined) delete saved[itemKey(item)]
    else saved[itemKey(item)] = before
  }
  ports.saveState(saved)
  const woke: string[] = []
  for (const name of picked.wake) if ((await ports.wake(name, WAKE_TEXT)).ok) woke.push(name)
  const noticed = picked.notify.length - failed.length
  ports.log({ noticed, failed: failed.length, woke })
  const lines = [`${noticed} noticed, ${failed.length} failed, woke ${woke.join(', ') || 'none'}`]
  return { ok: failed.length === 0, lines }
}

export const heldRelayStatePath = (): string => path.join(home(), 'held-relay.json')

function loadState(file: string): Notified {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    return z.record(z.string(), z.number()).parse(parsed)
  } catch {
    return {}
  }
}

function saveState(file: string, notified: Notified): void {
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(notified, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(tmp, file)
}

function readItems(dbPath: string, rules: HeldRelayConfig, untilMs: number): HeldItem[] {
  const book = readHolds(dbPath, rules.recipients, untilMs)
  const names = new Set([...rules.recipients, ...(rules.includeCoordinators ? book.coordinators : [])])
  const holds = new Map([...book.holds].filter(([name]) => names.has(name)))
  return readHeldCandidates(dbPath, holds, rules.thresholdMinutes * 60_000, untilMs)
}

function livePorts(dbPath: string, rules: HeldRelayConfig): RelayPorts {
  const file = heldRelayStatePath()
  return {
    rules,
    read: untilMs => readItems(dbPath, rules, untilMs),
    loadState: () => loadState(file),
    saveState: notified => saveState(file, notified),
    notify: notifyAsWatchdog,
    wake: (recipient, text) => withRunningBroker(client => sendAsOwner(client, recipient, text)),
    log: detail => logEvent('held_relay', detail),
  }
}

export const seatsHeldRelayVerb = defineVerb({
  name: 'seats.held-relay',
  description:
    'one pass of the held-message relay: peer mail waiting past heldRelay.thresholdMinutes for a ' +
    'coordinator (or a heldRelay.recipients name) that has taken no turn since, filed as one ' +
    'human-queue notice per message and deduped across passes. A no-op until heldRelay.enabled',
  args: z.object({ dryRun: z.boolean().optional(), now: z.string().optional(), db: z.string().optional() }),
  result: Report,
  cli: {
    options: {
      dryRun: {
        long: '--dry-run',
        description: 'read only: list what would be noticed; sends, wakes and saves nothing, enabled or not',
      },
      now: { long: '--now', description: 'ISO instant to replay the pass at; needs --dry-run' },
      db: { long: '--db', description: 'events.db to read (default: the broker home)' },
    },
  },
  async run({ dryRun, now, db }) {
    if (now !== undefined && dryRun !== true)
      return { ok: false, lines: [], errors: ['--now replays a past pass; use it with --dry-run'] }
    const nowMs = now === undefined ? Date.now() : Date.parse(now)
    if (Number.isNaN(nowMs)) return { ok: false, lines: [], errors: [`--now is not an ISO instant: ${now}`] }
    const ports = livePorts(db ?? path.join(home(), 'events.db'), resolveHeldRelay())
    try {
      const report = await runHeldRelay(ports, { dryRun: dryRun === true, nowMs })
      return resolveAutoStart({}) ? report : { ...report, lines: [REMOTE_WARNING, ...report.lines] }
    } catch (err) {
      return { ok: false, lines: [], errors: [err instanceof Error ? err.message : String(err)] }
    }
  },
})
