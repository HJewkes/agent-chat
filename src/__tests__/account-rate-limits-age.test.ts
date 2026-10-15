import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readAccountBudget } from '../agents/budget.js'
import type { WatchdogDoc } from '../agents/seats/io.js'
import type { PaceDoc, ReadingRow } from '../agents/seats/pace-pass.js'
import { probePool } from '../agents/seats/pool-probe.js'
import { runWatchdog, type WatchdogDeps } from '../agents/seats/run.js'

const NOW = new Date(2026, 9, 6, 12, 8).getTime()
const NOW_S = NOW / 1000
const HOUR_S = 3600
const RESET_S = NOW_S + 4 * 86_400

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})
const scratch = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-1366-'))
  dirs.push(dir)
  return dir
}

function writeStatus(dir: string, id: string, doc: object): void {
  const file = path.join(dir, 'status-cache', 'sessions', `${id}.json`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ session_id: id, ...doc }))
}

/** An idle session restamping a figure from its last API response, 35 h ago. */
function writeRedrawingStale(dir: string): void {
  writeStatus(dir, 'd7508c83', {
    written_at: NOW_S - 10,
    rate_limits: { seven_day: { used_percentage: 74, resets_at: RESET_S } },
    prompt_cache: { ttl: '1h', warm: false, expires_at: NOW_S - 34 * HOUR_S },
  })
}

function writePoller(dir: string, ageS: number): void {
  writeStatus(dir, 'usage-poll', {
    written_at: NOW_S - ageS,
    rate_limits: {
      five_hour: { used_percentage: 9, resets_at: NOW_S + HOUR_S },
      seven_day: { used_percentage: 95, resets_at: RESET_S },
    },
  })
}

describe('an account read is as old as its rate_limits, not its last redraw', () => {
  it('a session redrawing 35 h old rate_limits reads as 35 h old', () => {
    const dir = scratch()
    writeRedrawingStale(dir)

    const read = readAccountBudget(dir, NOW)

    expect(read).toMatchObject({ found: true, age_seconds: 35 * HOUR_S, stale: true })
  })

  it('a live session reads as fresh', () => {
    const dir = scratch()
    writeStatus(dir, 'live', {
      written_at: NOW_S - 10,
      rate_limits: { seven_day: { used_percentage: 40, resets_at: RESET_S } },
      prompt_cache: { ttl: '1h', warm: true, expires_at: NOW_S + HOUR_S - 10 },
    })

    const read = readAccountBudget(dir, NOW)

    expect(read).toMatchObject({ found: true, age_seconds: 10, stale: false })
  })

  it('a 5m ttl is honoured', () => {
    const dir = scratch()
    writeStatus(dir, 'short', {
      written_at: NOW_S - 10,
      rate_limits: { seven_day: { used_percentage: 40, resets_at: RESET_S } },
      prompt_cache: { ttl: '5m', expires_at: NOW_S - 60 },
    })

    expect(readAccountBudget(dir, NOW)).toMatchObject({ found: true, age_seconds: 360 })
  })

  it('a file without prompt_cache ages by written_at', () => {
    const dir = scratch()
    writePoller(dir, 117)

    expect(readAccountBudget(dir, NOW)).toMatchObject({ found: true, age_seconds: 117 })
  })

  it('a fresh poller beats a redrawing stale session', () => {
    const dir = scratch()
    writeRedrawingStale(dir)
    writePoller(dir, 117)

    const read = readAccountBudget(dir, NOW)

    expect(read).toMatchObject({ found: true, age_seconds: 117 })
    expect(read.found && path.basename(read.path)).toBe('usage-poll.json')
    expect(read.found && read.budget.rate_limits).toEqual({
      five_hour: { used_pct: 9, resets_at: NOW_S + HOUR_S },
      seven_day: { used_pct: 95, resets_at: RESET_S },
    })
  })

  it('with every file stale, the youngest is returned and marked stale', () => {
    const dir = scratch()
    writeRedrawingStale(dir)
    writePoller(dir, 20 * 60)

    const read = readAccountBudget(dir, NOW)

    expect(read).toMatchObject({ found: true, age_seconds: 1200, stale: true })
    expect(read.found && read.budget.rate_limits.seven_day?.used_pct).toBe(95)
  })
})

const probeStream = (): string =>
  JSON.stringify({
    type: 'rate_limit_event',
    rate_limit_info: {
      status: 'allowed',
      unifiedWindows: {
        five_hour: { utilization: 0.12, resetsAt: NOW_S + HOUR_S },
        seven_day: { utilization: 0.81, resetsAt: RESET_S },
      },
    },
  })

function writeFile(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

function watchdogDeps(configDir: string, probed: string[], paced: { doc?: PaceDoc }): WatchdogDeps {
  let doc: WatchdogDoc = { seats: {}, pools: {}, stopped: {} }
  const history: ReadingRow[] = []
  return {
    now: () => new Date(NOW),
    readCharter: () =>
      `---\nowner_seat: seat-a\nseats: [seat-a]\npools:\n  alpha: {config_dir: ${configDir}, human_uses: false, reserve_seven_day: 14, ceiling_five_hour: 100}\n---\n`,
    readSeatFile: () => '---\nprefix: sa\npool: alpha\n---\n',
    seatLogDays: () => [],
    readSeatLog: () => undefined,
    readBudget: (dir, nowMs) => readAccountBudget(dir, nowMs),
    ownerMessages: () => [],
    roster: async () => ({ agents: [], connected: ['seat-a'] }),
    presence: () => undefined,
    eligible: () => ({ count: 0, skipped: 0 }),
    loadDoc: () => structuredClone(doc),
    saveDoc: saved => void (doc = { ...saved, stopped: {} }),
    wake: async () => ({ ok: true, detail: 'm1' }),
    appendLog: () => undefined,
    lock: () => ({ held: true, release: () => undefined }),
    pace: {
      read: () => paced.doc,
      write: written => void (paced.doc = written),
      append: rows => void history.push(...rows),
    },
    probe: dir => {
      probed.push(dir)
      return probePool(dir, { run: probeStream, write: writeFile, now: () => NOW })
    },
  }
}

describe('the watchdog probes a pool whose only status file is a redrawing stale session', () => {
  it('calls the probe once and paces on the probe reading', async () => {
    const configDir = scratch()
    writeRedrawingStale(configDir)
    const probed: string[] = []
    const paced: { doc?: PaceDoc } = {}

    await runWatchdog(watchdogDeps(configDir, probed, paced), { dryRun: false })

    expect(probed).toEqual([configDir])
    expect(paced.doc?.pools.alpha).toMatchObject({ sevenDay: 81, ageSeconds: 0 })
  })
})
