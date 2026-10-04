import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Claim, Ledger } from '../agents/burndown/ledger.js'
import {
  milestoneReport,
  renderMilestoneLine,
  weekStartDay,
  type MilestoneReportInput,
  type ReportTask,
} from '../agents/burndown/milestone-report.js'
import { milestoneReportFromDisk, reportTaskOf } from '../agents/burndown/milestone-source.js'
import { validateMilestones, type MilestoneFile } from '../agents/burndown/milestones.js'
import { milestoneReportLines } from '../cli/verbs/burndown.js'

/** CC-630: the section 4.4 burn-down per milestone over a synthetic week, tasks and claim ledger. */

const NOW = new Date('2026-10-01T12:00:00Z')
const TODAY = '2026-10-01'

const task = (id: string, estimate: number | undefined, tags: string[], dates: Partial<ReportTask> = {}) =>
  ({ id, done: false, tags, ...(estimate !== undefined && { estimate }), ...dates }) as ReportTask

const done = (on: string) => ({ done: true, doneOn: on })

const TASKS: ReportTask[] = [
  task('EX-1', 2, ['milestone:M1'], { ...done('2026-09-30'), created: '2026-09-20' }),
  task('EX-2', 3, ['milestone:M1', 'dep:EX-1'], { created: '2026-09-25' }),
  task('EX-3', 1, ['milestone:M1', 'dep:EX-2'], { created: '2026-09-29' }),
  task('EX-4', 2, ['milestone:M1'], { created: '2026-09-30' }),
  task('EX-5', undefined, ['milestone:M1']),
  task('EX-6', 1, ['milestone:M1'], { ...done('2026-09-25'), created: '2026-09-20' }),
  task('EX-7', 1, ['milestone:M2', 'dep:EX-8']),
  task('EX-8', 1, ['milestone:M2', 'dep:EX-7']),
  task('EX-9', 2, ['milestone:M2', 'dep:EX-7']),
  task('EX-10', 3, ['milestone:M2']),
  task('EX-11', 6, ['milestone:M3'], done(TODAY)),
  task('EX-12', 1, ['milestone:M3']),
]

const claim = (taskId: string, phase: Claim['phase'], extra: Partial<Claim> = {}): Claim => ({
  taskId,
  initiative: 'example',
  spawnedAt: '2026-10-01T10:00:00Z',
  phase,
  phaseAt: '2026-10-01T11:30:00Z',
  ...extra,
})

const LEDGER: Ledger = {
  version: 1,
  claims: [
    claim('EX-2', 'implementing', { slice: 'a' }),
    claim('EX-2', 'reviewing', { slice: 'b' }),
    claim('EX-9', 'implementing', { stalledReason: 'no report' }),
    claim('EX-10', 'awaiting-merge'),
    claim('EX-11', 'done'),
  ],
}

const MILESTONES = {
  week: '2026-W40',
  appetite_days: 5,
  milestones: [
    { id: 'M1', rank: 1, seat: 'seat-a' },
    { id: 'M2', rank: 2, seat: 'seat-b', gated_by: 'M1' },
    { id: 'M3', rank: 3, seat: 'seat-a' },
  ],
}

const milestoneFile = (raw: unknown = MILESTONES): MilestoneFile => validateMilestones(raw, []).file!

const input = (extra: Partial<MilestoneReportInput> = {}): MilestoneReportInput => ({
  milestones: milestoneFile(),
  tasks: TASKS,
  ledger: LEDGER,
  now: NOW,
  today: TODAY,
  ...extra,
})

const report = (id: string, extra: Partial<MilestoneReportInput> = {}) =>
  milestoneReport(input(extra)).milestones.find(m => m.id === id)!

describe('weekStartDay', () => {
  it.each([
    ['2026-W40', '2026-09-28'],
    ['2026-W01', '2025-12-29'],
    ['2020-W53', '2020-12-28'],
  ])('puts %s on Monday %s', (week, monday) => {
    expect(new Date(weekStartDay(week) * 86_400_000).toISOString().slice(0, 10)).toBe(monday)
  })
})

describe('the section 4.4 fields', () => {
  it('reports scope, path, counts, WIP, throughput, forecast and status for one milestone', () => {
    const doc = milestoneReport(input())

    expect(doc).toMatchObject({ week: '2026-W40', weekStart: '2026-09-28', today: TODAY, appetiteDays: 5 })
    expect(doc.milestones.map(m => m.id)).toEqual(['M1', 'M2', 'M3'])
    expect(doc.milestones[0]).toEqual({
      id: 'M1',
      rank: 1,
      seat: 'seat-a',
      status: 'at-risk',
      reason: 'forecast 5.97d past 2d left',
      points: { scope: 9, done: 3, remaining: 6, addedThisWeek: 3, unestimated: ['EX-5'] },
      criticalPath: { points: 4, slices: ['EX-2', 'EX-3'], lowerBound: false, cycles: [] },
      counts: { ready: 2, blocked: 1, inFlight: 1 },
      wip: { building: 1, inReview: 1, awaitingMerge: 0, awaitingOwner: 0 },
      throughput: { pointsPerDay: 0.67, days: 3 },
      forecast: { days: 5.97, daysLeft: 2 },
    })
  })

  it('treats cycle members as blocked, prints the cycles and flags the path as a lower bound', () => {
    const m2 = report('M2')

    expect(m2.criticalPath).toEqual({
      points: 3,
      slices: ['EX-10'],
      lowerBound: true,
      cycles: [['EX-7', 'EX-8']],
    })
    expect(m2.counts).toEqual({ ready: 0, blocked: 2, inFlight: 2 })
    expect(m2.wip).toEqual({ building: 0, inReview: 0, awaitingMerge: 1, awaitingOwner: 1 })
    expect(m2.forecast).toEqual({ days: null, daysLeft: 2 })
  })

  it('is on track when the forecast fits the days left', () => {
    const m3 = report('M3')

    expect(m3.status).toBe('on-track')
    expect(m3.reason).toBeUndefined()
    expect(m3.forecast).toEqual({ days: 0.5, daysLeft: 2 })
  })
})

describe('status', () => {
  it('stops a milestone whose gate is open', () => {
    expect(report('M2')).toMatchObject({ status: 'stopped', reason: 'gate open: M1' })
  })

  it('stops every milestone when the factory is down', () => {
    const doc = milestoneReport(input({ factoryDown: 'held' }))

    expect(doc.milestones.map(m => m.reason)).toEqual(Array(3).fill('factory down: held'))
  })

  it("stops a milestone whose seat the owner stopped, and only that seat's", () => {
    const doc = milestoneReport(input({ stoppedSeats: { 'seat-a': 'owner pause' } }))

    expect(doc.milestones.map(m => m.status)).toEqual(['stopped', 'stopped', 'stopped'])
    expect(doc.milestones[2]!.reason).toBe('seat seat-a stopped: owner pause')
  })

  it('puts an ungated milestone with a cycle at risk', () => {
    const ungated = { ...MILESTONES, milestones: [{ id: 'M2', rank: 1, seat: 'seat-b' }] }

    expect(report('M2', { milestones: milestoneFile(ungated) })).toMatchObject({
      status: 'at-risk',
      reason: 'dependency cycle',
    })
  })

  it('puts a milestone with work left and no recent throughput at risk', () => {
    const quiet = TASKS.map(t => (t.id === 'EX-1' ? { ...t, doneOn: '2026-09-21' } : t))

    expect(report('M1', { tasks: quiet })).toMatchObject({
      status: 'at-risk',
      reason: 'no points done in 3 days',
    })
  })
})

describe('the digest line', () => {
  it('says status, points, path, counts, throughput and forecast on one line', () => {
    expect(renderMilestoneLine(report('M1'))).toBe(
      'M1 at-risk (forecast 5.97d past 2d left): 3/9 points done, +3 this week; path 4; ' +
        '2 ready, 1 blocked, 1 in flight; 0.67 points/day, forecast 5.97d vs 2d left',
    )
  })

  it('marks a path with cycles as a lower bound', () => {
    expect(renderMilestoneLine(report('M2'))).toContain('path 3 at least, 1 cycle;')
  })
})

describe('burndown milestone', () => {
  const doc = () => ({ ...milestoneReport(input()), errors: [] })

  it('--json prints the report as one document', () => {
    const result = milestoneReportLines(doc, true)

    expect(result.ok).toBe(true)
    expect(JSON.parse(result.lines.join('\n'))).toEqual(JSON.parse(JSON.stringify(doc())))
  })

  it('prints one line per milestone without --json', () => {
    expect(milestoneReportLines(doc, false).lines).toHaveLength(3)
  })

  it('--json prints a missing milestone file as an {"error"} document', () => {
    const result = milestoneReportLines(() => undefined, true)

    expect(result.ok).toBe(false)
    expect(JSON.parse(result.lines.join('\n'))).toEqual({
      error: 'no milestones/<week>.yml for this ISO week',
    })
  })
})

describe('reading the report from disk', () => {
  let world: string
  const saved = { ...process.env }
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, text)
  }

  beforeEach(() => {
    world = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-milestones-')))
    process.env.AGENT_CHAT_HOME = path.join(world, 'home')
  })

  afterEach(() => {
    process.env = { ...saved }
    fs.rmSync(world, { recursive: true, force: true })
  })

  it('reads the week file, open and done task files, and the claim ledger', () => {
    const tasks = path.join(world, 'aw', 'example', 'tasks')
    write(
      path.join(world, 'auto', 'milestones', '2026-W40.yml'),
      'week: 2026-W40\nappetite_days: 5\nmilestones:\n  - {id: M1, rank: 1, seat: seat-a}\n',
    )
    write(path.join(tasks, 'EX-1.yml'), 'id: EX-1\nstatus: open\nestimate: 2\ntags: [milestone:M1]\n')
    write(
      path.join(tasks, 'archive', 'EX-2.yml'),
      'id: EX-2\nstatus: done\nestimate: 1\ntags: [milestone:M1]\ndone_at: 2026-10-01\ncreated: 20260929\n',
    )
    write(
      path.join(world, 'home', 'burndown.json'),
      JSON.stringify({ version: 1, claims: [claim('EX-1', 'reviewing')] }),
    )

    const read = milestoneReportFromDisk({
      autonomyRoot: path.join(world, 'auto'),
      activeWorkRoot: path.join(world, 'aw'),
      now: NOW,
      today: TODAY,
    })!

    expect(read.errors).toEqual([])
    expect(read.milestones[0]).toMatchObject({
      points: { scope: 3, done: 1, remaining: 2, addedThisWeek: 1 },
      counts: { ready: 0, blocked: 0, inFlight: 1 },
      wip: { inReview: 1 },
      throughput: { pointsPerDay: 0.33 },
    })
  })

  it('is undefined when the week has no milestone file', () => {
    const read = milestoneReportFromDisk({
      autonomyRoot: path.join(world, 'auto'),
      activeWorkRoot: path.join(world, 'aw'),
      now: NOW,
      today: TODAY,
    })

    expect(read).toBeUndefined()
  })

  it('reads a task file, skipping one that is malformed or neither open nor done', () => {
    expect(reportTaskOf('id: EX-1\nstatus: done\ndone_at: 20261001\n')).toEqual({
      id: 'EX-1',
      done: true,
      doneOn: '2026-10-01',
    })
    expect(reportTaskOf('id: EX-1\nstatus: dropped\n')).toBeUndefined()
    expect(reportTaskOf('id: [unclosed\n')).toBeUndefined()
  })
})
