import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BudgetRead } from '../agents/budget.js'
import {
  appendSeatLog,
  isWatchedSeat,
  loadDoc,
  readAgentEvents,
  readOwnerMessages,
  saveDoc,
  type WatchdogDoc,
} from '../agents/seats/io.js'
import { DARK_AFTER_MS, RESUME_MESSAGE, judgeLiveness, type Presence } from '../agents/seats/liveness.js'
import { acquireRunLock } from '../agents/seats/lock.js'
import { runWatchdog, type Roster, type WatchdogDeps } from '../agents/seats/run.js'
import type { OwnerMessage } from '../agents/seats/stops.js'
import type { BrokerClient } from '../client/broker-client.js'
import { watchdogInstall, wakeSeat } from '../cli/verbs/seats.js'
import type { Launchctl } from '../mirror/launchd.js'
import { renderWatchdogPlist } from '../mirror/plist.js'

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => DatabaseSyncType
}

const CHARTER = `---
owner_seat: seat-a
seats: [seat-a, unconfigured, ../escape]
pools:
  claude:  {config_dir: /Users/o/.claude, human_uses: true, reserve_seven_day: 35, ceiling_five_hour: 70, per_day_points: 13}
---
`
const SEAT = '---\nprefix: sa\npool: claude\nspend:\n  per_run_points: 6\n  per_day_points: 10\n---\n'

const budget = (fiveHour: number, sevenDay = 19): BudgetRead => ({
  found: true,
  path: '/x',
  age_seconds: 5,
  stale: false,
  budget: {
    session_id: 's',
    written_at: 0,
    context: { exceeds_200k: false },
    cost: {},
    rate_limits: { five_hour: { used_pct: fiveHour }, seven_day: { used_pct: sevenDay } },
  },
})

interface Harness {
  deps: WatchdogDeps
  wakes: { seat: string; message: string; connected: boolean }[]
  logs: string[]
  doc: WatchdogDoc
  /** The seat's own log for today, as `HH:MM text` lines. */
  seatLog: string
  /** The seat's log for the day before. */
  priorLog: string
  fiveHour: number
  sevenDay: number
  ownerMessages: OwnerMessage[]
  /** What events.db says about the seat's presence; undefined reads as unreadable. */
  presence: Presence | undefined
  /** What the next wake or resume answers. */
  wakeResult: { ok: boolean; detail: string }
  now: () => number
  tick: () => void
}

const emptyDoc = (): WatchdogDoc => ({ seats: {}, pools: {}, stopped: {} })

function harness(roster: Roster, fiveHour = 41, start = new Date(2026, 8, 29, 8, 38)): Harness {
  let now = start.getTime()
  const h: Harness = {
    wakes: [],
    logs: [],
    doc: emptyDoc(),
    seatLog: '',
    priorLog: '',
    fiveHour,
    sevenDay: 19,
    ownerMessages: [],
    presence: { teleported: false, wokenByWatchdog: false, resumeStarted: false },
    wakeResult: { ok: true, detail: 'message m1' },
    now: () => now,
    tick: () => void (now += 15 * 60_000),
    deps: {
      now: () => new Date(now),
      readCharter: () => CHARTER,
      readSeatFile: seat => (seat === 'seat-a' ? SEAT : undefined),
      readSeatLog: (_seat, at) => (at.getDate() === new Date(now).getDate() ? h.seatLog : h.priorLog),
      readBudget: () => budget(h.fiveHour, h.sevenDay),
      ownerMessages: () => h.ownerMessages,
      roster: async () => roster,
      presence: () => h.presence,
      eligible: () => ({ count: 7, skipped: 0 }),
      loadDoc: () => structuredClone(h.doc),
      saveDoc: doc => void (h.doc = { ...doc, stopped: h.doc.stopped }),
      wake: async (seat, message, connected) => {
        h.wakes.push({ seat, message, connected })
        return h.wakeResult
      },
      appendLog: (seat, _at, text) => void h.logs.push(`${seat}: ${text}`),
      lock: () => ({ held: true, release: () => undefined }),
    },
  }
  return h
}

const IDLE: Roster = { agents: [], connected: ['seat-a'] }

const ONE = { seats: ['seat-a'], dryRun: false }

/** `count` watchdog runs 15 minutes apart; returns how many woke the seat. */
async function runs(h: Harness, count: number, before?: (i: number) => void): Promise<number> {
  const start = h.wakes.length
  for (let i = 0; i < count; i++) {
    before?.(i)
    await runWatchdog(h.deps, ONE)
    h.tick()
  }
  return h.wakes.length - start
}

const hhmm = (ms: number): string => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const GAP_LINE =
  "pool claude: no seven_day reading at or before 07:00, so the day's spend counts from the first sample"

describe('runWatchdog', () => {
  it('wakes a connected seat with the Discovery message on the second idle run, and logs it', async () => {
    const h = harness(IDLE)
    const first = await runWatchdog(h.deps, { seats: ['seat-a'], dryRun: false })
    h.tick()
    const second = await runWatchdog(h.deps, { seats: ['seat-a'], dryRun: false })
    expect(first).toEqual([GAP_LINE])
    expect(h.wakes).toEqual([
      { seat: 'seat-a', message: 'Watchdog: 0 implementers, run Discovery', connected: true },
    ])
    expect(h.logs).toHaveLength(1)
    expect(h.logs[0]).toMatch(/^seat-a: Watchdog: 0 implementers, budget open .*7 eligible; woke seat-a/)
    expect(second).toHaveLength(1)
  })

  it('resumes a seat that has no connected session', async () => {
    const h = harness({ agents: [], connected: [] })
    await runWatchdog(h.deps, { seats: ['seat-a'], dryRun: false })
    h.tick()
    await runWatchdog(h.deps, { seats: ['seat-a'], dryRun: false })
    expect(h.wakes[0]?.connected).toBe(false)
  })

  it('is silent while an implementer runs: no wake, no log line, only the one-time gap line', async () => {
    const busy: Roster = {
      agents: [{ name: 'sa-x-1', profile: 'implementer', state: 'live', spawnedBy: 'seat-a' }],
      connected: [],
    }
    const h = harness(busy)
    const out = [
      ...(await runWatchdog(h.deps, { seats: ['seat-a'], dryRun: false })),
      ...(h.tick(), await runWatchdog(h.deps, { seats: ['seat-a'], dryRun: false })),
    ]
    expect([out, h.wakes, h.logs]).toEqual([[GAP_LINE], [], []])
    expect(h.doc.seats['seat-a']?.idleRuns).toBe(0)
  })

  it('holds a seat over the five-hour ceiling and logs the BUDGET-PAUSE once, not every run', async () => {
    const h = harness(IDLE, 70)
    expect(await runs(h, 4)).toBe(0)
    expect(h.logs).toEqual([
      'seat-a: Watchdog: BUDGET-PAUSE pool claude: five_hour 70% at or above ceiling 70%',
    ])
    expect(h.doc.seats['seat-a']?.budgetPaused).toBe(true)
  })

  it('releases a held seat once its pool reopens, logging the change once, and wakes it', async () => {
    const h = harness(IDLE, 70)
    await runs(h, 2)
    h.fiveHour = 41
    expect(await runs(h, 3)).toBe(1)
    expect(h.logs.filter(l => l.includes('budget open again'))).toEqual([
      'seat-a: Watchdog: budget open again: pool claude: five_hour 41% vs ceiling 70%, seven_day 19% vs line 65%',
    ])
    expect(h.logs.filter(l => l.includes('BUDGET-PAUSE'))).toHaveLength(1)
  })

  it('logs nothing for an open pool and records nothing under --dry-run', async () => {
    const open = harness({ agents: [], connected: [] }, 41)
    open.deps.eligible = () => ({ count: 0, skipped: 0 })
    await runs(open, 3)
    expect(open.logs).toEqual([])
    const held = harness(IDLE, 70)
    await runWatchdog(held.deps, { ...ONE, dryRun: true })
    expect([held.logs, held.doc.seats]).toEqual([[], {}])
  })

  it('under --dry-run reports every charter seat and wakes, logs and saves nothing', async () => {
    const h = harness(IDLE)
    h.doc.seats = { 'seat-a': { idleRuns: 1, at: h.now() - 8 * 60_000 } }
    const out = await runWatchdog(h.deps, { dryRun: true })
    expect(out[0]).toMatch(/^seat-a: WOULD FIRE: 0 implementers/)
    expect(out[1]).toMatch(/^unconfigured: skipped, seats\/unconfigured.md has no prefix or pool/)
    expect(out[2]).toBe('../escape: skipped, not a seat name')
    expect(h.wakes).toEqual([])
    expect(h.logs).toEqual([])
    expect(h.doc.seats['seat-a']?.idleRuns).toBe(1)
  })

  it('wakes at most twice through a long idle stretch with no implementer appearing', async () => {
    const h = harness(IDLE)
    expect(await runs(h, 16)).toBe(2)
    const out = await runWatchdog(h.deps, { ...ONE, dryRun: true })
    expect(out[0]).toMatch(/skip: fire cap: 2 wake/)
  })

  it('stays capped after the seat logs a line, and wakes again once an implementer has run', async () => {
    const h = harness(IDLE)
    await runs(h, 6)
    h.seatLog = `${hhmm(h.now())} dispatch refused: no worktree slot\n`
    expect(await runs(h, 8)).toBe(0)
    const busy: Roster = {
      agents: [{ name: 'sa-x-1', profile: 'implementer', state: 'live', spawnedBy: 'seat-a' }],
      connected: [],
    }
    await runWatchdog({ ...h.deps, roster: async () => busy }, ONE)
    h.tick()
    expect(await runs(h, 2)).toBe(1)
  })

  it('never wakes a seat whose newest line is last night, within two heartbeats', async () => {
    const h = harness(IDLE, 41, new Date(2026, 8, 29, 0, 8))
    h.priorLog = '23:47 heartbeat: 0 implementers, nothing dispatchable\n'
    expect(await runs(h, 2)).toBe(0)
  })

  it('never wakes a seat the owner stopped in seat-watchdog.json', async () => {
    const h = harness(IDLE)
    h.doc.stopped = { 'seat-a': 'away for the weekend' }
    expect(await runs(h, 4)).toBe(0)
    const out = await runWatchdog(h.deps, { ...ONE, dryRun: true })
    expect(out[0]).toBe('seat-a: skip: held: stopped by the owner: away for the weekend')
  })

  it('never wakes a seat whose latest log line is BUDGET-PAUSE', async () => {
    const h = harness(IDLE)
    h.seatLog = '08:30 BUDGET-PAUSE five_hour 71%, seven_day 30%\n'
    expect(await runs(h, 4)).toBe(0)
  })

  it('never wakes a seat once its pool has spent the per_day_points stop', async () => {
    const h = harness(IDLE)
    h.doc.pools = { claude: { since: h.now() - 3_600_000, last: 19, spent: 9 } }
    h.sevenDay = 20
    expect(await runs(h, 4)).toBe(0)
    expect(h.doc.pools.claude?.spent).toBe(10)
    expect(h.doc.seats['seat-a']?.run?.spent).toBe(0)
    const out = await runWatchdog(h.deps, { ...ONE, dryRun: true })
    expect(out[0]).toMatch(
      /budget closed: BUDGET-PAUSE pool claude: day spend 10 points since 07:00 at or above the seat's per_day_points 10$/,
    )
  })

  it('holds a seat at its per_run_points stop even with the day cap open', async () => {
    const h = harness(IDLE)
    h.doc.seats = {
      'seat-a': {
        idleRuns: 1,
        at: h.now() - 15 * 60_000,
        run: { since: h.now() - 3_600_000, last: 19, spent: 6 },
      },
    }
    const out = await runWatchdog(h.deps, { ...ONE, dryRun: true })
    expect(out[0]).toMatch(
      /BUDGET-PAUSE pool claude: run spend 6 points at or above the seat's per_run_points 6$/,
    )
  })

  it('never wakes any seat inside an open restart window', async () => {
    const h = harness(IDLE)
    h.ownerMessages = [{ ts: h.now() - 5 * 60_000, body: 'seat-a: restart at 08:45' }]
    expect(await runs(h, 3)).toBe(0)
    h.ownerMessages.push({ ts: h.now(), body: 'seat-a: restart done' })
    expect(await runs(h, 2)).toBe(1)
  })

  it('holds every seat when events.db cannot be read, since a restart window cannot be ruled out', async () => {
    const h = harness(IDLE)
    h.deps.ownerMessages = () => undefined
    expect(await runs(h, 3)).toBe(0)
    const out = await runWatchdog(h.deps, { ...ONE, dryRun: true })
    expect(out[0]).toBe('seat-a: skip: held: events.db unreadable, so a restart window cannot be ruled out')
  })
})

describe('seat liveness (CC-320)', () => {
  const DARK: Roster = { agents: [], connected: [] }
  const LIVE: Presence = { teleported: false, wokenByWatchdog: false, resumeStarted: false }
  const minutesAgo = (h: Harness, minutes: number): number => h.now() - minutes * 60_000
  const dark = (h: Harness, minutes: number, extra: Partial<Presence> = {}): void => {
    h.presence = { ...LIVE, darkSince: minutesAgo(h, minutes), ...extra }
  }

  it('resumes a seat deregistered over five minutes with no teleport, and logs one line', async () => {
    const h = harness(DARK)
    dark(h, 6)
    const out = await runWatchdog(h.deps, ONE)
    expect(h.wakes).toEqual([{ seat: 'seat-a', message: RESUME_MESSAGE, connected: false }])
    expect(h.logs).toHaveLength(1)
    expect(h.logs[0]).toMatch(
      /^seat-a: Watchdog: dark 6 min since \d\d:\d\dZ with no teleport; resumed seat-a/,
    )
    expect(out.filter(line => line !== GAP_LINE)).toEqual([h.logs[0]])
  })

  it('does not resume again on later sweeps of the same dark episode, by either path', async () => {
    const h = harness(DARK)
    dark(h, 6)
    expect(await runs(h, 5)).toBe(1)
    expect(h.logs).toHaveLength(1)
  })

  it('resumes once through the synthetic 47-minute dark stretch that went unnoticed', async () => {
    const h = harness(DARK, 41, new Date(2026, 8, 29, 14, 53))
    const since = new Date(2026, 8, 29, 14, 46).getTime()
    h.presence = { ...LIVE, darkSince: since }
    // Sweeps at 14:53, 15:08 and 15:23; the owner found the seat dark at 15:33.
    expect(await runs(h, 3)).toBe(1)
    expect(h.logs).toHaveLength(1)
    expect(h.logs[0]).toContain('dark 7 min since')
  })

  it('never resumes a seat that registers again inside five minutes', async () => {
    const h = harness(DARK)
    dark(h, 4)
    await runWatchdog(h.deps, ONE)
    h.presence = LIVE
    h.tick()
    await runWatchdog(h.deps, ONE)
    expect(h.wakes.filter(wake => wake.message === RESUME_MESSAGE)).toEqual([])
  })

  it('does not resume a seat that left by teleport', async () => {
    const h = harness(DARK)
    dark(h, 30, { teleported: true })
    await runWatchdog(h.deps, ONE)
    expect(h.wakes).toEqual([])
    const out = await runWatchdog(h.deps, { ...ONE, dryRun: true })
    expect(out[0]).not.toContain('WOULD RESUME')
  })

  it('does not resume a seat the owner stopped in seat-watchdog.json', async () => {
    const h = harness(DARK)
    h.doc.stopped = { 'seat-a': 'shut down on purpose' }
    dark(h, 30)
    expect(await runs(h, 3)).toBe(0)
  })

  it('does not resume a seat the owner took off the charter list', async () => {
    const h = harness(DARK)
    h.deps.readCharter = () => CHARTER.replace('seats: [seat-a, ', 'seats: [')
    dark(h, 30)
    for (let i = 0; i < 3; i++) await runWatchdog(h.deps, { dryRun: false })
    expect(h.wakes).toEqual([])
  })

  it('does not resume a seat whose own log says it parked', async () => {
    const h = harness(DARK)
    h.seatLog = '08:30 PARKED handoff written, waiting for the owner\n'
    dark(h, 30)
    expect(await runs(h, 3)).toBe(0)
  })

  it('retries a refused resume on the next run, logs each try, and stops once one is accepted', async () => {
    const h = harness(DARK)
    h.wakeResult = { ok: false, detail: 'no free agent slots (4/4)' }
    dark(h, 6)
    expect(await runs(h, 2)).toBe(2)
    h.wakeResult = { ok: true, detail: 'resumed' }
    expect(await runs(h, 3)).toBe(1)
    expect(h.logs).toHaveLength(3)
    expect(h.logs[0]).toContain('resume FAILED seat-a (no free agent slots (4/4)); will retry next run')
    expect(h.logs[1]).toMatch(/try 2 of 8 after a failed resume; resume FAILED seat-a/)
    expect(h.logs[2]).toMatch(/dark 36 min since \d\d:\d\dZ with no teleport, try 3 of 8 .*; resumed seat-a/)
  })

  it('retries a resume that threw, having marked the episode before the call', async () => {
    const h = harness(DARK)
    dark(h, 6)
    const since = h.presence?.darkSince
    const wake = h.deps.wake
    h.deps.wake = async seat => {
      h.wakes.push({ seat, message: RESUME_MESSAGE, connected: false })
      expect(h.doc.seats['seat-a']).toMatchObject({ resumedDark: since, resumeRetry: 1 })
      throw new Error('broker went away')
    }
    await runWatchdog(h.deps, ONE)
    h.deps.wake = wake
    h.tick()
    expect(await runs(h, 3)).toBe(1)
    expect(h.logs[0]).toContain('resume FAILED seat-a (broker went away); will retry next run')
    expect(h.logs[1]).toContain('try 2 of 8 after a failed resume; resumed seat-a')
  })

  it('retries when the run died between saving the mark and the broker taking the resume', async () => {
    const h = harness(DARK)
    dark(h, 6)
    let atCrash: WatchdogDoc | undefined
    const wake = h.deps.wake
    h.deps.wake = async (...args) => {
      atCrash = structuredClone(h.doc)
      return wake(...args)
    }
    await runWatchdog(h.deps, ONE)
    h.doc = atCrash as WatchdogDoc
    h.tick()
    const out = await runWatchdog(h.deps, ONE)
    expect(h.wakes).toHaveLength(2)
    expect(out.at(-1)).toContain('try 2 of 8 after a failed resume; resumed seat-a')
  })

  it('does not retry a died run whose resume the broker had already started', async () => {
    const h = harness(DARK)
    const since = minutesAgo(h, 6)
    h.doc.seats = { 'seat-a': { idleRuns: 0, at: h.now(), resumedDark: since, resumeRetry: 1 } }
    h.presence = { ...LIVE, darkSince: since, resumeStarted: true }
    expect(await runs(h, 3)).toBe(0)
    expect(h.logs).toEqual([])
  })

  it('gives up after eight failed tries and says so once a run from then on', async () => {
    const h = harness(DARK)
    h.wakeResult = { ok: false, detail: 'no transcript on disk' }
    dark(h, 6)
    expect(await runs(h, 10)).toBe(8)
    expect(h.logs.at(-1)).toContain('try 8 of 8 after a failed resume; resume FAILED seat-a')
    expect(h.logs.at(-1)).toContain('giving up on this episode')
    const out = await runWatchdog(h.deps, ONE)
    expect(out).toEqual([expect.stringContaining('not resumed: 8 resume attempts failed this dark episode')])
    expect(h.logs).toHaveLength(8)
  })

  it('does not resume a session the watchdog itself started, which ends on its own', async () => {
    const h = harness(DARK)
    dark(h, 30, { wokenByWatchdog: true })
    await runWatchdog(h.deps, ONE)
    expect(h.wakes).toEqual([])
  })

  it('resumes nothing when events.db cannot be read', async () => {
    const h = harness(DARK)
    h.presence = undefined
    await runWatchdog(h.deps, ONE)
    expect(h.wakes).toEqual([])
  })

  it('resumes a new dark episode after the seat came back', async () => {
    const h = harness(DARK)
    dark(h, 6)
    await runWatchdog(h.deps, ONE)
    h.tick()
    dark(h, 7)
    await runWatchdog(h.deps, ONE)
    expect(h.wakes).toHaveLength(2)
  })

  it('under --dry-run says it would resume, and resumes and saves nothing', async () => {
    const h = harness(DARK)
    dark(h, 6)
    const out = await runWatchdog(h.deps, { ...ONE, dryRun: true })
    expect(out[0]).toMatch(/^seat-a: WOULD RESUME: dark 6 min since/)
    expect(h.wakes).toEqual([])
    expect(h.doc).toEqual(emptyDoc())
  })
})

describe('stops hold the dark-seat resume (CC-326)', () => {
  const DARK: Roster = { agents: [], connected: [] }
  const LIVE: Presence = { teleported: false, wokenByWatchdog: false, resumeStarted: false }
  const dark = (h: Harness, minutes: number): void => {
    h.presence = { ...LIVE, darkSince: h.now() - minutes * 60_000 }
  }
  const resumes = (h: Harness): number => h.wakes.filter(wake => wake.message === RESUME_MESSAGE).length
  const notGap = (lines: string[]): string[] => lines.filter(line => line !== GAP_LINE)

  it('does not resume a dark seat whose latest journal line is WRAP, and says why once per run', async () => {
    const h = harness(DARK)
    h.seatLog = '08:10 heartbeat: 1 implementer running\n08:20 WRAP closing the session for the day\n'
    dark(h, 17)
    const first = notGap(await runWatchdog(h.deps, ONE))
    h.tick()
    const second = notGap(await runWatchdog(h.deps, ONE))
    expect(h.wakes).toEqual([])
    expect(first).toEqual([
      expect.stringMatching(
        /^seat-a: Watchdog: dark 17 min since \d\d:\d\dZ with no teleport; not resumed: seat logged "WRAP closing the session for the day"$/,
      ),
    ])
    expect(second).toEqual([expect.stringContaining('dark 32 min')])
    expect(h.logs).toEqual([])
  })

  it('resumes the wrapped seat once it has logged a later ordinary line', async () => {
    const h = harness(DARK)
    h.seatLog = '08:20 WRAP closing the session for the day\n'
    dark(h, 17)
    await runWatchdog(h.deps, ONE)
    h.seatLog += '08:31 heartbeat: back, 0 implementers\n'
    h.tick()
    await runWatchdog(h.deps, ONE)
    expect(resumes(h)).toBe(1)
  })

  it('never wakes a connected seat whose latest journal line is WRAP', async () => {
    const h = harness(IDLE)
    h.seatLog = '07:10 WRAP closing the session for the day\n'
    expect(await runs(h, 4)).toBe(0)
    const out = await runWatchdog(h.deps, { ...ONE, dryRun: true })
    expect(out[0]).toBe('seat-a: skip: held: seat logged "WRAP closing the session for the day"')
  })

  it('reads a WRAP line as a stop only at the start of the text, as a whole word', async () => {
    const h = harness(DARK)
    h.seatLog = '08:20 notes: WRAP comes later\n08:21 WRAPPED the gift\n'
    dark(h, 17)
    await runWatchdog(h.deps, ONE)
    expect(resumes(h)).toBe(1)
  })

  it('finds a WRAP line the seat wrote three days before the run', async () => {
    const h = harness(DARK)
    const wrapDay = new Date(h.now()).getDate() - 3
    h.deps.readSeatLog = (_seat, at) => (at.getDate() === wrapDay ? '16:31 WRAP done until next week\n' : '')
    dark(h, 3 * 24 * 60)
    const out = notGap(await runWatchdog(h.deps, ONE))
    expect(h.wakes).toEqual([])
    expect(out).toEqual([expect.stringContaining('not resumed: seat logged "WRAP done until next week"')])
  })

  it('does not resume a seat dark for longer than the journal look-back', async () => {
    const h = harness(DARK)
    dark(h, 7 * 24 * 60 + 1)
    const out = notGap(await runWatchdog(h.deps, ONE))
    h.tick()
    expect(await runs(h, 3)).toBe(0)
    expect(out).toEqual([
      expect.stringContaining('not resumed: dark longer than the 7-day journal look-back'),
    ])
  })

  it('resumes a seat dark for exactly the journal look-back', async () => {
    const h = harness(DARK)
    dark(h, 7 * 24 * 60)
    await runWatchdog(h.deps, ONE)
    expect(resumes(h)).toBe(1)
  })

  it('does not resume a seat in the stopped map, says why, and resumes it once the entry is deleted', async () => {
    const h = harness(DARK)
    h.doc.stopped = { 'seat-a': 'shut down on purpose' }
    dark(h, 30)
    const out = notGap(await runWatchdog(h.deps, ONE))
    expect(h.wakes).toEqual([])
    expect(out).toEqual([expect.stringContaining('not resumed: stopped by the owner: shut down on purpose')])
    h.doc.stopped = {}
    h.tick()
    await runWatchdog(h.deps, ONE)
    expect(resumes(h)).toBe(1)
  })

  it('does not resume a dark seat whose latest journal line is BUDGET-PAUSE', async () => {
    const h = harness(DARK)
    h.seatLog = '08:30 BUDGET-PAUSE five_hour 71%, seven_day 30%\n'
    dark(h, 30)
    expect(await runs(h, 3)).toBe(0)
  })

  it('does not resume a dark seat inside an announced restart window, then resumes it after "restart done"', async () => {
    const h = harness(DARK)
    h.ownerMessages = [{ ts: h.now() - 5 * 60_000, body: 'seat-a: restart at 08:45' }]
    dark(h, 30)
    const out = await runWatchdog(h.deps, ONE)
    expect(h.wakes).toEqual([])
    expect(out).toContainEqual(expect.stringContaining('not resumed: restart window open since'))
    h.ownerMessages.push({ ts: h.now(), body: 'seat-a: restart done' })
    h.tick()
    await runWatchdog(h.deps, ONE)
    expect(resumes(h)).toBe(1)
  })

  it('does not resume a seat whose pool is at a budget stop, then resumes it when the pool reopens', async () => {
    const h = harness(DARK, 70)
    dark(h, 30)
    const out = await runWatchdog(h.deps, ONE)
    expect(h.wakes).toEqual([])
    expect(out).toContainEqual(
      expect.stringContaining(
        'not resumed: budget closed: BUDGET-PAUSE pool claude: five_hour 70% at or above ceiling 70%',
      ),
    )
    h.fiveHour = 41
    h.tick()
    await runWatchdog(h.deps, ONE)
    expect(resumes(h)).toBe(1)
  })

  it('does not resume a seat at its per_day_points spend stop', async () => {
    const h = harness(DARK)
    h.doc.pools = { claude: { since: h.now() - 3_600_000, last: 19, spent: 9 } }
    h.sevenDay = 20
    dark(h, 30)
    const out = await runWatchdog(h.deps, ONE)
    expect(h.wakes).toEqual([])
    expect(out).toContainEqual(expect.stringMatching(/not resumed: budget closed: .*per_day_points 10$/))
  })

  it('does not resume a seat whose pool has no budget reading', async () => {
    const h = harness(DARK)
    h.deps.readBudget = () => ({ found: false, path: '/x' }) as BudgetRead
    dark(h, 30)
    expect(await runs(h, 3)).toBe(0)
  })

  it('never wakes by the idle path a dark seat whose resume a stop refused', async () => {
    const h = harness(DARK)
    dark(h, 7 * 24 * 60 + 1)
    expect(await runs(h, 6)).toBe(0)
  })

  it('under --dry-run says why a dark seat would not be resumed', async () => {
    const h = harness(DARK)
    h.seatLog = '08:20 WRAP closing the session for the day\n'
    dark(h, 17)
    const out = await runWatchdog(h.deps, { ...ONE, dryRun: true })
    expect(out[0]).toMatch(/^seat-a: skip: dark 17 min .*; not resumed: seat logged "WRAP/)
  })
})

describe('the dark threshold (CC-326)', () => {
  const input = (darkForMs: number) => ({
    connected: false,
    presence: {
      darkSince: 1_000_000 - darkForMs,
      teleported: false,
      wokenByWatchdog: false,
      resumeStarted: false,
    },
    hold: undefined,
    absentSince: undefined,
    attempted: undefined,
    unconfirmed: undefined,
    nowMs: 1_000_000,
  })

  it('does not resume a seat dark for exactly five minutes', () => {
    expect(judgeLiveness(input(DARK_AFTER_MS))).toEqual({
      resume: false,
      reason: 'dark 5 min, not yet over 5',
    })
  })

  it('resumes a seat dark one millisecond over five minutes', () => {
    expect(judgeLiveness(input(DARK_AFTER_MS + 1))).toMatchObject({ resume: true, tries: 1 })
  })
})

describe('a seat the broker never deregistered (CC-326)', () => {
  const DARK: Roster = { agents: [], connected: [] }
  const open = (register: number): Presence => ({
    openRegister: register,
    teleported: false,
    wokenByWatchdog: false,
    resumeStarted: false,
  })
  /** No eligible work, so the idle wake stays out of the way and only the liveness check can resume. */
  const absentSeat = (register: number): Harness => {
    const h = harness(DARK)
    h.deps.eligible = () => ({ count: 0, skipped: 0 })
    h.presence = open(register)
    return h
  }

  it('counts a seat absent with `registered` as its last row as dark from the run that first sees it', async () => {
    const h = absentSeat(41)
    const first = await runWatchdog(h.deps, ONE)
    expect(h.wakes).toEqual([])
    expect(h.doc.seats['seat-a']?.absent).toEqual({ register: 41, since: h.now() })
    h.tick()
    const second = await runWatchdog(h.deps, ONE)
    expect(first).toEqual([GAP_LINE])
    expect(h.wakes).toEqual([{ seat: 'seat-a', message: RESUME_MESSAGE, connected: false }])
    expect(second).toEqual([
      expect.stringMatching(
        /^seat-a: Watchdog: absent 15 min since first seen at \d\d:\d\dZ with no deregistered row; resumed seat-a/,
      ),
    ])
  })

  it('resumes that absence once across later runs', async () => {
    const h = absentSeat(41)
    expect(await runs(h, 6)).toBe(1)
  })

  it('starts the clock again when the seat registered in between', async () => {
    const h = absentSeat(41)
    await runWatchdog(h.deps, ONE)
    h.tick()
    h.presence = open(57)
    await runWatchdog(h.deps, ONE)
    expect(h.wakes).toEqual([])
    expect(h.doc.seats['seat-a']?.absent).toEqual({ register: 57, since: h.now() })
  })

  it('keeps no absence clock for a seat that is connected', async () => {
    const h = harness(IDLE)
    h.doc.seats = { 'seat-a': { idleRuns: 0, at: h.now() - 60_000, absent: { register: 41, since: 1 } } }
    await runWatchdog(h.deps, ONE)
    expect(h.doc.seats['seat-a']?.absent).toBeUndefined()
  })

  it('keeps the clock through a run that cannot read events.db', async () => {
    const h = absentSeat(41)
    await runWatchdog(h.deps, ONE)
    const since = h.now()
    h.tick()
    h.presence = undefined
    await runWatchdog(h.deps, ONE)
    expect(h.wakes).toEqual([])
    expect(h.doc.seats['seat-a']?.absent).toEqual({ register: 41, since })
  })

  it('does not resume an absent seat that a stop holds', async () => {
    const h = absentSeat(41)
    h.seatLog = '08:20 WRAP closing the session for the day\n'
    expect(await runs(h, 3)).toBe(0)
  })
})

describe('overlapping runs (CC-326)', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-seat-watchdog-lock-'))
  })

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  function lockedHarness(): { h: Harness; file: string } {
    const h = harness({ agents: [], connected: [] })
    const file = path.join(dir, 'seat-watchdog.lock')
    h.deps.lock = () => acquireRunLock(file)
    h.presence = {
      darkSince: h.now() - 6 * 60_000,
      teleported: false,
      wokenByWatchdog: false,
      resumeStarted: false,
    }
    return { h, file }
  }

  it('resumes a dark seat once when a second run starts while the first is mid-resume', async () => {
    const { h, file } = lockedHarness()
    let finish: (result: { ok: boolean; detail: string }) => void = () => undefined
    const entered = new Promise<void>(inside => {
      h.deps.wake = (seat, message, connected) => {
        h.wakes.push({ seat, message, connected })
        inside()
        return new Promise(resolve => void (finish = resolve))
      }
    })
    const first = runWatchdog(h.deps, ONE)
    await entered

    const second = await runWatchdog(h.deps, ONE)

    finish({ ok: true, detail: 'resumed' })
    await first
    expect(h.wakes).toHaveLength(1)
    expect(second).toEqual([
      expect.stringMatching(
        /^Watchdog: another run holds seat-watchdog\.lock \(pid \d+, since \d\d:\d\dZ\); this run did nothing$/,
      ),
    ])
    expect(fs.existsSync(file)).toBe(false)
  })

  it('releases the lock when the run fails, so the next run is not locked out', async () => {
    const { h, file } = lockedHarness()
    h.deps.loadDoc = () => {
      throw new Error('seat-watchdog.json is unusable')
    }
    await expect(runWatchdog(h.deps, ONE)).rejects.toThrow('unusable')
    expect(fs.existsSync(file)).toBe(false)
  })

  it('takes no lock under --dry-run', async () => {
    const { h } = lockedHarness()
    h.deps.lock = () => {
      throw new Error('dry run took the lock')
    }
    const out = await runWatchdog(h.deps, { ...ONE, dryRun: true })
    expect(out[0]).toMatch(/^seat-a: WOULD RESUME/)
  })

  it('takes over the lock of a run that died, says so, and resumes the seat that run left dark', async () => {
    const { h, file } = lockedHarness()
    fs.writeFileSync(file, JSON.stringify({ pid: 424242, at: h.now() - 60_000 }))
    h.deps.lock = () => acquireRunLock(file, { alive: () => false })
    const out = await runWatchdog(h.deps, ONE)
    expect(out[0]).toBe('Watchdog: took over a stale run lock: its run (pid 424242) is gone')
    expect(h.wakes).toHaveLength(1)
    expect(fs.existsSync(file)).toBe(false)
  })
})

describe('state-change log lines', () => {
  const HOLD_ON = /^Watchdog: hold on every seat: /
  const HOLD_OFF = 'Watchdog: hold on every seat lifted'

  async function outputs(h: Harness, count: number): Promise<string[]> {
    const out: string[] = []
    for (let i = 0; i < count; i++) {
      out.push(...(await runWatchdog(h.deps, ONE)))
      h.tick()
    }
    return out
  }

  it('logs a hold on every seat when it starts and when it ends, not every run', async () => {
    const h = harness(IDLE)
    h.deps.ownerMessages = () => undefined
    const first = await outputs(h, 2)
    h.deps.ownerMessages = () => []
    const last = await outputs(h, 1)
    const lines = [...first, ...last].filter(l => l !== GAP_LINE)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatch(HOLD_ON)
    expect(lines[1]).toBe(HOLD_OFF)
  })

  it('logs a restart window hold once across its runs', async () => {
    const h = harness(IDLE)
    h.ownerMessages = [{ ts: h.now() - 5 * 60_000, body: 'seat-a: restart at 08:45' }]
    const out = (await outputs(h, 3)).filter(l => HOLD_ON.test(l))
    expect(out).toHaveLength(1)
  })

  it('logs a fire cap engaging once and lifting once', async () => {
    const h = harness(IDLE)
    const capLines = (lines: string[]): string[] => lines.filter(l => /fire cap (engaged|lifted)/.test(l))
    const engaged = capLines(await outputs(h, 8))
    expect(engaged).toHaveLength(1)
    expect(engaged[0]).toContain('fire cap engaged: 2 wake(s)')
    const busy: Roster = {
      agents: [{ name: 'sa-x-2', profile: 'implementer', state: 'live', spawnedBy: 'seat-a' }],
      connected: [],
    }
    const lifted = capLines(await runWatchdog({ ...h.deps, roster: async () => busy }, ONE))
    expect(lifted).toEqual(['seat-a: Watchdog: fire cap lifted: an implementer ran'])
    expect(h.logs.filter(l => /fire cap (engaged|lifted)/.test(l))).toHaveLength(2)
  })

  it('reads a state file from before these fields as no hold and no cap', async () => {
    const h = harness(IDLE)
    h.doc = {
      seats: { 'seat-a': { idleRuns: 0, at: h.now() - 60_000, fires: 0 } },
      pools: {},
      stopped: {},
    }
    const out = await outputs(h, 2)
    expect(out.filter(l => l !== GAP_LINE && !/woke/.test(l))).toEqual([])
  })
})

describe('wakeSeat', () => {
  function client(reply: Record<string, unknown>): { frames: unknown[]; client: BrokerClient } {
    const frames: unknown[] = []
    const request = async (frame: unknown) => (frames.push(frame), reply)
    return { frames, client: { request } as unknown as BrokerClient }
  }

  it('tags a message to a connected seat with source watchdog', async () => {
    const c = client({ t: 'send_result', ok: true, msgId: 'm1', recipients: ['s'] })
    expect(await wakeSeat(c.client, 's', 'Watchdog: x', true)).toEqual({ ok: true, detail: 'message m1' })
    expect(c.frames).toEqual([{ t: 'human_send', to: 's', text: 'Watchdog: x', source: 'watchdog' }])
  })

  it('tags a headless resume of a stopped seat with source watchdog', async () => {
    const c = client({ t: 'spawn_result', ok: true })
    await wakeSeat(c.client, 's', 'Watchdog: x', false)
    expect(c.frames).toEqual([
      { t: 'resume', name: 's', surface: 'headless', message: 'Watchdog: x', source: 'watchdog' },
    ])
  })
})

describe('watchdog disk state', () => {
  let dir: string
  const savedHome = process.env.AGENT_CHAT_HOME

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-seat-watchdog-'))
    process.env.AGENT_CHAT_HOME = dir
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
    if (savedHome === undefined) delete process.env.AGENT_CHAT_HOME
    else process.env.AGENT_CHAT_HOME = savedHome
  })

  it('round-trips seat state under AGENT_CHAT_HOME', () => {
    saveDoc({ seats: { s: { idleRuns: 1, at: 5 } }, pools: { p: { since: 1, last: 2, spent: 3 } } })
    expect(fs.existsSync(path.join(dir, 'seat-watchdog.json'))).toBe(true)
    expect(loadDoc()).toEqual({
      seats: { s: { idleRuns: 1, at: 5 } },
      pools: { p: { since: 1, last: 2, spent: 3 } },
      stopped: {},
    })
  })

  it("keeps the owner's stopped map as it is on disk when saving", () => {
    const file = path.join(dir, 'seat-watchdog.json')
    fs.writeFileSync(file, JSON.stringify({ stopped: { s: 'parked' } }))
    saveDoc({ seats: {}, pools: {} })
    expect(loadDoc().stopped).toEqual({ s: 'parked' })
  })

  it('reads missing state as empty', () => {
    expect(loadDoc()).toEqual({ seats: {}, pools: {}, stopped: {} })
  })

  it.each([
    ['text that is not JSON', '{"stopped": {"seat-a": "away"}'],
    ['a `stopped` that is a list', '{"stopped": ["seat-a"]}'],
    ['a `stopped` that is a string', '{"stopped": "seat-a"}'],
    ['a document that is a list', '[]'],
    ['an empty file', ''],
  ])('refuses %s instead of reading it as no stops', (_what, text) => {
    const file = path.join(dir, 'seat-watchdog.json')
    fs.writeFileSync(file, text)
    expect(() => loadDoc()).toThrow(/^seat-watchdog\.json is unusable \(.*so the owner's stops are unknown/)
    expect(() => saveDoc({ seats: {}, pools: {} })).toThrow('unusable')
    expect(fs.readFileSync(file, 'utf8')).toBe(text)
  })

  it('ends the run with that error, resuming nothing, when seat-watchdog.json cannot be parsed', async () => {
    fs.writeFileSync(path.join(dir, 'seat-watchdog.json'), '{"stopped": {"seat-a": "away"}')
    const h = harness({ agents: [], connected: [] })
    h.presence = {
      darkSince: h.now() - 30 * 60_000,
      teleported: false,
      wokenByWatchdog: false,
      resumeStarted: false,
    }
    h.deps.loadDoc = () => loadDoc()
    await expect(runWatchdog(h.deps, ONE)).rejects.toThrow('seat-watchdog.json is unusable')
    expect([h.wakes, h.logs]).toEqual([[], []])
  })

  it('holds no messages for a seat while the stops cannot be read', () => {
    fs.writeFileSync(path.join(dir, 'charter.md'), CHARTER)
    expect(isWatchedSeat('seat-a', dir)).toBe(true)
    fs.writeFileSync(path.join(dir, 'seat-watchdog.json'), '{"stopped": ')
    expect(isWatchedSeat('seat-a', dir)).toBe(false)
  })

  it('appends a local HH:MM line to logs/<seat>/<local date>.md', () => {
    const at = new Date(2026, 8, 29, 6, 53)
    const file = appendSeatLog(dir, 'seat', at, 'Watchdog: fired')
    appendSeatLog(dir, 'seat', at, 'again')
    expect(file).toBe(path.join(dir, 'logs', 'seat', '2026-09-29.md'))
    expect(fs.readFileSync(file, 'utf8')).toBe('06:53 Watchdog: fired\n06:53 again\n')
  })
})

describe('watchdog launchd job', () => {
  it('runs `seats watchdog` at minutes 8, 23, 38 and 53, not at load', () => {
    const plist = renderWatchdogPlist({
      label: 'dev.hjewkes.agent-chat-seat-watchdog',
      nodePath: '/opt/node',
      cliEntry: '/repo/dist/cli.js',
      logDir: '/logs',
      env: {},
      minutes: [8, 23, 38, 53],
    })
    expect(plist).toContain(
      '<string>/repo/dist/cli.js</string>\n    <string>seats</string>\n    <string>watchdog</string>',
    )
    expect(plist).toContain('<key>StartCalendarInterval</key>')
    expect([...plist.matchAll(/<key>Minute<\/key>\n\s+<integer>(\d+)<\/integer>/g)].map(m => m[1])).toEqual([
      '8',
      '23',
      '38',
      '53',
    ])
    expect(plist).toContain('<key>RunAtLoad</key>\n  <false/>')
    expect(plist).not.toContain('StartInterval</key>\n  <integer>')
  })

  it('under --dry-run prints the plist and the launchctl calls without a kickstart, and only asks launchd whether it is loaded', () => {
    const calls: string[] = []
    const launchctl: Launchctl = args => {
      calls.push(args[0] ?? '')
      return { code: 113, stdout: '', stderr: '' }
    }
    const report = watchdogInstall({
      launchctl,
      uid: 501,
      dryRun: true,
      label: 'dev.hjewkes.agent-chat-seat-watchdog',
    })
    expect(report.ok).toBe(true)
    expect(report.lines[0]).toContain('<plist version="1.0">')
    expect(report.lines.some(l => l.startsWith('launchctl bootstrap gui/501'))).toBe(true)
    expect(report.lines.some(l => l.startsWith('launchctl kickstart'))).toBe(false)
    expect(calls).toEqual(['print'])
  })
})

describe('readOwnerMessages', () => {
  it("reads only the owner seat's restart messages since the cut-off", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-seat-watchdog-db-'))
    const file = path.join(dir, 'events.db')
    const db = new DatabaseSync(file)
    db.exec(
      'CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, kind TEXT, actor TEXT, body TEXT)',
    )
    const insert = db.prepare('INSERT INTO events (ts, kind, actor, body) VALUES (?, ?, ?, ?)')
    insert.run(1, 'message', 'owner', 'restart at 06:00')
    insert.run(5, 'message', 'owner', 'restart at 07:00')
    insert.run(6, 'message', 'other', 'restart at 07:00')
    insert.run(7, 'message', 'owner', 'merged #1')
    insert.run(8, 'broadcast', 'owner', 'restart done')
    db.close()
    try {
      expect(readOwnerMessages(file, 'owner', 2)).toEqual([
        { ts: 5, body: 'restart at 07:00' },
        { ts: 8, body: 'restart done' },
      ])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("waits out another process's write lock instead of failing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-seat-watchdog-db-'))
    const file = path.join(dir, 'events.db')
    const db = new DatabaseSync(file)
    db.exec(
      'CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, kind TEXT, actor TEXT, body TEXT)',
    )
    db.close()
    const holder = spawn(process.execPath, [
      '-e',
      `const { DatabaseSync } = require('node:sqlite')
       const db = new DatabaseSync(${JSON.stringify(file)})
       db.exec('BEGIN EXCLUSIVE')
       process.stdout.write('locked\\n')
       setTimeout(() => { db.exec('COMMIT'); db.close() }, 400)`,
    ])
    try {
      await new Promise<void>(resolve => holder.stdout.once('data', () => resolve()))
      expect(readOwnerMessages(file, 'owner', 0)).toEqual([])
    } finally {
      holder.kill()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('readAgentEvents', () => {
  it('reads only agent lifecycle rows before the cut-off, with meta parsed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-seat-watchdog-db-'))
    const file = path.join(dir, 'events.db')
    const db = new DatabaseSync(file)
    db.exec(
      'CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, kind TEXT, actor TEXT, target TEXT, msg_id TEXT, ref TEXT, body TEXT, meta TEXT)',
    )
    const insert = db.prepare(
      'INSERT INTO events (ts, kind, actor, target, msg_id, ref, meta) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    insert.run(1, 'agent_spawned', 'seat', 'w', 'a1', null, '{"profile":"implementer"}')
    insert.run(2, 'message', 'w', 'seat', 'm1', null, null)
    insert.run(3, 'agent_exited', 'w', null, 'e1', 'a1', null)
    db.close()
    try {
      const rows = readAgentEvents(file, 3)
      expect(rows).toEqual([
        {
          kind: 'agent_spawned',
          ts: 1,
          actor: 'seat',
          target: 'w',
          msgId: 'a1',
          ref: null,
          body: null,
          meta: { profile: 'implementer' },
        },
      ])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
