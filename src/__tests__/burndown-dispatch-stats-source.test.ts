import fs from 'node:fs'
import { createRequire } from 'node:module'
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readGateRows } from '../agents/burndown/dispatch-stats-source.js'
import { gateCounts } from '../agents/burndown/dispatch-stats.js'

/** CC-965: the seat spawn gate's rows read from broker.log, its rotation and events.db. Synthetic names throughout. */

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => DatabaseSyncType
}

const SCHEMA = `CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL, actor TEXT NOT NULL,
  target TEXT, msg_id TEXT, ref TEXT, body TEXT, meta TEXT)`

const NOW = new Date(Date.UTC(2026, 1, 3, 12))
const HOUR_MS = 3_600_000
const SINCE = NOW.getTime() - 24 * HOUR_MS
const hoursAgo = (h: number): number => NOW.getTime() - h * HOUR_MS

const logLine = (event: string, h: number, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ ts: new Date(hoursAgo(h)).toISOString(), event, ...extra })
const reserveWarn = (h: number, name = 'ac-ab-1'): string =>
  logLine('seat_hand_reserve', h, { name, mode: 'warn', requested_by: 'alpha-coord' })

let root: string
let logFile: string
let dbPath: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-stats-source-'))
  fs.mkdirSync(path.join(root, 'seats'))
  fs.writeFileSync(path.join(root, 'seats', 'alpha-coord.md'), '---\nprefix: ac\npool: agents\n---\n')
  logFile = path.join(root, 'broker.log')
  dbPath = path.join(root, 'events.db')
  const db = new DatabaseSync(dbPath)
  db.exec(SCHEMA)
  db.close()
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

const writeLogs = (current: string[], rotated: string[]): void => {
  fs.writeFileSync(logFile, current.join('\n') + '\n')
  fs.writeFileSync(`${logFile}.1`, rotated.join('\n') + '\n')
}

const refusal = (h: number, actor: string, target: string, body: string): void => {
  const db = new DatabaseSync(dbPath)
  db.prepare(
    "INSERT INTO events (ts, kind, actor, target, body) VALUES (?, 'agent_spawn_refused', ?, ?, ?)",
  ).run(hoursAgo(h), actor, target, body)
  db.close()
}

const read = () => readGateRows(root, { logFile, dbPath }, SINCE, NOW)
const alpha = () => gateCounts(read(), 'alpha-coord')

describe('dispatch-stats gate rows', () => {
  it('counts warn lines inside the window from broker.log and its rotation', () => {
    writeLogs(
      [reserveWarn(2), reserveWarn(1), logLine('agent_spawned', 1)],
      [logLine('boot', 30), reserveWarn(30), reserveWarn(20)],
    )

    expect(alpha()).toMatchObject({ reserveWarn: 3, reserveRefused: 0, partial: false })
  })

  it('counts a refusal from events.db as refused, not warned, and its refuse-mode log line once', () => {
    writeLogs(
      [
        logLine('seat_spawn_unprefixed', 1, {
          name: 'fix-ab-1',
          mode: 'refuse',
          requested_by: 'alpha-coord',
        }),
      ],
      [logLine('boot', 30)],
    )
    refusal(
      1,
      'alpha-coord',
      'fix-ab-1',
      'seat_spawn_unprefixed: implementer fix-ab-1 lacks the seat prefix ac-',
    )
    refusal(1, 'alpha-coord', 'ac-ab-2', 'profile not found')

    expect(alpha()).toMatchObject({ unprefixedRefused: 1, unprefixedWarn: 0, reserveRefused: 0 })
  })

  it("attributes an unprefixed spawn by its seat spawner and a non-seat spawner's by the agent's prefix", () => {
    writeLogs(
      [
        logLine('seat_spawn_overlap', 1, { name: 'fix-ab-1', mode: 'warn', requested_by: 'alpha-coord' }),
        logLine('seat_spawn_overlap', 1, { name: 'ac-ab-2', mode: 'warn', requested_by: 'human' }),
        logLine('seat_spawn_overlap', 1, { name: 'zz-ab-3', mode: 'warn', requested_by: 'human' }),
      ],
      [logLine('boot', 30)],
    )

    const rows = read().rows

    expect(rows.map(r => r.seat)).toEqual(['alpha-coord', 'alpha-coord', undefined])
  })

  it('reports a partial window when the oldest log line is newer than the window start', () => {
    writeLogs([reserveWarn(1)], [logLine('boot', 10)])

    expect(read().partial).toBe(true)
  })

  it('reports a partial window when events.db cannot be read', () => {
    writeLogs([reserveWarn(1)], [logLine('boot', 30)])
    fs.rmSync(dbPath)

    expect(read()).toMatchObject({
      partial: true,
      rows: [expect.objectContaining({ code: 'seat_hand_reserve' })],
    })
  })

  it('skips a malformed log line instead of throwing', () => {
    writeLogs(['not json {', reserveWarn(1)], [logLine('boot', 30)])

    expect(alpha().reserveWarn).toBe(1)
  })
})
