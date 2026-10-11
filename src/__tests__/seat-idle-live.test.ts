import { describe, expect, it } from 'vitest'
import type { BudgetRead } from '../agents/budget.js'
import type { WatchdogDoc } from '../agents/seats/io.js'
import { runWatchdog, type WatchdogDeps } from '../agents/seats/run.js'
import type { SeatAgent } from '../agents/seats/watchdog.js'

const CHARTER = `---
owner_seat: seat-a
seats: [seat-a]
pools:
  claude:  {config_dir: ~/.claude, human_uses: true, reserve_seven_day: 35, ceiling_five_hour: 70, per_day_points: 13}
---
`
// No heartbeat_cron, so the cron tick never fires and only idle-live wakes show up.
const SEAT = `---
prefix: sa
pool: claude
---
`

const budget: BudgetRead = {
  found: true,
  path: '/x',
  age_seconds: 5,
  stale: false,
  budget: {
    session_id: 's',
    written_at: 0,
    context: { exceeds_200k: false },
    cost: {},
    rate_limits: { five_hour: { used_pct: 10 }, seven_day: { used_pct: 10 } },
  },
}

const IMPLEMENTER: SeatAgent = { name: 'sa-x-1', profile: 'implementer', state: 'live', spawnedBy: 'seat-a' }

interface Rig {
  sent: { at: string; message: string }[]
  events: { event: string; detail: Record<string, unknown> }[]
  failWakes: (fail: boolean) => void
  /** Set the seat's own log for 2026-10-08. */
  log: (text: string) => void
  /** Run the watchdog at local HH:MM on 2026-10-08. */
  at: (hh: number, mm: number) => Promise<void>
}

function rig(agents: SeatAgent[] = [IMPLEMENTER]): Rig {
  let now = new Date(2026, 9, 8, 8, 0)
  let seatLog = ''
  let doc: WatchdogDoc = { seats: {}, pools: {}, stopped: {} }
  let failing = false
  const sent: Rig['sent'] = []
  const events: Rig['events'] = []
  const hhmm = (d: Date): string => `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
  const deps: WatchdogDeps = {
    now: () => now,
    readCharter: () => CHARTER,
    readSeatFile: () => SEAT,
    seatLogDays: () => [new Date(2026, 9, 8, 12)],
    readSeatLog: () => seatLog,
    readBudget: () => budget,
    ownerMessages: () => [],
    roster: async () => ({ agents, connected: ['seat-a'] }),
    presence: () => ({ teleported: false, wokenByWatchdog: false, resumeStarted: false }),
    eligible: () => ({ count: 0, skipped: 0 }),
    loadDoc: () => structuredClone(doc),
    saveDoc: saved => void (doc = { ...saved, stopped: doc.stopped }),
    wake: async (_seat, message) => {
      if (failing) return { ok: false, detail: 'broker down' }
      sent.push({ at: hhmm(now), message })
      return { ok: true, detail: 'ok' }
    },
    appendLog: () => undefined,
    lock: () => ({ held: true, release: () => undefined }),
    logEvent: (event, detail) => void events.push({ event, detail }),
  }
  return {
    sent,
    events,
    failWakes: fail => void (failing = fail),
    log: text => void (seatLog = text),
    at: async (hh, mm) => {
      now = new Date(2026, 9, 8, hh, mm)
      await runWatchdog(deps, { seats: ['seat-a'], dryRun: false })
    },
  }
}

const idleWakes = (r: Rig): Rig['sent'] => r.sent.filter(s => s.message.includes('in flight'))

describe('watchdog idle-live wake', () => {
  // Catches: the run.ts call missing, and a missing idleWokeFor check waking the seat on every pass.
  it('wakes a connected seat with a live implementer and 21 quiet minutes exactly once over two passes', async () => {
    const r = rig()
    r.log('09:00 tick: dispatched X-1')
    await r.at(9, 21)
    await r.at(9, 36)
    expect(r.sent).toEqual([
      {
        at: '9:21',
        message: 'Watchdog: 1 agent(s) in flight and no seat log line for 21 min; read their reports and act',
      },
    ])
    expect(r.events.filter(e => e.event === 'idle_live_wake')).toHaveLength(1)
  })

  // Catches: an off-by-one or a shorter threshold.
  it('stays quiet at 19 minutes', async () => {
    const r = rig()
    r.log('09:00 tick: dispatched X-1')
    await r.at(9, 19)
    expect(idleWakes(r)).toEqual([])
  })

  // Catches: waking a seat that is simply idle, which is the idle path's job, not this one.
  it('does not wake a seat with no implementer in flight', async () => {
    const r = rig([])
    r.log('09:00 tick: nothing eligible')
    await r.at(9, 21)
    expect(idleWakes(r)).toEqual([])
  })

  // Catches: overriding a seat that parked itself.
  it('does not wake a seat whose latest line is PARKED', async () => {
    const r = rig()
    r.log('09:00 PARKED waiting on the owner')
    await r.at(9, 21)
    expect(idleWakes(r)).toEqual([])
  })

  // Catches: a mark that never re-arms, so a second quiet episode goes unnoticed.
  it('wakes again after a new log line and another 20 quiet minutes', async () => {
    const r = rig()
    r.log('09:00 tick: dispatched X-1')
    await r.at(9, 21)
    r.log('09:00 tick: dispatched X-1\n09:25 read reports, waiting on X-1')
    await r.at(9, 36)
    await r.at(9, 45)
    expect(idleWakes(r).map(s => s.at)).toEqual(['9:21', '9:45'])
  })

  // Catches: the mark advancing on a failed wake, which would drop the episode's only wake.
  it('retries a failed wake on the next pass', async () => {
    const r = rig()
    r.log('09:00 tick: dispatched X-1')
    r.failWakes(true)
    await r.at(9, 21)
    r.failWakes(false)
    await r.at(9, 36)
    expect(idleWakes(r).map(s => s.at)).toEqual(['9:36'])
  })
})
