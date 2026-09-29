import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { AgentEventRow } from '../broker/event-store.js'
import { parsePools } from '../agents/seats/charter.js'
import {
  agentsAt,
  parseLogReadings,
  parseReadingFlag,
  readingAt,
  replay,
  runTimes,
  type TimedReading,
} from '../agents/seats/replay.js'

const here = path.dirname(fileURLToPath(import.meta.url))

/** Every lifecycle row of an agent hjewkes-surplus spawned on 2026-09-29 before noon UTC, from events.db. */
const ROWS = JSON.parse(
  fs.readFileSync(path.join(here, 'fixtures', 'watchdog-2026-09-29.json'), 'utf8'),
) as AgentEventRow[]

/** The coordinator's heartbeat appends (transcript 02ce2ba4) and the status cache's five_hour resets_at. */
const READINGS: TimedReading[] = [
  parseReadingFlag('2026-09-29T05:53:53Z=39/19'),
  parseReadingFlag('2026-09-29T06:24:04Z=41/19'),
  parseReadingFlag('2026-09-29T07:10:00Z=0/'),
]

const CHARTER = `---
pools:
  claude:  {config_dir: /Users/o/.claude, human_uses: true, reserve_seven_day: 35, ceiling_five_hour: 70}
---
`

const hhmm = (at: number): string => new Date(at).toISOString().slice(11, 16)

describe('replay of 2026-09-29, the 3h52m idle night', () => {
  const rows = replay(
    {
      seat: { name: 'hjewkes-surplus', prefix: 'hs', pool: 'claude' },
      pool: parsePools(CHARTER).get('claude'),
      events: ROWS,
      readings: READINGS,
      eligible: 39,
    },
    runTimes('2026-09-29'),
  )
  const fires = rows.filter(r => r.fire).map(r => hhmm(r.at))

  it('fires at 06:23Z and again at 06:53Z, once the last implementer has exited', () => {
    expect(fires.slice(0, 2)).toEqual(['06:23', '06:53'])
  })

  it('keeps firing every 30 minutes through the idle stretch, and never while implementers run', () => {
    expect(fires).toEqual([
      '06:23',
      '06:53',
      '07:23',
      '07:53',
      '08:23',
      '08:53',
      '09:23',
      '09:53',
      '10:23',
      '10:53',
    ])
    expect(rows.filter(r => r.fire).every(r => r.implementers.length === 0)).toBe(true)
  })

  it('sees the night shift running implementers before the idle began', () => {
    const at0553 = rows.find(r => hhmm(r.at) === '05:53')
    expect(at0553?.implementers).toEqual(['tp457-titan-nits'])
  })
})

describe('agentsAt', () => {
  const row = (over: Partial<AgentEventRow>): AgentEventRow => ({
    kind: 'agent_attached',
    ts: 0,
    actor: 'x',
    target: null,
    msgId: null,
    ref: null,
    body: null,
    meta: {},
    ...over,
  })

  it('keys by agent id, so retiring an old generation leaves a reused name running', () => {
    const rows = [
      row({
        kind: 'agent_spawned',
        ts: 1,
        actor: 'seat',
        target: 'w',
        msgId: 'a1',
        meta: { profile: 'implementer' },
      }),
      row({
        kind: 'agent_spawned',
        ts: 2,
        actor: 'seat',
        target: 'w',
        msgId: 'a2',
        meta: { profile: 'implementer' },
      }),
      row({ kind: 'agent_attached', ts: 3, actor: 'w', ref: 'a2' }),
      row({ kind: 'agent_retired', ts: 4, actor: 'human', target: 'w', ref: 'a1' }),
    ]
    expect(agentsAt(rows, 5)).toEqual([
      { name: 'w', profile: 'implementer', state: 'live', spawnedBy: 'seat' },
    ])
  })

  it('ignores rows after the run time', () => {
    const rows = [
      row({
        kind: 'agent_spawned',
        ts: 1,
        actor: 'seat',
        target: 'w',
        msgId: 'a1',
        meta: { profile: 'implementer' },
      }),
      row({ kind: 'agent_exited', ts: 10, actor: 'w', ref: 'a1' }),
    ]
    expect(agentsAt(rows, 5)[0]?.state).toBe('spawning')
  })
})

describe('readings', () => {
  it('carries each window forward from its own latest reading', () => {
    const at = Date.parse('2026-09-29T07:20:00Z')
    expect(readingAt(READINGS, at)).toEqual({ ageSeconds: 600, fiveHour: 0, sevenDay: 19 })
  })

  it('knows nothing before the first reading', () => {
    expect(readingAt(READINGS, Date.parse('2026-09-29T05:00:00Z'))).toBeUndefined()
  })

  it('refuses a malformed --reading', () => {
    expect(() => parseReadingFlag('06:23=41/19')).toThrow(/ISO time/)
  })

  it('reads both windows from a timed seat log line', () => {
    const log =
      '06:23 tick: 0 implementers; five_hour 41%, seven_day 19%\nno time five_hour 1%, seven_day 2%\n'
    const [reading] = parseLogReadings(log, '2026-09-29')
    expect(reading).toMatchObject({ fiveHour: 41, sevenDay: 19 })
    expect(new Date(reading?.at ?? 0).getHours()).toBe(6)
  })

  it('schedules four runs an hour at the launchd minutes', () => {
    const times = runTimes('2026-09-29').map(hhmm)
    expect(times).toHaveLength(96)
    expect(times.slice(0, 5)).toEqual(['00:08', '00:23', '00:38', '00:53', '01:08'])
  })
})
