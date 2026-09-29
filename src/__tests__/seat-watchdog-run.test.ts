import fs from 'node:fs'
import { createRequire } from 'node:module'
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BudgetRead } from '../agents/budget.js'
import { appendSeatLog, loadStates, readAgentEvents, saveStates } from '../agents/seats/io.js'
import { runWatchdog, type Roster, type WatchdogDeps } from '../agents/seats/run.js'
import type { SeatState } from '../agents/seats/watchdog.js'
import { watchdogInstall } from '../cli/verbs/seats.js'
import type { Launchctl } from '../mirror/launchd.js'
import { renderWatchdogPlist } from '../mirror/plist.js'

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => DatabaseSyncType
}

const CHARTER = `---
seats: [hjewkes-surplus, unconfigured]
pools:
  claude:  {config_dir: /Users/o/.claude, human_uses: true, reserve_seven_day: 35, ceiling_five_hour: 70}
---
`
const SEAT = '---\nprefix: hs\npool: claude\n---\n'

const budget = (fiveHour: number): BudgetRead => ({
  found: true,
  path: '/x',
  age_seconds: 5,
  stale: false,
  budget: {
    session_id: 's',
    written_at: 0,
    context: { exceeds_200k: false },
    cost: {},
    rate_limits: { five_hour: { used_pct: fiveHour }, seven_day: { used_pct: 19 } },
  },
})

interface Harness {
  deps: WatchdogDeps
  wakes: { seat: string; message: string; connected: boolean }[]
  logs: string[]
  states: Record<string, SeatState>
  tick: () => void
}

function harness(roster: Roster, fiveHour = 41): Harness {
  let now = Date.parse('2026-09-29T06:38:00Z')
  const h: Harness = {
    wakes: [],
    logs: [],
    states: {},
    tick: () => void (now += 15 * 60_000),
    deps: {
      now: () => new Date(now),
      readCharter: () => CHARTER,
      readSeatFile: seat => (seat === 'hjewkes-surplus' ? SEAT : undefined),
      readBudget: () => budget(fiveHour),
      roster: async () => roster,
      eligible: () => 7,
      loadStates: () => ({ ...h.states }),
      saveStates: states => void (h.states = states),
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

describe('runWatchdog', () => {
  it('wakes a connected seat with the Discovery message on the second idle run, and logs it', async () => {
    const h = harness(IDLE)
    const first = await runWatchdog(h.deps, { seats: ['hjewkes-surplus'], dryRun: false })
    h.tick()
    const second = await runWatchdog(h.deps, { seats: ['hjewkes-surplus'], dryRun: false })
    expect(first).toEqual([])
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

  it('is silent while an implementer runs: no wake, no log line, no output', async () => {
    const busy: Roster = {
      agents: [{ name: 'hs-cc-1-x', profile: 'implementer', state: 'live', spawnedBy: 'hjewkes-surplus' }],
      connected: [],
    }
    const h = harness(busy)
    const out = [
      ...(await runWatchdog(h.deps, { seats: ['hjewkes-surplus'], dryRun: false })),
      ...(h.tick(), await runWatchdog(h.deps, { seats: ['hjewkes-surplus'], dryRun: false })),
    ]
    expect([out, h.wakes, h.logs]).toEqual([[], [], []])
    expect(h.states['hjewkes-surplus']?.idleRuns).toBe(0)
  })

  it('stays silent over the five-hour ceiling', async () => {
    const h = harness(IDLE, 70)
    await runWatchdog(h.deps, { seats: ['hjewkes-surplus'], dryRun: false })
    h.tick()
    await runWatchdog(h.deps, { seats: ['hjewkes-surplus'], dryRun: false })
    expect(h.wakes).toEqual([])
  })

  it('under --dry-run reports every charter seat and wakes, logs and saves nothing', async () => {
    const h = harness(IDLE)
    h.states = { 'hjewkes-surplus': { idleRuns: 1, at: Date.parse('2026-09-29T06:30:00Z') } }
    const out = await runWatchdog(h.deps, { dryRun: true })
    expect(out[0]).toMatch(/^hjewkes-surplus: WOULD FIRE: 0 implementers/)
    expect(out[1]).toMatch(/^unconfigured: skipped, seats\/unconfigured.md has no prefix or pool/)
    expect(h.wakes).toEqual([])
    expect(h.logs).toEqual([])
    expect(h.states['hjewkes-surplus']?.idleRuns).toBe(1)
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
    saveStates({ s: { idleRuns: 1, at: 5 } })
    expect(fs.existsSync(path.join(dir, 'seat-watchdog.json'))).toBe(true)
    expect(loadStates()).toEqual({ s: { idleRuns: 1, at: 5 } })
  })

  it('reads missing state as empty', () => {
    expect(loadStates()).toEqual({})
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

  it('under --dry-run prints the plist and the launchctl calls, and only asks launchd whether it is loaded', () => {
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
    expect(calls).toEqual(['print'])
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
