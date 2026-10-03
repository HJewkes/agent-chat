import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readAccountBudget, type BudgetRead } from '../agents/budget.js'
import type { WatchdogDoc } from '../agents/seats/io.js'
import {
  appendReadingRows,
  readPaceDoc,
  readingHistoryPath,
  writePaceDoc,
  type PaceDoc,
  type ReadingRow,
} from '../agents/seats/pace-pass.js'
import { PROBE_SESSION, parseRateLimits, probePool } from '../agents/seats/pool-probe.js'
import { runWatchdog, type WatchdogDeps } from '../agents/seats/run.js'
import { keepReading } from '../agents/seats/watchdog.js'

const DAY = 86_400_000
const NOW = new Date(2026, 9, 6, 12, 8).getTime()
/** NOW is 72 h into the window, so the glide target is 49 at reserve 14. */
const RESET_S = Math.round((NOW + 4 * DAY) / 1000)

const CHARTER = `---
owner_seat: seat-a
seats: [seat-a]
pools:
  alpha: {config_dir: /synthetic/alpha, human_uses: false, reserve_seven_day: 14, ceiling_five_hour: 100}
  beta:  {config_dir: /synthetic/beta, human_uses: false, reserve_seven_day: 14, ceiling_five_hour: 100}
---
`
const SEAT = '---\nprefix: sa\npool: alpha\n---\n'

interface Cached {
  sevenDay: number
  ageSeconds: number
  fiveHour?: number
}

const read = ({ sevenDay, ageSeconds, fiveHour = 30 }: Cached): BudgetRead => ({
  found: true,
  path: '/x',
  age_seconds: ageSeconds,
  stale: ageSeconds > 120,
  budget: {
    session_id: 's',
    written_at: 0,
    context: { exceeds_200k: false },
    cost: {},
    rate_limits: {
      five_hour: { used_pct: fiveHour },
      seven_day: { used_pct: sevenDay, resets_at: RESET_S },
    },
  },
})

interface Harness {
  deps: WatchdogDeps
  cache: Record<string, Cached | undefined>
  pace: PaceDoc | undefined
  history: ReadingRow[]
  probed: string[]
  doc: WatchdogDoc
  nowMs: number
}

function harness(): Harness {
  const h: Harness = {
    cache: {
      '/synthetic/alpha': { sevenDay: 41, ageSeconds: 60 },
      '/synthetic/beta': { sevenDay: 60, ageSeconds: 5 },
    },
    pace: undefined,
    history: [],
    probed: [],
    doc: { seats: {}, pools: {}, stopped: {} },
    nowMs: NOW,
    deps: {
      now: () => new Date(h.nowMs),
      readCharter: () => CHARTER,
      readSeatFile: () => SEAT,
      seatLogDays: () => [],
      readSeatLog: () => undefined,
      readBudget: dir => {
        const cached = h.cache[dir]
        return cached === undefined ? { found: false, path: dir, reason: 'no_file' } : read(cached)
      },
      ownerMessages: () => [],
      roster: async () => ({ agents: [], connected: ['seat-a'] }),
      presence: () => undefined,
      eligible: () => ({ count: 0, skipped: 0 }),
      loadDoc: () => structuredClone(h.doc),
      saveDoc: doc => void (h.doc = { ...doc, stopped: {} }),
      wake: async () => ({ ok: true, detail: 'm1' }),
      appendLog: () => undefined,
      lock: () => ({ held: true, release: () => undefined }),
      pace: {
        read: () => h.pace,
        write: doc => void (h.pace = doc),
        append: rows => void h.history.push(...rows),
      },
      probe: dir => {
        h.probed.push(dir)
        h.cache[dir] = { sevenDay: 22, ageSeconds: 0 }
      },
    },
  }
  return h
}

const LIVE = { dryRun: false }

async function pass(h: Harness, minutesLater = 0): Promise<string[]> {
  h.nowMs += minutesLater * 60_000
  return runWatchdog(h.deps, LIVE)
}

describe('the watchdog pass publishes pool pace', () => {
  it('writes a pace row for every charter pool, including one no seat calls home', async () => {
    const h = harness()

    await pass(h)

    expect(h.pace?.at).toBe(NOW)
    expect(h.pace?.pools.alpha).toMatchObject({ sevenDay: 41, target: 49, behind: 8, level: 'behind' })
    expect(h.pace?.pools.beta).toMatchObject({ sevenDay: 60, level: 'on_pace', passesAtLevel: 1 })
  })

  it('appends one history row per pool with the reading and its age', async () => {
    const h = harness()

    await pass(h)

    expect(h.history).toEqual([
      {
        ts: NOW / 1000,
        pool: 'alpha',
        seven_day: 41,
        five_hour: 30,
        resets_at: RESET_S,
        source: 'watchdog',
        age_s: 60,
      },
      {
        ts: NOW / 1000,
        pool: 'beta',
        seven_day: 60,
        five_hour: 30,
        resets_at: RESET_S,
        source: 'watchdog',
        age_s: 5,
      },
    ])
  })

  it('does not append an unchanged reading again, and counts the passes at its level', async () => {
    const h = harness()

    await pass(h)
    await pass(h, 15)

    expect(h.history).toHaveLength(2)
    expect(h.pace?.pools.alpha?.passesAtLevel).toBe(2)
  })

  it('appends one row for the pool whose reading changed, and restarts the count on a new level', async () => {
    const h = harness()
    await pass(h)
    h.cache['/synthetic/alpha'] = { sevenDay: 30, ageSeconds: 10 }

    await pass(h, 15)

    expect(h.history.map(row => `${row.pool} ${row.seven_day}`)).toEqual(['alpha 41', 'beta 60', 'alpha 30'])
    expect(h.pace?.pools.alpha).toMatchObject({ level: 'burn', passesAtLevel: 1 })
    expect(h.pace?.pools.beta?.passesAtLevel).toBe(2)
  })

  it('probes a pool whose reading is over 15 minutes old and paces on the probe reading', async () => {
    const h = harness()
    h.cache['/synthetic/alpha'] = { sevenDay: 41, ageSeconds: 901 }

    await pass(h)

    expect(h.probed).toEqual(['/synthetic/alpha'])
    expect(h.pace?.pools.alpha).toMatchObject({ sevenDay: 22, ageSeconds: 0, stale: false, level: 'burn' })
  })

  it('probes a pool with no reading at all, and leaves it no reading when the probe finds none', async () => {
    const h = harness()
    h.cache['/synthetic/beta'] = undefined
    h.deps.probe = dir => void h.probed.push(dir)

    await pass(h)

    expect(h.probed).toEqual(['/synthetic/beta'])
    expect(h.pace?.pools.beta).toMatchObject({ level: 'no_reading', sevenDay: null })
    expect(h.history.map(row => row.pool)).toEqual(['alpha'])
  })

  it('keeps a stale reading out of the pace levels when nothing can probe', async () => {
    const h = harness()
    h.cache['/synthetic/alpha'] = { sevenDay: 41, ageSeconds: 1200 }
    delete h.deps.probe

    await pass(h)

    expect(h.pace?.pools.alpha).toMatchObject({ stale: true, level: 'stale', ageSeconds: 1200 })
    expect(h.history[0]).toMatchObject({ pool: 'alpha', age_s: 1200 })
  })

  it('writes nothing and probes nothing under --dry-run', async () => {
    const h = harness()
    h.cache['/synthetic/alpha'] = { sevenDay: 41, ageSeconds: 901 }

    await runWatchdog(h.deps, { dryRun: true })

    expect(h.pace).toBeUndefined()
    expect(h.history).toEqual([])
    expect(h.probed).toEqual([])
  })

  it('reports a pace file that cannot be written and still saves the watchdog doc', async () => {
    const h = harness()
    h.deps.pace = {
      ...h.deps.pace!,
      write: () => {
        throw new Error('disk full')
      },
    }

    const lines = await pass(h)

    expect(lines).toContain('Watchdog: pace not published: disk full')
    expect(h.doc.lastReadings?.alpha).toMatchObject({ sevenDay: 41, resetsAt: RESET_S * 1000 })
  })
})

describe('the reading the watchdog keeps', () => {
  it('carries the seven_day reset time', () => {
    const kept = keepReading(
      undefined,
      { ageSeconds: 60, sevenDay: 41, fiveHour: 30, sevenDayResetsAt: 9_000 },
      NOW,
    )

    expect(kept).toEqual({ at: NOW - 60_000, sevenDay: 41, fiveHour: 30, resetsAt: 9_000 })
  })
})

describe('pace files on disk', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  })
  const scratch = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-pace-'))
    dirs.push(dir)
    return dir
  }

  it('reads back the pace doc it wrote, and reads a missing or broken file as none', () => {
    const file = path.join(scratch(), 'state', 'pace.json')
    const doc: PaceDoc = { at: NOW, pools: {} }

    expect(readPaceDoc(file)).toBeUndefined()
    writePaceDoc(doc, file)
    expect(readPaceDoc(file)).toEqual(doc)
    fs.writeFileSync(file, '{"at": "soon"}')
    expect(readPaceDoc(file)).toBeUndefined()
  })

  it('appends history rows as JSON lines after the rows already there', () => {
    const root = scratch()
    const row: ReadingRow = {
      ts: 1,
      pool: 'alpha',
      seven_day: 41,
      five_hour: 30,
      resets_at: 9,
      source: 'watchdog',
      age_s: 60,
    }
    fs.writeFileSync(readingHistoryPath(root), '{"ts": 0, "pool": "alpha"}\n')

    appendReadingRows(root, [row, { ...row, pool: 'beta' }])

    const lines = fs.readFileSync(readingHistoryPath(root), 'utf8').trimEnd().split('\n')
    expect(lines.map(line => (JSON.parse(line) as ReadingRow).pool)).toEqual(['alpha', 'alpha', 'beta'])
  })

  const event = (windows: unknown): string =>
    [
      '{"type":"system","subtype":"init"}',
      'not json',
      JSON.stringify({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'allowed', unifiedWindows: windows },
      }),
      '{"type":"result","is_error":false}',
    ].join('\n')

  const BOTH = {
    five_hour: { utilization: 0.67, resetsAt: 500 },
    seven_day: { utilization: 0.03, resetsAt: RESET_S },
  }

  it('reads both windows from a headless run as percentages', () => {
    expect(parseRateLimits(event(BOTH))).toEqual({
      five_hour: { used_pct: 67, resets_at: 500 },
      seven_day: { used_pct: 3, resets_at: RESET_S },
    })
  })

  it('reads no windows from a run with no event or with one window missing', () => {
    expect(parseRateLimits('{"type":"result"}')).toBeUndefined()
    expect(parseRateLimits(event({ five_hour: { utilization: 0.67 } }))).toBeUndefined()
  })

  it("writes a probe into the pool's status cache, where the account reader finds it as the freshest row", () => {
    const configDir = scratch()
    const write = (file: string, text: string): void => {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, text)
    }

    const ok = probePool(configDir, { run: () => event(BOTH), write, now: () => NOW })

    const found = readAccountBudget(configDir, NOW + 30_000)
    expect(ok).toBe(true)
    expect(found).toMatchObject({ found: true, age_seconds: 30 })
    expect(found.found && found.budget).toMatchObject({
      session_id: PROBE_SESSION,
      rate_limits: { seven_day: { used_pct: 3, resets_at: RESET_S }, five_hour: { used_pct: 67 } },
    })
  })

  it('writes nothing when the headless run fails or carries no reading', () => {
    const written: string[] = []
    const write = (file: string): void => void written.push(file)
    const failing = () => {
      throw new Error('exit 1')
    }

    expect(probePool('/synthetic/alpha', { run: failing, write, now: () => NOW })).toBe(false)
    expect(probePool('/synthetic/alpha', { run: () => '', write, now: () => NOW })).toBe(false)
    expect(written).toEqual([])
  })
})
