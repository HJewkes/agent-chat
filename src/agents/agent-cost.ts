import type { AgentEventRow } from '../broker/event-store.js'
import type { AgentCostEstimate, CostMetric } from '../protocol.js'
import { FOOTPRINT_INTERVAL_MS, parseFootprintMeta, type Footprint } from './agent-footprint.js'
import { inferWorkRole } from './spawn-provenance.js'

/**
 * CC-1671 S2: what a profile's agents have cost, from the footprints on their `agent_exited`
 * rows: the median and p90 of each measure over the last exits of a profile and role.
 *
 * A role with too few exits falls back to the profile's exits across its roles, then to a
 * cold-start default, and `source` says which answered. A failed start is left out: it ran
 * nothing, and would pull a profile's estimate towards zero.
 */

/** Exits kept per key: enough for a stable p90, few enough to follow a change in the work. */
export const COST_WINDOW = 50
/** Below this a p90 is one run's accident. */
export const MIN_MEASURED_EXITS = 3

const GIB_KB = 1024 ** 2

export interface ExitFootprint {
  profile: string
  role: string
  footprint: Footprint
}

const metric = (median: number, p90: number): CostMetric => ({ median, p90 })

type Measures = Pick<AgentCostEstimate, 'rssKb' | 'cpuCores' | 'children' | 'tmpFiles'>

const LIGHT: Measures = {
  rssKb: metric(GIB_KB, 2 * GIB_KB),
  cpuCores: metric(0.2, 0.5),
  children: metric(5, 15),
  tmpFiles: metric(100, 2_000),
}
const LITE_IMPLEMENTER: Measures = {
  rssKb: metric(1.5 * GIB_KB, 3 * GIB_KB),
  cpuCores: metric(0.5, 1.5),
  children: metric(10, 30),
  tmpFiles: metric(500, 5_000),
}
const IMPLEMENTER: Measures = {
  rssKb: metric(2 * GIB_KB, 4 * GIB_KB),
  cpuCores: metric(1, 3),
  children: metric(15, 50),
  tmpFiles: metric(1_000, 10_000),
}

/** Deliberately rough, and replaced once the profile has run a few times. */
export function coldStartCost(profile: string): Measures {
  if (profile.includes('implementer-lite')) return LITE_IMPLEMENTER
  if (profile.includes('implementer')) return IMPLEMENTER
  return LIGHT
}

/** Nearest rank over a sorted list; `values` is never empty. */
function percentile(values: readonly number[], share: number): number {
  const rank = Math.ceil(values.length * share) - 1
  return values[Math.max(rank, 0)] ?? 0
}

function metricOf(values: readonly number[]): CostMetric {
  const sorted = values.toSorted((a, b) => a - b)
  return metric(percentile(sorted, 0.5), percentile(sorted, 0.9))
}

const cores = (footprint: Footprint): number =>
  footprint.cpuSeconds / ((footprint.samples * FOOTPRINT_INTERVAL_MS) / 1000)

function measuresOf(exits: readonly ExitFootprint[]): Measures {
  const footprints = exits.map(exit => exit.footprint)
  const tmpFiles = footprints.flatMap(f => f.tmpFilesPeak ?? [])
  return {
    rssKb: metricOf(footprints.map(f => f.rssPeakKb)),
    cpuCores: metricOf(footprints.map(cores)),
    children: metricOf(footprints.map(f => f.childrenPeak)),
    tmpFiles: tmpFiles.length === 0 ? metric(0, 0) : metricOf(tmpFiles),
  }
}

/** Oldest first, as the log hands them. Rows with no footprint and failed starts are skipped. */
export function exitFootprints(rows: readonly AgentEventRow[]): ExitFootprint[] {
  const spawns = new Map<string, AgentEventRow>()
  const exits: ExitFootprint[] = []
  for (const row of rows) {
    if (row.kind === 'agent_spawned' && row.msgId !== null) spawns.set(row.msgId, row)
    if (row.kind !== 'agent_exited' || row.ref === null || row.meta.failed === 'true') continue
    const spawn = spawns.get(row.ref)
    const footprint = parseFootprintMeta(row.meta)
    if (spawn === undefined || footprint === undefined) continue
    const profile = spawn.meta.profile ?? ''
    const role = spawn.meta.work_role ?? inferWorkRole(profile, spawn.target ?? spawn.meta.name ?? '')
    exits.push({ profile, role, footprint })
  }
  return exits
}

const keyOf = (profile: string, role: string): string => `${profile}\0${role}`

export class CostTable {
  private readonly byKey = new Map<string, ExitFootprint[]>()
  private readonly byProfile = new Map<string, ExitFootprint[]>()

  constructor(exits: readonly ExitFootprint[], window = COST_WINDOW) {
    for (const exit of exits) {
      remember(this.byKey, keyOf(exit.profile, exit.role), exit, window)
      remember(this.byProfile, exit.profile, exit, window)
    }
  }

  /** Never undefined: a profile with no history reads its cold-start default. */
  estimate(profile: string, role: string): AgentCostEstimate {
    const exact = this.byKey.get(keyOf(profile, role)) ?? []
    if (exact.length >= MIN_MEASURED_EXITS)
      return { profile, role, exits: exact.length, source: 'measured', ...measuresOf(exact) }
    const broad = this.byProfile.get(profile) ?? []
    if (broad.length >= MIN_MEASURED_EXITS)
      return { profile, role, exits: broad.length, source: 'profile', ...measuresOf(broad) }
    return { profile, role, exits: exact.length, source: 'default', ...coldStartCost(profile) }
  }

  /** Every profile and role seen, most expensive p90 RSS first. */
  rows(): AgentCostEstimate[] {
    return [...this.byKey.values()]
      .flatMap(([first]) => (first === undefined ? [] : [this.estimate(first.profile, first.role)]))
      .toSorted((a, b) => b.rssKb.p90 - a.rssKb.p90)
  }
}

function remember<K>(map: Map<K, ExitFootprint[]>, key: K, exit: ExitFootprint, window: number): void {
  const kept = map.get(key) ?? []
  kept.push(exit)
  if (kept.length > window) kept.shift()
  map.set(key, kept)
}
