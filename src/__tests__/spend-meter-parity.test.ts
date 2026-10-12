import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BudgetRead } from '../agents/budget.js'
import { gatePool } from '../agents/burndown/budget-gate.js'
import type { Ledger, SeatState } from '../agents/burndown/ledger.js'
import { loadSeats } from '../agents/burndown/seat-tick.js'
import type { WatchdogDoc } from '../agents/seats/io.js'
import { runWatchdog, type WatchdogDeps } from '../agents/seats/run.js'
import { seatSpawnGate } from '../agents/seats/spawn-gate.js'
import { readSeatSpawn } from '../agents/seats/spawn-gate-read.js'
import { seatStatus, type StatusDeps } from '../agents/seats/status.js'
import { savedMeters } from '../agents/seats/stops.js'

/**
 * CC-1099 e: the tick, the broker spawn gate, `seats status` and the watchdog pass count one seat's spend
 * through `seatSpend`, so over one fixture whose watchdog meters and ledger samples disagree, all four
 * read the same run and day figures and reach the same verdict. Every name and path is synthetic.
 */

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'autonomy-2026-09-29')
const SEAT = 'seat-a'
const POOL = 'pool-p'
const POOL_DIR = '/synthetic/pool-p'
const at = (hour: number, minute = 0): number => new Date(2026, 8, 29, hour, minute).getTime()
const NOW = new Date(at(10))
const SEVEN_DAY = 75

/** The meters last read 67, so they count 8 points of run and day spend. */
const METERED_DOC: WatchdogDoc = {
  seats: { [SEAT]: { idleRuns: 0, at: at(9, 45), run: { since: at(9), last: 67, spent: 0 } } },
  pools: { [POOL]: { since: at(7), last: 67, spent: 0 } },
  stopped: {},
}

/** The ledger read 1 at 06:30, before the day and run starts, so it counts 74 points of each. */
const LEDGER_STATE: SeatState = { configDir: POOL_DIR, samples: [{ at: at(6, 30), sevenDay: 1 }] }

const POOLS = `pools:\n  ${POOL}: {config_dir: ${POOL_DIR}, human_uses: false, reserve_seven_day: 5, ceiling_five_hour: 80}\n`

const seatFile = (perRun: number, perDay: number): string =>
  [
    '---',
    'schema: autonomy-seat/v1',
    `name: ${SEAT}`,
    'prefix: sa',
    'role: owner',
    `pool: ${POOL}`,
    'initiatives:',
    '  init-alpha: 1.0',
    'unclaimed_engineering: false',
    'concurrency:',
    '  implementers: 2',
    'spend:',
    `  per_run_points: ${perRun}`,
    `  per_day_points: ${perDay}`,
    '---',
    '',
  ].join('\n')

const budgetRead = (): BudgetRead => ({
  found: true,
  path: path.join(POOL_DIR, 'status.json'),
  age_seconds: 30,
  stale: false,
  budget: {
    session_id: 'session-1',
    written_at: NOW.getTime() / 1000 - 30,
    context: { exceeds_200k: false },
    cost: {},
    rate_limits: { five_hour: { used_pct: 10 }, seven_day: { used_pct: SEVEN_DAY } },
  },
})

let root: string

function writeSeat(perRun: number, perDay: number): void {
  const charterPath = path.join(root, 'charter.md')
  const charter = fs.readFileSync(charterPath, 'utf8').replace(/^pools:\n(?: {2}.*\n)+/m, POOLS)
  fs.writeFileSync(charterPath, charter)
  fs.writeFileSync(path.join(root, 'seats', `${SEAT}.md`), seatFile(perRun, perDay))
}

interface Fixture {
  doc: WatchdogDoc
  state: SeatState | undefined
}

/** A reader's verdict: open, or the BUDGET-PAUSE reason past its pool name. */
interface Verdict {
  open: boolean
  why: string | null
}

const PAUSE = /BUDGET-PAUSE pool \S+: (.*)$/
const verdictOf = (text: string | null): Verdict => {
  const why = text === null ? null : (PAUSE.exec(text)?.[1] ?? null)
  return { open: why === null, why }
}

function tickVerdict(f: Fixture): Verdict {
  const ledger = { seats: f.state === undefined ? {} : { [SEAT]: f.state } } as unknown as Ledger
  const { loaded, skipped } = loadSeats([SEAT], ledger, {
    autonomyRoot: root,
    root,
    now: NOW,
    reading: () => ({ reading: { sevenDay: SEVEN_DAY, fiveHour: 10, ageSeconds: 30 } }),
    meters: (seat, pool) => savedMeters(f.doc, seat, pool),
  })
  expect(skipped).toEqual([])
  const gate = gatePool(loaded[0]!.budget)
  return verdictOf(gate.open ? null : gate.reason)
}

function spawnVerdict(f: Fixture): Verdict {
  const read = readSeatSpawn(
    root,
    { name: 'sa-cc-1-impl', spawner: SEAT, configDir: POOL_DIR, now: NOW },
    { readBudget: budgetRead, loadDoc: () => structuredClone(f.doc), seatState: () => f.state, home: root },
  )
  if (read.kind !== 'gate') throw new Error(`spawn read is ${read.kind}`)
  const verdict = seatSpawnGate({ ...read.input, model: 'claude-opus-5-5' })
  return verdictOf(verdict.allow ? null : verdict.reason)
}

async function statusVerdict(f: Fixture): Promise<Verdict> {
  const deps = {
    now: () => NOW,
    autonomyRoot: root,
    homeDir: root,
    agents: async () => [],
    waitingOwner: async () => [],
    readBudget: budgetRead,
    loadDoc: () => structuredClone(f.doc),
    inbox: () => ({ unread: 0, sinceLastSend: 0 }),
    poolPicks: () => [],
    scored: () => {
      throw new Error('no scorer in this test')
    },
    machine: () => ({}),
    machineStop: () => null,
    seatSamples: () => f.state,
  } as unknown as StatusDeps
  const { budget } = await seatStatus(deps, SEAT)
  return verdictOf(budget.stop)
}

async function watchdogVerdict(f: Fixture): Promise<Verdict> {
  const deps = {
    now: () => NOW,
    readCharter: () => fs.readFileSync(path.join(root, 'charter.md'), 'utf8'),
    readSeatFile: (seat: string) => fs.readFileSync(path.join(root, 'seats', `${seat}.md`), 'utf8'),
    seatLogDays: () => [],
    readSeatLog: () => undefined,
    readBudget: budgetRead,
    ownerMessages: () => [],
    roster: async () => ({ agents: [], connected: [SEAT] }),
    presence: () => ({ teleported: false, wokenByWatchdog: false, resumeStarted: false }),
    eligible: () => ({ count: 0, skipped: 0 }),
    loadDoc: () => structuredClone(f.doc),
    saveDoc: () => undefined,
    wake: async () => ({ ok: true, detail: 'not woken' }),
    appendLog: () => undefined,
    lock: () => ({ held: true, release: () => undefined }),
    seatState: () => f.state,
  } satisfies WatchdogDeps
  const [line] = await runWatchdog(deps, { seats: [SEAT], dryRun: true })
  return verdictOf(line ?? null)
}

async function allFour(f: Fixture): Promise<Record<string, Verdict>> {
  return {
    tick: tickVerdict(f),
    spawnGate: spawnVerdict(f),
    status: await statusVerdict(f),
    watchdog: await watchdogVerdict(f),
  }
}

const same = (verdict: Verdict) => ({ tick: verdict, spawnGate: verdict, status: verdict, watchdog: verdict })

const DIVERGENT: Fixture = { doc: METERED_DOC, state: LEDGER_STATE }

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-spend-meter-parity-'))
  fs.cpSync(FIXTURE, root, { recursive: true })
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('every spend reader counts one figure from the ledger when the meters disagree (CC-1099)', () => {
  it("closes all four on the ledger's run spend 74 when the meters read 8", async () => {
    writeSeat(60, 200)

    const verdicts = await allFour(DIVERGENT)

    expect(verdicts).toEqual(
      same({ open: false, why: "run spend 74 points at or above the seat's per_run_points 60" }),
    )
  })

  it("closes all four on the ledger's day spend 74 when the meters read 8", async () => {
    writeSeat(200, 60)

    const verdicts = await allFour(DIVERGENT)

    expect(verdicts).toEqual(
      same({ open: false, why: "day spend 74 points since 07:00 at or above the seat's per_day_points 60" }),
    )
  })

  it('leaves all four open with both caps above the ledger figure', async () => {
    writeSeat(100, 100)

    const verdicts = await allFour(DIVERGENT)

    expect(verdicts).toEqual(same({ open: true, why: null }))
  })

  it('counts the meters run spend 8 in all four when the ledger holds no samples for the seat', async () => {
    writeSeat(5, 200)

    const verdicts = await allFour({ doc: METERED_DOC, state: undefined })

    expect(verdicts).toEqual(
      same({ open: false, why: "run spend 8 points at or above the seat's per_run_points 5" }),
    )
  })
})
