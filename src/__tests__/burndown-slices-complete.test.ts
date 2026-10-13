import { describe, expect, it } from 'vitest'
import type { Task } from '../agents/burndown/eligibility.js'
import { EMPTY_LEDGER, type Claim, type Ledger } from '../agents/burndown/ledger.js'
import { seedSlices } from '../agents/burndown/seed-slices.js'
import { deliverSeatEvents, type SeatSender } from '../agents/burndown/seat-deliver.js'
import { releasedSlicesLanded } from '../agents/burndown/landed-sweep.js'
import { mergedEvents, slicesMerged, slicesReleasedComplete } from '../agents/burndown/slices-complete.js'

/** CC-1049: a parent whose every slice merged is told to its seat once, not refused plan-blocked each tick. */

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

  it('is false when a slice was released, which slicesReleasedComplete handles', () => {
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

  it('still refuses a parent with a released slice and a queued one', () => {
    const ledger = ledgerOf([slice('a', 'queued')], { slicesReleased: { 'A-1': ['b'] } })

    expect(seedSlices(PARENT, PLAN, ledger, NOW)).toEqual({
      blocked: expect.stringContaining('already queued'),
    })
  })
})

describe('merged parents told to their seat', () => {
  const tasks = new Map([['alpha', [task('A-1'), task('A-2'), task('A-3', { status: 'done' })]]])
  const held = (c: Claim): Claim => ({ ...c, seat: 'seat-a' })
  const ledger = ledgerOf([
    held(slice('a', 'done')),
    held(slice('b', 'done')),
    held(slice('a', 'done', 'A-2')),
    held(slice('b', 'queued', 'A-2')),
    held(slice('a', 'done', 'A-3')),
  ])

  function tick(start: Ledger) {
    const sent: string[] = []
    const open = async (): Promise<SeatSender> => ({
      send: async (to, text) => {
        sent.push(`${to}: ${text.split('\n').slice(1).join('|')}`)
        return { ok: true }
      },
      notify: async () => ({ ok: true }),
      close: () => {},
    })
    const merged = mergedEvents(start, tasks)
    const diff = { seats: ['seat-a'], before: start, after: start, spawns: [], merged }
    const done = deliverSeatEvents(diff, { open, log: () => {}, now: NOW })
    return done.then(r => ({ ...r, sent }))
  }

  it('sends the seat one line naming an open parent whose slices all merged, and files no human item', async () => {
    const first = await tick(ledger)

    expect(first.sent).toEqual(['seat-a: slices merged: close or replan: A-1 (1 new)'])
    expect(first.ledger.humanFiled).toBeUndefined()
    expect(first.ledger.slicesFlagged).toEqual(['alpha/A-1'])
  })

  it('tells nothing on the next tick', async () => {
    const first = await tick(ledger)

    const second = await tick(first.ledger)

    expect(second.sent).toEqual([])
  })

  it('batches several parents into one line and names only the first fifteen', async () => {
    const ids = Array.from({ length: 17 }, (_, i) => `B-${i + 1}`)
    const many = ledgerOf(ids.map(id => held(slice('a', 'done', id))))
    const open = new Map([['alpha', ids.map(id => task(id))]])

    const events = mergedEvents(many, open)['seat-a'] ?? []

    expect(events).toHaveLength(1)
    expect(events[0]?.flagged).toHaveLength(15)
  })

  it('does not tell a seat of a parent whose claims hold no seat', () => {
    expect(mergedEvents(ledgerOf([slice('a', 'done')]), tasks)).toEqual({})
  })
})

describe('a parent whose slices are all done or released (CC-1227)', () => {
  const released = (): Ledger => ledgerOf([slice('a', 'done')], { slicesReleased: { 'A-1': ['b'] } })

  it('counts as complete when no slice is held', () => {
    expect(slicesReleasedComplete(released(), 'A-1')).toBe(true)
  })

  it('is not complete while a slice is still held', () => {
    const ledger = ledgerOf([slice('a', 'done'), slice('c', 'queued')], { slicesReleased: { 'A-1': ['b'] } })

    expect(slicesReleasedComplete(ledger, 'A-1')).toBe(false)
  })

  it('is not complete when nothing was released', () => {
    expect(slicesReleasedComplete(ledgerOf([slice('a', 'done')]), 'A-1')).toBe(false)
  })

  it('is no longer refused as already queued', () => {
    expect(seedSlices(PARENT, PLAN, released(), NOW)).toEqual({ merged: true })
  })

  it('is told to the seat once, tagged slices:released', () => {
    const tasks = new Map([['alpha', [task('A-1')]]])
    const claims = [{ ...slice('a', 'done'), seat: 'seat-a' }]
    const ledger = ledgerOf(claims, { slicesReleased: { 'A-1': ['b'] } })

    const events = mergedEvents(ledger, tasks)
    const told = mergedEvents({ ...ledger, slicesFlagged: events['seat-a']?.[0]?.flagged }, tasks)

    expect(events['seat-a']?.[0]).toMatchObject({ kind: 'slices-merged', taskId: 'A-1 (slices:released)' })
    expect(told).toEqual({})
  })

  it('is not flagged when the sweep will close it', () => {
    const tasks = new Map([['alpha', [task('A-1')]]])
    const claims = [{ ...slice('a', 'done'), seat: 'seat-a' }]
    const ledger = ledgerOf(claims, { slicesReleased: { 'A-1': ['b'] } })

    expect(mergedEvents(ledger, tasks, () => true)).toEqual({})
  })
})

describe('releasedSlicesLanded', () => {
  const reads = (subjects: string[]) => [{ repo: '/r', subjects }]

  it('is true when a default-branch commit names the parent for each released slice', () => {
    expect(releasedSlicesLanded('A-1', 2, reads(['A-1: one', 'A-1 b: two']), [])).toBe(true)
  })

  it('is false when fewer commits than released slices name the parent', () => {
    expect(releasedSlicesLanded('A-1', 2, reads(['A-1: one']), [])).toBe(false)
  })

  it('is false when an open PR names the parent', () => {
    expect(releasedSlicesLanded('A-1', 1, reads(['A-1: one']), ['A-1: open work'])).toBe(false)
  })

  it('is false when a repo could not be read', () => {
    expect(releasedSlicesLanded('A-1', 1, [{ repo: '/r', subjects: undefined }], [])).toBe(false)
  })
})
