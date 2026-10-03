import os from 'node:os'
import path from 'node:path'
import { defaultConfigDir } from '../config-dir.js'
import { isTrusted } from '../trust.js'
import { charterSeats, parseFunds, parsePools, seatInitiatives, seatPools, type Pool } from './charter.js'
import { readText } from './io.js'
import { readPace, type PaceRead } from './pace-file.js'
import { pickPool, type PoolCandidate, type PoolPick, type PoolPickMode } from './pool-pick.js'
import { seatOf } from './seat-of.js'
import { poolForConfigDir } from './spawn-gate-read.js'

/** CC-606: the broker's pool pick for an unpinned seat spawn, read from disk and walked past the budget gate. */

export interface PoolPickRequest {
  name: string
  spawner: string
  /** The config_dir the spawn resolves to today. */
  homeDir: string
  pinned: boolean
  cwd: string
  /** The briefing's initiative; without one the seat's own initiatives stand in. */
  initiative?: string
  now: Date
}

export type PoolPickRead =
  { kind: 'none' } | { kind: 'pick'; seat: string; home?: string; pools: Pool[]; pick: PoolPick }

export interface PoolPickReadDeps {
  readPace: () => PaceRead
  trusted: (cwd: string, configDir: string) => boolean
  home: string
}

/** The default account keeps its trust in `~/.claude.json`, which the CLI reads with the variable unset. */
const trustsCwd = (cwd: string, configDir: string, home: string): boolean =>
  isTrusted(cwd, path.resolve(configDir) === defaultConfigDir(home) ? undefined : configDir) !== false

const defaultDeps = (): PoolPickReadDeps => {
  const home = os.homedir()
  return { readPace: () => readPace(), trusted: (cwd, dir) => trustsCwd(cwd, dir, home), home }
}

/** `none` is a spawn no charter seat owns. Throws when the seats directory cannot be read. */
export function readPoolPick(
  root: string,
  spawn: PoolPickRequest,
  deps: PoolPickReadDeps = defaultDeps(),
): PoolPickRead {
  const charter = readText(path.join(root, 'charter.md'))
  if (charter === undefined) return { kind: 'none' }
  const match = seatOf(root, spawn.name, spawn.spawner)
  if (match.kind !== 'seat' || !charterSeats(charter).includes(match.seat.seat.name)) return { kind: 'none' }
  const { seat, text } = match.seat
  const all = parsePools(charter, deps.home)
  const allowed = seatPools(text)
  const pools = [...all.values()].filter(pool => allowed === undefined || allowed.includes(pool.name))
  const home = poolForConfigDir(all, spawn.homeDir)?.name
  const pick = pickPool({
    pinned: spawn.pinned,
    home,
    pools,
    funds: parseFunds(charter),
    initiatives: spawn.initiative === undefined ? seatInitiatives(text) : [spawn.initiative],
    pace: deps.readPace(),
    trusted: pool => deps.trusted(spawn.cwd, pool.configDir),
    now: spawn.now.getTime(),
  })
  return { kind: 'pick', seat: seat.name, pools, pick, ...(home === undefined ? {} : { home }) }
}

/** What the broker logs and writes as the `pool_pick` event row. */
export interface PoolPickRecord {
  seat: string
  mode: PoolPickMode
  /** Shadow mode: the pick was computed and the spawn billed its home pool. */
  would: boolean
  home: string | null
  chosen: string | null
  reason: string
  candidates: PoolCandidate[]
}

export interface PoolRoute {
  record: PoolPickRecord
  /** Enforce mode: the pool to bill in place of the home pool. */
  redirect?: Pool
  /** Enforce mode: every eligible pool is past a budget stop. */
  refusal?: string
}

/** The pick's candidates, with a pool the budget gate closed carrying the gate's reason. */
const withClosed = (candidates: PoolCandidate[], closed: ReadonlyMap<string, string>): PoolCandidate[] =>
  candidates.map(c => {
    const reason = closed.get(c.pool)
    return reason === undefined ? c : { ...c, skip: reason }
  })

/** Redirect before refuse: the first pool in the pick's order whose gate is open; `gate` returns why a pool is closed. */
export function routePool(
  read: Extract<PoolPickRead, { kind: 'pick' }>,
  mode: PoolPickMode,
  gate: (configDir: string) => string | undefined,
): PoolRoute {
  const closed = new Map<string, string>()
  const inOrder = read.pick.order.flatMap(name => read.pools.filter(pool => pool.name === name))
  const chosen = inOrder.find(pool => {
    const reason = gate(pool.configDir)
    if (reason !== undefined) closed.set(pool.name, reason)
    return reason === undefined
  })
  const record: PoolPickRecord = {
    seat: read.seat,
    mode,
    would: mode === 'shadow',
    home: read.home ?? null,
    chosen: chosen?.name ?? null,
    reason: read.pick.reason,
    candidates: withClosed(read.pick.candidates, closed),
  }
  if (mode !== 'enforce' || inOrder.length === 0) return { record }
  if (chosen === undefined) return { record, refusal: allClosed(closed) }
  return chosen.name === read.home ? { record } : { record, redirect: chosen }
}

const allClosed = (closed: ReadonlyMap<string, string>): string =>
  `every eligible pool is closed: ${[...closed].map(([pool, reason]) => `${pool}: ${reason}`).join('; ')}`

/** One line for the event row's body and `seats status`. */
export function poolPickText(agent: string, record: PoolPickRecord): string {
  const verb = record.would ? 'would bill' : 'bills'
  const choice =
    record.chosen === null ? `keeps ${record.home ?? 'its own account'}` : `${verb} ${record.chosen}`
  return `pool pick (${record.mode}) for ${agent}: ${choice}, home ${record.home ?? 'none'}: ${record.reason}`
}
