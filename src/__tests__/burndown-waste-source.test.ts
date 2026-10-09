import fs from 'node:fs'
import { createRequire } from 'node:module'
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  coordinationTotals,
  readWasteObservations,
  type WasteInput,
  type WasteObservations,
} from '../agents/burndown/waste-source.js'
import { reviewCarousel } from '../agents/burndown/waste.js'
import type { DispatchRecord } from '../agents/seats/dispatch-record.js'

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => DatabaseSyncType
}

const SCHEMA = `CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL, actor TEXT NOT NULL,
  target TEXT, msg_id TEXT, ref TEXT, body TEXT, meta TEXT)`

const START = Date.UTC(2026, 0, 5)
const NOW = START + 3 * 86_400_000
const at = (minutes: number): number => START + minutes * 60_000
const H1 = 'a'.repeat(40)
const H2 = 'b'.repeat(40)

interface Row {
  ts: number
  kind: string
  actor: string
  target?: string
  body?: string
}

const run = (over: Partial<DispatchRecord>): DispatchRecord => ({
  ts: new Date(at(1)).toISOString(),
  task: 'T-1',
  initiative: 'demo',
  kind: null,
  score: null,
  profile: 'implementer',
  agent: 'impl-1',
  pr: null,
  outcome: 'retired',
  note: null,
  tokens: null,
  usd_est: null,
  usage_partial: false,
  value: null,
  agent_id: null,
  spawner: 'seat-a',
  model: null,
  predecessor: null,
  ...over,
})

const verdictBody = (verdict: string, pr: string, head: string): string =>
  `Status: DONE\nVerdict: ${verdict}\nPR: ${pr}\nHead: ${head}`

let dir: string
let dbPath: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-waste-source-'))
  dbPath = path.join(dir, 'events.db')
})

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

function writeEvents(rows: Row[]): void {
  const db = new DatabaseSync(dbPath)
  db.exec(SCHEMA)
  const insert = db.prepare('INSERT INTO events (ts, kind, actor, target, body) VALUES (?, ?, ?, ?, ?)')
  for (const r of rows) insert.run(r.ts, r.kind, r.actor, r.target ?? null, r.body ?? null)
  db.close()
}

const input = (dispatches: DispatchRecord[], tasks = [{ task: 'T-1', seat: 'seat-a' }]): WasteInput => ({
  tasks,
  dispatches,
  window: { startMs: START, endMs: NOW },
})

function read(rows: Row[], dispatches: DispatchRecord[], tasks?: WasteInput['tasks']): WasteObservations {
  writeEvents(rows)
  const out = readWasteObservations(dbPath, input(dispatches, tasks))
  if ('error' in out) throw new Error(out.error)
  return out
}

describe('readWasteObservations: verdicts', () => {
  const dispatches = [run({ pr: 'https://github.com/Own/Repo/pull/7' })]

  it('verdict blocks in reviewer messages become verdicts keyed by PR and head', () => {
    const obs = read(
      [
        {
          ts: at(10),
          kind: 'message',
          actor: 'rev-1',
          target: 'seat-a',
          body: verdictBody('FIX_FIRST', 'Own/Repo#7', H1),
        },
        {
          ts: at(20),
          kind: 'message',
          actor: 'rev-1',
          target: 'seat-a',
          body: verdictBody('MERGE', 'own/repo#7', H2),
        },
      ],
      dispatches,
    )
    expect(obs.verdicts).toEqual([
      { task: 'T-1', pr: 'own/repo#7', head: H1, verdict: 'FIX_FIRST', ts: at(10) },
      { task: 'T-1', pr: 'own/repo#7', head: H2, verdict: 'MERGE', ts: at(20) },
    ])
  })

  it('a message with a verdict line but no Head line is ignored', () => {
    const obs = read(
      [
        {
          ts: at(10),
          kind: 'message',
          actor: 'rev-1',
          target: 'seat-a',
          body: 'Verdict: FIX_FIRST\nPR: own/repo#7',
        },
      ],
      dispatches,
    )
    expect(obs.verdicts).toEqual([])
  })

  it('a verdict on a PR no milestone task ran is left out', () => {
    const obs = read(
      [
        {
          ts: at(10),
          kind: 'message',
          actor: 'rev-1',
          target: 'seat-a',
          body: verdictBody('FIX_FIRST', 'own/repo#8', H1),
        },
      ],
      dispatches,
    )
    expect(obs.verdicts).toEqual([])
  })

  it('the same verdict resent within 60 seconds counts once, and a later re-review counts again', () => {
    const body = verdictBody('FIX_FIRST', 'own/repo#7', H1)
    const obs = read(
      [
        { ts: at(10), kind: 'message', actor: 'rev-1', target: 'seat-a', body },
        { ts: at(10) + 30_000, kind: 'message', actor: 'rev-1', target: 'seat-a', body },
        { ts: at(30), kind: 'message', actor: 'rev-2', target: 'seat-a', body },
      ],
      dispatches,
    )
    expect(obs.verdicts.map(v => v.ts)).toEqual([at(10), at(30)])
  })
})

describe('readWasteObservations feeding the detectors', () => {
  it('five FIX_FIRST messages at one head on one PR give a review carousel with five returns', () => {
    const body = verdictBody('FIX_FIRST', 'own/repo#7', H1)
    const rows = [10, 20, 30, 40, 50].map(m => ({
      ts: at(m),
      kind: 'message',
      actor: 'rev-1',
      target: 'seat-a',
      body,
    }))
    const obs = read(rows, [run({ pr: 'own/repo#7' })])
    expect(reviewCarousel(obs.verdicts)).toEqual([
      expect.objectContaining({
        detector: 'review-carousel',
        pr: 'own/repo#7',
        head: H1,
        counts: { returns: 5 },
      }),
    ])
  })
})

describe('readWasteObservations: coordination messages', () => {
  const dispatches = [
    run({ task: 'T-1', agent: 'impl-1' }),
    run({ task: 'T-1', agent: 'rev-1', profile: 'reviewer' }),
    run({ task: 'T-2', agent: 'impl-2' }),
  ]
  const tasks = [
    { task: 'T-1', seat: 'seat-a' },
    { task: 'T-2', seat: 'seat-a' },
  ]

  it('messages count toward a task through its agents or its id', () => {
    const obs = read(
      [
        { ts: at(10), kind: 'message', actor: 'rev-1', target: 'seat-a', body: 'looked' },
        { ts: at(11), kind: 'notice', actor: 'agent-chat', target: 'impl-1', body: 'wake' },
        { ts: at(12), kind: 'message', actor: 'seat-a', target: 'seat-b', body: 'T-1 is blocked' },
        { ts: at(13), kind: 'message', actor: 'seat-a', target: 'seat-b', body: 'nothing named' },
        { ts: at(14), kind: 'message', actor: 'seat-b', target: 'seat-c', body: 'T-1 elsewhere' },
        { ts: at(15), kind: 'message', actor: 'seat-a', target: 'seat-b', body: 'T-10 is a different task' },
        { ts: at(16), kind: 'registered', actor: 'impl-1' },
      ],
      dispatches,
      tasks,
    )
    expect(obs.coordMessages['T-1']).toHaveLength(3)
    expect(obs.coordMessages['T-2']).toEqual([])
  })

  it('a message touching two tasks counts once for the milestone', () => {
    const obs = read(
      [
        { ts: at(10), kind: 'message', actor: 'impl-1', target: 'impl-2', body: 'hello' },
        { ts: at(11), kind: 'message', actor: 'impl-2', target: 'seat-a', body: 'done' },
      ],
      dispatches,
      tasks,
    )
    expect(obs.coordMessages['T-1']).toHaveLength(1)
    expect(obs.coordMessages['T-2']).toHaveLength(2)
    expect(coordinationTotals(obs, ['T-1', 'T-2']).coordMessages).toBe(2)
  })

  it('rows outside the week window are left out', () => {
    const obs = read(
      [
        { ts: START - 1, kind: 'message', actor: 'impl-1', target: 'seat-a', body: 'before' },
        { ts: START, kind: 'message', actor: 'impl-1', target: 'seat-a', body: 'first' },
        { ts: NOW, kind: 'message', actor: 'impl-1', target: 'seat-a', body: 'last' },
        { ts: NOW + 1, kind: 'message', actor: 'impl-1', target: 'seat-a', body: 'after' },
        {
          ts: Math.floor(at(10) / 1000),
          kind: 'message',
          actor: 'impl-1',
          target: 'seat-a',
          body: 'seconds',
        },
      ],
      dispatches,
      tasks,
    )
    expect(obs.coordMessages['T-1']).toHaveLength(2)
  })
})

describe('readWasteObservations: lineages and merged PRs', () => {
  it('transitions add resumes of the task agents to its messages, and merged PRs come from runs in the window', () => {
    const obs = read(
      [
        { ts: at(10), kind: 'message', actor: 'impl-1', target: 'seat-a', body: 'up' },
        { ts: at(11), kind: 'agent_resumed', actor: 'seat-a', target: 'impl-1' },
        { ts: at(12), kind: 'agent_resumed', actor: 'seat-a', target: 'someone-else' },
      ],
      [
        run({ pr: 'own/repo#1', outcome: 'merged', ts: new Date(at(20)).toISOString() }),
        run({ agent: 'impl-1b', pr: 'Own/Repo#1', outcome: 'merged', ts: new Date(at(21)).toISOString() }),
        run({ agent: 'impl-1c', pr: 'own/repo#2', outcome: 'merged', ts: new Date(START - 1).toISOString() }),
        run({ agent: 'impl-1d', pr: 'own/repo#3', outcome: 'parked' }),
      ],
    )
    expect(obs.lineages).toEqual([{ task: 'T-1', transitions: 2, mergedPrs: 1, hasImplementerRun: true }])
    expect(obs.mergedPrs['T-1']).toEqual(['own/repo#1'])
  })

  it('a task with only planner runs has no implementer run', () => {
    const obs = read([], [run({ profile: 'bd-planner', agent: 'plan-1' })])
    expect(obs.lineages[0]?.hasImplementerRun).toBe(false)
  })

  it('coordination per merged PR is null with no merged PR and rounded to two places otherwise', () => {
    const empty = read([], [run({})])
    expect(coordinationTotals(empty, ['T-1'])).toEqual({
      coordMessages: 0,
      mergedPrs: 0,
      coordMessagesPerMergedPr: null,
    })
    const obs: WasteObservations = {
      ...empty,
      coordMessages: { 'T-1': [1, 2, 3, 4, 5, 6, 7], 'T-2': [7] },
      mergedPrs: { 'T-1': ['o/r#1', 'o/r#2'], 'T-2': ['o/r#2', 'o/r#3'] },
    }
    expect(coordinationTotals(obs, ['T-1', 'T-2'])).toEqual({
      coordMessages: 7,
      mergedPrs: 3,
      coordMessagesPerMergedPr: 2.33,
    })
  })
})

describe('readWasteObservations: wakes', () => {
  it('a wake is rescued when the agent writes a message before its next wake', () => {
    const obs = read(
      [
        { ts: at(10), kind: 'agent_resumed', actor: 'seat-a', target: 'impl-1' },
        { ts: at(11), kind: 'message', actor: 'impl-1', target: 'seat-a', body: 'back' },
        { ts: at(20), kind: 'message', actor: 'agent-chat', target: 'impl-1', body: 'unreported exit' },
        { ts: at(30), kind: 'agent_resumed', actor: 'seat-a', target: 'impl-1' },
        { ts: at(31), kind: 'notice', actor: 'impl-1', target: 'seat-a', body: 'a notice is no reply' },
        { ts: at(40), kind: 'message', actor: 'seat-a', target: 'impl-1', body: 'a seat message is no wake' },
      ],
      [run({})],
    )
    expect(obs.wakes).toEqual([
      { task: 'T-1', agent: 'impl-1', rescued: true },
      { task: 'T-1', agent: 'impl-1', rescued: false },
      { task: 'T-1', agent: 'impl-1', rescued: false },
    ])
  })
})

describe('readWasteObservations: unreadable events.db', () => {
  it('a missing events.db gives an error, not a throw', () => {
    const out = readWasteObservations(path.join(dir, 'absent.db'), input([run({})]))
    expect(out).toEqual({ error: expect.stringContaining('events.db unreadable') })
  })

  it('a file that is not a database gives an error, not a throw', () => {
    fs.writeFileSync(dbPath, 'not sqlite at all, just text that is long enough to have a header')
    const out = readWasteObservations(dbPath, input([run({})]))
    expect(out).toEqual({ error: expect.stringContaining('events.db unreadable') })
  })

  it('reading never writes to events.db', () => {
    writeEvents([{ ts: at(10), kind: 'message', actor: 'impl-1', target: 'seat-a', body: 'up' }])
    const before = fs.readFileSync(dbPath)
    readWasteObservations(dbPath, input([run({})]))
    expect(fs.readFileSync(dbPath).equals(before)).toBe(true)
    expect(fs.readdirSync(dir)).toEqual(['events.db'])
  })
})
