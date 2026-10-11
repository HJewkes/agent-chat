import fs from 'node:fs'
import { createRequire } from 'node:module'
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { watchdogStatePath } from '../agents/seats/io.js'
import {
  BROADCAST_HOLD_MAX_MS,
  machineStopStatus,
  type MachineStopStatus,
  type StopInputs,
} from '../agents/seats/operator-stops.js'
import { liveStopInputs, machineStatusReport } from '../cli/verbs/machine.js'
import { home, operatorHoldPath } from '../paths.js'

/**
 * Every hold, lift, stop-file and owner-stop case runs through the live readers (`liveStopInputs`,
 * so `readChatMessages`, `readTextIfPresent` and `readDoc`) against a temp events.db, stop file and
 * seat-watchdog.json under the suite's AGENT_CHAT_HOME. A reader that drops a row the parser would
 * accept, or reads an error as a missing file, fails here.
 */

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => DatabaseSyncType
}

const NOW = new Date('2026-10-06T13:00:00Z')
const MIN = 60_000
const at = (minutesAgo: number): number => NOW.getTime() - minutesAgo * MIN

/** One send: `[actor, minutesAgo, body]`, optionally its msg id and the recipients it fanned out to. */
type Send = [actor: string, minutesAgo: number, body: string, msgId?: string, recipients?: string[]]

interface World {
  /** Undefined leaves events.db missing, which the reader cannot open. */
  chat?: Send[]
  /** Text of the stop file, or 'dir' to put a directory at its path. */
  stopFile?: string
  /** The seat-watchdog.json document, or 'dir' to put a directory at its path. */
  watchdog?: object | 'dir'
}

const eventsDb = (): string => path.join(home(), 'events.db')

function writeChat(sends: Send[]): void {
  const db = new DatabaseSync(eventsDb())
  db.exec(
    'CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, kind TEXT, actor TEXT, target TEXT, msg_id TEXT, body TEXT)',
  )
  const insert = db.prepare(
    'INSERT INTO events (ts, kind, actor, target, msg_id, body) VALUES (?, ?, ?, ?, ?, ?)',
  )
  sends.forEach(([actor, minutesAgo, body, msgId, recipients = ['peer']], i) =>
    recipients.forEach(to => insert.run(at(minutesAgo), 'message', actor, to, msgId ?? `m${i}`, body)),
  )
  db.close()
}

function writeAt(file: string, content: string | 'dir'): void {
  if (content === 'dir') fs.mkdirSync(file, { recursive: true })
  else fs.writeFileSync(file, content)
}

function status(world: World): MachineStopStatus {
  if (world.chat !== undefined) writeChat(world.chat)
  if (world.stopFile !== undefined) writeAt(operatorHoldPath(), world.stopFile)
  if (world.watchdog !== undefined)
    writeAt(watchdogStatePath(), world.watchdog === 'dir' ? 'dir' : JSON.stringify(world.watchdog))
  return machineStopStatus(liveStopInputs(NOW))
}

const holdsBy = (world: World): string[] => status(world).holds.map(h => h.by)

afterEach(() => {
  for (const file of [eventsDb(), operatorHoldPath(), watchdogStatePath()])
    fs.rmSync(file, { recursive: true, force: true })
})

describe('machine status from the live readers', () => {
  it('reports no hold, no owner stop and no error on a quiet machine', () => {
    const quiet = status({ chat: [['peer', 5, 'merged #1']] })

    expect(quiet).toMatchObject({ holds: [], ownerStops: [], errors: [] })
    expect(quiet.stopped).toBe(quiet.machine.stop !== null)
  })

  it('reports a broadcast HOLD once with who, since and reason, though it fanned out to three seats', () => {
    const body = 'tp-operator: HOLD (forecast trip). kalloc rising'

    const held = status({ chat: [['tp-operator', 55, body, '41c4a804', ['a', 'b', 'c']]] })

    expect(held.stopped).toBe(true)
    expect(held.holds).toEqual([
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

    const held = status({ chat: [], stopFile: file })

    expect(held.stopped).toBe(true)
    expect(held.holds).toEqual([
      { kind: 'file', by: 'owner', since: '2026-10-06T12:00:00Z', reason: 'reboot' },
    ])
  })

  it('lists owner stops without counting them as a machine stop, since each holds one seat', () => {
    const stopped = status({ chat: [], watchdog: { stopped: { 'design-coord': 'parked, item 201' } } })

    expect(stopped.ownerStops).toEqual([{ seat: 'design-coord', reason: 'parked, item 201' }])
    expect(stopped.holds).toEqual([])
    expect(stopped.errors).toEqual([])
  })

  it.each([
    ['a missing events.db', {}, 'events.db cannot be read, so broadcast HOLDs are unknown'],
    ['a directory at the stop file path', { chat: [], stopFile: 'dir' }, 'stop file: EISDIR'],
    ['a stop file that is not JSON', { chat: [], stopFile: 'not json' }, 'the stop file is not JSON'],
    [
      'a stop file whose since is not a time',
      { chat: [], stopFile: JSON.stringify({ by: 'owner', since: 'soon', reason: 'reboot' }) },
      'the stop file since is not an ISO time',
    ],
    ['a directory at seat-watchdog.json', { chat: [], watchdog: 'dir' as const }, 'seat-watchdog.json: '],
  ])('counts %s as a stop and names it', (_name, world: World, error) => {
    const unread = status(world)

    expect(unread.stopped).toBe(true)
    expect(unread.errors).toHaveLength(1)
    expect(unread.errors[0]).toContain(error)
  })

  it('reads a missing stop file and seat-watchdog.json as no hold and no owner stop', () => {
    expect(status({ chat: [] })).toMatchObject({ holds: [], ownerStops: [], errors: [] })
  })
})

describe('broadcast HOLDs through the live reader', () => {
  it.each([
    'tp-operator HOLD (machine watch): "TRIP 09:54"',
    'tp-operator MACHINE HOLD, from 07:21. The watch tripped',
    'tp-operator: HOLD, all seats, effective now.',
    'BUILD HOLD 16:19: load5 21.08 > 20',
    'tp-ram (successor of tp-ram-1003, teleported): BUILD HOLD from 13:01.',
    'tp-operator: HOLD on NEW dispatch, effective now.',
    'HOLD (tp-operator, memory trip). Mac kalloc 1,003,266',
    'op: HOLD (memory). Yesterday the hold lifted too early',
  ])('opens on %j', body => {
    expect(holdsBy({ chat: [['op', 5, body]] })).toEqual(['op'])
  })

  it.each([
    'coord-a: HOLD acked; no spawns from me',
    'platform-coord ACK HOLD 08:5x: no new dispatch',
    'ACK HOLD 08:50: no new dispatch',
    'ACK HOLD (tp-operator): standing down',
    'Re HOLD: which seats does it cover?',
    'seat-b: HOLD on #187. The repo is public',
    'tp-operator: HOLD dispatch of CC-763 until I confirm placement',
    'tp-operator: owner decision: reboot at 07:30. The HOLD stays until then.',
  ])('does not open on %j, which holds one piece of work or refers to a hold', body => {
    expect(holdsBy({ chat: [['op', 5, body]] })).toEqual([])
  })

  it.each([
    'tp-operator HOLD LIFTED at 16:00.',
    'tp-ram-1003: build hold LIFTED at 12:36.',
    'tp-operator: LIFT at NORMAL pace; this lifts HOLD 41c4a804',
    'LIFT (tp-operator, post-reboot). The machine is rebooted',
    'tp-operator: LOAD CLEAR at 22:25.',
    'tp-operator: ALL-CLEAR, resume dispatch',
    'tp-operator: placement is confirmed and the HOLD is released',
  ])("the sender's %j lifts its HOLD", body => {
    expect(
      holdsBy({
        chat: [
          ['op', 30, 'op: HOLD (memory trip)'],
          ['op', 5, body],
        ],
      }),
    ).toEqual([])
  })

  it("leaves a HOLD standing when another sender's lift arrives", () => {
    const chat: Send[] = [
      ['op', 30, 'op: HOLD (memory trip)'],
      ['peer', 5, 'peer HOLD LIFTED'],
    ]

    expect(holdsBy({ chat })).toEqual(['op'])
  })

  it('dates a repeated HOLD from the first one since the last lift', () => {
    const chat: Send[] = [
      ['op', 90, 'op: HOLD (first)'],
      ['op', 80, 'op HOLD LIFTED'],
      ['op', 30, 'op: HOLD (second)'],
      ['op', 10, 'op: HOLD (still)'],
    ]

    expect(status({ chat }).holds).toMatchObject([{ since: new Date(at(30)).toISOString() }])
  })

  it('drops a HOLD with no lift once it is older than the cap', () => {
    const capMinutes = BROADCAST_HOLD_MAX_MS / MIN

    expect(holdsBy({ chat: [['op', capMinutes + 1, 'op: HOLD (lost lift)']] })).toEqual([])
  })
})

describe('machine stop readings and output', () => {
  const inputs = (over: Partial<StopInputs>): StopInputs => ({
    now: NOW,
    chat: [],
    stopFile: () => undefined,
    ownerStops: () => ({}),
    readings: { memoryFreePercent: 80, load5: 4, swapUsedPercent: 10, pressureLevel: 1 },
    machineStop: null,
    ...over,
  })

  it('reports the machine stop reason beside the readings', () => {
    const readings = { memoryFreePercent: 80, load5: 40, swapUsedPercent: 10, pressureLevel: 1 }
    const machineStop = { ...readings, reason: 'machine under pressure: load5 40 (limit 28)' }

    const stopped = machineStopStatus(inputs({ readings, machineStop }))

    expect(stopped.stopped).toBe(true)
    expect(stopped.machine).toEqual({ ...readings, stop: 'machine under pressure: load5 40 (limit 28)' })
  })

  it('reports a clear machine with every list empty and the readings', () => {
    const report = machineStatusReport(inputs({}), true)

    expect(JSON.parse(report.lines.join('\n'))).toEqual({
      at: NOW.toISOString(),
      stopped: false,
      holds: [],
      ownerStops: [],
      machine: { memoryFreePercent: 80, load5: 4, swapUsedPercent: 10, pressureLevel: 1, stop: null },
      errors: [],
    })
  })
})
