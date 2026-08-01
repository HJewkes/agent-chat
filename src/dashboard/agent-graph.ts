/**
 * The chat feed's spawn tree, laid out as a graph.
 *
 * Same input as the feed — the raw event log — read for a different fact. The
 * feed asks "who said what"; this asks "who spawned whom", which the log answers
 * exactly: an `agent_spawned` row puts the spawner in `actor` (`from` after the
 * history projection) and the spawned name in `meta.target`. That is real
 * parentage, not the `agents[0] is the coordinator` guess AgentsView refused to
 * draw.
 *
 * Everything here is pure: no clock, no DOM, no React. The view feeds it items
 * and a timestamp and renders what comes back, which is what makes the layout
 * and the spark routing unit-testable without a browser.
 */
import type { EventKind, QueueItem } from '../protocol.js'
import type { ChatEntry } from './chat-feed.js'

export const HUMAN = 'human'

/**
 * A `target` is only a peer's name when the send resolved to one.
 *
 * A `route_failed` row records what the SENDER TYPED, which is exactly the
 * string that did not name anybody: `*`, `?`, or a whole comma-separated
 * addressee list. Taking those literally puts nodes called `*` on the graph, as
 * the first live run did.
 */
const isPeerName = (name: string): boolean => name !== '' && !/[\s,*?]/.test(name)

// ---------------------------------------------------------------------------
// Activity taxonomy
// ---------------------------------------------------------------------------

/**
 * The activity categories the graph glows by. These extend the dashboard's
 * existing tool taxonomy (TOOL_COLORS: read/write/bash/search/error) rather than
 * inventing a second colour language — see `ACTIVITY_COLORS` in tokens.ts.
 *
 * `thinking` is the residual: a node whose newest row is lifecycle rather than
 * talk is alive and working without having said anything, which is exactly the
 * state the other three do not cover.
 */
export const ACTIVITY_CATEGORIES = ['message', 'question', 'notice', 'thinking'] as const

export type ActivityCategory = (typeof ACTIVITY_CATEGORIES)[number]

const CATEGORY_BY_KIND: Partial<Record<EventKind, ActivityCategory>> = {
  message: 'message',
  broadcast: 'message',
  question: 'question',
  approval_request: 'question',
  notice: 'notice',
  answer: 'notice',
  resolution: 'notice',
}

export function activityCategory(kind: EventKind | string): ActivityCategory {
  return CATEGORY_BY_KIND[kind as EventKind] ?? 'thinking'
}

export interface NodeActivity {
  category: ActivityCategory
  at: number
}

/**
 * Newest activity per name, sender and recipients alike — a node that was just
 * asked something is as active as the one that asked.
 */
export function nodeActivity(items: QueueItem[]): Map<string, NodeActivity> {
  const latest = new Map<string, NodeActivity>()
  const touch = (name: string, activity: NodeActivity) => {
    if (!isPeerName(name)) return
    const current = latest.get(name)
    if (!current || activity.at >= current.at) latest.set(name, activity)
  }

  for (const item of items) {
    if (item.kind === 'route_failed') continue
    const activity: NodeActivity = { category: activityCategory(item.kind), at: item.at }
    touch(item.from, activity)
    touch(item.meta['target'] ?? '', activity)
  }
  return latest
}

// ---------------------------------------------------------------------------
// Spawn tree
// ---------------------------------------------------------------------------

/** Every name the log knows, each pointing at its spawner (null for a root). */
export function buildSpawnTree(items: QueueItem[]): Map<string, string | null> {
  const parents = new Map<string, string | null>()
  const see = (name: string) => {
    if (isPeerName(name) && !parents.has(name)) parents.set(name, null)
  }

  for (const item of items) {
    if (item.kind === 'route_failed') continue
    see(item.from)
    see(item.meta['target'] ?? '')
    for (const name of (item.meta['audience'] ?? '').split(',')) see(name.trim())

    if (item.kind !== 'agent_spawned') continue
    const child = item.meta['target'] ?? item.meta['name'] ?? ''
    if (!isPeerName(child) || child === item.from || !isPeerName(item.from)) continue
    // Last spawn wins: a name freed by a retirement can be spawned again by
    // someone else, and the newer parentage is the true one.
    parents.set(child, item.from)
  }

  for (const [name, parent] of parents) {
    if (parent !== null && wouldCycle(parents, name)) parents.set(name, null)
  }
  return parents
}

/** A malformed log must not hang the walk; a name that reaches itself is a root. */
function wouldCycle(parents: Map<string, string | null>, start: string): boolean {
  const seen = new Set<string>([start])
  let cursor = parents.get(start) ?? null
  while (cursor !== null) {
    if (seen.has(cursor)) return true
    seen.add(cursor)
    cursor = parents.get(cursor) ?? null
  }
  return false
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/**
 * Depth is a column, exactly as CC-64 places iTerm panes (docs/agent-teams.md
 * §5.4): the coordinator sits leftmost, its spawns one column right, theirs one
 * further. Siblings stack vertically inside their column.
 */
export const COLUMN_WIDTH = 186
export const ROW_HEIGHT = 30
export const PADDING_X = 26
export const PADDING_Y = 22

/** Room to the right of the last column for its labels, which sit beside nodes. */
export const LABEL_ALLOWANCE = 150

export interface Point {
  x: number
  y: number
}

export interface GraphNode extends Point {
  name: string
  depth: number
  row: number
  parent: string | null
}

export interface GraphEdge {
  from: string
  to: string
}

export interface GraphLayout {
  nodes: GraphNode[]
  edges: GraphEdge[]
  byName: Map<string, GraphNode>
  width: number
  height: number
}

export function layoutSpawnTree(items: QueueItem[]): GraphLayout {
  const parents = buildSpawnTree(items)
  const children = childIndex(parents)
  const depths = depthIndex(parents)

  const rows = new Map<string, number>()
  let nextRow = 0
  const place = (name: string): number => {
    const kids = children.get(name) ?? []
    if (kids.length === 0) {
      rows.set(name, nextRow)
      return nextRow++
    }
    // A parent centres on its subtree, which is what keeps a fan-out readable.
    const kidRows = kids.map(place)
    const row = (Math.min(...kidRows) + Math.max(...kidRows)) / 2
    rows.set(name, row)
    return row
  }

  for (const root of roots(parents, children)) place(root)

  const nodes: GraphNode[] = [...parents.keys()].sort().map(name => {
    const depth = depths.get(name) ?? 0
    const row = rows.get(name) ?? 0
    return {
      name,
      depth,
      row,
      parent: parents.get(name) ?? null,
      x: PADDING_X + depth * COLUMN_WIDTH,
      y: PADDING_Y + row * ROW_HEIGHT,
    }
  })

  const byName = new Map(nodes.map(node => [node.name, node]))
  const edges: GraphEdge[] = nodes
    .filter(node => node.parent !== null && byName.has(node.parent))
    .map(node => ({ from: node.parent as string, to: node.name }))

  return {
    nodes,
    edges,
    byName,
    width: PADDING_X + maxOf(nodes, n => n.depth) * COLUMN_WIDTH + LABEL_ALLOWANCE,
    height: PADDING_Y * 2 + maxOf(nodes, n => n.row) * ROW_HEIGHT,
  }
}

function maxOf<T>(items: T[], of: (item: T) => number): number {
  return items.reduce((best, item) => Math.max(best, of(item)), 0)
}

/**
 * Biggest tree first, so the panel opens on the actual orchestration rather than
 * on a column of singletons.
 *
 * Those singletons are real — a peer whose spawn row has aged out of the history
 * window genuinely has no visible parent — but they are the least informative
 * thing on the graph and they were the first thing the first live run showed.
 * The human queue sorts last for the same reason: it is an endpoint, not a
 * coordinator.
 */
function roots(parents: Map<string, string | null>, children: Map<string, string[]>): string[] {
  const names = [...parents.keys()].filter(name => parents.get(name) === null)
  const size = (name: string): number =>
    1 + (children.get(name) ?? []).reduce((total, kid) => total + size(kid), 0)
  return names.sort((a, b) => rootRank(a) - rootRank(b) || size(b) - size(a) || a.localeCompare(b))
}

const rootRank = (name: string): number => (name === HUMAN ? 1 : 0)

function childIndex(parents: Map<string, string | null>): Map<string, string[]> {
  const children = new Map<string, string[]>()
  for (const name of [...parents.keys()].sort()) {
    const parent = parents.get(name) ?? null
    if (parent === null || !parents.has(parent)) continue
    children.set(parent, [...(children.get(parent) ?? []), name])
  }
  return children
}

function depthIndex(parents: Map<string, string | null>): Map<string, number> {
  const depths = new Map<string, number>()
  const depthOf = (name: string): number => {
    const cached = depths.get(name)
    if (cached !== undefined) return cached
    const parent = parents.get(name) ?? null
    const depth = parent === null || !parents.has(parent) ? 0 : depthOf(parent) + 1
    depths.set(name, depth)
    return depth
  }
  for (const name of parents.keys()) depthOf(name)
  return depths
}

// ---------------------------------------------------------------------------
// Spark routing
// ---------------------------------------------------------------------------

/**
 * The names a message travels through, sender to recipient, along tree edges.
 *
 * Peers three hops apart talk directly, but drawing that as a fresh line would
 * assert an edge the spawn tree does not have. So the spark walks up to the
 * lowest common ancestor and back down — the path a reader can already see.
 *
 * Two names in different trees (the human queue, or a log truncated before the
 * spawn row) have no such path, and the pair is returned as-is: one straight
 * segment is honest about being a jump, where an invented route would not be.
 */
export function treePath(layout: GraphLayout, from: string, to: string): string[] {
  if (from === to) return []
  if (!layout.byName.has(from) || !layout.byName.has(to)) return []

  const fromLine = ancestry(layout, from)
  const toLine = ancestry(layout, to)
  const meetIndex = toLine.findIndex(name => fromLine.includes(name))
  if (meetIndex === -1) return [from, to]

  const meet = toLine[meetIndex] as string
  const up = fromLine.slice(0, fromLine.indexOf(meet) + 1)
  const down = toLine.slice(0, meetIndex).reverse()
  return [...up, ...down]
}

/** The node, then each ancestor, closest first. */
function ancestry(layout: GraphLayout, name: string): string[] {
  const line: string[] = []
  let cursor: string | null = name
  while (cursor !== null && layout.byName.has(cursor) && !line.includes(cursor)) {
    line.push(cursor)
    cursor = layout.byName.get(cursor)?.parent ?? null
  }
  return line
}

export interface SparkRoute {
  from: string
  to: string
  category: ActivityCategory
  points: Point[]
}

/** One route per recipient of a send. Recipients off the graph are dropped. */
export function sparkRoutes(layout: GraphLayout, entry: ChatEntry): SparkRoute[] {
  const category = activityCategory(entry.kind)
  return entry.recipients
    .map(to => ({ to, path: treePath(layout, entry.from, to) }))
    .filter(({ path }) => path.length > 1)
    .map(({ to, path }) => ({
      from: entry.from,
      to,
      category,
      points: path.map(name => pointOf(layout, name)),
    }))
}

function pointOf(layout: GraphLayout, name: string): Point {
  const node = layout.byName.get(name)
  return { x: node?.x ?? 0, y: node?.y ?? 0 }
}

/**
 * Position at fraction `t` of a polyline, measured by length so a spark keeps a
 * constant speed across segments of different lengths.
 */
export function pointAlongPolyline(points: Point[], t: number): Point {
  if (points.length === 0) return { x: 0, y: 0 }
  if (points.length === 1) return points[0] as Point
  const clamped = Math.min(1, Math.max(0, t))

  const lengths = points.slice(1).map((point, i) => distance(points[i] as Point, point))
  const total = lengths.reduce((sum, length) => sum + length, 0)
  if (total === 0) return points[0] as Point

  let travelled = clamped * total
  for (let i = 0; i < lengths.length; i++) {
    const length = lengths[i] as number
    if (travelled <= length || i === lengths.length - 1) {
      const ratio = length === 0 ? 0 : Math.min(1, travelled / length)
      return lerp(points[i] as Point, points[i + 1] as Point, ratio)
    }
    travelled -= length
  }
  return points[points.length - 1] as Point
}

function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y)
}

function lerp(a: Point, b: Point, t: number): Point {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
}

// ---------------------------------------------------------------------------
// Spark lifetime
// ---------------------------------------------------------------------------

/** How long a spark takes to travel its route, whatever the route's length. */
export const SPARK_DURATION_MS = 1_100

/** How long after an event a node keeps its glow. */
export const GLOW_DURATION_MS = 6_000

export interface Spark extends SparkRoute {
  id: string
  startedAt: number
}

/** Sparks for entries newer than `since`, so a refetch cannot replay the feed. */
export function sparksSince(layout: GraphLayout, entries: ChatEntry[], since: number, now: number): Spark[] {
  return entries
    .filter(entry => entry.at > since)
    .flatMap(entry =>
      sparkRoutes(layout, entry).map((route, i) => ({
        ...route,
        id: `${entry.msgId}:${route.to}:${i}`,
        startedAt: now,
      })),
    )
}

export function liveSparks(sparks: Spark[], now: number): Spark[] {
  return sparks.filter(spark => now - spark.startedAt < SPARK_DURATION_MS)
}

/** 1 at the instant of the event, 0 once the glow has decayed. */
export function glowStrength(activity: NodeActivity | undefined, now: number): number {
  if (!activity) return 0
  const age = now - activity.at
  if (age < 0) return 1
  return Math.max(0, 1 - age / GLOW_DURATION_MS)
}
