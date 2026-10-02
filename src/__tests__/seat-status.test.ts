import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stringify } from 'yaml'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readAccountBudget } from '../agents/budget.js'
import { scoredPlanFromDisk } from '../agents/burndown/score-render.js'
import { dayStart } from '../agents/burndown/budget-gate.js'
import { readDoc, type SeatRecord, type WatchdogDoc } from '../agents/seats/io.js'
import {
  STATUS_TOP,
  readInbox,
  seatStatus,
  type SeatStatus,
  type StatusDeps,
} from '../agents/seats/status.js'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { SocketServer } from '../broker/socket.js'
import { withBroker } from '../cli/client.js'
import { seatsStatusVerb, statusReport } from '../cli/verbs/seats.js'
import type { IsolationName, ServerMessage } from '../protocol.js'
import {
  countLiveHeadless,
  machineStatus,
  type MemoryReading,
  type SwapReading,
} from '../agents/machine-guard.js'
import { machineStop } from '../agents/seats/stops.js'

/**
 * CC-317: `seats status` answers a seat's tick questions in one read-only call.
 * The broker, the autonomy root, the pool's status file and every name are synthetic.
 */

// A mutant that lets the verb autostart must not leave a real broker running.
vi.mock('node:child_process', async original => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: vi.fn(() => ({ unref: () => undefined })),
}))

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'score-2026-09-29')
const fixture = (file: string) => fs.readFileSync(path.join(FIXTURE, file), 'utf8')

const SEAT = 'sample-seat'
const POOL = 'pool-a'
const NOW = new Date(2026, 8, 29, 10, 0)
const DAY_MS = 24 * 3_600_000
/** Epoch ms of `hour:minute` on the fixture's day. */
const at = (hour: number, minute = 0): number => new Date(2026, 8, 29, hour, minute).getTime()

interface Spend {
  per_run_points?: number
  per_day_points?: number
}

const seatExtra = (spend: Spend, concurrency: string): string =>
  ['prefix: ss', `pool: ${POOL}`, `concurrency: ${concurrency}`, `spend: ${JSON.stringify(spend)}`].join('\n')

interface Wire {
  conn: Conn
  frames: ServerMessage[]
}

let tmp: string
let autonomy: string
let activeWork: string
let poolDir: string
let core: BrokerCore
let server: SocketServer
let doc: WatchdogDoc
let agentIds = 0

const beforeFrontmatterEnd = (text: string, extra: string): string =>
  text.replace(/\n---\n$/, `\n${extra}\n---\n`)

interface AutonomyOptions {
  spend?: Spend
  concurrency?: string
  /** Written under `~` by default, which the status expands against its home directory. */
  configDir?: string
  /** Extra seat frontmatter lines, such as `pacing: reset-aware`. */
  seatLines?: string
}

function writeAutonomy(options: AutonomyOptions = {}): void {
  const {
    spend = { per_day_points: 10 },
    concurrency = '{implementers: 2, reviewers: 1, planners: 3}',
    configDir = '~/pool',
    seatLines = '',
  } = options
  const pools = `pools:\n  ${POOL}: {config_dir: ${configDir}, human_uses: false, reserve_seven_day: 35, ceiling_five_hour: 70}`
  fs.mkdirSync(path.join(autonomy, 'seats'), { recursive: true })
  fs.writeFileSync(path.join(autonomy, 'charter.md'), beforeFrontmatterEnd(fixture('charter.md'), pools))
  fs.writeFileSync(
    path.join(autonomy, 'seats', `${SEAT}.md`),
    beforeFrontmatterEnd(
      fixture('seats/sample-seat.md'),
      [seatExtra(spend, concurrency), seatLines].filter(Boolean).join('\n'),
    ),
  )
}

function writeTasks(): void {
  const { tasks } = JSON.parse(fixture('tasks.json')) as { tasks: { id: string; slug: string }[] }
  for (const task of tasks) {
    const dir = path.join(activeWork, task.slug, 'tasks')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${task.id}.yml`), stringify(task))
    fs.writeFileSync(path.join(activeWork, task.slug, 'brief.md'), '---\nstate: focused\n---\n')
  }
}

/** The pool's status file, as the status line writes it, `ageSeconds` before `now`; `resetsAt` is epoch ms. */
function writeReading(
  fiveHour: number,
  sevenDay: number,
  ageSeconds = 30,
  now = NOW,
  resetsAt?: number,
): void {
  const dir = path.join(poolDir, 'status-cache', 'sessions')
  fs.mkdirSync(dir, { recursive: true })
  const sevenDayWindow = {
    used_pct: sevenDay,
    ...(resetsAt === undefined ? {} : { resets_at: resetsAt / 1000 }),
  }
  const reading = {
    session_id: 'session-1',
    written_at: now.getTime() / 1000 - ageSeconds,
    rate_limits: { five_hour: { used_pct: fiveHour }, seven_day: sevenDayWindow },
  }
  fs.writeFileSync(path.join(dir, 'session-1.json'), JSON.stringify(reading))
}

/** A status file the status line wrote just after a five-hour window reset, which carries no `five_hour`. */
function writeWindowless(sevenDay: number): void {
  const dir = path.join(poolDir, 'status-cache', 'sessions')
  fs.mkdirSync(dir, { recursive: true })
  const reading = {
    session_id: 'session-1',
    written_at: NOW.getTime() / 1000 - 30,
    rate_limits: { seven_day: { used_pct: sevenDay } },
  }
  fs.writeFileSync(path.join(dir, 'session-1.json'), JSON.stringify(reading))
}

const wire = (): Wire => {
  const frames: ServerMessage[] = []
  const conn = { write: (line: string) => frames.push(JSON.parse(line) as ServerMessage) } as unknown as Conn
  return { conn, frames }
}

function join(name: string): Wire {
  const w = wire()
  server.handleMessage(w.conn, { t: 'register', name, workingOn: 'testing', cwd: tmp, pid: 1 })
  return w
}

const send = (from: Wire, to: string, text: string): void =>
  server.handleMessage(from.conn, { t: 'send', to, text })

interface AgentSeed {
  name: string
  profile: string
  spawnedBy?: string
  exited?: boolean
  detached?: boolean
  cwd?: string
  isolation?: IsolationName
  surface?: string
}

const GIB = 1024 ** 3
let swap: SwapReading
let memory: MemoryReading
let pressure: { memoryFreePercent: number | null; load5: number | null }

function seedAgent(seed: AgentSeed): void {
  const { name, profile, spawnedBy = SEAT, cwd = tmp, isolation = 'worktree', surface = 'headless' } = seed
  const id = `agent-${++agentIds}`
  core.append({
    kind: 'agent_spawned',
    actor: spawnedBy,
    target: name,
    msgId: id,
    body: 'synthetic brief',
    meta: { profile, cwd, isolation, surface },
  })
  core.append({ kind: 'agent_attached', actor: name, ref: id })
  if (seed.detached) core.append({ kind: 'agent_detached', actor: name, ref: id })
  if (seed.exited) core.append({ kind: 'agent_exited', actor: name, ref: id })
}

function deps(over: Partial<StatusDeps> = {}): StatusDeps {
  return {
    now: () => NOW,
    autonomyRoot: autonomy,
    homeDir: tmp,
    agents: async () => {
      const w = wire()
      server.handleMessage(w.conn, { t: 'agents' })
      const reply = w.frames.find(f => f.t === 'agents_result')
      return reply?.t === 'agents_result' ? reply.agents : []
    },
    readBudget: (dir, nowMs) => readAccountBudget(dir, nowMs),
    loadDoc: () => structuredClone(doc),
    inbox: seat => readInbox(path.join(tmp, 'events.db'), seat),
    scored: (seat, today) =>
      scoredPlanFromDisk({
        seat,
        top: STATUS_TOP,
        today,
        autonomyRoot: autonomy,
        activeWorkRoot: activeWork,
      }),
    machine: agents =>
      machineStatus(
        { liveHeadless: countLiveHeadless(agents), memory, swap },
        { headlessAgents: 10, memoryFreePercent: 15 },
        { inUse: 1, total: 4 },
      ),
    machineStop: () => machineStop(pressure, { memoryFreePercent: 20, load5: 28 }),
    ...over,
  }
}

const status = (over: Partial<StatusDeps> = {}): Promise<SeatStatus> => seatStatus(deps(over), SEAT)

/** The scorer's real plan for the fixture, for a test that changes one part of it. */
const fixturePlan = () => deps().scored(SEAT, '2026-09-29')

const scorerExplodes = (): never => {
  throw new Error('scorer exploded')
}

beforeEach(() => {
  pressure = { memoryFreePercent: 60, load5: 2 }
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ac-seat-status-')))
  autonomy = path.join(tmp, 'autonomy')
  activeWork = path.join(tmp, 'active-work')
  poolDir = path.join(tmp, 'pool')
  doc = { seats: {}, pools: { [POOL]: { since: at(7), last: 41, spent: 0 } }, stopped: {} }
  swap = { usedBytes: 2 * GIB, totalBytes: 8 * GIB }
  memory = { freePercent: 50 }
  writeAutonomy()
  writeTasks()
  writeReading(12, 41)
  core = new BrokerCore((conn, message) => void conn.write(JSON.stringify({ t: 'deliver', message })), {
    events: new EventLog(path.join(tmp, 'events.db')),
    registry: new Registry<Conn>(),
  })
  server = new SocketServer(core)
})

afterEach(() => {
  server.close()
  core.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('a seat against its concurrency caps', () => {
  it('reports a seat with as many running implementers as its cap as at cap', async () => {
    seedAgent({ name: 'ss-al-1', profile: 'implementer', spawnedBy: 'an-earlier-generation' })
    seedAgent({ name: 'helper', profile: 'bd-implementer-lite' })
    seedAgent({ name: 'zz-be-2', profile: 'implementer', spawnedBy: 'other-seat' })

    const { implementers } = await status()

    expect(implementers).toEqual({
      active: 2,
      cap: 2,
      atCap: true,
      names: ['helper', 'ss-al-1'],
      detached: [],
    })
  })

  it('reports a seat one implementer under its cap as not at cap', async () => {
    seedAgent({ name: 'ss-al-1', profile: 'implementer' })

    const { implementers } = await status()

    expect(implementers).toMatchObject({ active: 1, cap: 2, atCap: false })
  })

  it("leaves out another seat's agent whose name only starts with the seat's prefix letters", async () => {
    seedAgent({ name: 'ssx-be-3', profile: 'implementer', spawnedBy: 'other-seat' })

    const { implementers } = await status()

    expect(implementers.names).toEqual([])
  })

  it('counts a detached implementer as active and names it as detached', async () => {
    seedAgent({ name: 'ss-al-1', profile: 'implementer' })
    seedAgent({ name: 'ss-al-2', profile: 'implementer', detached: true })

    const report = await statusReport(deps(), SEAT, false)
    const { implementers } = await status()

    expect(implementers).toMatchObject({ active: 2, atCap: true, detached: ['ss-al-2'] })
    expect(report.lines[1]).toBe('implementers  2/2  AT CAP  ss-al-1, ss-al-2  detached: ss-al-2')
  })

  it('counts running reviewers and planners against their own caps', async () => {
    seedAgent({ name: 'ss-al-1-review', profile: 'reviewer' })
    seedAgent({ name: 'ss-al-9-review', profile: 'reviewer', exited: true })

    const { reviewers, planners } = await status()

    expect(reviewers).toEqual({ active: 1, cap: 1, atCap: true, names: ['ss-al-1-review'], detached: [] })
    expect(planners).toEqual({ active: 0, cap: 3, atCap: false, names: [], detached: [] })
  })

  it('lists a running agent whose profile names no role under other, with no cap', async () => {
    seedAgent({ name: 'ss-scout', profile: 'researcher' })
    seedAgent({ name: 'ss-scribe', profile: 'docs-writer', detached: true })
    seedAgent({ name: 'ss-gone', profile: 'researcher', exited: true })

    const result = await status()
    const report = await statusReport(deps(), SEAT, false)

    expect(result.other).toEqual({ active: 2, names: ['ss-scout', 'ss-scribe'], detached: ['ss-scribe'] })
    expect(result.implementers.active + result.reviewers.active + result.planners.active).toBe(0)
    expect(report.lines[4]).toBe('other         2  ss-scout, ss-scribe  detached: ss-scribe')
  })

  it('counts an agent whose profile names two roles once, as an implementer', async () => {
    seedAgent({ name: 'ss-al-5', profile: 'implementer-reviewer' })

    const result = await status()

    expect(result.implementers.names).toEqual(['ss-al-5'])
    expect(result.reviewers.names).toEqual([])
    expect(result.other.names).toEqual([])
  })

  it('counts exited implementers as parked and names the ones whose tree is still on disk', async () => {
    seedAgent({ name: 'ss-al-3', profile: 'implementer', exited: true, cwd: path.join(tmp, 'removed-tree') })
    seedAgent({ name: 'ss-al-4', profile: 'implementer', exited: true, cwd: autonomy })

    const { parked, implementers } = await status()

    expect(parked).toEqual({ count: 2, names: ['ss-al-3', 'ss-al-4'], treeOnDisk: ['ss-al-4'] })
    expect(implementers.active).toBe(0)
  })

  it('counts no exited reviewer or roleless agent as parked', async () => {
    seedAgent({ name: 'ss-al-9-review', profile: 'reviewer', exited: true })
    seedAgent({ name: 'ss-gone', profile: 'researcher', exited: true })

    const { parked } = await status()

    expect(parked).toEqual({ count: 0, names: [], treeOnDisk: [] })
  })

  it('names no tree on disk for a parked implementer that ran without a worktree', async () => {
    seedAgent({ name: 'ss-al-6', profile: 'implementer', exited: true, cwd: autonomy, isolation: 'none' })

    const { parked } = await status()

    expect(parked).toEqual({ count: 1, names: ['ss-al-6'], treeOnDisk: [] })
  })
})

describe("the seat's pool reading and charter stop", () => {
  it('reports both windows with the reading age and no stop while the gate is open', async () => {
    const { budget } = await status()

    expect(budget).toMatchObject({
      pool: POOL,
      sevenDay: 41,
      fiveHour: 12,
      ageSeconds: 30,
      stale: false,
      stop: null,
      sonnetOnly: false,
      spendSince: null,
      note: null,
    })
    expect(budget.margin).toContain('seven_day 41% vs line 65%')
  })

  it('names the stop for a seat past its seven_day line', async () => {
    writeReading(12, 70)

    const { budget } = await status()

    expect(budget.stop).toBe(`BUDGET-PAUSE pool ${POOL}: seven_day 70% at or above line 65%`)
    expect(budget.margin).toBeNull()
  })

  it('reports an open gate within ten points of its line as sonnet only', async () => {
    writeReading(12, 58)
    doc.pools[POOL] = { since: at(7), last: 58, spent: 0 }

    const { budget } = await status()

    expect(budget).toMatchObject({ stop: null, sonnetOnly: true })
  })

  it('shows the age of a stale reading and closes the gate on it', async () => {
    writeReading(12, 41, 1200)

    const { budget } = await status()

    expect(budget).toMatchObject({ sevenDay: 41, ageSeconds: 1200, stale: true })
    expect(budget.stop).toContain('reading is 1200s old')
  })

  it('reports a pool with no status file as having no reading, and stops on it', async () => {
    fs.rmSync(poolDir, { recursive: true })

    const report = await statusReport(deps(), SEAT, false)
    const { budget } = await status()

    expect(budget).toMatchObject({ sevenDay: null, fiveHour: null, ageSeconds: null, stale: true })
    expect(budget.stop).toContain('no seven_day and five_hour reading')
    expect(report.lines[6]).toBe(`budget        pool ${POOL}: no reading`)
  })
})

describe("a current reading that lacks a window, against the pool's last good one (CC-409)", () => {
  const NO_READING = `BUDGET-PAUSE pool ${POOL}: no seven_day and five_hour reading for this pool`
  const keep = (minutesAgo: number, sevenDay: number, fiveHour: number): void => {
    doc.lastReadings = { [POOL]: { at: NOW.getTime() - minutesAgo * 60_000, sevenDay, fiveHour } }
  }

  beforeEach(() => writeWindowless(41))

  it('opens on the current seven_day and a 30-minute-old five_hour with margin, flagged stale-ok', async () => {
    keep(30, 35, 12)

    const { budget } = await status()
    const report = await statusReport(deps(), SEAT, true)
    const table = await statusReport(deps(), SEAT, false)

    expect(budget).toMatchObject({ stop: null, sevenDay: 41, fiveHour: 12, ageSeconds: 1800, staleOk: true })
    expect(budget.margin).toContain('seven_day 41% vs line 65%')
    expect(budget.margin).toContain('stale-ok: last good reading 1800s old')
    expect(JSON.parse(report.lines.join('\n'))).toMatchObject({ budget: { staleOk: true, stale: true } })
    expect(table.lines[6]).toBe(
      `budget        pool ${POOL}: seven_day 41%, five_hour 12% (last good reading 1800s old, STALE-OK)`,
    )
  })

  it('stops on a current seven_day over the line though the stored one is well under it', async () => {
    writeWindowless(70)
    keep(30, 35, 12)

    const { budget } = await status()

    expect(budget.stop).toBe(`BUDGET-PAUSE pool ${POOL}: seven_day 70% at or above line 65%`)
    expect(budget.margin).toBeNull()
  })

  it('opens on a current seven_day under the line and a stored five_hour exactly 10 under the ceiling', async () => {
    keep(30, 63, 60)

    const { budget } = await status()

    expect(budget).toMatchObject({ stop: null, staleOk: true, sevenDay: 41, fiveHour: 60 })
  })

  it('counts day spend from the current seven_day, not the stored one', async () => {
    writeWindowless(52)
    keep(30, 41, 12)

    const { budget } = await status()

    expect(budget.stop).toBe(
      `BUDGET-PAUSE pool ${POOL}: day spend 11 points since 07:00 at or above the seat's per_day_points 10`,
    )
  })

  it('opens on the stored day-spend figure only when the current reading has no seven_day either', async () => {
    fs.rmSync(poolDir, { recursive: true })
    keep(30, 41, 12)

    const { budget } = await status()

    expect(budget).toMatchObject({ stop: null, staleOk: true, sevenDay: 41 })
  })

  it.each([
    ['a borrowed five_hour within 10 points of the ceiling', 41, 61, false],
    ['a borrowed seven_day within 5 points of the line', 61, 12, true],
  ])('stops on %s', async (_name, sevenDay, fiveHour, noFile) => {
    if (noFile) fs.rmSync(poolDir, { recursive: true })
    keep(30, sevenDay, fiveHour)
    doc.pools[POOL] = { since: at(7), last: sevenDay, spent: 0 }

    const { budget } = await status()

    expect(budget.stop?.startsWith(NO_READING)).toBe(true)
  })

  it('opens with no status file on a stored reading exactly 5 under the line and 10 under the ceiling', async () => {
    fs.rmSync(poolDir, { recursive: true })
    keep(30, 60, 60)
    doc.pools[POOL] = { since: at(7), last: 60, spent: 0 }

    const { budget } = await status()

    expect(budget).toMatchObject({ stop: null, staleOk: true })
  })

  it('stops on a last good reading 90 minutes old', async () => {
    keep(90, 41, 12)

    const { budget } = await status()

    expect(budget.stop?.startsWith(NO_READING)).toBe(true)
  })

  it('stops with no last good reading', async () => {
    const { budget } = await status()

    expect(budget.stop).toBe(NO_READING)
  })
})

describe("the seat's spend caps", () => {
  const statePath = (): string => path.join(tmp, 'seat-watchdog.json')
  const fromDisk = (): Promise<SeatStatus> => status({ loadDoc: () => readDoc(statePath()) })
  const stopOf = (why: string): string => `BUDGET-PAUSE pool ${POOL}: ${why}`
  const RUN_UNKNOWN = stopOf('no seven_day reading at run start, so run spend is unknown')
  const DAY_UNKNOWN = stopOf('no seven_day reading at or before 07:00, so day spend unknown')
  const dayMeter = { since: at(7), last: 40, spent: 8 }

  it('stops a per_day cap as unknown when the watchdog has saved no state file', async () => {
    const { budget } = await fromDisk()

    expect(budget).toMatchObject({ stop: DAY_UNKNOWN, margin: null })
  })

  it('stops a per_run cap as unknown when the watchdog has saved no state file', async () => {
    writeAutonomy({ spend: { per_run_points: 5 } })

    const { budget } = await fromDisk()

    expect(budget.stop).toBe(RUN_UNKNOWN)
  })

  it('opens the gate for a seat with no spend cap and no state file', async () => {
    writeAutonomy({ spend: {} })

    const { budget } = await fromDisk()

    expect(budget.stop).toBeNull()
  })

  it('stops on a state file that does not parse, and names the failure', async () => {
    fs.writeFileSync(statePath(), '{"pools": ')

    const { budget } = await fromDisk()

    expect(budget.stop).toMatch(
      new RegExp(
        `^BUDGET-PAUSE pool ${POOL}: seat-watchdog.json is not valid JSON: .*, so spend is unknown$`,
      ),
    )
    expect(budget).toMatchObject({ margin: null, sonnetOnly: false })
    expect(budget.stop).not.toContain(tmp)
  })

  it('stops on a state file that holds no object, even with no spend cap set', async () => {
    writeAutonomy({ spend: {} })
    fs.writeFileSync(statePath(), '[]')

    const { budget } = await fromDisk()

    expect(budget.stop).toBe(stopOf('seat-watchdog.json does not hold a JSON object, so spend is unknown'))
  })

  it('reads the saved day meter from the state file', async () => {
    fs.writeFileSync(statePath(), JSON.stringify({ pools: { [POOL]: dayMeter } }))

    const { budget } = await fromDisk()

    expect(budget.stop).toBeNull()
  })

  it('stops a per_run cap as unknown for a seat record that holds no run meter', async () => {
    writeAutonomy({ spend: { per_run_points: 5 } })
    doc.seats[SEAT] = { idleRuns: 0, at: at(9, 45) }

    const { budget } = await status()

    expect(budget.stop).toBe(RUN_UNKNOWN)
  })

  it('stops a per_run cap as unknown for a run meter that holds no figures', async () => {
    writeAutonomy({ spend: { per_run_points: 5 } })
    doc.seats[SEAT] = { idleRuns: 0, at: at(9, 45), run: {} } as unknown as SeatRecord

    const { budget } = await status()

    expect(budget.stop).toBe(RUN_UNKNOWN)
  })

  it('stops a per_day cap as unknown when the day meter is saved under another pool', async () => {
    doc.pools = { 'pool-b': dayMeter }

    const { budget } = await status()

    expect(budget.stop).toBe(DAY_UNKNOWN)
  })

  it('opens the gate on a saved run meter below the per_run cap', async () => {
    writeAutonomy({ spend: { per_run_points: 5, per_day_points: 10 } })
    doc.pools[POOL] = dayMeter
    doc.seats[SEAT] = { idleRuns: 0, at: at(9, 45), run: { since: at(9), last: 40, spent: 2 } }

    const { budget } = await status()

    expect(budget.stop).toBeNull()
    expect(budget.margin).toContain('seven_day 41% vs line 65%')
  })

  it('stops on a saved run meter that this reading brings to the per_run cap', async () => {
    writeAutonomy({ spend: { per_run_points: 5, per_day_points: 10 } })
    doc.pools[POOL] = dayMeter
    doc.seats[SEAT] = { idleRuns: 0, at: at(9, 45), run: { since: at(9), last: 40, spent: 4 } }

    const { budget } = await status()

    expect(budget.stop).toBe(stopOf("run spend 5 points at or above the seat's per_run_points 5"))
  })

  it('counts a run meter older than 12 hours from its last reading, not from zero', async () => {
    writeAutonomy({ spend: { per_run_points: 5 } })
    doc.pools[POOL] = dayMeter
    doc.seats[SEAT] = { idleRuns: 0, at: at(9, 45), run: { since: at(9) - DAY_MS, last: 30, spent: 20 } }

    const { budget } = await status()

    expect(budget.stop).toBe(stopOf("run spend 11 points at or above the seat's per_run_points 5"))
  })

  it("names the day spend stop from the watchdog's saved pool meter", async () => {
    doc.pools[POOL] = { since: at(7), last: 30, spent: 0 }

    const { budget } = await status()

    expect(budget.stop).toBe(
      stopOf("day spend 11 points since 07:00 at or above the seat's per_day_points 10"),
    )
    expect(budget.spendSince).toBeNull()
  })

  it("counts the day's spend from yesterday's last reading when the day meter is from yesterday", async () => {
    doc.pools[POOL] = { since: at(7) - DAY_MS, last: 30, spent: 25 }

    const { budget } = await status()

    expect(budget.stop).toBe(
      stopOf("day spend 11 points since 07:00 at or above the seat's per_day_points 10"),
    )
    expect(budget).toMatchObject({ spendSince: null, note: null })
  })

  it('opens the gate on a day meter from yesterday whose last reading is under the cap away', async () => {
    doc.pools[POOL] = { since: at(7) - DAY_MS, last: 35, spent: 25 }

    const { budget } = await status()

    expect(budget).toMatchObject({ stop: null, spendSince: null })
  })

  it("says the day's spend counts from the first sample when the day meter started after 07:00", async () => {
    doc.pools[POOL] = { since: at(7, 30), last: 40, spent: 0 }
    const since = new Date(at(7, 30)).toISOString()
    const note = `no seven_day reading at or before 07:00, so the day's spend counts from the first sample at ${since}`

    const { budget } = await status()
    const report = await statusReport(deps(), SEAT, false)

    expect(budget).toMatchObject({ stop: null, spendSince: since, note })
    expect(report.lines[8]).toBe(`note          ${note}`)
  })

  it('keeps the late start note on a day meter that is also at its cap', async () => {
    doc.pools[POOL] = { since: at(7, 30), last: 30, spent: 0 }

    const { budget } = await status()

    expect(budget.stop).toContain('day spend 11 points')
    expect(budget.spendSince).toBe(new Date(at(7, 30)).toISOString())
  })
})

describe('reset-aware day pacing (CC-404)', () => {
  const PACED = 'pacing: reset-aware'
  const stopOf = (why: string): string => `BUDGET-PAUSE pool ${POOL}: ${why}`
  const resetIn = (days: number): number => NOW.getTime() + days * DAY_MS
  const pacedAt = (days: number): void => {
    writeAutonomy({ seatLines: PACED })
    writeReading(12, 41, 30, NOW, resetIn(days))
    doc.pools[POOL] = { since: at(7), last: 30, spent: 0 }
  }

  it.each([
    [0.5, 48],
    [3, 8],
    [6, 4],
  ])('allows (65 - 41) / %s days to reset = %s points a day', async (days, points) => {
    pacedAt(days)

    const { budget } = await status()

    expect(budget.allowance).toEqual({
      source: 'reset-aware',
      points,
      stopLine: 65,
      sevenDay: 41,
      daysToReset: days,
      resetsAt: new Date(resetIn(days)).toISOString(),
    })
  })

  it('opens on day spend over per_day_points when the reset is half a day away', async () => {
    pacedAt(0.5)

    const { budget } = await status()

    expect(budget.stop).toBeNull()
  })

  it('stops on day spend at or above an allowance smaller than per_day_points', async () => {
    pacedAt(3)

    const { budget } = await status()

    expect(budget.stop).toBe(
      stopOf("day spend 11 points since 07:00 at or above the seat's reset-aware day allowance 8"),
    )
  })

  it('falls back to per_day_points when the reading carries no resets_at', async () => {
    writeAutonomy({ seatLines: PACED })
    doc.pools[POOL] = { since: at(7), last: 30, spent: 0 }

    const { budget } = await status()

    expect(budget.allowance).toMatchObject({ source: 'per_day_points', points: 10, resetsAt: null })
    expect(budget.stop).toBe(
      stopOf("day spend 11 points since 07:00 at or above the seat's per_day_points 10"),
    )
  })

  it('falls back to per_day_points when resets_at has passed', async () => {
    writeAutonomy({ seatLines: PACED })
    writeReading(12, 41, 30, NOW, resetIn(-0.1))

    const { budget } = await status()

    expect(budget.allowance).toMatchObject({ source: 'per_day_points', points: 10, daysToReset: -0.1 })
  })

  it('keeps the per_day_points stop for a seat without the key, whatever the reset', async () => {
    writeReading(12, 41, 30, NOW, resetIn(0.5))
    doc.pools[POOL] = { since: at(7), last: 30, spent: 0 }

    const { budget } = await status()

    expect(budget.allowance).toMatchObject({ source: 'per_day_points', points: 10 })
    expect(budget.stop).toBe(
      stopOf("day spend 11 points since 07:00 at or above the seat's per_day_points 10"),
    )
  })

  it('prints a pacing line only for a reset-aware seat', async () => {
    pacedAt(6)
    const paced = await statusReport(deps(), SEAT, false)
    writeAutonomy()
    const plain = await statusReport(deps(), SEAT, false)

    expect(paced.lines).toContain(
      `pacing        reset-aware: 4 points/day = (65 - 41) / 6 days to reset at ${new Date(resetIn(6)).toISOString()}`,
    )
    expect(plain.lines.some(l => l.startsWith('pacing'))).toBe(false)
  })
})

describe("the seat's unread inbox", () => {
  it('reports an empty inbox when only other sessions have mail', async () => {
    join(SEAT)
    join('peer-c')
    const peer = join('peer-b')
    send(peer, 'peer-c', 'not for the seat')
    send(peer, 'peer-c', 'nor is this')

    const { inbox } = await status()

    expect(inbox).toEqual({ unread: 0, sinceLastSend: null })
  })

  it('counts only the messages that arrived after the seat last sent one', async () => {
    const seat = join(SEAT)
    const peer = join('peer-b')
    send(peer, SEAT, 'first')
    send(peer, SEAT, 'second')
    send(seat, 'peer-b', 'handled both')
    send(peer, SEAT, 'third')

    const { inbox } = await status()

    expect(inbox.unread).toBe(1)
    expect(inbox.sinceLastSend).not.toBeNull()
  })

  it('keeps a message unread after the seat tags itself', async () => {
    const seat = join(SEAT)
    const peer = join('peer-b')
    send(peer, SEAT, 'first')
    server.handleMessage(seat.conn, { t: 'tag', add: ['dispatching'] })
    const notices = core.events.activityFor(SEAT, 10).filter(row => row.kind === 'notice')

    const { inbox } = await status()

    expect(notices).toHaveLength(1)
    expect(inbox).toEqual({ unread: 1, sinceLastSend: null })
  })

  it('keeps a message unread after the seat asks the owner a question', async () => {
    const seat = join(SEAT)
    const peer = join('peer-b')
    send(peer, SEAT, 'first')
    server.handleMessage(seat.conn, { t: 'ask', text: 'May the seat dispatch?' })

    const { inbox } = await status()

    expect(seat.frames.at(-1)).toMatchObject({ t: 'send_result', ok: true })
    expect(inbox).toEqual({ unread: 1, sinceLastSend: null })
  })

  it('counts a broadcast that reached the seat', async () => {
    join(SEAT)
    const peer = join('peer-b')
    server.handleMessage(peer.conn, { t: 'broadcast', text: 'to everyone' })

    const { inbox } = await status()

    expect(inbox.unread).toBe(1)
  })

  it("moves the cutoff on the seat's own broadcast", async () => {
    const seat = join(SEAT)
    const peer = join('peer-b')
    send(peer, SEAT, 'first')
    server.handleMessage(seat.conn, { t: 'broadcast', text: 'handled it' })

    const { inbox } = await status()

    expect(inbox.unread).toBe(0)
    expect(inbox.sinceLastSend).not.toBeNull()
  })

  it('carries the error and keeps every other reading when events.db cannot be read', async () => {
    seedAgent({ name: 'ss-al-1', profile: 'implementer' })
    const inbox = (seat: string) => readInbox(path.join(tmp, 'absent', 'events.db'), seat)

    const result = await status({ inbox })
    const report = await statusReport(deps({ inbox }), SEAT, false)

    expect(result.inbox).toMatchObject({ unread: null, sinceLastSend: null })
    expect(result.inbox.error).toMatch(/\S/)
    expect(result.inbox.error).not.toContain(tmp)
    expect(result.implementers.active).toBe(1)
    expect(result.budget.sevenDay).toBe(41)
    expect(result.eligible.top).toHaveLength(3)
    expect(report.lines[9]).toBe(`inbox         unavailable: ${result.inbox.error}`)
  })
})

describe('the top eligible tasks', () => {
  it("lists the scorer's first three rows with their scores", async () => {
    const { eligible } = await status()

    expect(eligible.top.map(t => [t.id, t.score, t.rawScore])).toEqual([
      ['AL-1', 72, 72],
      ['AL-2', 51.6, 60.7],
      ['BE-3', 51.2, 51.2],
    ])
    expect(eligible).toMatchObject({ skipped: 0, today: '2026-09-29' })
    expect(eligible.error).toBeUndefined()
  })

  it('counts the malformed tasks the scorer skipped', async () => {
    const scored = () => ({ ...fixturePlan(), skipped: ['alpha/AL-8.yml', 'beta/BE-9.yml'] })

    const { eligible } = await status({ scored })
    const report = await statusReport(deps({ scored }), SEAT, false)

    expect(eligible.skipped).toBe(2)
    expect(report.lines.at(-1)).toBe('              2 malformed task(s) skipped')
  })

  it('keeps every other reading and carries the error when the scorer throws', async () => {
    seedAgent({ name: 'ss-al-1', profile: 'implementer' })

    const result = await status({ scored: scorerExplodes })

    expect(result.eligible).toEqual({ top: [], skipped: 0, today: '2026-09-29', error: 'scorer exploded' })
    expect(result.implementers.active).toBe(1)
    expect(result.budget.sevenDay).toBe(41)
    expect(result.inbox.unread).toBe(0)
  })
})

describe('the machine-wide guard readings', () => {
  it("counts every seat's live headless agents and leaves out exited and visible ones", async () => {
    seedAgent({ name: 'ss-al-1', profile: 'implementer' })
    seedAgent({ name: 'other-1', profile: 'implementer', spawnedBy: 'other-seat' })
    seedAgent({ name: 'other-2', profile: 'reviewer', spawnedBy: 'other-seat', detached: true })
    seedAgent({ name: 'other-3', profile: 'implementer', spawnedBy: 'other-seat', exited: true })
    seedAgent({ name: 'other-4', profile: 'implementer', spawnedBy: 'other-seat', surface: 'iterm-pane' })

    const result = await status()

    expect(result.machine.headlessAgents).toEqual({ live: 3, limit: 10 })
  })

  it('reports free memory against its floor, swap used, and suite slots', async () => {
    memory = { freePercent: 35 }
    swap = { usedBytes: 7 * GIB, totalBytes: 8 * GIB }

    const result = await status()

    expect(result.machine.memoryFree).toEqual({ percent: 35, limit: 15 })
    expect(result.machine.swap).toEqual({ usedPercent: 87.5 })
    expect(result.machine.fullSuiteSlots).toEqual({ inUse: 1, total: 4 })
  })

  it('flags memory under its floor and names failed readings in the table', async () => {
    memory = { freePercent: 9 }
    const low = await statusReport(deps(), SEAT, false)
    memory = { error: 'no level' }
    swap = { error: 'sysctl failed' }
    const failed = await statusReport(deps(), SEAT, false)

    expect(low.lines).toContain(
      'machine       headless 0/10, memory 9% free/15% floor LOW, swap 25% used, suite slots 1/4',
    )
    expect(failed.lines).toContain(
      'machine       headless 0/10, memory unread (no level), swap unread (sysctl failed), suite slots 1/4',
    )
  })
})

describe('the machine stop (CC-431)', () => {
  const breach = async (readings: typeof pressure) => {
    pressure = readings
    return status()
  }

  it('stops on machine with the memory reading when free memory is under 20%', async () => {
    const result = await breach({ memoryFreePercent: 19, load5: 4 })

    expect(result.stop).toBe('machine')
    expect(result.machineStop).toEqual({
      memoryFreePercent: 19,
      load5: 4,
      reason: 'machine under pressure: memory 19% free (floor 20%)',
    })
  })

  it('stops on machine with the load5 reading when load5 is over 28', async () => {
    const result = await breach({ memoryFreePercent: 60, load5: 28.5 })

    expect(result.stop).toBe('machine')
    expect(result.machineStop?.reason).toBe('machine under pressure: load5 28.5 (limit 28)')
  })

  it('reports no stop at exactly 20% free and exactly load5 28', async () => {
    const result = await breach({ memoryFreePercent: 20, load5: 28 })

    expect(result.stop).toBeNull()
    expect(result.machineStop).toBeNull()
  })

  it('does not stop on a memory reading that could not be taken', async () => {
    const result = await breach({ memoryFreePercent: null, load5: 3 })

    expect(result.stop).toBeNull()
  })

  it('takes the stop line before the budget stop in the table', async () => {
    const report = await (async () => {
      pressure = { memoryFreePercent: 5, load5: 40 }
      return statusReport(deps(), SEAT, false)
    })()

    expect(report.lines).toContain(
      'stop          machine under pressure: memory 5% free (floor 20%), load5 40 (limit 28)',
    )
  })
})

describe('the status verb', () => {
  it('prints the status as one JSON object under --json', async () => {
    seedAgent({ name: 'ss-al-1', profile: 'implementer' })

    const report = await statusReport(deps(), SEAT, true)

    expect(report.ok).toBe(true)
    expect(JSON.parse(report.lines.join('\n'))).toEqual(await status())
  })

  it('prints the same facts as a short table without --json', async () => {
    seedAgent({ name: 'ss-al-1', profile: 'implementer' })
    seedAgent({ name: 'ss-al-2', profile: 'implementer' })
    seedAgent({ name: 'ss-al-4', profile: 'implementer', exited: true, cwd: autonomy })
    writeReading(12, 70)

    const { lines } = await statusReport(deps(), SEAT, false)

    expect(lines).toEqual([
      `seat ${SEAT} at ${NOW.toISOString()}`,
      'implementers  2/2  AT CAP  ss-al-1, ss-al-2',
      'reviewers     0/1',
      'planners      0/3',
      'other         0',
      'parked        1  tree on disk: ss-al-4',
      `budget        pool ${POOL}: seven_day 70%, five_hour 12% (reading 30s old)`,
      `stop          BUDGET-PAUSE pool ${POOL}: seven_day 70% at or above line 65%`,
      'machine       headless 2/10, memory 50% free/15% floor, swap 25% used, suite slots 1/4',
      'inbox         0 unread (the seat has sent nothing)',
      'eligible      AL-1  72.0  alpha  Harden the secret store against injection',
      '              AL-2  51.6  alpha  Add the export feature to the dashboard',
      '              BE-3  51.2  beta  Survey the queue behaviour',
    ])
  })

  it('marks a stale reading, an open gate and a failed scorer in the table', async () => {
    writeReading(12, 41, 300)

    const { lines } = await statusReport(deps({ scored: scorerExplodes }), SEAT, false)

    expect(lines.slice(6)).toEqual([
      `budget        pool ${POOL}: seven_day 41%, five_hour 12% (reading 300s old, STALE)`,
      `stop          none; pool ${POOL}: five_hour 12% vs ceiling 70%, seven_day 41% vs line 65%`,
      'machine       headless 0/10, memory 50% free/15% floor, swap 25% used, suite slots 1/4',
      'inbox         0 unread (the seat has sent nothing)',
      'eligible      unavailable: scorer exploded',
    ])
  })

  it('cuts a long task title to sixty characters in the table', async () => {
    const plan = fixturePlan()
    const [first] = plan.order
    const scored = () => ({
      ...plan,
      order: first === undefined ? [] : [{ ...first, title: 'x'.repeat(80) }],
    })

    const { lines } = await statusReport(deps({ scored }), SEAT, false)

    expect(lines.at(-1)).toBe(`eligible      AL-1  72.0  alpha  ${'x'.repeat(60)}`)
  })

  it('says none when the scorer has no eligible task, then the skipped count', async () => {
    const scored = () => ({ ...fixturePlan(), order: [], skipped: ['alpha/AL-8.yml'] })

    const { lines } = await statusReport(deps({ scored }), SEAT, false)

    expect(lines.slice(-2)).toEqual(['eligible      none', '              1 malformed task(s) skipped'])
  })

  it('writes nothing to the event log', async () => {
    const peer = join('peer-b')
    join(SEAT)
    send(peer, SEAT, 'hello')
    const head = core.events.latestId()

    await statusReport(deps(), SEAT, true)

    expect(core.events.latestId()).toBe(head)
  })
})

describe('a status that cannot be read', () => {
  const seatFile = (): string => path.join(autonomy, 'seats', `${SEAT}.md`)
  const failures: [string, () => void, string][] = [
    ['a missing charter', () => fs.rmSync(path.join(autonomy, 'charter.md')), "open 'charter.md'"],
    ['a missing seat file', () => fs.rmSync(seatFile()), `open 'seats/${SEAT}.md'`],
    [
      'a seat file that is not YAML',
      () => fs.writeFileSync(seatFile(), '---\nprefix: [\n---\n'),
      'Flow sequence',
    ],
    [
      'a cap that is not a number',
      () => writeAutonomy({ concurrency: '{implementers: two}' }),
      `seat file ${SEAT} is malformed`,
    ],
  ]

  it.each(failures)('prints one error document for %s under --json', async (_name, damage, text) => {
    damage()

    const report = await statusReport(deps(), SEAT, true)
    const document = JSON.parse(report.lines.join('\n')) as { seat: string; error: string }

    expect(report).toMatchObject({ ok: false })
    expect(report.errors).toBeUndefined()
    expect(Object.keys(document)).toEqual(['seat', 'error'])
    expect(document.seat).toBe(SEAT)
    expect(document.error).toContain(text)
    expect(document.error).not.toContain(tmp)
  })

  it('prints one error document for a name the charter does not list as a seat', async () => {
    const report = await statusReport(deps(), 'no-such-seat', true)

    expect(report.ok).toBe(false)
    expect(JSON.parse(report.lines.join('\n'))).toEqual({
      seat: 'no-such-seat',
      error: 'no-such-seat is not a seat in charter.md',
    })
  })

  it('prints one error document when the broker does not answer', async () => {
    const agents = (): never => {
      throw new Error('broker request timed out')
    }

    const report = await statusReport(deps({ agents }), SEAT, true)

    expect(report.ok).toBe(false)
    expect(JSON.parse(report.lines.join('\n'))).toEqual({ seat: SEAT, error: 'broker request timed out' })
  })

  it('prints the failure as an error line and nothing else without --json', async () => {
    const report = await statusReport(deps(), 'no-such-seat', false)

    expect(report).toEqual({ ok: false, lines: [], errors: ['no-such-seat is not a seat in charter.md'] })
  })
})

describe('the verb wired to a running broker', () => {
  const ctx = { warnings: [], format: 'human' as const, withBroker }
  const saved = { ...process.env }
  let listener: net.Server | undefined

  async function stopListening(): Promise<void> {
    const open = listener
    listener = undefined
    if (open !== undefined) await new Promise<void>(resolve => open.close(() => resolve()))
  }

  beforeEach(async () => {
    const now = new Date()
    process.env.AGENT_CHAT_HOME = tmp
    process.env.AGENT_CHAT_ACTIVE_WORK_ROOT = activeWork
    writeAutonomy({ configDir: poolDir })
    writeReading(12, 41, 30, now)
    const state = { pools: { [POOL]: { since: dayStart(now), last: 41, spent: 0 } } }
    fs.writeFileSync(path.join(tmp, 'seat-watchdog.json'), JSON.stringify(state))
    const opened = net.createServer(conn => server.onConnection(conn))
    listener = opened
    await new Promise<void>(resolve => opened.listen(path.join(tmp, 'chat.sock'), resolve))
  })

  afterEach(async () => {
    process.env = { ...saved }
    await stopListening()
  })

  it("reads the broker's roster, the live inbox and the saved meters under --json", async () => {
    seedAgent({ name: 'ss-al-1', profile: 'implementer' })
    join(SEAT)
    send(join('peer-b'), SEAT, 'hello')

    const report = await seatsStatusVerb.run({ seat: SEAT, json: true, root: autonomy }, ctx)
    const result = JSON.parse(report.lines.join('\n')) as SeatStatus

    expect(report.ok).toBe(true)
    expect(result.implementers.names).toEqual(['ss-al-1'])
    expect(result.inbox.unread).toBe(1)
    expect(result.budget).toMatchObject({ sevenDay: 41, stop: null })
  })

  it('stops on a saved state file that does not parse', async () => {
    fs.writeFileSync(path.join(tmp, 'seat-watchdog.json'), '{"pools": ')

    const report = await seatsStatusVerb.run({ seat: SEAT, json: true, root: autonomy }, ctx)
    const result = JSON.parse(report.lines.join('\n')) as SeatStatus

    expect(result.budget.stop).toContain('seat-watchdog.json is not valid JSON')
  })

  it('prints the table when --json is not given', async () => {
    const report = await seatsStatusVerb.run({ seat: SEAT, root: autonomy }, ctx)

    expect(report.ok).toBe(true)
    expect(report.lines[0]).toMatch(new RegExp(`^seat ${SEAT} at `))
    expect(report.lines[1]).toBe('implementers  0/2')
  })

  it('prints one error document and starts no broker when none is running', async () => {
    await stopListening()

    const report = await seatsStatusVerb.run({ seat: SEAT, json: true, root: autonomy }, ctx)

    expect(report.ok).toBe(false)
    expect(JSON.parse(report.lines.join('\n'))).toEqual({
      seat: SEAT,
      error: 'could not reach or start the agent-chat broker',
    })
    expect(spawn).not.toHaveBeenCalled()
  })
})
