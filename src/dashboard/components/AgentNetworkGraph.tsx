/**
 * The live agent network, sitting above the chat feed (CC-66).
 *
 * All of the arithmetic — parentage, columns, spark routes, decay — lives in
 * `agent-graph.ts` and is unit-tested there. What is left here is the parts that
 * genuinely need a browser: an SVG scene and a requestAnimationFrame clock that
 * runs only while something is actually moving.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { View, Text, ScrollView, StyleSheet } from 'react-native'
import type { QueueItem } from '../../protocol.js'
import type { ChatEntry } from '../chat-feed.js'
import {
  ACTIVITY_CATEGORIES,
  GLOW_DURATION_MS,
  SPARK_DURATION_MS,
  glowStrength,
  layoutSpawnTree,
  liveSparks,
  nodeActivity,
  pointAlongPolyline,
  sparksSince,
} from '../agent-graph.js'
import type { ActivityCategory, GraphLayout, NodeActivity, Spark } from '../agent-graph.js'
import { C, palette } from './shared/colors.js'
import { type as T, radii, sp } from '../tokens.js'
import { avatarColor } from '../utils/avatar.js'
import { activityColor } from '../utils/semantic-colors.js'

/**
 * Past this the scene SCROLLS rather than scaling.
 *
 * Scaling was the first attempt and it does not survive contact with a real log:
 * a 26-peer roster squeezed into 340px turns every label into a smear. A tree
 * that outgrows the panel is a normal Tuesday here, so the nodes keep their size
 * and the panel gains a scrollbar.
 */
const MAX_HEIGHT = 380

const NODE_RADIUS = 5.5
const GLOW_RADIUS = 13
const SPARK_RADIUS = 4

/** Long agent names are ellipsised rather than allowed to run into the next column. */
const MAX_LABEL_CHARS = 22

interface Props {
  /** Raw log rows — the spawn tree and the glows are both read out of these. */
  items: QueueItem[]
  /** The feed's grouped entries; a new one fires a spark. */
  entries: ChatEntry[]
}

export function AgentNetworkGraph({ items, entries }: Props) {
  const layout = useMemo(() => layoutSpawnTree(items), [items])
  const activity = useMemo(() => nodeActivity(items), [items])
  const { sparks, now } = useNetworkAnimation(layout, entries, activity)

  if (layout.nodes.length === 0) return null

  return (
    <View style={s.panel}>
      <View style={s.head}>
        <Text style={s.title}>Network</Text>
        <Text style={s.subtitle}>
          {layout.nodes.length} peers · {layout.edges.length} spawn edges
        </Text>
        <Legend />
      </View>
      <ScrollView style={s.scene}>
        <svg
          width={layout.width}
          height={layout.height}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          // The scroll container is a flex column, which would otherwise shrink
          // the scene to fit and undo the whole point of scrolling it.
          style={{ display: 'block', flexShrink: 0, minWidth: layout.width, minHeight: layout.height }}
        >
          {layout.edges.map(edge => {
            const from = layout.byName.get(edge.from)
            const to = layout.byName.get(edge.to)
            if (!from || !to) return null
            return (
              <line
                key={`${edge.from}->${edge.to}`}
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
                stroke={palette.overlay.white12}
                strokeWidth={1}
              />
            )
          })}

          {layout.nodes.map(node => (
            <NodeMark
              key={node.name}
              name={node.name}
              x={node.x}
              y={node.y}
              activity={activity.get(node.name)}
              now={now}
            />
          ))}

          {sparks.map(spark => (
            <SparkMark key={spark.id} spark={spark} now={now} />
          ))}
        </svg>
      </ScrollView>
    </View>
  )
}

interface NodeMarkProps {
  name: string
  x: number
  y: number
  activity: NodeActivity | undefined
  now: number
}

function NodeMark({ name, x, y, activity, now }: NodeMarkProps) {
  const strength = glowStrength(activity, now)
  const glow = activity ? activityColor(activity.category) : C.textTertiary

  return (
    <g>
      {strength > 0 && (
        <circle cx={x} cy={y} r={GLOW_RADIUS + strength * 6} fill={glow} opacity={0.06 + strength * 0.3} />
      )}
      <circle
        cx={x}
        cy={y}
        r={NODE_RADIUS}
        fill={avatarColor(name)}
        stroke={strength > 0 ? glow : palette.overlay.white12}
        strokeWidth={strength > 0 ? 1.5 : 1}
      />
      <text
        x={x + NODE_RADIUS + 6}
        y={y + 3.5}
        fill={strength > 0.15 ? C.textPrimary : C.textSecondary}
        fontSize={10}
        fontFamily="monospace"
      >
        {truncate(name)}
      </text>
    </g>
  )
}

const truncate = (name: string): string =>
  name.length <= MAX_LABEL_CHARS ? name : `${name.slice(0, MAX_LABEL_CHARS - 1)}…`

function SparkMark({ spark, now }: { spark: Spark; now: number }) {
  const progress = (now - spark.startedAt) / SPARK_DURATION_MS
  if (progress < 0 || progress > 1) return null

  const at = pointAlongPolyline(spark.points, progress)
  const color = activityColor(spark.category)
  // Bright the whole way, dimming only over the last stretch, so the eye can
  // follow where a message landed rather than only where it left.
  const fade = progress < 0.75 ? 1 : 1 - (progress - 0.75) / 0.25

  return (
    <g>
      <circle cx={at.x} cy={at.y} r={SPARK_RADIUS * 2.4} fill={color} opacity={0.18 * fade} />
      <circle cx={at.x} cy={at.y} r={SPARK_RADIUS} fill={color} opacity={fade} />
    </g>
  )
}

function Legend() {
  return (
    <View style={s.legend}>
      {ACTIVITY_CATEGORIES.map(category => (
        <View key={category} style={s.legendItem}>
          <View style={[s.legendDot, { backgroundColor: activityColor(category as ActivityCategory) }]} />
          <Text style={s.legendLabel}>{category}</Text>
        </View>
      ))}
    </View>
  )
}

/**
 * Sparks for traffic that arrived since the last render, plus the clock that
 * moves them.
 *
 * The first render deliberately fires nothing: `history` is up to 200 rows of
 * past conversation, and replaying it as sparks would open every page load with
 * a firework rather than showing what is happening now.
 */
function useNetworkAnimation(
  layout: GraphLayout,
  entries: ChatEntry[],
  activity: Map<string, NodeActivity>,
): { sparks: Spark[]; now: number } {
  const [sparks, setSparks] = useState<Spark[]>([])
  const seenThrough = useRef<number | null>(null)

  useEffect(() => {
    const newest = entries.reduce((max, entry) => Math.max(max, entry.at), 0)
    const since = seenThrough.current
    seenThrough.current = newest
    if (since === null || newest <= since) return
    const at = Date.now()
    setSparks(current => [...liveSparks(current, at), ...sparksSince(layout, entries, since, at)])
  }, [entries, layout])

  const now = Date.now()
  useAnimationClock(sparks.length > 0 || anyGlowing(activity, now))
  const visible = liveSparks(sparks, now)

  useEffect(() => {
    if (visible.length === 0 && sparks.length > 0) setSparks([])
  }, [visible.length, sparks.length])

  return { sparks: visible, now }
}

function anyGlowing(activity: Map<string, NodeActivity>, now: number): boolean {
  for (const entry of activity.values()) {
    if (now - entry.at < GLOW_DURATION_MS) return true
  }
  return false
}

/** Roughly 30fps, which is smooth enough for a dot on a line. */
const FRAME_MS = 33

/**
 * Re-render while there is something to animate. It returns nothing on purpose:
 * the time every frame is drawn against is read fresh in the render body, so
 * there is exactly ONE clock.
 *
 * An earlier version held `now` in state and only updated it inside the loop,
 * which gave the component two clocks that disagreed the moment the loop
 * stopped: glows stayed painted at full strength forever and sparks rendered at
 * negative progress. `setInterval` rather than `requestAnimationFrame` for a
 * related reason — rAF stops dead in a background tab, and a dashboard behind
 * another tab should catch up when you look at it rather than resume from a
 * timestamp minutes old.
 */
function useAnimationClock(running: boolean): void {
  const [, force] = useState(0)

  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => force(n => n + 1), FRAME_MS)
    return () => clearInterval(timer)
  }, [running])
}

const s = StyleSheet.create({
  panel: {
    backgroundColor: C.surface1,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: radii.lg,
    paddingHorizontal: sp[6],
    paddingVertical: sp[6],
    gap: sp[5],
  },
  head: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: sp[5] },
  scene: { maxHeight: MAX_HEIGHT },
  title: { ...T.headingSm, color: C.textPrimary },
  subtitle: { fontSize: 11, color: C.textTertiary },
  legend: { flexDirection: 'row', alignItems: 'center', gap: sp[5], marginLeft: 'auto' },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: sp[2] },
  legendDot: { width: 7, height: 7, borderRadius: 4 },
  legendLabel: { fontSize: 10, color: C.textTertiary },
})
