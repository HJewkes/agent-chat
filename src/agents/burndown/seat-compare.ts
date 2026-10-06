import path from 'node:path'
import type { Refusal } from './eligibility.js'
import { run, type Runner } from './exec.js'
import { heldClaims } from './ledger.js'
import { LAST_SORTED_TIER, type Placement, type PlacedTier, type SeatPlan } from './seat-plan.js'
import { localDate, planLoaded } from './seat-tick.js'
import { seatPlanSetup, type SeatPlanOptions } from './tick.js'

/**
 * CC-205 D7: `burndown seats compare`. Walks score.py's order for a seat and gives each ID the
 * dry-run seat plan's verdict: dispatched, refused, held, or beyond caps. Fails on an ID the plan
 * skipped with no reason, on a dispatch that overtakes a higher-ranked dispatch with no recorded
 * reason, and on a dispatch score.py does not list. Pure but for `runScorePy`.
 *
 * score.py runs with the plan's prior picks as `--prior`, so the decayed scores match exactly.
 * A reorder is explained only by the plan's own record (`SeatPlan.placement`), never a recomputation:
 * `planOrder` placed the jumper in a higher class-of-service tier (expedite, fixed date, or an
 * owned milestone) than the ID it overtook; both sit in one of tiers 0 to 2, which the plan sorts
 * by age, slack and float; or both sit in tier 3 or 4 and the decays each side applied at that
 * pick flip the pair: the plan's from every `planOrder` pick before the jumper (tier 0 to 2 rows,
 * dispatched or not, but no share-cap skip), score.py's from every row it ranks above the overtaken
 * ID. Tiers 3 and 4 follow score.py's order, so any other reorder there fails.
 */

/** One row of score.py's `--json` order. */
export interface ScorePyRow {
  id: string
  initiative: string
  score: number
  effective: number
  kind: string
}

export interface ScorePyOutput {
  order: ScorePyRow[]
  /** IDs `--check-landed` dropped, with the commit it found, from score.py's `LANDED` stderr lines. */
  landed: Map<string, string>
}

export interface CompareInput {
  score: ScorePyOutput
  /** The plan's own record: its dispatches, refusals, share-cap counts and `planOrder` placement. */
  plan: Pick<SeatPlan, 'dispatch' | 'refusals' | 'shareCapped' | 'priorPicks' | 'placement'>
  /** Task IDs the claim ledger holds. */
  held: ReadonlySet<string>
}

export interface Comparison {
  ok: boolean
  lines: string[]
}

/** Refusals that mean the seat ran out of room, not that the task was wrong for it. */
const CAP_KINDS = new Set<string>(['role-cap', 'worktrees', 'slots', 'budget', 'lanes-full'])

const LANDED_LINE = /^LANDED (\S+): (.*)$/

export function parseScorePy(stdout: string, stderr = ''): ScorePyOutput {
  const doc = JSON.parse(stdout) as { order?: unknown }
  if (!Array.isArray(doc.order)) throw new Error('score.py --json printed no order array')
  const landed = new Map<string, string>()
  for (const line of stderr.split('\n')) {
    const hit = LANDED_LINE.exec(line)
    if (hit) landed.set(hit[1]!, hit[2]!)
  }
  return { order: doc.order as ScorePyRow[], landed }
}

/** score.py's `--top` for the compare: every scored row, as the tick walks them all. */
export const SCORE_PY_TOP = 1000

export function scorePyArgs(seat: string, today: string, prior: Readonly<Record<string, number>>): string[] {
  const priors = Object.entries(prior).flatMap(([slug, n]) => ['--prior', `${slug}=${n}`])
  const flags = ['--seat', seat, '--check-landed', '--json', '--top', String(SCORE_PY_TOP)]
  return [...flags, '--today', today, ...priors]
}

export function runScorePy(autonomyRoot: string, args: string[], runner: Runner = run): ScorePyOutput {
  const result = runner('python3', [path.join(autonomyRoot, 'score.py'), ...args])
  if (result.status !== 0) {
    const first = (result.stderr ?? '').trim().split('\n').at(-1) ?? ''
    if (result.status === null)
      throw new Error(
        'score.py did not run: python3 is missing from PATH, it timed out, or a signal killed it',
      )
    throw new Error(`score.py exited ${result.status}: ${first}`)
  }
  return parseScorePy(result.stdout, result.stderr)
}

type Verdict =
  | { kind: 'dispatched'; pick: number }
  | { kind: 'held' }
  | { kind: 'intangible-held' }
  | { kind: 'refused' | 'beyond-caps'; refusal: { kind: string; reason: string } }
  | { kind: 'unexplained' }

function verdictOf(
  id: string,
  input: CompareInput,
  picks: Map<string, number>,
  refusals: Map<string, Refusal>,
): Verdict {
  const pick = picks.get(id)
  if (pick !== undefined) return { kind: 'dispatched', pick }
  if (input.held.has(id)) return { kind: 'held' }
  if (input.plan.placement?.intangibleHeld.includes(id)) return { kind: 'intangible-held' }
  const refusal = refusals.get(id)
  if (refusal === undefined) return { kind: 'unexplained' }
  return { kind: CAP_KINDS.has(refusal.kind) ? 'beyond-caps' : 'refused', refusal }
}

/** The plan's share-cap skips leave no per-ID refusal; each kind's count explains that many of its lowest-ranked silent IDs. */
function shareCapped(
  order: readonly ScorePyRow[],
  verdicts: Verdict[],
  capped: SeatPlan['shareCapped'],
): void {
  const left = new Map(Object.entries(capped).map(([key, n]) => [key.slice('share-cap:'.length), n]))
  for (let i = order.length - 1; i >= 0; i--) {
    const row = order[i]!
    const n = left.get(row.kind) ?? 0
    if (verdicts[i]!.kind !== 'unexplained' || n === 0) continue
    left.set(row.kind, n - 1)
    const reason = `the plan's dispatch order skipped ${capped[`share-cap:${row.kind}`]} ${row.kind} rows over the share cap`
    verdicts[i] = { kind: 'beyond-caps', refusal: { kind: `share-cap:${row.kind}`, reason } }
  }
}

const TIER_NAMES = ['expedite', 'fixed date', 'milestone', 'standard', 'intangible']

export function describeTier(t: PlacedTier): string {
  if (t.tier === 1 && t.slack !== undefined) return `tier 1 (fixed date, slack ${t.slack})`
  if (t.tier === 2 && t.milestone !== undefined)
    return `tier 2 (milestone ${t.milestone}, float ${t.float ?? '?'})`
  return `tier ${t.tier} (${TIER_NAMES[t.tier]})`
}

interface Ranked {
  rank: Map<string, number>
  rows: readonly ScorePyRow[]
  prior: Readonly<Record<string, number>>
  placement: Placement
}

const NO_PLACEMENT: Placement = { tiers: {}, picks: [], decay: 1, intangibleHeld: [] }

/** Why `jumper` may go ahead of `overtaken` by tier, or undefined when the tiers explain nothing. */
function tierReason(jumper: ScorePyRow, overtaken: ScorePyRow, ranked: Ranked): string | undefined {
  const [a, b] = [ranked.placement.tiers[jumper.id], ranked.placement.tiers[overtaken.id]]
  if (a === undefined || b === undefined) return undefined
  if (a.tier < b.tier) return `${describeTier(a)} over ${describeTier(b)}`
  if (a.tier === b.tier && a.tier <= LAST_SORTED_TIER)
    return `same tier ${a.tier} (${TIER_NAMES[a.tier]}): the plan orders a tier by age, slack and float`
  return undefined
}

/** Each initiative's decay count: its prior picks plus its picks in `ahead`. */
function decayCounts(prior: Readonly<Record<string, number>>, ahead: readonly { initiative: string }[]) {
  const counts = new Map(Object.entries(prior))
  for (const { initiative } of ahead) counts.set(initiative, (counts.get(initiative) ?? 0) + 1)
  return counts
}

/**
 * The exact decay difference, for a pair the plan places in tiers 3 and 4. The plan picked the jumper
 * with every `planOrder` pick before it applied, held, refused and tier 0 to 2 rows included, and
 * share-cap skips not; score.py picked the overtaken ID with every row it ranks above that ID applied.
 * Explained only when score.py's counts favour the overtaken ID and the plan's favour the jumper.
 */
function decayReason(jumper: ScorePyRow, overtaken: ScorePyRow, ranked: Ranked): string | undefined {
  const { picks, decay } = ranked.placement
  const at = picks.findIndex(p => p.id === jumper.id)
  if (at < 0) return undefined
  const plan = decayCounts(ranked.prior, picks.slice(0, at))
  const score = decayCounts(ranked.prior, ranked.rows.slice(0, ranked.rank.get(overtaken.id)))
  const n = (counts: Map<string, number>, row: ScorePyRow) => counts.get(row.initiative) ?? 0
  const favoursJumper = (counts: Map<string, number>) =>
    jumper.score * decay ** n(counts, jumper) > overtaken.score * decay ** n(counts, overtaken)
  if (favoursJumper(score) || !favoursJumper(plan)) return undefined
  const side = (row: ScorePyRow) =>
    `${row.initiative} ${n(plan, row)} in the plan, ${n(score, row)} in score.py`
  return `decays at this pick: ${side(overtaken)}; ${side(jumper)}`
}

const inDispatchOrder = (id: string, ranked: Ranked) => {
  const placed = ranked.placement.tiers[id]
  return placed !== undefined && placed.tier > LAST_SORTED_TIER
}

/** Why `jumper` may go ahead of `overtaken`, or undefined when nothing on record says so. */
function reorderReason(jumper: ScorePyRow, overtaken: ScorePyRow, ranked: Ranked): string | undefined {
  const tier = tierReason(jumper, overtaken, ranked)
  if (tier !== undefined) return tier
  const bothDecayed = inDispatchOrder(jumper.id, ranked) && inDispatchOrder(overtaken.id, ranked)
  return bothDecayed ? decayReason(jumper, overtaken, ranked) : undefined
}

/** For each dispatched ID, the best-ranked ID dispatched after it that score.py ranks above it. */
function overtakes(dispatched: readonly string[], rank: ReadonlyMap<string, number>): Map<string, string> {
  const out = new Map<string, string>()
  dispatched.forEach((id, i) => {
    const later = dispatched.slice(i + 1).filter(other => rank.get(other)! < rank.get(id)!)
    const best = later.sort((x, y) => rank.get(x)! - rank.get(y)!)[0]
    if (best !== undefined) out.set(id, best)
  })
  return out
}

const scoreText = (r: ScorePyRow) => `score ${r.score} effective ${r.effective}`

function verdictText(
  row: ScorePyRow,
  v: Verdict,
  ranked: Ranked,
  jumps: Map<string, string>,
): { text: string; ok: boolean } {
  if (v.kind === 'held') return { text: 'held: the claim ledger holds it', ok: true }
  if (v.kind === 'intangible-held')
    return {
      text: 'held [intangible]: planOrder holds intangible tasks while a higher tier has a ready row',
      ok: true,
    }
  if (v.kind === 'unexplained') return { text: 'UNEXPLAINED SKIP: neither dispatched nor refused', ok: false }
  if (v.kind !== 'dispatched') {
    const label = v.kind === 'refused' ? 'refused' : 'beyond caps'
    return { text: `${label} [${v.refusal.kind}]: ${v.refusal.reason}`, ok: true }
  }
  const overtaken = jumps.get(row.id)
  const pick = `dispatched as pick ${v.pick}`
  if (overtaken === undefined) return { text: pick, ok: true }
  const over = ranked.rows[ranked.rank.get(overtaken)!]!
  const reason = reorderReason(row, over, ranked)
  return reason === undefined
    ? {
        text: `OUT OF ORDER: ${pick}, ahead of #${ranked.rank.get(overtaken)! + 1} ${overtaken} with no recorded reason`,
        ok: false,
      }
    : { text: `${pick}, ahead of #${ranked.rank.get(overtaken)! + 1} ${overtaken}: ${reason}`, ok: true }
}

/** Plan dispatches score.py does not list: a landed task, or a row the two scorers disagree on. */
function extras(input: CompareInput, rank: ReadonlyMap<string, number>): string[] {
  return input.plan.dispatch
    .filter(d => d.slice === undefined && !rank.has(d.task))
    .map(d => {
      const landed = input.score.landed.get(d.task)
      return `EXTRA DISPATCH ${d.task}: not in score.py's order${landed === undefined ? '' : `; score.py found it landed (${landed})`}`
    })
}

export function compareSeat(input: CompareInput): Comparison {
  const rows = input.score.order
  const rank = new Map(rows.map((r, i) => [r.id, i]))
  const whole = input.plan.dispatch.filter(d => d.slice === undefined).map(d => d.task)
  const picks = new Map(whole.map((id, i) => [id, i + 1]))
  const refusals = new Map<string, Refusal>()
  for (const r of input.plan.refusals)
    if (r.task !== undefined && !refusals.has(r.task)) refusals.set(r.task, r)
  const verdicts = rows.map(r => verdictOf(r.id, input, picks, refusals))
  shareCapped(rows, verdicts, input.plan.shareCapped)
  const ranked: Ranked = {
    rank,
    rows,
    prior: input.plan.priorPicks,
    placement: input.plan.placement ?? NO_PLACEMENT,
  }
  const jumps = overtakes(
    whole.filter(id => rank.has(id)),
    rank,
  )
  const lines: string[] = []
  let ok = true
  rows.forEach((row, i) => {
    const v = verdictText(row, verdicts[i]!, ranked, jumps)
    ok &&= v.ok
    lines.push(`${String(i + 1).padStart(3)}. ${row.id} ${row.initiative} ${scoreText(row)}: ${v.text}`)
  })
  const extra = extras(input, rank)
  const slices = input.plan.dispatch.length - whole.length
  if (slices > 0) lines.push(`ready slices dispatched outside score.py's order: ${slices}`)
  return {
    ok: ok && extra.length === 0,
    lines: [...lines, ...extra, summary(verdicts, ok && extra.length === 0)],
  }
}

/**
 * The dry-run seat plan, as `burndown plan --seat` makes it, then score.py with the plan's prior
 * picks and the same day; the reorder reasons read the plan's own `planOrder` placement. CLI-only.
 */
export function seatCompareFromDisk(opts: SeatPlanOptions & { runner?: Runner }): Comparison {
  const { ledger, seats, deps } = seatPlanSetup(opts)
  const [loaded] = seats.loaded
  if (loaded === undefined) throw new Error(seats.skipped[0]?.reason ?? `seat ${opts.seat} did not load`)
  const { planned } = planLoaded(loaded, deps, opts.root, { dispatch: [], claims: [], charged: [] })
  const today = localDate(opts.now)
  const args = scorePyArgs(opts.seat, today, planned.priorPicks)
  const score = runScorePy(opts.autonomyRoot, args, opts.runner)
  const compared = compareSeat({ score, plan: planned, held: new Set(heldClaims(ledger).map(c => c.taskId)) })
  const head = `seats compare ${opts.seat} at ${opts.now.toISOString()}: score.py ${args.join(' ')} against a dry-run seat plan`
  return { ...compared, lines: [head, ...compared.lines] }
}

function summary(verdicts: readonly Verdict[], ok: boolean): string {
  const count = (kind: Verdict['kind']) => verdicts.filter(v => v.kind === kind).length
  const parts = [
    `${count('dispatched')} dispatched`,
    `${count('refused')} refused`,
    `${count('held') + count('intangible-held')} held`,
    `${count('beyond-caps')} beyond caps`,
    `${count('unexplained')} unexplained`,
  ]
  return `${ok ? 'PASS' : 'FAIL'}: ${verdicts.length} score.py IDs; ${parts.join(', ')}`
}
