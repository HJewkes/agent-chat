import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BudgetRead } from '../agents/budget.js'
import {
  appendSeatLog,
  loadDoc,
  readAgentEvents,
  readOwnerMessages,
  saveDoc,
  type WatchdogDoc,
} from '../agents/seats/io.js'
import { runWatchdog, type Roster, type WatchdogDeps } from '../agents/seats/run.js'
import type { OwnerMessage } from '../agents/seats/stops.js'
import type { BrokerClient } from '../client/broker-client.js'
import { watchdogInstall, wakeSeat } from '../cli/verbs/seats.js'
import type { Launchctl } from '../mirror/launchd.js'
import { renderWatchdogPlist } from '../mirror/plist.js'

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => DatabaseSyncType
}

const CHARTER = `---
owner_seat: hjewkes-surplus
seats: [hjewkes-surplus, unconfigured, ../escape]
pools:
  claude:  {config_dir: /Users/o/.claude, human_uses: true, reserve_seven_day: 35, ceiling_five_hour: 70, per_day_points: 13}
---
`
const SEAT = '---\nprefix: hs\npool: claude\nspend:\n  per_run_points: 6\n  per_day_points: 10\n---\n'

const budget = (fiveHour: number, sevenDay = 19): BudgetRead => ({
  found: true,
  path: '/x',
  age_seconds: 5,
  stale: false,
  budget: {
    session_id: 's',
    written_at: 0,
    context: { exceeds_200k: false },
    cost: {},
    rate_limits: { five_hour: { used_pct: fiveHour }, seven_day: { used_pct: sevenDay } },
  },
})

interface Harness {
  deps: WatchdogDeps
  wakes: { seat: string; message: string; connected: boolean }[]
  logs: string[]
  doc: WatchdogDoc
  /** The seat's own log for today, as `HH:MM text` lines. */
  seatLog: string
  /** The seat's log for the day before. */
  priorLog: string
  fiveHour: number
  sevenDay: number
  ownerMessages: OwnerMessage[]
  now: () => number
  tick: () => void
}

const emptyDoc = (): WatchdogDoc => ({ seats: {}, pools: {}, stopped: {} })

function harness(roster: Roster, fiveHour = 41, start = new Date(2026, 8, 29, 8, 38)): Harness {
  let now = start.getTime()
  const h: Harness = {
    wakes: [],
    logs: [],
    doc: emptyDoc(),
    seatLog: '',
    priorLog: '',
    fiveHour,
    sevenDay: 19,
    ownerMessages: [],
    now: () => now,
    tick: () => void (now += 15 * 60_000),
    deps: {
      now: () => new Date(now),
      readCharter: () => CHARTER,
      readSeatFile: seat => (seat === 'hjewkes-surplus' ? SEAT : undefined),
      readSeatLog: (_seat, at) => (at.getDate() === new Date(now).getDate() ? h.seatLog : h.priorLog),
      readBudget: () => budget(h.fiveHour, h.sevenDay),
      ownerMessages: () => h.ownerMessages,
      roster: async () => roster,
      eligible: () => 7,
      loadDoc: () => structuredClone(h.doc),
      saveDoc: doc => void (h.doc = { ...doc, stopped: h.doc.stopped }),
      wake: async (seat, message, connected) => {
        h.wakes.push({ seat, message, connected })
        return { ok: true, detail: 'message m1' }
      },
      appendLog: (seat, _at, text) => void h.logs.push(`${seat}: ${text}`),
    },
  }
  return h
}

const IDLE: Roster = { agents: [], connected: ['hjewkes-surplus'] }

const ONE = { seats: ['hjewkes-surplus'], dryRun: false }

/** `count` watchdog runs 15 minutes apart; returns how many woke the seat. */
async function runs(h: Harness, count: number, before?: (i: number) => void): Promise<number> {
  const start = h.wakes.length
  for (let i = 0; i < count; i++) {
    before?.(i)
    await runWatchdog(h.deps, ONE)
    h.tick()
  }
  return h.wakes.length - start
}

const hhmm = (ms: number): string => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const GAP_LINE =
  "pool claude: no seven_day reading at or before 07:00, so the day's spend counts from the first sample"

describe('runWatchdog', () => {
  it('wakes a connected seat with the Discovery message on the second idle run, and logs it', async () => {
    const h = harness(IDLE)
    const first = await runWatchdog(h.deps, { seats: ['hjewkes-surplus'], dryRun: false })
    h.tick()
    const second = await runWatchdog(h.deps, { seats: ['hjewkes-surplus'], dryRun: false })
    expect(first).toEqual([GAP_LINE])
    expect(h.wakes).toEqual([
      { seat: 'hjewkes-surplus', message: 'Watchdog: 0 implementers, run Discovery', connected: true },
    ])
    expect(h.logs).toHaveLength(1)
    expect(h.logs[0]).toMatch(
      /^hjewkes-surplus: Watchdog: 0 implementers, budget open .*7 eligible; woke hjewkes-surplus/,
    )
    expect(second).toHaveLength(1)
  })

  it('resumes a seat that has no connected session', async () => {
    const h = harness({ agents: [], connected: [] })
    await runWatchdog(h.deps, { seats: ['hjewkes-surplus'], dryRun: false })
    h.tick()
    await runWatchdog(h.deps, { seats: ['hjewkes-surplus'], dryRun: false })
    expect(h.wakes[0]?.connected).toBe(false)
  })

  it('is silent while an implementer runs: no wake, no log line, only the one-time gap line', async () => {
    const busy: Roster = {
      agents: [{ name: 'hs-cc-1-x', profile: 'implementer', state: 'live', spawnedBy: 'hjewkes-surplus' }],
      connected: [],
    }
    const h = harness(busy)
    const out = [
      ...(await runWatchdog(h.deps, { seats: ['hjewkes-surplus'], dryRun: false })),
      ...(h.tick(), await runWatchdog(h.deps, { seats: ['hjewkes-surplus'], dryRun: false })),
    ]
    expect([out, h.wakes, h.logs]).toEqual([[GAP_LINE], [], []])
    expect(h.doc.seats['hjewkes-surplus']?.idleRuns).toBe(0)
  })

  it('holds a seat over the five-hour ceiling and logs the BUDGET-PAUSE once, not every run', async () => {
    const h = harness(IDLE, 70)
    expect(await runs(h, 4)).toBe(0)
    expect(h.logs).toEqual([
      'hjewkes-surplus: Watchdog: BUDGET-PAUSE pool claude: five_hour 70% at or above ceiling 70%',
    ])
    expect(h.doc.seats['hjewkes-surplus']?.budgetPaused).toBe(true)
  })

  it('releases a held seat once its pool reopens, logging the change once, and wakes it', async () => {
    const h = harness(IDLE, 70)
    await runs(h, 2)
    h.fiveHour = 41
    expect(await runs(h, 3)).toBe(1)
    expect(h.logs.filter(l => l.includes('budget open again'))).toEqual([
      'hjewkes-surplus: Watchdog: budget open again: pool claude: five_hour 41% vs ceiling 70%, seven_day 19% vs line 65%',
    ])
    expect(h.logs.filter(l => l.includes('BUDGET-PAUSE'))).toHaveLength(1)
  })

  it('logs nothing for an open pool and records nothing under --dry-run', async () => {
    const open = harness({ agents: [], connected: [] }, 41)
    open.deps.eligible = () => 0
    await runs(open, 3)
    expect(open.logs).toEqual([])
    const held = harness(IDLE, 70)
    await runWatchdog(held.deps, { ...ONE, dryRun: true })
    expect([held.logs, held.doc.seats]).toEqual([[], {}])
  })

  it('under --dry-run reports every charter seat and wakes, logs and saves nothing', async () => {
    const h = harness(IDLE)
    h.doc.seats = { 'hjewkes-surplus': { idleRuns: 1, at: h.now() - 8 * 60_000 } }
    const out = await runWatchdog(h.deps, { dryRun: true })
    expect(out[0]).toMatch(/^hjewkes-surplus: WOULD FIRE: 0 implementers/)
    expect(out[1]).toMatch(/^unconfigured: skipped, seats\/unconfigured.md has no prefix or pool/)
    expect(out[2]).toBe('../escape: skipped, not a seat name')
    expect(h.wakes).toEqual([])
    expect(h.logs).toEqual([])
    expect(h.doc.seats['hjewkes-surplus']?.idleRuns).toBe(1)
  })

  it('wakes at most twice through a long idle stretch with no implementer appearing', async () => {
    const h = harness(IDLE)
    expect(await runs(h, 16)).toBe(2)
    const out = await runWatchdog(h.deps, { ...ONE, dryRun: true })
    expect(out[0]).toMatch(/skip: fire cap: 2 wake/)
  })

  it('stays capped after the seat logs a line, and wakes again once an implementer has run', async () => {
    const h = harness(IDLE)
    await runs(h, 6)
    h.seatLog = `${hhmm(h.now())} dispatch refused: no worktree slot\n`
    expect(await runs(h, 8)).toBe(0)
    const busy: Roster = {
      agents: [{ name: 'hs-cc-1-x', profile: 'implementer', state: 'live', spawnedBy: 'hjewkes-surplus' }],
      connected: [],
    }
    await runWatchdog({ ...h.deps, roster: async () => busy }, ONE)
    h.tick()
    expect(await runs(h, 2)).toBe(1)
  })

  it('never wakes a seat whose newest line is last night, within two heartbeats', async () => {
    const h = harness(IDLE, 41, new Date(2026, 8, 29, 0, 8))
    h.priorLog = '23:47 heartbeat: 0 implementers, nothing dispatchable\n'
    expect(await runs(h, 2)).toBe(0)
  })

  it('never wakes a seat the owner stopped in seat-watchdog.json', async () => {
    const h = harness(IDLE)
    h.doc.stopped = { 'hjewkes-surplus': 'away for the weekend' }
    expect(await runs(h, 4)).toBe(0)
    const out = await runWatchdog(h.deps, { ...ONE, dryRun: true })
    expect(out[0]).toBe('hjewkes-surplus: skip: held: stopped by the owner: away for the weekend')
  })

  it('never wakes a seat whose latest log line is BUDGET-PAUSE', async () => {
    const h = harness(IDLE)
    h.seatLog = '08:30 BUDGET-PAUSE five_hour 71%, seven_day 30%\n'
    expect(await runs(h, 4)).toBe(0)
  })

  it('never wakes a seat once its pool has spent the per_day_points stop', async () => {
    const h = harness(IDLE)
    h.doc.pools = { claude: { since: h.now() - 3_600_000, last: 19, spent: 9 } }
    h.sevenDay = 20
    expect(await runs(h, 4)).toBe(0)
    expect(h.doc.pools.claude?.spent).toBe(10)
    expect(h.doc.seats['hjewkes-surplus']?.run?.spent).toBe(0)
    const out = await runWatchdog(h.deps, { ...ONE, dryRun: true })
    expect(out[0]).toMatch(
      /budget closed: BUDGET-PAUSE pool claude: day spend 10 points since 07:00 at or above the seat's per_day_points 10$/,
    )
  })

  it('holds a seat at its per_run_points stop even with the day cap open', async () => {
    const h = harness(IDLE)
    h.doc.seats = {
      'hjewkes-surplus': {
        idleRuns: 1,
        at: h.now() - 15 * 60_000,
        run: { since: h.now() - 3_600_000, last: 19, spent: 6 },
      },
    }
    const out = await runWatchdog(h.deps, { ...ONE, dryRun: true })
    expect(out[0]).toMatch(
      /BUDGET-PAUSE pool claude: run spend 6 points at or above the seat's per_run_points 6$/,
    )
  })

  it('never wakes any seat inside an open restart window', async () => {
    const h = harness(IDLE)
    h.ownerMessages = [{ ts: h.now() - 5 * 60_000, body: 'hjewkes-surplus: restart at 08:45' }]
    expect(await runs(h, 3)).toBe(0)
    h.ownerMessages.push({ ts: h.now(), body: 'hjewkes-surplus: restart done' })
    expect(await runs(h, 2)).toBe(1)
  })

  it('holds every seat when events.db cannot be read, since a restart window cannot be ruled out', async () => {
    const h = harness(IDLE)
    h.deps.ownerMessages = () => undefined
    expect(await runs(h, 3)).toBe(0)
    const out = await runWatchdog(h.deps, { ...ONE, dryRun: true })
    expect(out[0]).toBe(
      'hjewkes-surplus: skip: held: events.db unreadable, so a restart window cannot be ruled out',
    )
  })
})

describe('state-change log lines', () => {
  const HOLD_ON = /^Watchdog: hold on every seat: /
  const HOLD_OFF = 'Watchdog: hold on every seat lifted'

  async function outputs(h: Harness, count: number): Promise<string[]> {
    const out: string[] = []
    for (let i = 0; i < count; i++) {
      out.push(...(await runWatchdog(h.deps, ONE)))
      h.tick()
    }
    return out
  }

  it('logs a hold on every seat when it starts and when it ends, not every run', async () => {
    const h = harness(IDLE)
    h.deps.ownerMessages = () => undefined
    const first = await outputs(h, 2)
    h.deps.ownerMessages = () => []
    const last = await outputs(h, 1)
    const lines = [...first, ...last].filter(l => l !== GAP_LINE)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatch(HOLD_ON)
    expect(lines[1]).toBe(HOLD_OFF)
  })

  it('logs a restart window hold once across its runs', async () => {
    const h = harness(IDLE)
    h.ownerMessages = [{ ts: h.now() - 5 * 60_000, body: 'hjewkes-surplus: restart at 08:45' }]
    const out = (await outputs(h, 3)).filter(l => HOLD_ON.test(l))
    expect(out).toHaveLength(1)
  })

  it('logs a fire cap engaging once and lifting once', async () => {
    const h = harness(IDLE)
    const capLines = (lines: string[]): string[] => lines.filter(l => /fire cap (engaged|lifted)/.test(l))
    const engaged = capLines(await outputs(h, 8))
    expect(engaged).toHaveLength(1)
    expect(engaged[0]).toContain('fire cap engaged: 2 wake(s)')
    const busy: Roster = {
      agents: [{ name: 'hs-cc-1-x', profile: 'implementer', state: 'live', spawnedBy: 'hjewkes-surplus' }],
      connected: [],
    }
    const lifted = capLines(await runWatchdog({ ...h.deps, roster: async () => busy }, ONE))
    expect(lifted).toEqual(['hjewkes-surplus: Watchdog: fire cap lifted: an implementer ran'])
    expect(h.logs.filter(l => /fire cap (engaged|lifted)/.test(l))).toHaveLength(2)
  })

  it('reads a state file from before these fields as no hold and no cap', async () => {
    const h = harness(IDLE)
    h.doc = {
      seats: { 'hjewkes-surplus': { idleRuns: 0, at: h.now() - 60_000, fires: 0 } },
      pools: {},
      stopped: {},
    }
    const out = await outputs(h, 2)
    expect(out.filter(l => l !== GAP_LINE && !/woke/.test(l))).toEqual([])
  })
})

describe('wakeSeat', () => {
  function client(reply: Record<string, unknown>): { frames: unknown[]; client: BrokerClient } {
    const frames: unknown[] = []
    const request = async (frame: unknown) => (frames.push(frame), reply)
    return { frames, client: { request } as unknown as BrokerClient }
  }

  it('tags a message to a connected seat with source watchdog', async () => {
    const c = client({ t: 'send_result', ok: true, msgId: 'm1', recipients: ['s'] })
    expect(await wakeSeat(c.client, 's', 'Watchdog: x', true)).toEqual({ ok: true, detail: 'message m1' })
    expect(c.frames).toEqual([{ t: 'human_send', to: 's', text: 'Watchdog: x', source: 'watchdog' }])
  })

  it('tags a headless resume of a stopped seat with source watchdog', async () => {
    const c = client({ t: 'spawn_result', ok: true })
    await wakeSeat(c.client, 's', 'Watchdog: x', false)
    expect(c.frames).toEqual([
      { t: 'resume', name: 's', surface: 'headless', message: 'Watchdog: x', source: 'watchdog' },
    ])
  })
})

describe('watchdog disk state', () => {
  let dir: string
  const savedHome = process.env.AGENT_CHAT_HOME

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-seat-watchdog-'))
    process.env.AGENT_CHAT_HOME = dir
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
    if (savedHome === undefined) delete process.env.AGENT_CHAT_HOME
    else process.env.AGENT_CHAT_HOME = savedHome
  })

  it('round-trips seat state under AGENT_CHAT_HOME', () => {
    saveDoc({ seats: { s: { idleRuns: 1, at: 5 } }, pools: { p: { since: 1, last: 2, spent: 3 } } })
    expect(fs.existsSync(path.join(dir, 'seat-watchdog.json'))).toBe(true)
    expect(loadDoc()).toEqual({
      seats: { s: { idleRuns: 1, at: 5 } },
      pools: { p: { since: 1, last: 2, spent: 3 } },
      stopped: {},
    })
  })

  it("keeps the owner's stopped map as it is on disk when saving", () => {
    const file = path.join(dir, 'seat-watchdog.json')
    fs.writeFileSync(file, JSON.stringify({ stopped: { s: 'parked' } }))
    saveDoc({ seats: {}, pools: {} })
    expect(loadDoc().stopped).toEqual({ s: 'parked' })
  })

  it('reads missing state as empty', () => {
    expect(loadDoc()).toEqual({ seats: {}, pools: {}, stopped: {} })
  })

  it('appends a local HH:MM line to logs/<seat>/<local date>.md', () => {
    const at = new Date(2026, 8, 29, 6, 53)
    const file = appendSeatLog(dir, 'seat', at, 'Watchdog: fired')
    appendSeatLog(dir, 'seat', at, 'again')
    expect(file).toBe(path.join(dir, 'logs', 'seat', '2026-09-29.md'))
    expect(fs.readFileSync(file, 'utf8')).toBe('06:53 Watchdog: fired\n06:53 again\n')
  })
})

describe('watchdog launchd job', () => {
  it('runs `seats watchdog` at minutes 8, 23, 38 and 53, not at load', () => {
    const plist = renderWatchdogPlist({
      label: 'dev.hjewkes.agent-chat-seat-watchdog',
      nodePath: '/opt/node',
      cliEntry: '/repo/dist/cli.js',
      logDir: '/logs',
      env: {},
      minutes: [8, 23, 38, 53],
    })
    expect(plist).toContain(
      '<string>/repo/dist/cli.js</string>\n    <string>seats</string>\n    <string>watchdog</string>',
    )
    expect(plist).toContain('<key>StartCalendarInterval</key>')
    expect([...plist.matchAll(/<key>Minute<\/key>\n\s+<integer>(\d+)<\/integer>/g)].map(m => m[1])).toEqual([
      '8',
      '23',
      '38',
      '53',
    ])
    expect(plist).toContain('<key>RunAtLoad</key>\n  <false/>')
    expect(plist).not.toContain('StartInterval</key>\n  <integer>')
  })

  it('under --dry-run prints the plist and the launchctl calls without a kickstart, and only asks launchd whether it is loaded', () => {
    const calls: string[] = []
    const launchctl: Launchctl = args => {
      calls.push(args[0] ?? '')
      return { code: 113, stdout: '', stderr: '' }
    }
    const report = watchdogInstall({
      launchctl,
      uid: 501,
      dryRun: true,
      label: 'dev.hjewkes.agent-chat-seat-watchdog',
    })
    expect(report.ok).toBe(true)
    expect(report.lines[0]).toContain('<plist version="1.0">')
    expect(report.lines.some(l => l.startsWith('launchctl bootstrap gui/501'))).toBe(true)
    expect(report.lines.some(l => l.startsWith('launchctl kickstart'))).toBe(false)
    expect(calls).toEqual(['print'])
  })
})

describe('readOwnerMessages', () => {
  it("reads only the owner seat's restart messages since the cut-off", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-seat-watchdog-db-'))
    const file = path.join(dir, 'events.db')
    const db = new DatabaseSync(file)
    db.exec(
      'CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, kind TEXT, actor TEXT, body TEXT)',
    )
    const insert = db.prepare('INSERT INTO events (ts, kind, actor, body) VALUES (?, ?, ?, ?)')
    insert.run(1, 'message', 'owner', 'restart at 06:00')
    insert.run(5, 'message', 'owner', 'restart at 07:00')
    insert.run(6, 'message', 'other', 'restart at 07:00')
    insert.run(7, 'message', 'owner', 'merged #1')
    insert.run(8, 'broadcast', 'owner', 'restart done')
    db.close()
    try {
      expect(readOwnerMessages(file, 'owner', 2)).toEqual([
        { ts: 5, body: 'restart at 07:00' },
        { ts: 8, body: 'restart done' },
      ])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("waits out another process's write lock instead of failing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-seat-watchdog-db-'))
    const file = path.join(dir, 'events.db')
    const db = new DatabaseSync(file)
    db.exec(
      'CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, kind TEXT, actor TEXT, body TEXT)',
    )
    db.close()
    const holder = spawn(process.execPath, [
      '-e',
      `const { DatabaseSync } = require('node:sqlite')
       const db = new DatabaseSync(${JSON.stringify(file)})
       db.exec('BEGIN EXCLUSIVE')
       process.stdout.write('locked\\n')
       setTimeout(() => { db.exec('COMMIT'); db.close() }, 400)`,
    ])
    try {
      await new Promise<void>(resolve => holder.stdout.once('data', () => resolve()))
      expect(readOwnerMessages(file, 'owner', 0)).toEqual([])
    } finally {
      holder.kill()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('readAgentEvents', () => {
  it('reads only agent lifecycle rows before the cut-off, with meta parsed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-seat-watchdog-db-'))
    const file = path.join(dir, 'events.db')
    const db = new DatabaseSync(file)
    db.exec(
      'CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, kind TEXT, actor TEXT, target TEXT, msg_id TEXT, ref TEXT, body TEXT, meta TEXT)',
    )
    const insert = db.prepare(
      'INSERT INTO events (ts, kind, actor, target, msg_id, ref, meta) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    insert.run(1, 'agent_spawned', 'seat', 'w', 'a1', null, '{"profile":"implementer"}')
    insert.run(2, 'message', 'w', 'seat', 'm1', null, null)
    insert.run(3, 'agent_exited', 'w', null, 'e1', 'a1', null)
    db.close()
    try {
      const rows = readAgentEvents(file, 3)
      expect(rows).toEqual([
        {
          kind: 'agent_spawned',
          ts: 1,
          actor: 'seat',
          target: 'w',
          msgId: 'a1',
          ref: null,
          body: null,
          meta: { profile: 'implementer' },
        },
      ])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
