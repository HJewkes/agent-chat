import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readAccountBudget } from '../agents/budget.js'
import type { MachineStatus } from '../agents/machine-guard.js'
import type { PacePool } from '../agents/seats/pace-file.js'
import type { PoolPickMode } from '../agents/seats/pool-pick.js'
import { readPoolPick } from '../agents/seats/pool-route.js'
import { readSeatSpawn, type SeatSpawnReadDeps } from '../agents/seats/spawn-gate-read.js'
import { seatSpawnGate } from '../agents/seats/spawn-gate.js'
import { renderBrief, seatStatus, type StatusDeps } from '../agents/seats/status.js'

/**
 * CC-905: `seats status` shows BUDGET-PAUSE only when the broker's seat spawn gate, walked over its pool pick, would
 * refuse the seat's next spawn. Every name, path and reading is synthetic.
 */

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'score-2026-09-29')
const SEAT = 'sample-seat'
const NOW = new Date(2026, 9, 9, 8, 20)
const saved = { ...process.env }

let tmp: string
let autonomy: string

const profileDir = (pool: string): string => path.join(tmp, 'profiles', pool)

function writeCharter(): void {
  const withFields = (text: string, extra: string): string => text.replace(/\n---\n$/, `\n${extra}\n---\n`)
  const read = (file: string): string => fs.readFileSync(path.join(FIXTURE, file), 'utf8')
  const pools = ['agents', 'server']
    .map(name => `  ${name}: {config_dir: ${profileDir(name)}, reserve_seven_day: 14, ceiling_five_hour: 85}`)
    .join('\n')
  fs.mkdirSync(path.join(autonomy, 'seats'), { recursive: true })
  fs.writeFileSync(
    path.join(autonomy, 'charter.md'),
    withFields(read('charter.md'), `pools:\n${pools}\nfunds:\n  default: [agents, server]`),
  )
  fs.writeFileSync(
    path.join(autonomy, 'seats', `${SEAT}.md`),
    withFields(read(`seats/${SEAT}.md`), `prefix: ss\npool: agents\ncwd: ${tmp}`),
  )
}

/** The pool's status file, written `ageSeconds` before NOW. */
function writeReading(pool: string, fiveHour: number, ageSeconds = 30): void {
  const dir = path.join(profileDir(pool), 'status-cache', 'sessions')
  fs.mkdirSync(dir, { recursive: true })
  const rate_limits = { seven_day: { used_pct: 20 }, five_hour: { used_pct: fiveHour } }
  const reading = { session_id: 's1', written_at: NOW.getTime() / 1000 - ageSeconds, rate_limits }
  fs.writeFileSync(path.join(dir, 's1.json'), JSON.stringify(reading))
}

const gateDeps = (): SeatSpawnReadDeps => ({
  readBudget: readAccountBudget,
  loadDoc: () => ({ seats: {}, pools: {}, stopped: {} }),
  home: tmp,
})

const paceRow = (fiveHour: number, behind: number, ageSeconds = 30): PacePool => ({
  behind,
  fiveHour,
  readingAt: NOW.getTime() - ageSeconds * 1000,
})

function deps(mode: PoolPickMode, pace: Record<string, PacePool>): StatusDeps {
  const paceRead = { found: true as const, pools: new Map(Object.entries(pace)) }
  return {
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
    machine: () => ({ holding: null }) as MachineStatus,
    machineStop: () => null,
    nextSpawn: {
      mode,
      pick: spawn =>
        readPoolPick(autonomy, spawn, { readPace: () => paceRead, trusted: () => true, home: tmp }),
      gate: spawn => readSeatSpawn(autonomy, spawn, gateDeps()),
    },
  }
}

/** The broker's own gate on one pool, for a spawn the seat's prefix names. */
function brokerAllows(pool: string): boolean {
  const spawn = { name: 'ss-task', spawner: SEAT, configDir: profileDir(pool), now: NOW }
  const read = readSeatSpawn(autonomy, spawn, gateDeps())
  if (read.kind !== 'gate') throw new Error(`no gate for pool ${pool}`)
  return seatSpawnGate({ ...read.input, model: 'claude-sonnet-5-5' }).allow
}

const stopLine = (lines: string[]): string | undefined => lines.find(l => l.startsWith('stop'))

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ac-next-spawn-')))
  autonomy = path.join(tmp, 'aw', 'claude-channels', 'sources', 'autonomy')
  process.env.AGENT_CHAT_HOME = path.join(tmp, 'home')
  process.env.AGENT_CHAT_ACTIVE_WORK_ROOT = path.join(tmp, 'aw')
  process.env.CLAUDE_PROFILE_ROOT = path.join(tmp, 'profiles')
  delete process.env.AGENT_CHAT_STATUS_CACHE
  writeCharter()
})

afterEach(() => {
  process.env = { ...saved }
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('seats status takes its stop from the broker pool pick (CC-905)', () => {
  it('shows no stop and the next spawn pool when home is over its ceiling and the pick overflows', async () => {
    writeReading('agents', 98)
    writeReading('server', 22)

    const status = await seatStatus(
      deps('enforce', { agents: paceRow(98, 3), server: paceRow(22, 12) }),
      SEAT,
    )

    expect([brokerAllows('agents'), brokerAllows('server')]).toEqual([false, true])
    expect(status.budget.stop).toBeNull()
    expect(status.budget.nextSpawnPool).toBe('server')
    expect(status.budget.margin).toMatch(/^next spawn: pool server: seat sample-seat: /)
    expect(stopLine(renderBrief(status))).toMatch(/none; next spawn: pool server$/)
  })

  it('shows BUDGET-PAUSE when every pool the pick offers is over its ceiling', async () => {
    writeReading('agents', 98)
    writeReading('server', 97)

    const status = await seatStatus(
      deps('enforce', { agents: paceRow(98, 3), server: paceRow(97, 12) }),
      SEAT,
    )

    expect([brokerAllows('agents'), brokerAllows('server')]).toEqual([false, false])
    expect(status.budget.stop).toContain('BUDGET-PAUSE')
    expect(status.budget.nextSpawnPool).toBeNull()
  })

  it('shows BUDGET-PAUSE in shadow mode, where the broker bills the closed home pool', async () => {
    writeReading('agents', 98)
    writeReading('server', 22)

    const status = await seatStatus(deps('shadow', { agents: paceRow(98, 3), server: paceRow(22, 12) }), SEAT)

    expect(brokerAllows('agents')).toBe(false)
    expect(status.budget.stop).toContain('BUDGET-PAUSE')
  })

  it('shows no stop on a stale home reading, which the gate lets through', async () => {
    writeReading('agents', 98, 3600)
    writeReading('server', 97)

    const status = await seatStatus(
      deps('enforce', { agents: paceRow(98, 3, 3600), server: paceRow(97, 12) }),
      SEAT,
    )

    expect(brokerAllows('agents')).toBe(true)
    expect(status.budget.stop).toBeNull()
    expect(status.budget.nextSpawnPool).toBeNull()
  })
})
