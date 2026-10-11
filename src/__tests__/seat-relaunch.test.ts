import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadDoc, readPresence, saveDoc } from '../agents/seats/io.js'
import type { Presence } from '../agents/seats/liveness.js'
import { judgeRelaunch, RELAUNCH_TRY_CAP, type RelaunchInput } from '../agents/seats/relaunch.js'
import { readSeatLog } from '../agents/seats/stops.js'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'

/** CC-463: the seat relaunch rule and its 15-minute dedupe. Every name, time and line is synthetic. */

const SEAT = 'seat-hub'
const MINUTE = 60_000
const DAY = new Date(2026, 9, 2)
const at = (hh: number, mm: number): number => new Date(2026, 9, 2, hh, mm).getTime()
const NOW = at(12, 0)

const dark: Presence = { teleported: false, wokenByWatchdog: false, resumeStarted: false }

const input = (over: Partial<RelaunchInput> = {}): RelaunchInput => ({
  connected: false,
  presence: dark,
  activityAt: at(11, 40),
  hold: undefined,
  relaunchedAt: undefined,
  relaunchTries: undefined,
  nowMs: NOW,
  ...over,
})

/** The journal's verdict passed in as the run passes it: its stop line holds, its newest line is the activity. */
const fromLog = (log: string): Partial<RelaunchInput> => {
  const verdict = readSeatLog(log, DAY)
  return { hold: verdict.stop, activityAt: verdict.activityAt }
}

describe('judgeRelaunch', () => {
  it('relaunches a seat with no live session and no log line for 15 min', () => {
    const verdict = judgeRelaunch(input(fromLog('11:30 dispatched hs-1\n11:45 heartbeat\n')))
    expect(verdict).toEqual({
      relaunch: true,
      reason: 'no log line for 15 min and no live session',
      tries: 1,
    })
  })

  it('relaunches a seat that has never logged a line', () => {
    expect(judgeRelaunch(input({ activityAt: undefined })).relaunch).toBe(true)
  })

  it('leaves a connected seat alone however stale its log', () => {
    expect(judgeRelaunch(input({ connected: true, activityAt: at(6, 0) }))).toEqual({
      relaunch: false,
      reason: 'connected',
    })
  })

  it('leaves a seat alone when events.db cannot be read', () => {
    expect(judgeRelaunch(input({ presence: undefined })).relaunch).toBe(false)
  })

  it('leaves a seat alone whose newest line is under 15 min old', () => {
    const verdict = judgeRelaunch(input(fromLog('11:46 heartbeat\n')))
    expect(verdict).toEqual({ relaunch: false, reason: 'last log line 14 min ago, under 15' })
  })

  it.each([['WRAP for the night'], ['PARKED until the owner returns'], ['BUDGET-PAUSE five_hour 91%']])(
    'refuses a seat whose latest line is "%s"',
    line => {
      const verdict = judgeRelaunch(input(fromLog(`10:00 heartbeat\n10:05 ${line}\n`)))
      expect(verdict).toMatchObject({ relaunch: false, refused: true })
      expect(verdict.reason).toMatch(/^not relaunched: seat logged "(WRAP|PARKED|BUDGET-PAUSE)/)
    },
  )

  it('refuses a seat under any other hold, such as an owner stop', () => {
    const verdict = judgeRelaunch(input({ hold: 'stopped by the owner: travel' }))
    expect(verdict).toMatchObject({ relaunch: false, refused: true })
  })

  it('leaves a seat alone mid-teleport: a handoff in the last 15 min with no register after it', () => {
    const verdict = judgeRelaunch(input({ presence: { ...dark, handoffAt: NOW - 10 * MINUTE } }))
    expect(verdict.relaunch).toBe(false)
    expect(verdict.reason).toMatch(/^teleport in progress/)
  })

  it('relaunches once a handoff is 15 min old with still no register', () => {
    expect(judgeRelaunch(input({ presence: { ...dark, handoffAt: NOW - 15 * MINUTE } })).relaunch).toBe(true)
  })

  it('does not fire twice within 15 min from its own relaunch mark', () => {
    const verdict = judgeRelaunch(input({ relaunchedAt: NOW - 14 * MINUTE, relaunchTries: 1 }))
    expect(verdict).toEqual({ relaunch: false, reason: 'launched 14 min ago, under 15' })
  })

  it('does not fire within 15 min of a launch recorded in events.db', () => {
    const verdict = judgeRelaunch(input({ presence: { ...dark, lastLaunchAt: NOW - 5 * MINUTE } }))
    expect(verdict).toEqual({ relaunch: false, reason: 'launched 5 min ago, under 15' })
  })

  it('fires again 15 min after its last relaunch, counting the try', () => {
    const verdict = judgeRelaunch(input({ relaunchedAt: NOW - 15 * MINUTE, relaunchTries: 1 }))
    expect(verdict).toMatchObject({ relaunch: true, tries: 2 })
    expect(verdict.reason).toMatch(/try 2 of 8$/)
  })

  it(`refuses after ${RELAUNCH_TRY_CAP} relaunches with no register`, () => {
    const verdict = judgeRelaunch(input({ relaunchedAt: NOW - 20 * MINUTE, relaunchTries: RELAUNCH_TRY_CAP }))
    expect(verdict).toEqual({
      relaunch: false,
      refused: true,
      reason: `not relaunched: ${RELAUNCH_TRY_CAP} relaunches failed this dark stretch`,
    })
  })

  it('starts a new dark stretch once the seat registered after its last relaunch', () => {
    const presence = { ...dark, registeredAt: NOW - 18 * MINUTE }
    const verdict = judgeRelaunch(
      input({ presence, relaunchedAt: NOW - 20 * MINUTE, relaunchTries: RELAUNCH_TRY_CAP }),
    )
    expect(verdict).toMatchObject({ relaunch: true, tries: 1 })
  })
})

describe('the relaunch marks on disk', () => {
  const T0 = at(11, 0)
  let dir: string
  let core: BrokerCore

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-seat-relaunch-'))
    core = new BrokerCore(() => undefined, {
      events: new EventLog(path.join(dir, 'events.db')),
      registry: new Registry<Conn>(),
    })
  })

  afterEach(() => {
    core.close()
    vi.useRealTimers()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const presence = (): Presence => readPresence(path.join(dir, 'events.db'), SEAT)
  const judgeAt = (nowMs: number, over: Partial<RelaunchInput> = {}) =>
    judgeRelaunch(input({ presence: presence(), activityAt: undefined, nowMs, ...over }))

  it('keeps relaunchedAt across a save and load, so the next run skips', () => {
    const file = path.join(dir, 'seat-watchdog.json')
    saveDoc(
      { seats: { [SEAT]: { idleRuns: 0, at: T0, relaunchedAt: T0, relaunchTries: 1 } }, pools: {} },
      file,
    )
    const record = loadDoc(file).seats[SEAT]

    const verdict = judgeAt(T0 + 5 * MINUTE, { ...record })

    expect(verdict.relaunch).toBe(false)
  })

  it('skips from an agent_resumed row in events.db, and fires once it is 15 min old', () => {
    core.append({ kind: 'agent_resumed', actor: 'human', target: SEAT })

    expect(presence().lastLaunchAt).toBe(T0)
    expect(judgeAt(T0 + 14 * MINUTE).relaunch).toBe(false)
    expect(judgeAt(T0 + 15 * MINUTE).relaunch).toBe(true)
  })

  it('reads a spawn as a launch but not an adopted session', () => {
    core.append({ kind: 'agent_spawned', actor: 'human', target: SEAT, meta: { origin: 'adopted' } })
    expect(presence().lastLaunchAt).toBeUndefined()

    core.append({ kind: 'agent_spawned', actor: 'coord', target: SEAT, meta: { name: SEAT } })
    expect(presence().lastLaunchAt).toBe(T0)
  })

  it('reads a handoff with no register after it as a teleport in progress, and a register as its end', () => {
    core.append({ kind: 'agent_handoff', actor: SEAT, body: 'handoff' })
    expect(judgeAt(T0 + 5 * MINUTE).reason).toMatch(/^teleport in progress/)

    vi.setSystemTime(T0 + MINUTE)
    core.append({ kind: 'registered', actor: SEAT })
    expect(presence()).toMatchObject({ registeredAt: T0 + MINUTE })
    expect(presence().handoffAt).toBeUndefined()
  })
})
