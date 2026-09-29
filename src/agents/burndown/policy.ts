import fs from 'node:fs'
import path from 'node:path'
import { parse } from 'yaml'
import { z } from 'zod'
import { activeWorkRoot } from '../active-work.js'
import type { PoolRule, SpendCaps } from './budget-gate.js'
import type { Initiative } from './eligibility.js'
import type { ScoringDefaults } from './score.js'

/** The CC-201 scorer's policy: charter and seat frontmatter, as score.py `load_policy` and `seat_initiatives` read them. CLI-only; the broker never imports this. */

/** score.py `frontmatter()`: the YAML between the first and second `---`; `{}` when the text does not open with one. */
export function frontmatter(text: string): Record<string, unknown> {
  const parts = text.split('---')
  if (!text.startsWith('---') || parts.length < 3) return {}
  const data: unknown = parse(parts[1] ?? '')
  return data !== null && typeof data === 'object' && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : {}
}

const Weights = z.record(z.string(), z.number())
const orEmpty = <T extends z.ZodType>(schema: T, empty: z.output<T>) =>
  schema.nullish().transform(v => v ?? empty)

const Defaults = z.looseObject({
  kind_weights: Weights,
  share_caps: Weights,
  initiative_decay: z.number(),
  score_terms: z.object({
    severity: z.number(),
    priority_pct: z.number(),
    unblocks: z.number(),
    staleness: z.number(),
  }),
  severity: z.object({ unset: z.number() }).catchall(z.number()),
  readiness: z.object({ ready: z.number(), untriaged: z.number(), blocked: z.number() }),
  size: z.object({ le3: z.number(), le8: z.number(), gt8: z.number() }),
  stop_short_factor: z.number(),
})

// An unset human_uses reads as true, which keeps the stricter five_hour ceiling.
const Pool = z.looseObject({
  config_dir: z.string(),
  human_uses: orEmpty(z.boolean(), true),
  reserve_seven_day: z.number().optional(),
  ceiling_five_hour: z.number().optional(),
  night_reserve_seven_day: z.number().optional(),
  per_day_points: z.number().optional(),
})

const Charter = z.looseObject({
  seats: z.array(z.string()),
  human_only_initiatives: orEmpty(z.array(z.string()), []),
  hard_stops: orEmpty(z.array(z.string()), []),
  defaults: Defaults,
  pools: orEmpty(z.record(z.string(), Pool), {}),
})

const Seat = z.looseObject({
  initiatives: orEmpty(Weights, {}),
  unclaimed_engineering: orEmpty(z.boolean(), false),
  unclaimed_weight: orEmpty(z.number(), 0.5),
  excluded_tags: orEmpty(z.array(z.string()), []),
  excluded_title_patterns: orEmpty(z.array(z.string()), []),
  kind_weights: orEmpty(Weights, {}),
  share_caps: orEmpty(Weights, {}),
  pool: z.string().optional(),
  spend: orEmpty(
    z.looseObject({ per_run_points: z.number().optional(), per_day_points: z.number().optional() }),
    {},
  ),
})

export type CharterPolicy = z.infer<typeof Charter>
export type SeatPolicy = z.infer<typeof Seat>

export interface Policy {
  charter: CharterPolicy
  seats: Record<string, SeatPolicy>
  seat: SeatPolicy
  /** The charter's defaults with the seat's `kind_weights` and `share_caps` merged over them key by key. */
  defaults: ScoringDefaults
}

function validate<T extends z.ZodType>(schema: T, data: unknown, what: string): z.output<T> {
  const parsed = schema.safeParse(data)
  if (!parsed.success) throw new Error(`${what} is malformed: ${parsed.error.message}`)
  return parsed.data
}

export const parseCharter = (text: string): CharterPolicy =>
  validate(Charter, frontmatter(text), 'autonomy charter')

export const parseSeat = (text: string, name: string): SeatPolicy =>
  validate(Seat, frontmatter(text), `seat file ${name}`)

/** score.py merges only these two keys; every other default is charter-only. */
export function mergeDefaults(charter: CharterPolicy, seat: SeatPolicy): ScoringDefaults {
  return {
    ...charter.defaults,
    kind_weights: { ...charter.defaults.kind_weights, ...seat.kind_weights },
    share_caps: { ...charter.defaults.share_caps, ...seat.share_caps },
  }
}

export const defaultAutonomyRoot = (): string =>
  path.join(activeWorkRoot(), 'claude-channels', 'sources', 'autonomy')

/** Reads `charter.md` and every seat it lists under `seats/`; throws on a seat the charter does not list. */
export function loadPolicy(root: string, seatName: string): Policy {
  const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8')
  const charter = parseCharter(read('charter.md'))
  if (!charter.seats.includes(seatName)) throw new Error(`${seatName} is not a seat in ${root}/charter.md`)
  const seats = Object.fromEntries(
    charter.seats.map(s => [s, parseSeat(read(path.join('seats', `${s}.md`)), s)]),
  )
  const seat = seats[seatName] as SeatPolicy
  return { charter, seats, seat, defaults: mergeDefaults(charter, seat) }
}

/** The seat's pool from the charter and its own spend caps, as `gatePool` reads them; an unknown pool is undefined, which closes the gate. */
export function seatBudget(
  charter: CharterPolicy,
  seat: SeatPolicy,
): { pool: PoolRule | undefined; spend: SpendCaps } {
  const found = seat.pool === undefined ? undefined : charter.pools[seat.pool]
  const spend = { per_run_points: seat.spend.per_run_points, per_day_points: seat.spend.per_day_points }
  return { pool: found === undefined ? undefined : { ...found, name: seat.pool ?? '' }, spend }
}

/** score.py `seat_initiatives`: slug to scope weight, adding focused unclaimed initiatives when the seat takes them. */
export function seatScope(
  charter: CharterPolicy,
  seats: Record<string, SeatPolicy>,
  seatName: string,
  briefs: readonly Pick<Initiative, 'slug' | 'state'>[],
): Record<string, number> {
  const seat = seats[seatName]
  if (seat === undefined) throw new Error(`${seatName} is not a seat`)
  const weights = { ...seat.initiatives }
  if (seat.unclaimed_engineering) {
    const claimed = new Set(Object.values(seats).flatMap(s => Object.keys(s.initiatives)))
    const humanOnly = new Set(charter.human_only_initiatives)
    for (const { slug, state } of briefs) {
      if (state === 'focused' && !claimed.has(slug) && !humanOnly.has(slug))
        weights[slug] = seat.unclaimed_weight
    }
  }
  if (Object.keys(weights).length === 0) throw new Error(`${seatName} has no dispatch scope (hub seat)`)
  return weights
}
