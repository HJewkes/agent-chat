import os from 'node:os'
import path from 'node:path'
import { readAccountBudget, type BudgetRead } from '../budget.js'
import { parsePools, type Pool } from './charter.js'
import { loadDoc, readText, type WatchdogDoc } from './io.js'
import { readLedger, heldClaims } from '../burndown/ledger.js'
import { readInitiatives, readTasks } from '../burndown/source.js'
import { parseTaskTags } from '../burndown/task-tags.js'
import { taskOf } from './journal-line.js'
import { ownsSpawns, seatOf } from './seat-of.js'
import type { OverlapClaim, SeatSpawnInput } from './spawn-gate.js'
import { savedMeters } from './stops.js'
import { accountReading } from './watchdog.js'

/** CC-288: what the spawn gate needs from disk. `none` is a spawn no seat owns; `skip` names why a seat's is not gated. */
export type SeatSpawnRead =
  { kind: 'none' } | { kind: 'skip'; reason: string } | { kind: 'gate'; input: Omit<SeatSpawnInput, 'model'> }

export interface SeatSpawnReadDeps {
  readBudget: (configDir: string, nowMs: number) => BudgetRead
  loadDoc: () => WatchdogDoc
  home: string
}

export interface SeatSpawnRequest {
  name: string
  spawner: string
  /** The spawn's resolved config_dir, which names the pool it bills. */
  configDir: string
  now: Date
}

const defaultDeps: SeatSpawnReadDeps = {
  readBudget: readAccountBudget,
  loadDoc: () => loadDoc(),
  home: os.homedir(),
}

/** The charter pool billed through `configDir`, matched on the resolved path. */
export const poolForConfigDir = (pools: ReadonlyMap<string, Pool>, configDir: string): Pool | undefined =>
  [...pools.values()].find(pool => path.resolve(pool.configDir) === path.resolve(configDir))

/** An unreadable watchdog doc leaves the caps unmetered, and so unchecked, rather than refusing the spawn. */
function savedDoc(load: () => WatchdogDoc): WatchdogDoc | undefined {
  try {
    return load()
  } catch {
    return undefined
  }
}

/** Throws when the seats directory cannot be read; the broker logs that and lets the spawn through. */
export function readSeatSpawn(
  root: string,
  spawn: SeatSpawnRequest,
  deps: SeatSpawnReadDeps = defaultDeps,
): SeatSpawnRead {
  const charter = readText(path.join(root, 'charter.md'))
  if (charter === undefined) return { kind: 'none' }
  const match = seatOf(root, spawn.name, spawn.spawner)
  if (match.kind === 'none') return { kind: 'none' }
  if (match.kind === 'ambiguous')
    return { kind: 'skip', reason: `prefix ${match.prefix} is declared by ${match.seats.join(', ')}` }
  const { seat } = match.seat
  if (!ownsSpawns(charter, match.seat))
    return { kind: 'skip', reason: `seat ${seat.name} is not in the charter's seats` }
  const pool = poolForConfigDir(parsePools(charter, deps.home), spawn.configDir)
  if (pool === undefined)
    return { kind: 'skip', reason: `seat ${seat.name}: the spawn's config_dir is no charter pool's` }
  const nowMs = spawn.now.getTime()
  const read = deps.readBudget(pool.configDir, nowMs)
  const resetsAt = read.found ? read.budget.rate_limits.seven_day?.resets_at : undefined
  const meters = savedMeters(savedDoc(deps.loadDoc), seat.name, pool.name)
  const input: Omit<SeatSpawnInput, 'model'> = {
    seat,
    pool,
    reading: accountReading(read, nowMs),
    resetsAt: resetsAt === undefined ? undefined : resetsAt * 1000,
    runMeter: meters.run,
    dayMeter: meters.day,
    now: spawn.now,
  }
  return { kind: 'gate', input }
}

export interface OverlapRequest {
  name: string
  spawner: string
  /** The brief's task id, when the spawn request carries one. */
  task?: string | undefined
}

export interface OverlapFacts {
  task: string
  claims: OverlapClaim[]
  briefReady?: string | undefined
}

export interface OverlapPaths {
  /** The autonomy root, whose seat files give the name prefixes. */
  root: string
  ledgerFile: string
  activeRoot: string
}

/** The task a hand spawn runs: the request's own id wins, else the seat-prefixed name's. Throws when `seats/` is unreadable. */
function spawnTask(paths: OverlapPaths, req: OverlapRequest): string | undefined {
  if (req.task !== undefined) return req.task.toUpperCase()
  const match = seatOf(paths.root, req.name, req.spawner)
  return match.kind === 'seat' ? taskOf(req.name, match.seat.seat.prefix) : undefined
}

function briefReadyOf(activeRoot: string, task: string): string | undefined {
  for (const { slug } of readInitiatives(activeRoot)) {
    const found = readTasks(activeRoot, slug).find(t => t.id.toUpperCase() === task)
    if (found !== undefined) return parseTaskTags({ id: found.id, tags: found.tags }).task.briefReady
  }
  return undefined
}

/**
 * CC-932: the claims and brief tag a hand spawn's task holds. Undefined when the spawn names no task.
 * Throws when the seats directory or the ledger cannot be read; the broker logs that and lets the spawn through.
 */
export function readOverlap(paths: OverlapPaths, req: OverlapRequest): OverlapFacts | undefined {
  const task = spawnTask(paths, req)
  if (task === undefined) return undefined
  const claims = heldClaims(readLedger(paths.ledgerFile))
    .filter(claim => claim.taskId.toUpperCase() === task)
    .map(claim => ({ holder: claim.agentName ?? claim.seat }))
  return { task, claims, briefReady: briefReadyOf(paths.activeRoot, task) }
}
