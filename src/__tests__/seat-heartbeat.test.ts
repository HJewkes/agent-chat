import { describe, expect, it } from 'vitest'
import type { BudgetRead } from '../agents/budget.js'
import type { WatchdogDoc } from '../agents/seats/io.js'
import { readSeatLog } from '../agents/seats/stops.js'
import { runWatchdog, type WatchdogDeps } from '../agents/seats/run.js'

const CHARTER = `---
owner_seat: seat-a
seats: [seat-a]
pools:
  claude:  {config_dir: ~/.claude, human_uses: true, reserve_seven_day: 35, ceiling_five_hour: 70, per_day_points: 13}
---
`
const SEAT = `---
prefix: sa
pool: claude
heartbeat_cron: "17,47 * * * *"
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

interface Rig {
  deps: WatchdogDeps
  sent: { at: string; message: string }[]
  /** Set the seat's own log for 2026-10-08. */
  log: (text: string) => void
  /** Run the watchdog at local HH:MM on 2026-10-08. */
  at: (hh: number, mm: number) => Promise<void>
}

function rig(cron = '"17,47 * * * *"'): Rig {
  let now = new Date(2026, 9, 8, 8, 0)
  let seatLog = ''
  let doc: WatchdogDoc = { seats: {}, pools: {}, stopped: {} }
  const sent: Rig['sent'] = []
  const hhmm = (d: Date): string => `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
  const deps: WatchdogDeps = {
    now: () => now,
    readCharter: () => CHARTER,
    readSeatFile: () => SEAT.replace('"17,47 * * * *"', cron),
    seatLogDays: () => [new Date(2026, 9, 8, 12)],
    readSeatLog: () => seatLog,
    readBudget: () => budget,
    ownerMessages: () => [],
    roster: async () => ({ agents: [], connected: ['seat-a'] }),
    presence: () => ({ teleported: false, wokenByWatchdog: false, resumeStarted: false }),
    // No eligible work, so the idle wake never fires and only heartbeat sends show up.
    eligible: () => ({ count: 0, skipped: 0 }),
    loadDoc: () => structuredClone(doc),
    saveDoc: saved => void (doc = { ...saved, stopped: doc.stopped }),
    wake: async (_seat, message) => {
      sent.push({ at: hhmm(now), message })
      return { ok: true, detail: 'ok' }
    },
    appendLog: () => undefined,
    lock: () => ({ held: true, release: () => undefined }),
  }
  return {
    deps,
    sent,
    log: text => void (seatLog = text),
    at: async (hh, mm) => {
      now = new Date(2026, 9, 8, hh, mm)
      await runWatchdog(deps, { seats: ['seat-a'], dryRun: false })
    },
  }
}

const TICK = 'Heartbeat tick'
const everyMinute = async (r: Rig, from: [number, number], to: [number, number]): Promise<void> => {
  for (let m = from[0] * 60 + from[1]; m <= to[0] * 60 + to[1]; m++) await r.at(Math.floor(m / 60), m % 60)
}

describe('watchdog heartbeat', () => {
  it('sends a tick at :17 and :47 only', async () => {
    const r = rig()
    await everyMinute(r, [9, 0], [10, 30])
    expect(r.sent).toEqual([
      { at: '9:17', message: TICK },
      { at: '9:47', message: TICK },
      { at: '10:17', message: TICK },
    ])
  })

  it('does not tick twice in one slot when the seat already logged since the slot', async () => {
    const r = rig()
    r.log('09:17 heartbeat done')
    await everyMinute(r, [9, 10], [9, 30])
    expect(r.sent).toEqual([])
  })

  it('sends nothing during a BUDGET-PAUSE', async () => {
    const r = rig()
    r.log('08:50 BUDGET-PAUSE five_hour 71% until 13:00')
    await everyMinute(r, [9, 0], [12, 59])
    expect(r.sent).toEqual([])
  })

  it('wakes exactly once at the reset plus 2 minutes', async () => {
    const r = rig()
    r.log('08:50 BUDGET-PAUSE five_hour 71% until 13:00')
    await everyMinute(r, [12, 55], [14, 0])
    expect(r.sent).toHaveLength(1)
    expect(r.sent[0]?.at).toBe('13:02')
    expect(r.sent[0]?.message).toMatch(/BUDGET-PAUSE/)
  })

  it('reads a reset earlier than the pause line as the next day', () => {
    const verdict = readSeatLog('23:30 BUDGET-PAUSE seven_day 80% until 01:00', new Date(2026, 9, 8, 12))
    expect(verdict.pauseUntil).toBe(new Date(2026, 9, 9, 1, 0).getTime())
  })

  it.each(['WRAP day done', 'PARKED waiting on the owner'])('stays silent after a %s line', async line => {
    const r = rig()
    r.log(`08:50 ${line}`)
    await everyMinute(r, [9, 0], [10, 30])
    expect(r.sent).toEqual([])
  })

  it('sends nothing for a seat without a heartbeat_cron', async () => {
    const r = rig('""')
    await everyMinute(r, [9, 0], [9, 59])
    expect(r.sent).toEqual([])
  })
})
