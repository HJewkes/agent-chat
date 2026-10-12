import { describe, expect, it } from 'vitest'
import {
  projectMix,
  sharedDefaults,
  shareOrder,
  type ProjectShares,
  type ShareRow,
} from '../agents/burndown/project-shares.js'
import type { ScoringDefaults } from '../agents/burndown/score.js'

interface Row extends ShareRow {
  id: string
}

const TP = 'titan-platform'
const CC = 'claude-channels'

const rowsOf = (initiative: string, n: number, tier?: number): Row[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `${initiative}-${i}`,
    initiative,
    ...(tier !== undefined && { tier }),
  }))

const interleave = (a: Row[], b: Row[]): Row[] => a.flatMap((row, i) => [row, ...(b[i] ? [b[i]] : [])])

const shares = (initiatives: Record<string, number>, patch: Partial<ProjectShares> = {}): ProjectShares => ({
  initiatives,
  ...patch,
})

const slugs = (rows: readonly Row[]) => rows.map(row => row.initiative)

describe('shareOrder (CC-1107)', () => {
  it('splits 10 picks 6/4 under 0.6/0.4 shares', () => {
    const rows = interleave(rowsOf(TP, 20), rowsOf(CC, 20))

    const order = shareOrder(rows, shares({ [TP]: 0.6, [CC]: 0.4 }))

    expect(projectMix(order, 10)).toEqual({ [TP]: 6, [CC]: 4 })
  })

  it('gives a 0.2 project its first pick only once it is owed one', () => {
    const rows = interleave(rowsOf(TP, 10), rowsOf(CC, 10))

    const order = shareOrder(rows, shares({ [TP]: 0.8, [CC]: 0.2 }))

    expect(slugs(order).slice(0, 5)).toEqual([TP, TP, CC, TP, TP])
  })

  it('hands a project share on once its supply runs out', () => {
    const rows = [...rowsOf(TP, 9), ...rowsOf(CC, 1)]

    const order = shareOrder(rows, shares({ [TP]: 0.2, [CC]: 0.8 }))

    expect(slugs(order)).toEqual([CC, ...Array<string>(9).fill(TP)])
  })

  it('gives the first picks to the project behind on prior picks', () => {
    const rows = interleave(rowsOf(TP, 10), rowsOf(CC, 10))

    const order = shareOrder(rows, shares({ [TP]: 0.5, [CC]: 0.5 }), { [TP]: 4 })

    expect(slugs(order).slice(0, 4)).toEqual([CC, CC, CC, CC])
  })

  it('keeps a tier 0 row of the low-share project first', () => {
    const expedite = { id: 'X', initiative: CC, tier: 0 }
    const rows = [...rowsOf(TP, 5, 3), expedite, ...rowsOf(CC, 5, 3)]

    const order = shareOrder(rows, shares({ [TP]: 0.9, [CC]: 0.1 }))

    expect(order[0]).toBe(expedite)
  })

  it('lets a tier 2 row bypass shares only with milestone_tier_boost', () => {
    const milestone = { id: 'M', initiative: CC, tier: 2 }
    const rows = [...rowsOf(TP, 5, 3), milestone]
    const tilted = { [TP]: 0.9, [CC]: 0.1 }

    expect(shareOrder(rows, shares(tilted))[0]).not.toBe(milestone)
    expect(shareOrder(rows, shares(tilted, { milestone_tier_boost: true }))[0]).toBe(milestone)
  })

  it('keeps each project in its base order', () => {
    const tp = rowsOf(TP, 6).reverse()
    const cc = rowsOf(CC, 6)

    const order = shareOrder(interleave(tp, cc), shares({ [TP]: 0.7, [CC]: 0.3 }))

    expect(order.filter(row => row.initiative === TP)).toEqual(tp)
    expect(order.filter(row => row.initiative === CC)).toEqual(cc)
  })

  it('puts a project with no share after every shared row, in base order', () => {
    const other = rowsOf('other', 2)
    const rows = [other[0]!, ...rowsOf(TP, 3), other[1]!]

    const order = shareOrder(rows, shares({ [TP]: 1 }))

    expect(order.slice(3)).toEqual(other)
  })
})

describe('sharedDefaults (CC-1107)', () => {
  it('sets decay 1, empty kind weights and share caps from priorities.kinds', () => {
    const defaults = {
      kind_weights: { 'agent-tooling': 1 },
      share_caps: { docs: 0.1 },
      initiative_decay: 0.85,
    } as unknown as ScoringDefaults

    const shared = sharedDefaults(defaults, shares({ [TP]: 1 }, { kinds: { nit: { share: 0.2 } } }))

    expect(shared).toEqual({ kind_weights: {}, share_caps: { nit: 0.2 }, initiative_decay: 1 })
  })
})
