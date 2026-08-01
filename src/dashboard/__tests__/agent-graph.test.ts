import { describe, expect, it } from 'vitest'
import type { QueueItem } from '../../protocol.js'
import type { ChatEntry } from '../chat-feed.js'
import {
  GLOW_DURATION_MS,
  SPARK_DURATION_MS,
  activityCategory,
  buildSpawnTree,
  glowStrength,
  layoutSpawnTree,
  liveSparks,
  nodeActivity,
  pointAlongPolyline,
  sparkRoutes,
  sparksSince,
  treePath,
} from '../agent-graph.js'

function row(overrides: Partial<QueueItem> & Pick<QueueItem, 'msgId'>): QueueItem {
  return { kind: 'message', from: 'cc50', text: 'hi', at: 1_000, meta: {}, ...overrides }
}

function spawn(parent: string, child: string, at = 1_000): QueueItem {
  return row({ msgId: `spawn-${child}`, kind: 'agent_spawned', from: parent, at, meta: { target: child } })
}

function entry(overrides: Partial<ChatEntry> & Pick<ChatEntry, 'msgId'>): ChatEntry {
  return {
    kind: 'message',
    from: 'cc50',
    text: 'hi',
    at: 2_000,
    recipients: ['cc51'],
    scope: 'direct',
    ...overrides,
  }
}

/** coordinator -> {a, b}; a -> a1. */
const TREE: QueueItem[] = [spawn('root', 'a'), spawn('root', 'b'), spawn('a', 'a1')]

describe('buildSpawnTree', () => {
  it('reads parentage off agent_spawned rows', () => {
    const parents = buildSpawnTree(TREE)
    expect(parents.get('root')).toBeNull()
    expect(parents.get('a')).toBe('root')
    expect(parents.get('a1')).toBe('a')
  })

  it('includes names that only ever talked, as roots', () => {
    const parents = buildSpawnTree([row({ msgId: 'm1', from: 'cc50', meta: { target: 'human' } })])
    expect([...parents.keys()].sort()).toEqual(['cc50', 'human'])
    expect(parents.get('cc50')).toBeNull()
  })

  it('ignores route_failed targets, which are what the sender typed', () => {
    const parents = buildSpawnTree([
      row({ msgId: 'm1', kind: 'route_failed', from: 'cc50', meta: { target: '*' } }),
      row({ msgId: 'm2', kind: 'route_failed', from: 'cc50', meta: { target: 'a, b' } }),
      row({ msgId: 'm3', kind: 'route_failed', from: 'cc50', meta: { target: '?' } }),
    ])
    expect([...parents.keys()]).toEqual([])
  })

  it('never lets an addressee list become a node', () => {
    const parents = buildSpawnTree([row({ msgId: 'm1', from: 'cc50', meta: { target: 'a,b' } })])
    expect([...parents.keys()]).toEqual(['cc50'])
  })

  it('breaks a cycle rather than looping on a corrupt log', () => {
    const parents = buildSpawnTree([spawn('x', 'y'), spawn('y', 'x')])
    expect(parents.get('x')).toBeNull()
  })
})

describe('layoutSpawnTree', () => {
  it('puts depth in a column, left to right', () => {
    const layout = layoutSpawnTree(TREE)
    expect(layout.byName.get('root')?.depth).toBe(0)
    expect(layout.byName.get('a')?.depth).toBe(1)
    expect(layout.byName.get('a1')?.depth).toBe(2)
    const [rootX, aX, a1X] = ['root', 'a', 'a1'].map(n => layout.byName.get(n)!.x)
    expect(rootX).toBeLessThan(aX!)
    expect(aX).toBeLessThan(a1X!)
  })

  it('stacks siblings vertically and centres the parent on them', () => {
    const layout = layoutSpawnTree([spawn('root', 'a'), spawn('root', 'b')])
    const a = layout.byName.get('a')!
    const b = layout.byName.get('b')!
    const root = layout.byName.get('root')!
    expect(a.y).not.toBe(b.y)
    expect(root.y).toBe((a.y + b.y) / 2)
  })

  it('puts the biggest tree first and a lone peer last', () => {
    const layout = layoutSpawnTree([...TREE, row({ msgId: 'm1', from: 'loner', meta: {} })])
    expect(layout.byName.get('loner')!.row).toBeGreaterThan(layout.byName.get('root')!.row)
  })

  it('sorts the human queue below the coordinators', () => {
    const layout = layoutSpawnTree([...TREE, row({ msgId: 'm1', from: 'human', meta: {} })])
    expect(layout.byName.get('human')!.row).toBeGreaterThan(layout.byName.get('b')!.row)
  })

  it('emits one edge per spawn', () => {
    const layout = layoutSpawnTree(TREE)
    expect(layout.edges).toEqual([
      { from: 'root', to: 'a' },
      { from: 'a', to: 'a1' },
      { from: 'root', to: 'b' },
    ])
  })

  it('sizes the canvas around the widest and tallest extent', () => {
    const layout = layoutSpawnTree(TREE)
    const maxX = Math.max(...layout.nodes.map(n => n.x))
    const maxY = Math.max(...layout.nodes.map(n => n.y))
    expect(layout.width).toBeGreaterThan(maxX)
    expect(layout.height).toBeGreaterThan(maxY)
  })
})

describe('treePath', () => {
  it('routes cousins through their common ancestor instead of drawing a new edge', () => {
    const layout = layoutSpawnTree(TREE)
    expect(treePath(layout, 'a1', 'b')).toEqual(['a1', 'a', 'root', 'b'])
  })

  it('walks a direct parent/child edge as two points', () => {
    const layout = layoutSpawnTree(TREE)
    expect(treePath(layout, 'root', 'a')).toEqual(['root', 'a'])
  })

  it('falls back to a straight jump between disconnected trees', () => {
    const layout = layoutSpawnTree([...TREE, row({ msgId: 'm1', from: 'root', meta: { target: 'human' } })])
    expect(treePath(layout, 'a1', 'human')).toEqual(['a1', 'human'])
  })

  it('has no path to itself or to an unknown name', () => {
    const layout = layoutSpawnTree(TREE)
    expect(treePath(layout, 'a', 'a')).toEqual([])
    expect(treePath(layout, 'a', 'nobody')).toEqual([])
  })
})

describe('sparkRoutes', () => {
  it('emits one route per recipient of a multicast', () => {
    const layout = layoutSpawnTree(TREE)
    const routes = sparkRoutes(layout, entry({ msgId: 'm1', from: 'root', recipients: ['a', 'b'] }))
    expect(routes.map(r => r.to)).toEqual(['a', 'b'])
    expect(routes[0]?.points).toHaveLength(2)
  })

  it('routes through the intermediate nodes, not point to point', () => {
    const layout = layoutSpawnTree(TREE)
    const [route] = sparkRoutes(layout, entry({ msgId: 'm1', from: 'a1', recipients: ['b'] }))
    expect(route?.points).toHaveLength(4)
    expect(route?.points[1]).toEqual({ x: layout.byName.get('a')!.x, y: layout.byName.get('a')!.y })
  })

  it('drops a recipient that is not on the graph', () => {
    const layout = layoutSpawnTree(TREE)
    expect(sparkRoutes(layout, entry({ msgId: 'm1', from: 'a', recipients: ['ghost'] }))).toEqual([])
  })

  it('carries the send kind through as its activity category', () => {
    const layout = layoutSpawnTree(TREE)
    const [route] = sparkRoutes(
      layout,
      entry({ msgId: 'm1', kind: 'question', from: 'root', recipients: ['a'] }),
    )
    expect(route?.category).toBe('question')
  })
})

describe('pointAlongPolyline', () => {
  const line = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 30 },
  ]

  it('travels at constant speed across segments of different lengths', () => {
    expect(pointAlongPolyline(line, 0)).toEqual({ x: 0, y: 0 })
    expect(pointAlongPolyline(line, 0.25)).toEqual({ x: 10, y: 0 })
    expect(pointAlongPolyline(line, 0.5)).toEqual({ x: 10, y: 10 })
    expect(pointAlongPolyline(line, 1)).toEqual({ x: 10, y: 30 })
  })

  it('clamps outside 0..1 rather than overshooting', () => {
    expect(pointAlongPolyline(line, -1)).toEqual({ x: 0, y: 0 })
    expect(pointAlongPolyline(line, 5)).toEqual({ x: 10, y: 30 })
  })

  it('survives a degenerate route', () => {
    expect(pointAlongPolyline([], 0.5)).toEqual({ x: 0, y: 0 })
    expect(pointAlongPolyline([{ x: 3, y: 4 }], 0.5)).toEqual({ x: 3, y: 4 })
    expect(
      pointAlongPolyline(
        [
          { x: 3, y: 4 },
          { x: 3, y: 4 },
        ],
        0.5,
      ),
    ).toEqual({ x: 3, y: 4 })
  })
})

describe('activity', () => {
  it('maps every chat kind into the four-category taxonomy', () => {
    expect(activityCategory('broadcast')).toBe('message')
    expect(activityCategory('approval_request')).toBe('question')
    expect(activityCategory('answer')).toBe('notice')
    expect(activityCategory('agent_spawned')).toBe('thinking')
  })

  it('marks both ends of a send as active', () => {
    const activity = nodeActivity([row({ msgId: 'm1', kind: 'question', at: 5, meta: { target: 'a' } })])
    expect(activity.get('cc50')).toEqual({ category: 'question', at: 5 })
    expect(activity.get('a')?.category).toBe('question')
  })

  it('does not glow a name that never resolved', () => {
    const activity = nodeActivity([
      row({ msgId: 'm1', kind: 'route_failed', from: 'cc50', at: 5, meta: { target: '*' } }),
    ])
    expect([...activity.keys()]).toEqual([])
  })

  it('keeps the newest row, whatever order the log arrives in', () => {
    const activity = nodeActivity([
      row({ msgId: 'm1', kind: 'message', at: 9 }),
      row({ msgId: 'm2', kind: 'agent_spawned', at: 4 }),
    ])
    expect(activity.get('cc50')).toEqual({ category: 'message', at: 9 })
  })

  it('decays a glow to nothing over its lifetime', () => {
    const activity = { category: 'message' as const, at: 1_000 }
    expect(glowStrength(activity, 1_000)).toBe(1)
    expect(glowStrength(activity, 1_000 + GLOW_DURATION_MS / 2)).toBeCloseTo(0.5)
    expect(glowStrength(activity, 1_000 + GLOW_DURATION_MS * 2)).toBe(0)
    expect(glowStrength(undefined, 1_000)).toBe(0)
  })
})

describe('spark lifetime', () => {
  const layout = layoutSpawnTree(TREE)
  const entries = [
    entry({ msgId: 'old', from: 'root', recipients: ['a'], at: 100 }),
    entry({ msgId: 'new', from: 'root', recipients: ['b'], at: 500 }),
  ]

  it('only fires for traffic newer than the last watermark', () => {
    const sparks = sparksSince(layout, entries, 200, 10_000)
    expect(sparks.map(s => s.to)).toEqual(['b'])
    expect(sparks[0]?.startedAt).toBe(10_000)
  })

  it('gives every spark of one multicast a distinct id', () => {
    const multicast = [entry({ msgId: 'm1', from: 'root', recipients: ['a', 'b'], at: 900 })]
    const ids = sparksSince(layout, multicast, 0, 0).map(s => s.id)
    expect(new Set(ids).size).toBe(2)
  })

  it('retires a spark once it has finished travelling', () => {
    const sparks = sparksSince(layout, entries, 200, 10_000)
    expect(liveSparks(sparks, 10_000 + SPARK_DURATION_MS - 1)).toHaveLength(1)
    expect(liveSparks(sparks, 10_000 + SPARK_DURATION_MS)).toHaveLength(0)
  })
})
