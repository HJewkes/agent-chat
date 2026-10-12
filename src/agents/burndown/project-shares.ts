import { PREEMPT_TIER } from './ready-order.js'
import type { ScoringDefaults } from './score.js'

/**
 * CC-1107 (Levers S11): one knob per project. `limits.priorities` decides which project the seat's
 * next whole-task pick comes from: the one furthest below its share of the run's picks, among the
 * projects that still have a row, so a project out of supply hands its share on. Each project keeps
 * its rows in the base order. Pure, no clock.
 */

export interface ProjectShares {
  /** Share of the seat's whole-task picks per initiative slug; renormalised over projects with supply. */
  initiatives: Readonly<Record<string, number>>
  /** Tier 2 (owned milestone) rows also bypass shares; tiers 0-1 always do. */
  milestone_tier_boost?: boolean
  /** Per-kind share of a pass's picks; replaces the seat's `share_caps`. */
  kinds?: Readonly<Record<string, { share: number }>>
}

export interface ShareRow {
  initiative: string
  /** `planOrder`'s class-of-service tier; absent when the order had no planning inputs. */
  tier?: number
}

/** The milestone tier, which bypasses shares only with `milestone_tier_boost`. */
const MILESTONE_TIER = 2

/**
 * The base order re-interleaved by project share. Preempting rows keep their place at the front;
 * rows of an initiative with no positive share follow every shared row, in base order.
 */
export function shareOrder<T extends ShareRow>(
  rows: readonly T[],
  shares: ProjectShares,
  priorPicks: Readonly<Record<string, number>> = {},
): T[] {
  const bypass = shares.milestone_tier_boost === true ? MILESTONE_TIER : PREEMPT_TIER
  const preempting = (row: T) => row.tier !== undefined && row.tier <= bypass
  const preempts = rows.filter(preempting)
  const rest = rows.filter(row => !preempting(row))
  const shareOf = (slug: string) => Math.max(0, shares.initiatives[slug] ?? 0)
  const unshared = rest.filter(row => shareOf(row.initiative) === 0)
  const fifos = fifosOf(rest.filter(row => shareOf(row.initiative) > 0))
  const picks = new Map(Object.entries(priorPicks))
  for (const row of preempts) bump(picks, row.initiative)
  const interleaved: T[] = []
  for (
    let slug = nextSlug(fifos, shareOf, picks);
    slug !== undefined;
    slug = nextSlug(fifos, shareOf, picks)
  ) {
    interleaved.push(fifos.get(slug)!.shift()!)
    bump(picks, slug)
  }
  return [...preempts, ...interleaved, ...unshared]
}

function fifosOf<T extends ShareRow>(rows: readonly T[]): Map<string, T[]> {
  const fifos = new Map<string, T[]>()
  for (const row of rows) fifos.set(row.initiative, [...(fifos.get(row.initiative) ?? []), row])
  return fifos
}

function bump(picks: Map<string, number>, slug: string): void {
  picks.set(slug, (picks.get(slug) ?? 0) + 1)
}

/**
 * The initiative with supply whose deficit `share × (total + 1) − picks` is largest, shares
 * renormalised over the initiatives with supply; ties by larger share, then slug by code point.
 */
function nextSlug(
  fifos: ReadonlyMap<string, readonly unknown[]>,
  shareOf: (slug: string) => number,
  picks: ReadonlyMap<string, number>,
): string | undefined {
  const supplied = [...fifos].filter(([, fifo]) => fifo.length > 0).map(([slug]) => slug)
  const sum = supplied.reduce((acc, slug) => acc + shareOf(slug), 0)
  const total = [...picks.values()].reduce((acc, n) => acc + n, 0)
  const deficit = (slug: string) => (shareOf(slug) / sum) * (total + 1) - (picks.get(slug) ?? 0)
  const ahead = (a: string, b: string) =>
    deficit(a) - deficit(b) || shareOf(a) - shareOf(b) || (a < b ? 1 : a > b ? -1 : 0)
  return supplied.reduce<string | undefined>(
    (best, slug) => (best === undefined || ahead(slug, best) > 0 ? slug : best),
    undefined,
  )
}

/** The scoring defaults under shares: no initiative decay, every kind at the default K, kind caps from `kinds`. */
export function sharedDefaults(defaults: ScoringDefaults, shares: ProjectShares): ScoringDefaults {
  const kinds = Object.entries(shares.kinds ?? {}).map(([kind, { share }]) => [kind, share] as const)
  return {
    ...defaults,
    initiative_decay: 1,
    kind_weights: {},
    share_caps: Object.fromEntries(kinds),
  }
}

/** How many of the first `n` rows each initiative takes. */
export function projectMix(order: readonly ShareRow[], n: number): Record<string, number> {
  const mix: Record<string, number> = {}
  for (const row of order.slice(0, n)) mix[row.initiative] = (mix[row.initiative] ?? 0) + 1
  return mix
}
