import { RESERVED_TAGS } from './eligibility.js'

/**
 * The autonomy scorer (CC-201), ported from `sources/autonomy/score.py`.
 *
 * Pure: no I/O and no clock, `today` is a parameter. Each term is its own
 * function so the tests can pin it against score.py's formula. Regexes run
 * with JS semantics, so `\b`, `\w` and `\d` are ASCII where Python's are
 * Unicode; that only differs when an ID or keyword abuts a non-ASCII letter.
 */

/** An open task as score.py sees it: the task-file keys, plus the initiative slug. */
export interface ScoredTask {
  id: string
  title: string
  priority: number
  severity?: string | null
  estimate?: number | null
  done_when?: string | null
  notes?: string | null
  tags?: string[] | null
  created?: string | null
  updated?: string | null
  slug: string
}

/** The charter's `defaults`, with the seat's `kind_weights` and `share_caps` merged over them. */
export interface ScoringDefaults {
  kind_weights: Record<string, number>
  share_caps: Record<string, number>
  initiative_decay: number
  score_terms: { severity: number; priority_pct: number; unblocks: number; staleness: number }
  severity: Record<string, number> & { unset: number }
  readiness: { ready: number; untriaged: number; blocked: number }
  size: { le3: number; le8: number; gt8: number }
  stop_short_factor: number
}

export interface Exclusions {
  /** The seat's `excluded_tags`; the reserved tags are always added. */
  tags: readonly string[]
  /** The seat's `excluded_title_patterns`, joined with `|` and matched case-insensitively. */
  titlePatterns?: readonly string[]
}

export type KindSource = 'tag' | 'regex' | 'default'
export type Route = 'triage' | 'planner' | 'implementer-lite' | 'implementer'
export type RefusalCounts = Partial<Record<'excluded-tag' | 'excluded-pattern', number>>

/** S, P, U, A: the additive terms. W, K, R, Z, H: the multipliers. */
export interface Components {
  S: number
  P: number
  U: number
  A: number
  W: number
  K: number
  R: number
  Z: number
  H: number
}

export interface ScoreRow {
  id: string
  initiative: string
  score: number
  kind: string
  kindSource: KindSource
  severity: string | null
  estimate: number | null
  unblocks: number
  ageDays: number
  blocked: string[]
  stopShort: string[]
  route: Route
  title: string
  components: Components
}

export const ID = /\b([A-Z]{1,5}-\d+)\b/g
export const DEP =
  /(depend|prereq|blocked (by|on)|waits? (on|for)|requires? [A-Z]{1,5}-\d|after [A-Z]{1,5}-\d)/i

export const HARD_STOP_PATTERNS: Record<string, RegExp> = {
  'broker-restart': /\brestart(s|ed|ing)? (the )?broker\b|\bbroker restart\b|restart window/i,
  deploy: /\bdeploy(s|ed|ing)?\b|\bwrangler\b/i,
  'launchd-install': /launchd install|burndown install/i,
  'force-push': /force-push|reset --hard/i,
  'config-edit': /CLAUDE\.md|settings\.json|~\/\.agent-chat\//i,
  'spend-money': /\b(purchase|pay for|spend money|submit (the )?order)\b/i,
  'npm-publish': /\bnpm publish|first publish|publish(es|ed)? to npm|version packages/i,
  'ruleset-write': /ruleset|branch protection/i,
  'tag-move': /\bmove (the )?v1\b|cut a (release )?tag|tag push/i,
}

export const KIND_FALLBACK: [kind: string, pattern: RegExp][] = [
  ['security', /security|inject|secret|leak|oauth|vulnerab|audit advis|confidential/],
  ['nit', /\bnits?\b|hygiene|flak|typo|test pins?|surviv\w* mutant|cleanup|clean up/],
  ['docs', /\bdocs?\b|readme|runbook/],
  ['product', /user|feature|\bui\b|screen|\bapp\b|phone|voice|telegram|dashboard|chapter|coach|workout/],
  ['platform', /contract|consolidat|\bport\b|package|adapter|route|\bapi\b|fold|schema/],
  ['agent-tooling', /agent|spawn|broker|worktree|profile|briefing|teleport|roster|budget/],
]

const DEFAULT_KIND_WEIGHT = 0.8
const DAY_MS = 86_400_000

/** Python's `round(x, digits)`: half to even on the exact binary value of `x`. */
export function pyRound(x: number, digits: number): number {
  if (!Number.isFinite(x) || Math.abs(x) >= 1e21) return x
  const exact = Math.abs(x).toFixed(100)
  const point = exact.indexOf('.')
  const dropped = exact.slice(point + 1 + digits)
  const isTie = dropped[0] === '5' && /^0*$/.test(dropped.slice(1))
  if (!isTie) return Number(x.toFixed(digits))
  const kept = digits === 0 ? exact.slice(0, point) : exact.slice(0, point + 1 + digits)
  const lastKeptIsEven = Number(kept[kept.length - 1]) % 2 === 0
  const magnitude = lastKeptIsEven ? Number(kept) : Number(Math.abs(x).toFixed(digits))
  return Math.sign(x) * magnitude
}

/** Python's `str(v or '')` for the text fields. */
function text(value: unknown): string {
  return value ? String(value) : ''
}

/** A dict lookup that cannot hit `Object.prototype`, since tags and slugs are free text. */
function own(table: Readonly<Record<string, number>>, key: string): number | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined
}

function tagsOf(task: ScoredTask): string[] {
  return (task.tags ?? []).map(String)
}

export function severityTerm(severity: string | null | undefined, defaults: ScoringDefaults): number {
  return own(defaults.severity, severity || 'unset') ?? defaults.severity.unset
}

/** 1 for the most urgent priority in the initiative; ties share a value. */
export function priorityPercentile(priority: number, peers: readonly number[]): number {
  const ahead = peers.filter(p => p < priority).length
  return 1 - ahead / Math.max(1, peers.length - 1)
}

/** IDs the task says it waits on: every ID in a sentence that reads as a dependency, minus its own. */
export function namedDependencies(task: ScoredTask): Set<string> {
  const body = [task.title, task.done_when, task.notes].map(text).join(' ')
  const ids = new Set<string>()
  for (const sentence of body.split(/(?<=[.;])\s+/)) {
    if (!DEP.test(sentence)) continue
    for (const id of sentence.match(ID) ?? []) ids.add(id)
  }
  ids.delete(task.id)
  return ids
}

export interface DependencyGraph {
  /** How many open tasks name each ID as a dependency. */
  unblocks: Map<string, number>
  /** The open IDs each task waits on, sorted. */
  blocked: Map<string, string[]>
}

export function dependencyGraph(tasks: readonly ScoredTask[]): DependencyGraph {
  const openIds = new Set(tasks.map(t => t.id))
  const unblocks = new Map<string, number>()
  const blocked = new Map<string, string[]>()
  for (const task of tasks) {
    const waitsOn = [...namedDependencies(task)].filter(id => openIds.has(id))
    for (const id of waitsOn) unblocks.set(id, (unblocks.get(id) ?? 0) + 1)
    blocked.set(task.id, waitsOn.sort())
  }
  return { unblocks, blocked }
}

export function unblocksTerm(unblockCount: number): number {
  return Math.min(1, unblockCount / 3)
}

function parseIsoDay(value: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return undefined
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const ms = Date.UTC(year, month - 1, day)
  const roundTrips = new Date(ms).getUTCMonth() === month - 1 && new Date(ms).getUTCDate() === day
  return roundTrips ? ms / DAY_MS : undefined
}

/** Days since `updated` (else `created`), read from the first 10 characters; 0 when unparseable. */
export function ageDays(task: ScoredTask, today: string): number {
  const stamp = parseIsoDay(String(task.updated || task.created).slice(0, 10))
  const now = parseIsoDay(today)
  if (now === undefined) throw new Error(`today must be YYYY-MM-DD, got ${today}`)
  return stamp === undefined ? 0 : now - stamp
}

export function stalenessTerm(days: number): number {
  return Math.min(1, days / 30)
}

export function kindOf(task: ScoredTask): { kind: string; source: KindSource } {
  const tags = tagsOf(task)
  const tagged = tags.find(tag => tag.startsWith('kind:'))
  if (tagged !== undefined) return { kind: tagged.slice(5), source: 'tag' }
  const haystack = `${task.title} ${tags.join(' ')}`.toLowerCase()
  const match = KIND_FALLBACK.find(([, pattern]) => pattern.test(haystack))
  return match ? { kind: match[0], source: 'regex' } : { kind: 'platform', source: 'default' }
}

export function kindWeight(kind: string, defaults: ScoringDefaults): number {
  return own(defaults.kind_weights, kind) ?? DEFAULT_KIND_WEIGHT
}

function isTriaged(task: ScoredTask): boolean {
  return task.estimate != null && Boolean(task.done_when)
}

export function readinessTerm(task: ScoredTask, isBlocked: boolean, defaults: ScoringDefaults): number {
  if (isBlocked) return defaults.readiness.blocked
  return isTriaged(task) ? defaults.readiness.ready : defaults.readiness.untriaged
}

export function sizeTerm(estimate: number | null | undefined, defaults: ScoringDefaults): number {
  if (estimate == null || estimate <= 3) return defaults.size.le3
  return estimate <= 8 ? defaults.size.le8 : defaults.size.gt8
}

/** The charter's hard stops whose pattern matches the task's `done_when`, in pattern order. */
export function stopShortNames(
  doneWhen: string | null | undefined,
  hardStops: ReadonlySet<string>,
): string[] {
  const body = text(doneWhen)
  return Object.entries(HARD_STOP_PATTERNS)
    .filter(([name, pattern]) => hardStops.has(name) && pattern.test(body))
    .map(([name]) => name)
}

export function stopShortTerm(stopShort: readonly string[], defaults: ScoringDefaults): number {
  return stopShort.length > 0 ? defaults.stop_short_factor : 1
}

export function route(task: ScoredTask): Route {
  if (!isTriaged(task)) return 'triage'
  const estimate = task.estimate as number
  if (estimate >= 3) return 'planner'
  return estimate <= 1 ? 'implementer-lite' : 'implementer'
}

/** score.py's product, in its operand order so the float result matches bit for bit. */
export function combine(c: Components, defaults: ScoringDefaults): number {
  const w = defaults.score_terms
  const base = w.severity * c.S + w.priority_pct * c.P + w.unblocks * c.U + w.staleness * c.A
  return pyRound(100 * base * c.W * c.K * c.R * c.Z * c.H, 1)
}

/** Locale-independent string order, by Unicode code point rather than UTF-16 unit. */
function byCodePoint(a: string, b: string): number {
  const [x, y] = [Array.from(a, c => c.codePointAt(0) ?? 0), Array.from(b, c => c.codePointAt(0) ?? 0)]
  const i = x.findIndex((point, k) => point !== y[k])
  return i === -1 ? x.length - y.length : (x[i] ?? 0) - (y[i] ?? -1)
}

/** Digit strings by numeric value, exact at any length. */
function byDigits(a: string, b: string): number {
  const [x, y] = [a.replace(/^0+/, ''), b.replace(/^0+/, '')]
  return x.length - y.length || byCodePoint(x, y)
}

function idParts(id: string): { prefix: string; digits: string } | undefined {
  const dash = id.lastIndexOf('-')
  const digits = id.slice(dash + 1)
  return dash >= 0 && /^\d+$/.test(digits) ? { prefix: id.slice(0, dash), digits } : undefined
}

/** `PREFIX-<digits>` IDs by prefix then number; any other ID after them, by text. */
function compareIds(a: string, b: string): number {
  const [x, y] = [idParts(a), idParts(b)]
  if (x && y) return byCodePoint(x.prefix, y.prefix) || byDigits(x.digits, y.digits) || byCodePoint(a, b)
  if (x || y) return x ? -1 : 1
  return byCodePoint(a, b)
}

/** Ranking order (owner decision, CC-201 plan section 1.3): score, initiative weight, slug, ID number. */
export function compareRows(a: ScoreRow, b: ScoreRow): number {
  return (
    b.score - a.score ||
    b.components.W - a.components.W ||
    byCodePoint(a.initiative, b.initiative) ||
    compareIds(a.id, b.id)
  )
}

export interface DispatchRow extends ScoreRow {
  /** The score after initiative decay, rounded as score.py does. */
  effective: number
}

export type ShareCapRefusals = Record<`share-cap:${string}`, number>

/** Picks allowed per capped kind; `discovery` is a route share the tick enforces, not a kind. */
function kindLimits(shareCaps: Readonly<Record<string, number>>, n: number): Map<string, number> {
  const limits = new Map<string, number>()
  for (const [kind, cap] of Object.entries(shareCaps)) {
    if (kind === 'discovery' || cap >= 1) continue
    limits.set(kind, Math.max(1, Math.floor(cap * n)))
  }
  return limits
}

/**
 * score.py's greedy `dispatch_order`, plus share caps (CC-201 plan section
 * 1.2). Each pick decays its initiative's later candidates by
 * `initiative_decay`; blocked rows never enter the order.
 */
export function dispatchOrder(
  rows: readonly ScoreRow[],
  defaults: ScoringDefaults,
  n: number,
): { order: DispatchRow[]; refused: ShareCapRefusals } {
  const pool = rows.filter(row => row.blocked.length === 0)
  const decay = new Set(pool.map(row => row.initiative)).size > 1 ? defaults.initiative_decay : 1
  const limits = kindLimits(defaults.share_caps, n)
  const picksIn = new Map<string, number>()
  const picksOf = new Map<string, number>()
  const raw = (row: ScoreRow) => row.score * decay ** (picksIn.get(row.initiative) ?? 0)
  const order: DispatchRow[] = []
  const refused: ShareCapRefusals = {}
  while (pool.length > 0 && order.length < n) {
    const best = pool.reduce((a, b) =>
      raw(b) > raw(a) || (raw(b) === raw(a) && compareRows(b, a) < 0) ? b : a,
    )
    pool.splice(pool.indexOf(best), 1)
    const taken = picksOf.get(best.kind) ?? 0
    if (taken >= (limits.get(best.kind) ?? Infinity)) {
      refused[`share-cap:${best.kind}`] = (refused[`share-cap:${best.kind}`] ?? 0) + 1
      continue
    }
    order.push({ ...best, effective: pyRound(raw(best), 1) })
    picksOf.set(best.kind, taken + 1)
    picksIn.set(best.initiative, (picksIn.get(best.initiative) ?? 0) + 1)
  }
  return { order, refused }
}

function exclusionOf(
  task: ScoredTask,
  tags: ReadonlySet<string>,
  title?: RegExp,
): keyof RefusalCounts | undefined {
  if (tagsOf(task).some(tag => tags.has(tag))) return 'excluded-tag'
  if (title?.test(task.title)) return 'excluded-pattern'
  return undefined
}

interface ScoringContext {
  weights: Readonly<Record<string, number>>
  defaults: ScoringDefaults
  hardStops: ReadonlySet<string>
  today: string
  graph: DependencyGraph
  peers: Map<string, number[]>
}

function initiativeWeight(slug: string, weights: Readonly<Record<string, number>>): number {
  const weight = own(weights, slug)
  if (weight === undefined) throw new Error(`no scope weight for initiative ${slug}`)
  return weight
}

function scoreTask(task: ScoredTask, ctx: ScoringContext): ScoreRow {
  const { defaults } = ctx
  const blocked = ctx.graph.blocked.get(task.id) ?? []
  const unblocks = ctx.graph.unblocks.get(task.id) ?? 0
  const age = ageDays(task, ctx.today)
  const stopShort = stopShortNames(task.done_when, ctx.hardStops)
  const { kind, source } = kindOf(task)
  const components: Components = {
    S: severityTerm(task.severity, defaults),
    P: priorityPercentile(task.priority, ctx.peers.get(task.slug) ?? []),
    U: unblocksTerm(unblocks),
    A: stalenessTerm(age),
    W: initiativeWeight(task.slug, ctx.weights),
    K: kindWeight(kind, defaults),
    R: readinessTerm(task, blocked.length > 0, defaults),
    Z: sizeTerm(task.estimate, defaults),
    H: stopShortTerm(stopShort, defaults),
  }
  return {
    id: task.id,
    initiative: task.slug,
    score: combine(components, defaults),
    kind,
    kindSource: source,
    severity: task.severity ?? null,
    estimate: task.estimate ?? null,
    unblocks,
    ageDays: age,
    blocked,
    stopShort,
    route: route(task),
    title: task.title,
    components,
  }
}

function peersBySlug(tasks: readonly ScoredTask[]): Map<string, number[]> {
  const peers = new Map<string, number[]>()
  for (const task of tasks) peers.set(task.slug, [...(peers.get(task.slug) ?? []), task.priority])
  return peers
}

/**
 * Scores every open task in the seat's scope. Dependencies and priority peers
 * are computed over all tasks, excluded ones included, as score.py does.
 */
export function scoreAll(
  tasks: readonly ScoredTask[],
  weights: Readonly<Record<string, number>>,
  defaults: ScoringDefaults,
  exclusions: Exclusions,
  hardStops: readonly string[],
  today: string,
): { rows: ScoreRow[]; refused: RefusalCounts } {
  const ctx: ScoringContext = {
    weights,
    defaults,
    hardStops: new Set(hardStops),
    today,
    graph: dependencyGraph(tasks),
    peers: peersBySlug(tasks),
  }
  const excludedTags = new Set([...exclusions.tags, ...RESERVED_TAGS])
  const patterns = exclusions.titlePatterns?.join('|')
  const titlePattern = patterns ? new RegExp(patterns, 'i') : undefined
  const rows: ScoreRow[] = []
  const refused: RefusalCounts = {}
  for (const task of tasks) {
    const exclusion = exclusionOf(task, excludedTags, titlePattern)
    if (exclusion) refused[exclusion] = (refused[exclusion] ?? 0) + 1
    else rows.push(scoreTask(task, ctx))
  }
  return { rows: rows.sort(compareRows), refused }
}
