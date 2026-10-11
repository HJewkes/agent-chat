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
    'tp-operator: HOLD. Watch output: "TRIP 12:19: kalloc +112131/h"',
    'tp-operator: HOLD now. Observed 03:21:42: pressure level 4',
    'tp-operator machine watch, SPAWN HOLD at 15:28. kalloc rising',
    'tp-ram-1003: BUILD HOLD is formally on. The sampler read load5 20.77',
    'tp-ram-1003 STOP ALL DISPATCH, 10:05: load5 30.2',
    'STOP ALL 18:13: load5 crossed 28',
    'tp-ram-1003 22:1x: MACHINE STOP is on. Swap is 71% used',
    'tp-operator: LOAD STEP-BACK 22:29 (load5 >= 20)',
    'tp-operator: REBOOT NOTICE. The machine watch tripped at 19:18',
    'tp-ram-1003: REBOOT QUIET STARTS NOW (12:58)',
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
    'coord-t: exception ask under your 08:59 HOLD',
    'coord-t: status check on HOLD 522dd03b (12:19)',
    'tp-operator re 3f69488d: no memory HOLD now',
    'tp-operator: memory WARNING, not a HOLD yet',
    'Status: WAITING at the MACHINE STOP gate',
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

  it.each([
    'coord-t: no LIFT time known',
    'coord-d: back up after the reboot, holding for LIFT',
    'coord-p ack, holding spawns and resumes until CLEAR',
    'coord-d tick: #722 hold RELEASED under rule (a)',
    'coord-t: the restart hold is lifted',
  ])('does not lift on %j, which says a hold still stands or ends another hold', body => {
    const chat: Send[] = [
      ['op', 30, 'op: HOLD (memory trip)'],
      ['coord', 5, body],
    ]

    expect(holdsBy({ chat })).toEqual(['op'])
  })

  it("ends every open hold at any sender's lift, so a relayed HOLD ends with the operator's", () => {
    const chat: Send[] = [
      ['op', 30, 'op: HOLD (memory trip)'],
      ['coord', 29, 'coord: machine HOLD from op (memory trip)'],
    ]
    const relayed = holdsBy({ chat })
    fs.rmSync(eventsDb())

    const lifted = holdsBy({ chat: [...chat, ['op', 5, 'op: LIFT at NORMAL pace']] })

    expect(relayed).toEqual(['op', 'coord'])
    expect(lifted).toEqual([])
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

/**
 * The operator stops and lifts of 2026-10-03 to 10-07 as they were sent (heads only, seat names
 * replaced), in order. Every open must leave a hold standing and every lift must close it; a phrasing
 * the classifier drops shows up here as an open with no hold or a lift with nothing to close.
 */
const LIVE: [body: string, expected: 'open' | 'lift' | 'none'][] = [
  ['tp-ram-1003 STOP ALL DISPATCH, 10:05: load1 38.0, load5 30.2', 'open'],
  ['tp-ram-1003: build hold LIFTED. Two readings under 16, ten minutes apart', 'lift'],
  ['tp-ram-1003: BUILD HOLD is formally on. The sampler read load5 20.77 at 12:11', 'open'],
  ['tp-ram: BUILD HOLD LIFTED 13:21. Sampler load5 readings: 13:11 11.23', 'lift'],
  ['STOP ALL 18:13: load5 crossed 28', 'open'],
  ['coord-t: STOP ALL. load5 has passed 28', 'open'],
  ['tp-ram-1003 18:30: STOP ALL and the build hold are LIFTED. Sampler readings: 18:19:56 at 9.41', 'lift'],
  ["tp-ram-1003 22:1x: MACHINE STOP is on. Swap is 71% used against the owner's 60% rule", 'open'],
  ['tp-ram-1003 22:4x: MACHINE STOP LIFTED. OWNER item 32', 'lift'],
  ['tp-ram-1003: REBOOT QUIET STARTS NOW (12:58). Make no new spawns, merges or pushes', 'open'],
  ['tp-ram-1003: REBOOT QUIET RELEASED 13:39. The owner has not rebooted yet (afk)', 'lift'],
  ['tp-operator machine watch, SPAWN HOLD at 15:28. kalloc.1024 inuse was 61,557', 'open'],
  ['coord-d reading for the hold: kalloc.1024 inuse 68,952 at 15:29', 'none'],
  ['tp-operator HOLD LIFTED at 16:00. kalloc.1024 was 79,114 at 15:41', 'lift'],
  ['tp-operator: HOLD. Watch output: "TRIP 12:19: kalloc +112131/h over 20 min"', 'open'],
  ['coord-t: status check on HOLD 522dd03b (12:19)', 'none'],
  ['tp-operator: the hold stays. Sampler at 13:19: kalloc=1010924', 'none'],
  ['LIFT (tp-operator, post-reboot 14:59). The machine is rebooted', 'lift'],
  ['tp-operator: REBOOT NOTICE. The machine watch tripped at 19:18 (kalloc 695,040)', 'open'],
  ['coord-t: no LIFT time known. Observed: the kalloc watch is running', 'none'],
  ['coord-d: back up after the reboot (watchdog-resumed), holding for LIFT', 'none'],
  ['tp-operator: LIFT at NORMAL pace (reboot reset kalloc). Observed 02:32: kalloc 3,359', 'lift'],
  ['tp-operator: HOLD now. Observed 03:21:42: kern.memorystatus_vm_pressure_level 4', 'open'],
  ['coord-d: machine HOLD from tp-operator (memory pressure level 4, swap nearly full)', 'open'],
  ['tp-operator: LIFT at HALF RATE (as 6316791e: half implementer caps)', 'lift'],
  ['tp-operator: LOAD STEP-BACK 22:29 (load 25.3/21.9/20.5; load5 >= 20)', 'open'],
  ['coord-p ack, holding spawns and resumes until CLEAR', 'none'],
  ['tp-operator: LOAD CLEAR 22:34 (load5 13.5, two readings < 16)', 'lift'],
]

describe('the classifier against live operator phrasings', () => {
  it('opens a hold at every live stop and closes it at every live lift', () => {
    const chat: Send[] = LIVE.map(([body], i) => ['op', LIVE.length - i, body])
    writeChat(chat)

    const holdsAfter = LIVE.map((_, i) => {
      const now = new Date(at(LIVE.length - i) + 1)
      return machineStopStatus(liveStopInputs(now)).holds.length > 0
    })

    const expected = LIVE.reduce<boolean[]>((held, [, kind]) => {
      const before = held.at(-1) ?? false
      return [...held, kind === 'open' ? true : kind === 'lift' ? false : before]
    }, [])
    expect(holdsAfter).toEqual(expected)
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
