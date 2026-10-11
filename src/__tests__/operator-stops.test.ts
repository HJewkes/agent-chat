import fs from 'node:fs'
import { createRequire } from 'node:module'
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readHoldMessages } from '../agents/seats/io.js'
import {
  BROADCAST_HOLD_MAX_MS,
  broadcastHolds,
  machineStopStatus,
  type ChatLine,
  type StopInputs,
} from '../agents/seats/operator-stops.js'
import { machineStatusReport } from '../cli/verbs/machine.js'

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => DatabaseSyncType
}

const NOW = new Date('2026-10-06T13:00:00Z')
const MIN = 60_000
const at = (minutesAgo: number): number => NOW.getTime() - minutesAgo * MIN

const line = (actor: string, minutesAgo: number, body: string, msgId: string | null = null): ChatLine => ({
  ts: at(minutesAgo),
  actor,
  msgId,
  body,
})

const READINGS = { memoryFreePercent: 80, load5: 4, swapUsedPercent: 10, pressureLevel: 1 }

const inputs = (over: Partial<StopInputs> = {}): StopInputs => ({
  now: NOW,
  chat: [],
  stopFile: () => undefined,
  ownerStops: () => ({}),
  readings: READINGS,
  machineStop: null,
  ...over,
})

describe('machine stop status', () => {
  it('reports a clear machine with every list empty and the readings', () => {
    const status = machineStopStatus(inputs())

    expect(status).toEqual({
      at: NOW.toISOString(),
      stopped: false,
      holds: [],
      ownerStops: [],
      machine: { ...READINGS, stop: null },
      errors: [],
    })
  })

  it('reports a broadcast HOLD with who, since and reason', () => {
    const hold = line('tp-operator', 55, 'tp-operator: HOLD (forecast trip). kalloc rising', '41c4a804')

    const status = machineStopStatus(inputs({ chat: [hold] }))

    expect(status.stopped).toBe(true)
    expect(status.holds).toEqual([
      {
        kind: 'broadcast',
        by: 'tp-operator',
        since: new Date(at(55)).toISOString(),
        reason: '(forecast trip). kalloc rising',
        msgId: '41c4a804',
      },
    ])
  })

  it('reports the stop file hold', () => {
    const file = JSON.stringify({ by: 'owner', since: '2026-10-06T12:00:00Z', reason: 'reboot' })

    const status = machineStopStatus(inputs({ stopFile: () => file }))

    expect(status.stopped).toBe(true)
    expect(status.holds).toEqual([
      { kind: 'file', by: 'owner', since: '2026-10-06T12:00:00Z', reason: 'reboot' },
    ])
  })

  it('lists owner stops without counting them as a machine stop, since each holds one seat', () => {
    const status = machineStopStatus(inputs({ ownerStops: () => ({ 'design-coord': 'parked, item 201' }) }))

    expect(status.stopped).toBe(false)
    expect(status.ownerStops).toEqual([{ seat: 'design-coord', reason: 'parked, item 201' }])
  })

  it('reports the machine stop reason beside the readings', () => {
    const readings = { ...READINGS, load5: 40 }
    const machineStop = { ...readings, reason: 'machine under pressure: load5 40 (limit 28)' }

    const status = machineStopStatus(inputs({ readings, machineStop }))

    expect(status.stopped).toBe(true)
    expect(status.machine).toEqual({ ...readings, stop: 'machine under pressure: load5 40 (limit 28)' })
  })

  it('counts an unreadable events.db, stop file or seat-watchdog.json as a stop and names it', () => {
    const status = machineStopStatus(
      inputs({
        chat: undefined,
        stopFile: () => 'not json',
        ownerStops: () => {
          throw new Error('seat-watchdog.json cannot be read (EACCES)')
        },
      }),
    )

    expect(status.stopped).toBe(true)
    expect(status.errors).toEqual([
      'events.db cannot be read, so broadcast HOLDs are unknown',
      'the stop file is not JSON',
      'seat-watchdog.json: seat-watchdog.json cannot be read (EACCES)',
    ])
  })
})

describe('broadcast HOLDs', () => {
  const nowMs = NOW.getTime()

  it.each([
    'tp-operator HOLD (machine watch): "TRIP 09:54"',
    'tp-operator MACHINE HOLD, from 07:21. The watch tripped',
    'tp-operator: HOLD, all seats, effective now.',
    'BUILD HOLD 16:19: load5 21.08 > 20',
    'tp-ram (successor of tp-ram-1003, teleported): BUILD HOLD from 13:01.',
    'tp-operator: HOLD on NEW dispatch, effective now.',
    'HOLD (tp-operator, memory trip). Mac kalloc 1,003,266',
  ])('opens on %j', body => {
    expect(broadcastHolds([line('op', 5, body)], nowMs)).toHaveLength(1)
  })

  it.each([
    'coord-a: HOLD acked; no spawns from me',
    'platform-coord ACK HOLD 08:5x: no new dispatch',
    'seat-b: HOLD on #187. The repo is public',
    'tp-operator: HOLD dispatch of CC-763 until I confirm placement',
    'tp-operator: owner decision: reboot at 07:30. The HOLD stays until then.',
  ])('does not open on %j, which holds one piece of work or refers to a hold', body => {
    expect(broadcastHolds([line('op', 5, body)], nowMs)).toEqual([])
  })

  it.each([
    'tp-operator HOLD LIFTED at 16:00.',
    'tp-ram-1003: build hold LIFTED at 12:36.',
    'tp-operator: LIFT at NORMAL pace; this lifts HOLD 41c4a804',
    'LIFT (tp-operator, post-reboot). The machine is rebooted',
    'tp-operator: LOAD CLEAR at 22:25.',
    'tp-operator: placement is confirmed and the HOLD is released',
  ])("the sender's %j lifts its HOLD", body => {
    const lines = [line('op', 30, 'op: HOLD (memory trip)'), line('op', 5, body)]

    expect(broadcastHolds(lines, nowMs)).toEqual([])
  })

  it("leaves a HOLD standing when another sender's lift arrives", () => {
    const lines = [line('op', 30, 'op: HOLD (memory trip)'), line('peer', 5, 'peer HOLD LIFTED')]

    expect(broadcastHolds(lines, nowMs).map(h => h.by)).toEqual(['op'])
  })

  it('dates a repeated HOLD from the first one since the last lift', () => {
    const lines = [
      line('op', 90, 'op: HOLD (first)'),
      line('op', 80, 'op HOLD LIFTED'),
      line('op', 30, 'op: HOLD (second)'),
      line('op', 10, 'op: HOLD (still)'),
    ]

    expect(broadcastHolds(lines, nowMs)).toMatchObject([{ since: new Date(at(30)).toISOString() }])
  })

  it('drops a HOLD with no lift once it is older than the cap', () => {
    const old = { ...line('op', 0, 'op: HOLD (lost lift)'), ts: nowMs - BROADCAST_HOLD_MAX_MS - 1 }

    expect(broadcastHolds([old], nowMs)).toEqual([])
  })
})

describe('readHoldMessages', () => {
  const dirs: string[] = []
  afterEach(() => dirs.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })))

  it('returns one row per message since the cut-off, for HOLD and LIFT bodies only', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-operator-stops-'))
    dirs.push(dir)
    const file = path.join(dir, 'events.db')
    const db = new DatabaseSync(file)
    db.exec(
      'CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, kind TEXT, actor TEXT, target TEXT, msg_id TEXT, body TEXT)',
    )
    const insert = db.prepare(
      'INSERT INTO events (ts, kind, actor, target, msg_id, body) VALUES (?, ?, ?, ?, ?, ?)',
    )
    insert.run(1, 'message', 'op', 'a', 'm0', 'op: HOLD (too old)')
    insert.run(5, 'message', 'op', 'a', 'm1', 'op: HOLD (memory)')
    insert.run(5, 'message', 'op', 'b', 'm1', 'op: HOLD (memory)')
    insert.run(6, 'message', 'op', 'a', 'm2', 'merged #1')
    insert.run(7, 'question', 'op', null, 'm3', 'HOLD (not a message)')
    insert.run(8, 'broadcast', 'op', 'a', 'm4', 'op HOLD LIFTED')
    db.close()

    expect(readHoldMessages(file, 2)).toEqual([
      { ts: 5, actor: 'op', msgId: 'm1', body: 'op: HOLD (memory)' },
      { ts: 8, actor: 'op', msgId: 'm4', body: 'op HOLD LIFTED' },
    ])
  })
})

describe('machine status verb', () => {
  it('prints one JSON document under --json', () => {
    const report = machineStatusReport(inputs(), true)

    expect(report.ok).toBe(true)
    expect(JSON.parse(report.lines.join('\n'))).toMatchObject({ stopped: false, holds: [] })
  })
})
