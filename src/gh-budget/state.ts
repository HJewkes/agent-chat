import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { withLock } from './lock.js'

/**
 * The shared GitHub cooldown for agents' direct gh calls (CC-1162): one file the shim and gh-write
 * both read, written when a call is refused by a rate limit. Cooldown only; there is no bucket.
 * Format and rules: docs/gh-budget.md.
 */

export type Lane = 'rest' | 'graphql'
export const LANES: readonly Lane[] = ['rest', 'graphql']
export type HitClass = 'secondary' | 'primary'

export interface Cooldown {
  /** Epoch ms the lane opens again. */
  until: number
  class: HitClass
  /** Who saw the limit: this machine's own gh calls, or Shepherd serve's gateway. */
  source?: 'observed' | 'gateway'
}

interface LaneEntry extends Cooldown {
  strikes: number
}

export type Cooldowns = Partial<Record<Lane, Cooldown>>

export interface Hit {
  lane: Lane
  class: HitClass
  retryAfterSeconds?: number | undefined
  /** `x-ratelimit-reset`, epoch seconds. */
  resetSeconds?: number | undefined
}

export const BASE_COOLDOWN_MS = 60_000
export const MAX_SECONDARY_MS = 15 * 60_000

export interface BudgetPaths {
  stateFile: string
  lockDir: string
  gatewayFile: string
}

export function budgetPaths(env: NodeJS.ProcessEnv = process.env): BudgetPaths {
  const dir = path.join(env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'gh-budget')
  return {
    stateFile: path.join(dir, 'cooldown.json'),
    lockDir: path.join(dir, 'cooldown.lock'),
    gatewayFile: path.join(dir, 'gateway.json'),
  }
}

/** `max(retry-after, 60 s × 2^strikes)`, capped at 15 min. */
const backoffMs = (strikes: number, retryAfterSeconds: number | undefined): number =>
  Math.min(Math.max((retryAfterSeconds ?? 0) * 1000, BASE_COOLDOWN_MS * 2 ** strikes), MAX_SECONDARY_MS)

/** A primary hit lasts until the quota resets; without a usable reset it backs off like a secondary one. */
function hitEnd(hit: Hit, strikes: number, now: number): number {
  const reset = hit.resetSeconds === undefined ? 0 : hit.resetSeconds * 1000
  if (hit.class === 'primary' && reset > now) return reset
  return now + backoffMs(strikes, hit.retryAfterSeconds)
}

/**
 * The lane's entry after a hit. A hit while the lane is still cooling is the same incident seen
 * again (another caller, or the shim and gh-write both reporting one call), so it never adds a
 * strike; a hit soon after a cooldown ended means the limit was still there and adds one.
 */
export function nextEntry(prev: LaneEntry | undefined, hit: Hit, now: number): LaneEntry {
  if (prev !== undefined && prev.until > now) {
    const until = hitEnd(hit, prev.strikes, now)
    return until > prev.until ? { until, class: hit.class, strikes: prev.strikes } : prev
  }
  const recent = prev !== undefined && now - prev.until < MAX_SECONDARY_MS
  const strikes = recent ? prev.strikes + 1 : 0
  return { until: hitEnd(hit, strikes, now), class: hit.class, strikes }
}

type StateFile = Partial<Record<Lane, LaneEntry>>

const isEntry = (value: unknown): value is LaneEntry => {
  const entry = value as Partial<LaneEntry> | null
  return (
    typeof entry?.until === 'number' &&
    (entry.class === 'secondary' || entry.class === 'primary') &&
    typeof entry.strikes === 'number'
  )
}

function readState(stateFile: string): StateFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  } catch {
    return {}
  }
  const state: StateFile = {}
  for (const lane of LANES) {
    const entry = (parsed as Record<string, unknown> | null)?.[lane]
    if (isEntry(entry)) state[lane] = entry
  }
  return state
}

/** Readers take no lock, so the file is replaced whole. */
function writeState(stateFile: string, state: StateFile): void {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true })
  const tmp = `${stateFile}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(state))
  fs.renameSync(tmp, stateFile)
}

/** The lanes cooling down at `now`, from the observed state only. */
export function observedCooldowns(paths: BudgetPaths, now: number): Cooldowns {
  const active: Cooldowns = {}
  for (const [lane, entry] of Object.entries(readState(paths.stateFile)) as [Lane, LaneEntry][]) {
    if (entry.until > now) active[lane] = { until: entry.until, class: entry.class, source: 'observed' }
  }
  return active
}

export interface RecordDeps {
  now(): number
  sleep(ms: number): Promise<void>
}

/** Best effort: a failed state write never fails the gh call that observed the hit. */
export async function recordHit(paths: BudgetPaths, hit: Hit, deps: RecordDeps): Promise<void> {
  try {
    await withLock({ ...deps, lockDir: paths.lockDir }, async () => {
      const state = readState(paths.stateFile)
      state[hit.lane] = nextEntry(state[hit.lane], hit, deps.now())
      writeState(paths.stateFile, state)
    })
  } catch {
    // The next refused call records it again.
  }
}

/** The later cooldown per lane. */
export function mergeCooldowns(a: Cooldowns, b: Cooldowns): Cooldowns {
  const merged: Cooldowns = { ...a }
  for (const lane of LANES) {
    const other = b[lane]
    if (other !== undefined && (merged[lane]?.until ?? 0) < other.until) merged[lane] = other
  }
  return merged
}
