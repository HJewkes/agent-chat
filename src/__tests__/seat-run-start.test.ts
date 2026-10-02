import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BudgetRead } from '../agents/budget.js'
import { loadDoc, saveDoc, type WatchdogDoc } from '../agents/seats/io.js'
import { acquireRunLock } from '../agents/seats/lock.js'
import { RunStartRefused, startRun, type RunStartDeps } from '../agents/seats/run-start.js'
import { runWatchdog, type WatchdogDeps } from '../agents/seats/run.js'
import { readSeatSpawn } from '../agents/seats/spawn-gate-read.js'
import { seatSpawnGate } from '../agents/seats/spawn-gate.js'
import { runStartReport } from '../cli/verbs/seats.js'

/** CC-472: `seats run-start` resets a seat's run meter under the watchdog's run lock. Synthetic seats and pools. */

const MIN = 60_000
const NOW = new Date(2026, 9, 2, 9, 0)
const LAST_NIGHT = new Date(2026, 9, 1, 22, 38).getTime()
const DAY_START = new Date(2026, 9, 2, 7, 0).getTime()

let tmp: string
let root: string
let state: string
let lockFile: string
let poolDir: string

const charter = (): string =>
  [
    '---',
    'owner_seat: alpha-coord',
    'seats: [alpha-coord, beta-coord]',
    'pools:',
    `  agents: {config_dir: ${poolDir}, human_uses: false, reserve_seven_day: 25, ceiling_five_hour: 85}`,
    '---',
    '',
  ].join('\n')

const SEAT_FILES: Record<string, string> = {
  'alpha-coord': '---\nprefix: ac\npool: agents\nspend:\n  per_run_points: 20\n---\n',
  'beta-coord': '---\nprefix: bc\npool: agents\n---\n',
}

const reading = (sevenDay: number | undefined, ageSeconds = 30): BudgetRead => ({
  found: true,
  path: '/synthetic',
  age_seconds: ageSeconds,
  stale: false,
  budget: {
    session_id: 's',
    written_at: 0,
    context: { exceeds_200k: false },
    cost: {},
    rate_limits: {
      five_hour: { used_pct: 20 },
      ...(sevenDay === undefined ? {} : { seven_day: { used_pct: sevenDay } }),
    },
  },
})

const PAST_CAP = { since: LAST_NIGHT, last: 46, spent: 26, before: 20 }

const seededDoc = (): WatchdogDoc => ({
  seats: {
    'alpha-coord': { idleRuns: 2, at: NOW.getTime() - 15 * MIN, fires: 1, run: PAST_CAP },
    'beta-coord': {
      idleRuns: 0,
      at: NOW.getTime() - 15 * MIN,
      run: { since: LAST_NIGHT, last: 44, spent: 3 },
    },
  },
  pools: { agents: { since: DAY_START, last: 47, spent: 0 } },
  lastReadings: { agents: { at: NOW.getTime() - MIN, sevenDay: 49, fiveHour: 20 } },
  held: false,
  stopped: { 'gamma-coord': 'owner stop' },
})

const writeDoc = (doc: WatchdogDoc): void => fs.writeFileSync(state, `${JSON.stringify(doc, null, 2)}\n`)
const stateBytes = (): string | undefined =>
  fs.existsSync(state) ? fs.readFileSync(state, 'utf8') : undefined

function deps(over: Partial<RunStartDeps> = {}): RunStartDeps {
  return {
    now: () => NOW,
    readCharter: () => charter(),
    readSeatFile: seat => SEAT_FILES[seat],
    readBudget: () => reading(50),
    loadDoc: () => loadDoc(state),
    saveDoc: doc => saveDoc(doc, state),
    lock: () => acquireRunLock(lockFile),
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    lockWaitMs: 0,
    ...over,
  }
}

function watchdogDeps(at: Date, over: Partial<WatchdogDeps> = {}): WatchdogDeps {
  return {
    now: () => at,
    readCharter: () => charter(),
    readSeatFile: seat => SEAT_FILES[seat],
    seatLogDays: () => [],
    readSeatLog: () => undefined,
    readBudget: () => reading(50),
    ownerMessages: () => [],
    roster: async () => ({ agents: [], connected: ['alpha-coord', 'beta-coord'] }),
    presence: () => undefined,
    eligible: () => ({ count: 3, skipped: 0 }),
    loadDoc: () => loadDoc(state),
    saveDoc: doc => saveDoc(doc, state),
    wake: async () => ({ ok: true, detail: 'synthetic' }),
    appendLog: () => undefined,
    lock: () => acquireRunLock(lockFile),
    ...over,
  }
}

const refusal = async (run: Promise<unknown>): Promise<string> => {
  const err = await run.then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(RunStartRefused)
  return (err as RunStartRefused).code
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ac-run-start-')))
  root = path.join(tmp, 'autonomy')
  poolDir = path.join(tmp, 'pool')
  state = path.join(tmp, 'seat-watchdog.json')
  lockFile = path.join(tmp, 'seat-watchdog.lock')
  fs.mkdirSync(path.join(root, 'seats'), { recursive: true })
  fs.writeFileSync(path.join(root, 'charter.md'), charter())
  for (const [name, text] of Object.entries(SEAT_FILES))
    fs.writeFileSync(path.join(root, 'seats', `${name}.md`), text)
  writeDoc(seededDoc())
})

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

describe('seats run-start', () => {
  it('resets a meter mid-run and leaves every other seat and map as it was', async () => {
    const started = await startRun(deps(), 'alpha-coord')

    const after = loadDoc(state)
    const before = seededDoc()
    expect(started.meter).toEqual({ since: NOW.getTime(), last: 50, spent: 0, before: 46 })
    expect(after.seats['alpha-coord']).toEqual({ ...before.seats['alpha-coord'], run: started.meter })
    expect(after.seats['beta-coord']).toEqual(before.seats['beta-coord'])
    expect(after.pools).toEqual(before.pools)
    expect(after.lastReadings).toEqual(before.lastReadings)
    expect(after.held).toBe(false)
    expect(after.stopped).toEqual(before.stopped)
    expect(fs.existsSync(lockFile)).toBe(false)
  })

  it('gives a seat the watchdog never saw a first run with no earlier reading', async () => {
    writeDoc({ seats: {}, pools: {}, stopped: {} })

    await startRun(deps(), 'beta-coord')

    expect(loadDoc(state).seats['beta-coord']).toEqual({
      idleRuns: 0,
      at: NOW.getTime(),
      run: { since: NOW.getTime(), last: 50, spent: 0 },
    })
  })

  it.each([
    ['a missing status file', { found: false, path: '/synthetic', reason: 'no_file' } as BudgetRead],
    ['a reading with no seven_day', reading(undefined)],
    ['a reading over 15 minutes old', reading(50, 16 * 60)],
  ])('refuses with no_reading on %s and writes nothing', async (_case, read) => {
    const bytes = stateBytes()

    const code = await refusal(startRun(deps({ readBudget: () => read }), 'alpha-coord'))

    expect(code).toBe('no_reading')
    expect(stateBytes()).toBe(bytes)
    expect(fs.existsSync(lockFile)).toBe(false)
  })

  it.each(['gamma-coord', '../escape', 'not-a-seat'])(
    'refuses unknown seat %s with unknown_seat and writes nothing',
    async name => {
      const bytes = stateBytes()

      const code = await refusal(startRun(deps(), name))

      expect(code).toBe('unknown_seat')
      expect(stateBytes()).toBe(bytes)
    },
  )

  it('reports a refusal through the verb body with its code', async () => {
    const report = await runStartReport(deps({ readBudget: () => reading(undefined) }), 'alpha-coord')

    expect(report.ok).toBe(false)
    expect(report.errors?.[0]).toMatch(/^no_reading: pool agents has no seven_day reading$/)
  })
})

describe('seats run-start against a concurrent watchdog pass', () => {
  it('keeps a watchdog pass out while it holds the run lock', async () => {
    let pass: Promise<string[]> | undefined
    const load = (): WatchdogDoc => {
      pass = runWatchdog(watchdogDeps(new Date(NOW.getTime() + MIN)), { dryRun: false })
      return loadDoc(state)
    }

    const started = await startRun(deps({ loadDoc: load }), 'alpha-coord')

    expect(await pass).toEqual([
      expect.stringMatching(/another run holds seat-watchdog\.lock.*this run did nothing/),
    ])
    expect(loadDoc(state).seats['alpha-coord']?.run).toEqual(started.meter)
  })

  it('waits for a watchdog pass that holds the lock, then writes on top of its save', async () => {
    let reset: Promise<unknown> | undefined
    const passAt = new Date(NOW.getTime() - MIN)
    const save = (doc: Omit<WatchdogDoc, 'stopped'>): void => {
      reset ??= startRun(
        deps({ lockWaitMs: 60_000, sleep: ms => new Promise(r => setTimeout(r, ms / 50)) }),
        'alpha-coord',
      )
      saveDoc(doc, state)
    }

    await runWatchdog(watchdogDeps(passAt, { saveDoc: save }), { dryRun: false })
    await reset

    const after = loadDoc(state)
    expect(after.seats['alpha-coord']?.run).toEqual({ since: NOW.getTime(), last: 50, spent: 0, before: 50 })
    expect(after.seats['alpha-coord']?.at).toBe(passAt.getTime())
    expect(after.seats['beta-coord']?.at).toBe(passAt.getTime())
    expect(after.pools.agents?.last).toBe(50)
  })

  it('refuses with lock_held and writes nothing when a live run keeps the lock', async () => {
    const held = acquireRunLock(lockFile, { pid: process.ppid })
    const bytes = stateBytes()

    const code = await refusal(startRun(deps(), 'alpha-coord'))

    expect(held.held).toBe(true)
    expect(code).toBe('lock_held')
    expect(stateBytes()).toBe(bytes)
  })
})

describe('readers of the run meter after a run-start', () => {
  const spawn = (at: Date) => ({ name: 'ac-task', spawner: 'alpha-coord', configDir: poolDir, now: at })

  function spawnVerdict(at: Date, sevenDay: number) {
    const read = readSeatSpawn(root, spawn(at), {
      readBudget: () => reading(sevenDay),
      loadDoc: () => loadDoc(state),
      home: tmp,
    })
    if (read.kind !== 'gate') throw new Error(`expected a gated spawn, got ${read.kind}`)
    return seatSpawnGate({ ...read.input, model: 'opus' })
  }

  it('opens the CC-288 spawn gate for a seat that was past per_run_points', async () => {
    const refused = spawnVerdict(NOW, 50)

    await startRun(deps(), 'alpha-coord')
    const allowed = spawnVerdict(new Date(NOW.getTime() + MIN), 51)

    expect(refused).toEqual({
      allow: false,
      reason: expect.stringContaining("run spend 30 points at or above the seat's per_run_points 20"),
    })
    expect(allowed.allow).toBe(true)
  })

  it('opens the watchdog budget for the seat on its next pass', async () => {
    const dryRun = async (at: Date): Promise<string[]> =>
      runWatchdog(watchdogDeps(at), { seats: ['alpha-coord'], dryRun: true })
    const before = await dryRun(NOW)

    await startRun(deps(), 'alpha-coord')
    const after = await dryRun(new Date(NOW.getTime() + MIN))

    expect(before).toEqual([
      expect.stringContaining('budget closed: BUDGET-PAUSE pool agents: run spend 30 points'),
    ])
    expect(after).toEqual([expect.not.stringContaining('budget closed')])
  })
})
