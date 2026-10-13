import { describe, expect, it } from 'vitest'
import type { Task } from '../agents/burndown/eligibility.js'
import { EMPTY_LEDGER, type Claim, type Ledger } from '../agents/burndown/ledger.js'
import { seedSlices } from '../agents/burndown/seed-slices.js'
import { mergedParentFlags, mergedFlagKey, slicesMerged } from '../agents/burndown/slices-complete.js'

/** CC-1049: a parent whose every slice merged is flagged once, not refused plan-blocked each tick. */

const NOW = new Date('2026-10-13T12:00:00.000Z')
const PLAN = { path: '/tmp/aw/alpha/sources/A-1-plan.md', text: '```burndown-slices\n```' }
const PARENT = { taskId: 'A-1', initiative: 'alpha', seat: 'seat-a', namePrefix: 'sa' }

const slice = (n: string, phase: Claim['phase'], taskId = 'A-1'): Claim => ({
  taskId,
  initiative: 'alpha',
  slice: n,
  spawnedAt: '2026-10-12T09:00:00.000Z',
  phase,
  phaseAt: '2026-10-12T09:00:00.000Z',
})

const ledgerOf = (claims: Claim[], patch: Partial<Ledger> = {}): Ledger => ({
  ...EMPTY_LEDGER,
  claims,
  ...patch,
})

const task = (id: string, patch: Partial<Task> = {}): Task => ({
  id,
  title: `task ${id}`,
  status: 'open',
  tags: [],
  ...patch,
})

describe('slicesMerged', () => {
  it('is true when every slice claim of the task is done', () => {
    expect(slicesMerged(ledgerOf([slice('a', 'done'), slice('b', 'done')]), 'A-1')).toBe(true)
  })

  it('is false while any slice is not done', () => {
    expect(slicesMerged(ledgerOf([slice('a', 'done'), slice('b', 'queued')]), 'A-1')).toBe(false)
  })

  it('is false for a task with no slice claims', () => {
    expect(slicesMerged(EMPTY_LEDGER, 'A-1')).toBe(false)
  })

  it('is false when a slice was released, which CC-1227 handles', () => {
    const ledger = ledgerOf([slice('a', 'done')], { slicesReleased: { 'A-1': ['b'] } })

    expect(slicesMerged(ledger, 'A-1')).toBe(false)
  })
})

describe('seedSlices on a parent whose slices all merged', () => {
  it('does not refuse it as already queued', () => {
    const ledger = ledgerOf([slice('a', 'done'), slice('b', 'done')])

    const result = seedSlices(PARENT, PLAN, ledger, NOW)

    expect(result).toEqual({ merged: true })
  })

  it('still refuses a parent with a queued slice', () => {
    const ledger = ledgerOf([slice('a', 'done'), slice('b', 'queued')])

    const result = seedSlices(PARENT, PLAN, ledger, NOW)

    expect(result).toEqual({ blocked: expect.stringContaining('already queued') })
  })

  it('still refuses a parent with a released slice', () => {
    const ledger = ledgerOf([slice('a', 'done')], { slicesReleased: { 'A-1': ['b'] } })

    expect(seedSlices(PARENT, PLAN, ledger, NOW)).toEqual({
      blocked: expect.stringContaining('already queued'),
    })
  })
})

describe('mergedParentFlags', () => {
  const tasks = new Map([['alpha', [task('A-1'), task('A-2'), task('A-3', { status: 'done' })]]])
  const ledger = ledgerOf([
    slice('a', 'done'),
    slice('b', 'done'),
    slice('a', 'done', 'A-2'),
    slice('b', 'queued', 'A-2'),
    slice('a', 'done', 'A-3'),
  ])

  it('flags an open parent whose slices all merged, once', () => {
    const flags = mergedParentFlags(ledger, tasks)

    expect(flags).toEqual([
      {
        key: mergedFlagKey('alpha', 'A-1'),
        task: 'A-1',
        text: 'alpha A-1: slices merged: close or replan',
      },
    ])
  })

  it('flags nothing once the flag is filed', () => {
    const filed = { ...ledger, humanFiled: [mergedFlagKey('alpha', 'A-1')] }

    expect(mergedParentFlags(filed, tasks)).toEqual([])
  })
})
