import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { backoffHeld, heldUntil, RELEASE_BASE_MS } from '../agents/burndown/backoff.js'
import { taskRefusal, type Task } from '../agents/burndown/eligibility.js'
import { readLedger, readySlices, writeLedger, type Claim, type Ledger } from '../agents/burndown/ledger.js'

const T0 = new Date('2026-10-01T12:00:00.000Z')
const B = RELEASE_BASE_MS
const at = (ms: number): Date => new Date(T0.getTime() + ms)

const ledgerWith = (n: number): Ledger => ({
  version: 1,
  claims: [],
  releases: { 'X-1': { n, at: T0.toISOString() } },
})

const task: Task = {
  id: 'X-1',
  title: 'Do X-1',
  status: 'open',
  estimate: 1,
  doneWhen: 'unit tests cover it',
  tags: [],
}

const refusalAt = (ledger: Ledger, now: Date): ReturnType<typeof taskRefusal> =>
  taskRefusal(task, [], new Set(), backoffHeld(ledger, now))

describe('release backoff hold', () => {
  it('holds a task released three times for four times the base', () => {
    const ledger = ledgerWith(3)

    const held = refusalAt(ledger, at(4 * B - 1))
    const free = refusalAt(ledger, at(4 * B + 1))

    expect(held).toEqual({
      kind: 'backoff',
      reason: `released 3 times; held until ${at(4 * B).toISOString()}`,
    })
    expect(free).toBeUndefined()
  })

  it.each([
    [1, 1],
    [2, 2],
    [5, 16],
    [9, 16],
  ])('holds a task released %i times for %i times the base', (n, factor) => {
    expect(heldUntil({ n, at: T0.toISOString() })).toBe(T0.getTime() + factor * B)
  })

  it('keeps a requeued slice out of the ready slices while its task is held', () => {
    const slice: Claim = {
      taskId: 'X-1',
      slice: 's2',
      initiative: 'demo',
      spawnedAt: T0.toISOString(),
      phase: 'queued',
      phaseAt: T0.toISOString(),
    }
    const ledger: Ledger = { ...ledgerWith(1), claims: [slice] }

    expect(readySlices(ledger, backoffHeld(ledger, at(B - 1)))).toEqual([])
    expect(readySlices(ledger, backoffHeld(ledger, at(B + 1)))).toEqual([slice])
  })
})

describe('release count on disk', () => {
  let dir: string | undefined

  afterEach(() => {
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true })
  })

  it('reads back the count and time written', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-backoff-'))
    const file = path.join(dir, 'ledger.json')

    writeLedger(file, ledgerWith(4))

    expect(readLedger(file).releases).toEqual({ 'X-1': { n: 4, at: T0.toISOString() } })
  })

  it.each([
    ['an unparseable time', { n: 1, at: 'yesterday' }],
    ['a zero count', { n: 0, at: T0.toISOString() }],
    ['a fractional count', { n: 1.5, at: T0.toISOString() }],
  ])('rejects %s on read', (_label, rec) => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-backoff-'))
    const file = path.join(dir, 'ledger.json')
    fs.writeFileSync(file, JSON.stringify({ version: 1, claims: [], releases: { 'X-1': rec } }))

    expect(() => readLedger(file)).toThrow('malformed')
  })
})
