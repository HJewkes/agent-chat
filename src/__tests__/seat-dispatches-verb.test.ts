import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { parseSince } from '../agents/seats/dispatch-read.js'
import { dispatchedRow, retiredRow, type DispatchRun } from '../agents/seats/dispatch-record.js'
import { dispatchesReport } from '../cli/verbs/seats.js'

/** CC-332: `seats dispatches` prints the folded records. Every seat, agent and path here is synthetic. */

const SEAT = 'sample-seat'
const USAGE = { input: 1, cache_read: 2, cache_write_5m: 3, cache_write_1h: 4, output: 5 }
const SPEND = { tokens: 15, usd_est: 0.5, usage: USAGE, models: ['m'], price_table: 1 }

const run = (agent: string, ts: string, task: string): DispatchRun => ({
  ts,
  task,
  initiative: 'init-a',
  kind: 'implement',
  profile: 'impl',
  agent,
  agent_id: `id-${agent}`,
  spawner: SEAT,
  model: 'm',
  predecessor: null,
})

const hand = (agent: string, outcome: string, extra: Record<string, unknown> = {}) => ({
  agent,
  outcome,
  ...extra,
})

let root: string
let savedTz: string | undefined

beforeAll(() => {
  savedTz = process.env.TZ
  // A zone far from UTC makes a local-time comparison visible.
  process.env.TZ = 'Pacific/Kiritimati'
})
afterAll(() => {
  if (savedTz === undefined) delete process.env.TZ
  else process.env.TZ = savedTz
})
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-dispatches-'))
  fs.mkdirSync(path.join(root, 'seats'))
  fs.writeFileSync(path.join(root, 'seats', `${SEAT}.md`), '---\nprefix: sx\npool: p\n---\n')
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

function writeLog(lines: unknown[]): void {
  fs.mkdirSync(path.join(root, 'logs', SEAT), { recursive: true })
  const body = lines.map(l => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n')
  fs.writeFileSync(path.join(root, 'logs', SEAT, 'dispatch.jsonl'), `${body}\n`)
}

const brokerAndHand = [
  dispatchedRow(run('sx-a-1-one', '2026-09-01T00:30:00.000Z', 'A-1')),
  retiredRow(run('sx-a-1-one', '2026-09-01T00:30:00.000Z', 'A-1'), 's1', SPEND),
  hand('sx-a-1-one', 'merged', { pr: 7, score: 4, by: 'seat' }),
  dispatchedRow(run('sx-b-2-two', '2026-09-02T12:00:00.000Z', 'B-2')),
  retiredRow(run('sx-b-2-two', '2026-09-02T12:00:00.000Z', 'B-2'), 's2', SPEND),
]

const records = (lines: string[]) =>
  lines
    .filter(l => l.startsWith('{') && l.includes('"agent"'))
    .map(l => JSON.parse(l) as Record<string, unknown>)

describe('seats dispatches', () => {
  it('folds broker and hand rows into one record per agent run', () => {
    writeLog(brokerAndHand)
    const report = dispatchesReport(root, SEAT, undefined, true)
    const recs = records(report.lines)
    expect(recs).toHaveLength(2)
    expect(recs[0]).toMatchObject({ agent: 'sx-a-1-one', outcome: 'merged', pr: 7, tokens: 15 })
    expect(recs[1]).toMatchObject({ agent: 'sx-b-2-two', outcome: 'retired' })
  })

  it('prints a text line per record, not per raw row', () => {
    writeLog(brokerAndHand)
    const lines = dispatchesReport(root, SEAT, undefined, false).lines
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('sx-a-1-one')
    expect(lines[0]).toContain('merged')
  })

  it('emits the malformed and invalid-outcome counts as the last JSON line', () => {
    writeLog([...brokerAndHand, 'not json', hand('sx-a-1-one', 'bogus')])
    const lines = dispatchesReport(root, SEAT, undefined, true).lines
    expect(JSON.parse(lines.at(-1) as string)).toEqual({ malformed: 1, invalid_outcomes: 1 })
  })

  it('keeps reading past a malformed line', () => {
    writeLog([brokerAndHand[0], '{"agent": ', '[1]', ...brokerAndHand.slice(1)])
    const report = dispatchesReport(root, SEAT, undefined, true)
    expect(report.ok).toBe(true)
    expect(records(report.lines)).toHaveLength(2)
    expect(JSON.parse(report.lines.at(-1) as string).malformed).toBe(2)
  })

  it('filters by dispatch ts with a zone-less --since read as UTC', () => {
    writeLog(brokerAndHand)
    // 00:30Z is before 01:00 UTC. In a zone at UTC+14 the same digits would be 11:00Z the day before.
    const recs = records(dispatchesReport(root, SEAT, '2026-09-01T01:00:00', true).lines)
    expect(recs.map(r => r.agent)).toEqual(['sx-b-2-two'])
  })

  it('reads a bare --since date as UTC midnight', () => {
    expect(parseSince('2026-09-01')).toBe(Date.UTC(2026, 8, 1))
    expect(parseSince('2026-09-01T05:00')).toBe(Date.UTC(2026, 8, 1, 5))
    expect(parseSince('2026-09-01T05:00:00+02:00')).toBe(Date.UTC(2026, 8, 1, 3))
    expect(parseSince('yesterday')).toBeUndefined()
  })

  it('reports an unknown seat as a plain error', () => {
    const report = dispatchesReport(root, 'nobody', undefined, false)
    expect(report).toMatchObject({ ok: false, lines: [], errors: ['nobody is not a seat'] })
  })

  it('reports a missing log as a plain error without the root path', () => {
    const report = dispatchesReport(root, SEAT, undefined, false)
    expect(report.ok).toBe(false)
    expect(report.errors?.[0]).toContain('no dispatch log')
    expect(report.errors?.[0]).not.toContain(root)
  })

  it('reads the file a seat names in dispatch_log inside the root', () => {
    fs.writeFileSync(
      path.join(root, 'seats', `${SEAT}.md`),
      '---\nprefix: sx\npool: p\ndispatch_log: custom/runs.jsonl\n---\n',
    )
    fs.mkdirSync(path.join(root, 'custom'))
    const body = brokerAndHand.map(l => JSON.stringify(l)).join('\n')
    fs.writeFileSync(path.join(root, 'custom', 'runs.jsonl'), `${body}\n`)
    const report = dispatchesReport(root, SEAT, undefined, true)
    expect(report.ok).toBe(true)
    expect(records(report.lines)).toHaveLength(2)
  })

  it('refuses a dispatch_log outside the root as a plain error without reading it', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-dispatches-out-'))
    try {
      fs.writeFileSync(path.join(outside, 'runs.jsonl'), `${JSON.stringify(brokerAndHand[0])}\n`)
      fs.writeFileSync(
        path.join(root, 'seats', `${SEAT}.md`),
        `---\nprefix: sx\npool: p\ndispatch_log: ${path.join(outside, 'runs.jsonl')}\n---\n`,
      )
      const report = dispatchesReport(root, SEAT, undefined, false)
      expect(report).toMatchObject({ ok: false, lines: [] })
      expect(report.errors?.[0]).toContain('outside the root')
      expect(report.errors?.[0]).not.toContain(outside)
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('reports an unreadable --since as a plain error', () => {
    writeLog(brokerAndHand)
    const report = dispatchesReport(root, SEAT, 'soon', false)
    expect(report.ok).toBe(false)
    expect(report.errors?.[0]).toContain('--since')
  })
})
