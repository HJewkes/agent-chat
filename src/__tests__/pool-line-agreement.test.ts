import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readAccountBudget } from '../agents/budget.js'
import { gateAccount } from '../agents/burndown/budget-gate.js'
import { EMPTY_LEDGER } from '../agents/burndown/ledger.js'
import { renderStatus } from '../agents/burndown/tick.js'
import type { MachineStatus } from '../agents/machine-guard.js'
import { seatStatus, type StatusDeps } from '../agents/seats/status.js'

/**
 * CC-801: `burndown status` and `seats status` judge one pool, at one time, by the same seven_day line
 * and five_hour ceiling, both from the charter's `pools:`. Every name, path and reading is synthetic.
 */

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'score-2026-09-29')
const SEAT = 'sample-seat'
const POOL = 'agents'
const DAY_MS = 24 * 3_600_000
const NOW = new Date(2026, 9, 6, 17, 39)
const DAY = 3
/** A reset 7 - DAY + 0.5 days out puts NOW mid-way through day DAY of the window. */
const RESETS_AT = NOW.getTime() + (7 - DAY + 0.5) * DAY_MS
const saved = { ...process.env }

let tmp: string
let autonomy: string

const profileDir = (): string => path.join(tmp, 'profiles', POOL)

function writeCharter(pools: string, seatPool = POOL): void {
  const withPools = (text: string, extra: string): string => text.replace(/\n---\n$/, `\n${extra}\n---\n`)
  const read = (file: string): string => fs.readFileSync(path.join(FIXTURE, file), 'utf8')
  fs.mkdirSync(path.join(autonomy, 'seats'), { recursive: true })
  fs.writeFileSync(path.join(autonomy, 'charter.md'), withPools(read('charter.md'), `pools:\n${pools}`))
  fs.writeFileSync(
    path.join(autonomy, 'seats', `${SEAT}.md`),
    withPools(read(`seats/${SEAT}.md`), `prefix: ss\npool: ${seatPool}`),
  )
}

/** The pool's status file, as the status line writes it, 30 seconds before NOW. */
function writeReading(sevenDay: number, fiveHour: number): void {
  const dir = path.join(profileDir(), 'status-cache', 'sessions')
  fs.mkdirSync(dir, { recursive: true })
  const rate_limits = {
    seven_day: { used_pct: sevenDay, resets_at: RESETS_AT / 1000 },
    five_hour: { used_pct: fiveHour },
  }
  const reading = { session_id: 's1', written_at: NOW.getTime() / 1000 - 30, rate_limits }
  fs.writeFileSync(path.join(dir, 's1.json'), JSON.stringify(reading))
}

const deps = (): StatusDeps => ({
  now: () => NOW,
  autonomyRoot: autonomy,
  homeDir: tmp,
  agents: async () => [],
  waitingOwner: async () => [],
  readBudget: (dir, nowMs) => readAccountBudget(dir, nowMs),
  loadDoc: () => ({ seats: {}, pools: {}, stopped: {} }),
  inbox: () => ({ unread: 0, sinceLastSend: null }),
  poolPicks: () => [],
  scored: () => {
    throw new Error('not scored here')
  },
  machine: () => ({}) as MachineStatus,
  machineStop: () => null,
})

const burndownLine = (): string =>
  renderStatus(EMPTY_LEDGER, NOW, autonomy).find(l => l.startsWith(`account ${POOL}:`)) ?? ''

const seatsBudget = async () => (await seatStatus(deps(), SEAT)).budget

/** The seven_day line and five_hour ceiling a status line quotes. */
const figures = (text: string): { line: number; ceiling: number } => ({
  line: Number(/vs line ([\d.]+)%/.exec(text)?.[1]),
  ceiling: Number(/vs ceiling ([\d.]+)%/.exec(text)?.[1]),
})

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ac-pool-line-')))
  autonomy = path.join(tmp, 'aw', 'claude-channels', 'sources', 'autonomy')
  process.env.AGENT_CHAT_HOME = path.join(tmp, 'home')
  process.env.AGENT_CHAT_ACTIVE_WORK_ROOT = path.join(tmp, 'aw')
  process.env.CLAUDE_PROFILE_ROOT = path.join(tmp, 'profiles')
  delete process.env.AGENT_CHAT_STATUS_CACHE
})

afterEach(() => {
  process.env = { ...saved }
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('burndown status and seats status read one pool line (CC-801)', () => {
  it.each([
    { humanUses: false, ceiling: 100 },
    { humanUses: true, ceiling: 70 },
  ])(
    'print the same line and ceiling for a pool with human_uses $humanUses on day 3',
    async ({ humanUses, ceiling }) => {
      writeCharter(
        `  ${POOL}: {config_dir: ${profileDir()}, human_uses: ${humanUses}, reserve_seven_day: 14, ceiling_five_hour: 100}`,
      )
      writeReading(73, 9)

      const burndown = burndownLine()
      const seats = await seatsBudget()

      expect(burndown).toContain(`(day ${DAY} of 7`)
      expect(seats.margin).toContain(`(day ${DAY} of 7`)
      expect(figures(burndown)).toEqual({ line: 100 - (14 * (8 - DAY)) / 7, ceiling })
      expect(figures(seats.margin ?? '')).toEqual(figures(burndown))
    },
  )

  it('refuse a pool the charter lacks, each naming it', async () => {
    writeCharter(
      `  other: {config_dir: ${profileDir()}, human_uses: false, reserve_seven_day: 14, ceiling_five_hour: 100}`,
    )
    writeReading(10, 5)
    const reading = { sevenDay: 10, fiveHour: 5, ageSeconds: 30, sevenDayResetsAt: RESETS_AT }

    const tick = gateAccount(POOL, undefined, reading, { now: NOW })
    const seats = await seatsBudget()

    expect(burndownLine()).toBe('')
    expect(tick).toEqual({
      open: false,
      account: POOL,
      reason: `pool ${POOL}: no reserve_seven_day and ceiling_five_hour for this pool in the charter`,
    })
    expect(seats.stop).toBe(
      `BUDGET-PAUSE pool ${POOL}: no reserve_seven_day and ceiling_five_hour for this pool in the charter`,
    )
  })
})
