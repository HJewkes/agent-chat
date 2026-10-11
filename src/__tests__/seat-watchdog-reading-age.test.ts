import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { BudgetRead } from '../agents/budget.js'
import type { WatchdogDoc } from '../agents/seats/io.js'
import { readReadingRows, readingHistoryPath, type ReadingRow } from '../agents/seats/pace-pass.js'
import { runWatchdog, type WatchdogDeps } from '../agents/seats/run.js'
import { WATCHDOG_MAX_READING_AGE_SECONDS, poolBudget } from '../agents/seats/watchdog.js'

const CHARTER = `---
owner_seat: seat-a
seats: [seat-a]
pools:
  claude:  {config_dir: /home/example/.claude, human_uses: true, reserve_seven_day: 35, ceiling_five_hour: 70, per_day_points: 13}
---
`
const SEAT = '---\nprefix: sa\npool: claude\nspend:\n  per_run_points: 20\n  per_day_points: 10\n---\n'
const NOW = new Date(2026, 9, 6, 11)
const at = (hour: number): number => new Date(2026, 9, 6, hour).getTime()

const RESETS_AT = at(24 * 3)

const budget = (sevenDay: number, ageSeconds = 5): BudgetRead => ({
  found: true,
  path: '/x',
  age_seconds: ageSeconds,
  stale: false,
  budget: {
    session_id: 's',
    written_at: 0,
    context: { exceeds_200k: false },
    cost: {},
    rate_limits: {
      five_hour: { used_pct: 10 },
      seven_day: { used_pct: sevenDay, resets_at: RESETS_AT / 1000 },
    },
  },
})

const row = (hour: number, sevenDay: number, resetsAt = RESETS_AT): ReadingRow => ({
  ts: at(hour) / 1000,
  pool: 'claude',
  seven_day: sevenDay,
  five_hour: 10,
  resets_at: resetsAt / 1000,
  source: 'watchdog',
  age_s: 5,
})

interface Pass {
  out: string[]
  doc: WatchdogDoc
}

interface PassInput {
  sevenDay: number
  rows?: ReadingRow[]
  dryRun?: boolean
  ageSeconds?: number
  /** Whether the pass may probe a pool with an old reading; the probe here never gets one. */
  probe?: boolean
}

/** One watchdog pass at 11:00 with no seat-watchdog.json, over `rows` of history. */
async function passWithoutDoc(input: PassInput): Promise<Pass> {
  const { sevenDay, rows = [], dryRun = false, ageSeconds = 5 } = input
  let doc: WatchdogDoc = { seats: {}, pools: {}, stopped: {} }
  const deps: WatchdogDeps = {
    now: () => NOW,
    readCharter: () => CHARTER,
    readSeatFile: seat => (seat === 'seat-a' ? SEAT : undefined),
    seatLogDays: () => [NOW],
    readSeatLog: () => '',
    readBudget: () => budget(sevenDay, ageSeconds),
    ownerMessages: () => [],
    roster: async () => ({ agents: [], connected: ['seat-a'] }),
    presence: () => ({ teleported: false, wokenByWatchdog: false, resumeStarted: false }),
    eligible: () => ({ count: 7, skipped: 0 }),
    loadDoc: () => structuredClone(doc),
    saveDoc: saved => void (doc = { ...saved, stopped: {} }),
    wake: async () => ({ ok: true, detail: 'message m1' }),
    appendLog: () => undefined,
    lock: () => ({ held: true, release: () => undefined }),
    pace: { read: () => undefined, write: () => undefined, append: () => undefined, rows: () => rows },
    ...(input.probe === true ? { probe: () => false } : {}),
  }
  const out = await runWatchdog(deps, { seats: ['seat-a'], dryRun })
  return { out, doc }
}

const GAP_LINE =
  "pool claude: no seven_day reading at or before 07:00, so the day's spend counts from the first sample"

describe('the watchdog budget on an old reading (CC-346)', () => {
  const pool = {
    name: 'agents',
    configDir: '/pool',
    humanUses: false,
    rule: { reserve_seven_day: 25, ceiling_five_hour: 70 },
    perDayPoints: 13,
  }
  const gate = (ageSeconds: number, maxReadingAgeSeconds?: number) =>
    poolBudget({
      pool,
      spend: {},
      reading: { ageSeconds, fiveHour: 5, sevenDay: 20 },
      history: [{ at: at(7), sevenDay: 18 }],
      runStartAt: at(9),
      now: NOW,
      ...(maxReadingAgeSeconds === undefined ? {} : { maxReadingAgeSeconds }),
    })

  it('holds the resume on a 20% reading three days old and says how old it is against the limit', () => {
    const verdict = gate(3 * 86_400, WATCHDOG_MAX_READING_AGE_SECONDS)
    expect(WATCHDOG_MAX_READING_AGE_SECONDS).toBe(21_600)
    expect(verdict.open).toBe(false)
    expect(verdict.reason).toContain('reading is 259200s old, over the 21600s limit')
  })

  it('stays open on a 20% reading ten minutes old', () => {
    expect(gate(600, WATCHDOG_MAX_READING_AGE_SECONDS).open).toBe(true)
  })

  it('stays open on an old reading when the caller sets no limit', () => {
    expect(gate(3 * 86_400).open).toBe(true)
  })

  it('holds a seat on a reading three days old when the pass has a probe that took none', async () => {
    const { out } = await passWithoutDoc({
      sevenDay: 20,
      rows: [row(6, 18)],
      ageSeconds: 3 * 86_400,
      probe: true,
      dryRun: true,
    })
    expect(out[0]).toMatch(/budget closed: .*reading is 259200s old, over the 21600s limit/)
  })

  it('does not lock out an idle pool whose reading is three days old when no probe is configured', async () => {
    const { out } = await passWithoutDoc({
      sevenDay: 20,
      rows: [row(6, 18)],
      ageSeconds: 3 * 86_400,
      dryRun: true,
    })
    expect(out[0]).toContain('budget open')
  })
})

describe('a deleted seat-watchdog.json and the day meter (CC-346)', () => {
  it("holds the seat on the day cap counted from the history's reading before 07:00", async () => {
    const live = await passWithoutDoc({ sevenDay: 52, rows: [row(6, 40)] })
    expect(live.doc.pools.claude).toEqual({ since: at(7), last: 52, spent: 12 })
    expect(live.out).not.toContain(GAP_LINE)
    const dry = await passWithoutDoc({ sevenDay: 52, rows: [row(6, 40)], dryRun: true })
    expect(dry.out[0]).toMatch(/budget closed: .*day spend 12 points since 07:00 .*per_day_points 10$/)
  })

  it('starts the meter at now with no history, and says the day has no 07:00 reading', async () => {
    const { doc, out } = await passWithoutDoc({ sevenDay: 52 })
    expect(doc.pools.claude).toEqual({ since: NOW.getTime(), last: 52, spent: 0 })
    expect(out).toContain(GAP_LINE)
  })

  it('ignores a history row above the current reading, since the window rolled after it', async () => {
    const { doc } = await passWithoutDoc({ sevenDay: 52, rows: [row(6, 60)] })
    expect(doc.pools.claude).toEqual({ since: NOW.getTime(), last: 52, spent: 0 })
  })

  it('ignores a history row from a window with another reset time, though it is below the current reading', async () => {
    const { doc } = await passWithoutDoc({ sevenDay: 52, rows: [row(6, 40, RESETS_AT - 7 * 86_400_000)] })
    expect(doc.pools.claude).toEqual({ since: NOW.getTime(), last: 52, spent: 0 })
  })

  it("ignores a pre-07:00 row over a day older than the day start, so earlier spend is not today's", async () => {
    const { doc } = await passWithoutDoc({ sevenDay: 52, rows: [row(7 - 25, 40)] })
    expect(doc.pools.claude).toEqual({ since: NOW.getTime(), last: 52, spent: 0 })
  })

  it('counts from the earliest row of the day when none precedes 07:00, dated at that row, and says so', async () => {
    const { doc, out } = await passWithoutDoc({ sevenDay: 52, rows: [row(10, 48), row(8, 44), row(9, 45)] })
    expect(doc.pools.claude).toEqual({ since: at(8), last: 52, spent: 8 })
    expect(out).toContain(GAP_LINE)
  })
})

describe('readReadingRows', () => {
  it('reads the history and skips lines that are not rows', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc346-'))
    const good = row(6, 40)
    fs.writeFileSync(readingHistoryPath(root), `${JSON.stringify(good)}\nnot json\n{"pool":"claude"}\n\n`)
    expect(readReadingRows(root)).toEqual([good])
    expect(readReadingRows(path.join(root, 'missing'))).toEqual([])
    fs.rmSync(root, { recursive: true })
  })
})
