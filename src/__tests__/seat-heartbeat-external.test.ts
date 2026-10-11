import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkHeartbeat, type HeartbeatCheckDeps } from '../agents/seats/heartbeat-check.js'
import {
  EXTERNAL_HEARTBEAT_MESSAGE,
  heartbeatUnits,
  judgeExternal,
  lastTickAt,
  quietLimitMs,
  type HeartbeatJobContext,
} from '../agents/seats/heartbeat-external.js'
import { installHeartbeats, refreshHeartbeat } from '../agents/seats/heartbeat-install.js'
import type { WatchdogDeps } from '../agents/seats/run.js'
import type { OwnerMessage } from '../agents/seats/stops.js'

const DAY = new Date(2026, 9, 8, 12)
const at = (hh: number, mm: number, day = 8): number => new Date(2026, 9, day, hh, mm).getTime()
const MIN = 60_000

const CTX: HeartbeatJobContext = {
  nodePath: '/opt/node/bin/node',
  cliEntry: '/opt/agent-chat/dist/cli.js',
  root: '/srv/autonomy',
  env: { HOME: '/srv/tester', PATH: '/usr/bin' },
  logDir: '/var/lib/heartbeat-logs',
}

const seatFile = (cron?: string): string =>
  `---\nprefix: sa\npool: p\n${cron === undefined ? '' : `heartbeat_cron: "${cron}"\n`}---\n`

describe('lastTickAt', () => {
  // Catches: matching any seat line as a tick, so a spawn or watchdog line would suppress the heartbeat.
  it('reads only tick lines, ignoring broker, watchdog and prose lines after them', () => {
    const log = [
      '09:17 tick: 1 implementer, dispatched X-1',
      '09:30 spawn X-2 sa-x-2 -',
      '09:38 Watchdog: idle',
    ].join('\n')
    expect(lastTickAt(log, DAY)).toBe(at(9, 17))
  })

  // Catches: reading a hand-typed `x` minute as 9 (or dropping the line), which would hide a stale seat.
  it('reads a tick with an x minute digit as the earliest minute it could be', () => {
    expect(lastTickAt('10:4x tick: nothing eligible', DAY)).toBe(at(10, 40))
  })

  // Review of #548. Catches: a case-sensitive `tick:`-only match, which never sees a seat writing
  // `TICK impl 2/2`, `tick.` or `tick (`, so a healthy seat got a fallback tick on every firing.
  it.each([
    ['00:29 TICK impl 2/2, rev 0, dispatched nothing'],
    ['00:29 tick. 1 implementer, budget 40%'],
    ['00:29 tick (late): nothing eligible'],
    ['00:29 Boot tick: 0 implementers'],
    ['00:2x Tick: nothing eligible'],
  ])('reads the seat wording %j as a tick', line => {
    expect(lastTickAt(line, DAY)).toBe(at(0, 20 + (line.includes('2x') ? 0 : 9)))
  })

  // Catches: loosening the match so far that a line merely mentioning a tick counts as one.
  it('does not read a tick named mid-line as a tick', () => {
    expect(lastTickAt('00:29 Merged the PR that fixed the tick parser', DAY)).toBeUndefined()
  })

  // Catches: taking the first tick line instead of the latest.
  it('takes the latest tick of the day', () => {
    expect(lastTickAt('08:17 tick: a\n08:47 tick: b\n', DAY)).toBe(at(8, 47))
  })
})

describe('judgeExternal', () => {
  const judge = (nowMs: number, lastTick: number | undefined) =>
    judgeExternal({ nowMs, lastTickAt: lastTick, quietMs: 35 * MIN }).send

  // Catches: a limit applied off by one in either direction.
  it('stays quiet under the limit since the tick and sends at it', () => {
    const tick = at(10, 0)
    expect(judge(tick + 34 * MIN, tick)).toBe(false)
    expect(judge(tick + 35 * MIN, tick)).toBe(true)
  })

  // Catches: treating a connected, unheld seat that never logged a tick as alive.
  it('sends when no log holds a tick line', () => {
    expect(judge(at(12, 0), undefined)).toBe(true)
  })
})

describe('quietLimitMs', () => {
  // Review of #548. Catches: a fixed 35-min limit, which ticks an hourly-cron seat every hour on top of its own cron.
  it("is the cron's widest gap across the hour plus five minutes", () => {
    expect(quietLimitMs([17, 47])).toBe(35 * MIN)
    expect(quietLimitMs([17])).toBe(65 * MIN)
    expect(quietLimitMs([50, 5, 20])).toBe(35 * MIN)
  })
})

describe('heartbeatUnits', () => {
  // Catches: a timer on fixed watchdog minutes instead of the seat's own heartbeat_cron.
  it("fires the timer on the seat's cron minutes and runs heartbeat-check for that seat", () => {
    const units = heartbeatUnits('seat-a', '17,47 * * * *', CTX)
    if (typeof units === 'string') throw new Error(units)
    expect(units.name).toBe('agent-chat-heartbeat-seat-a')
    expect(units.timer).toContain('OnCalendar=*-*-* *:17:00\nOnCalendar=*-*-* *:47:00')
    expect(units.service).toContain(
      'ExecStart=/opt/node/bin/node /opt/agent-chat/dist/cli.js seats heartbeat-check --seat seat-a --root /srv/autonomy',
    )
  })

  // Catches: rendering an hour-restricted cron as every hour, which would tick a seat outside its hours.
  it('refuses a cron that restricts hours or is missing', () => {
    expect(heartbeatUnits('seat-a', '17 8-18 * * *', CTX)).toMatch(/restricts hours/)
    expect(heartbeatUnits('seat-a', undefined, CTX)).toBe('no heartbeat_cron')
  })
})

describe('installHeartbeats and refreshHeartbeat', () => {
  let dir: string
  const files: Record<string, string> = {}
  const input = (print = false, ctx = CTX) => ({
    seats: Object.keys(files),
    readSeatFile: (seat: string) => files[seat],
    ctx,
    targetDir: dir,
    print,
    tmpdir: '/scratch',
  })
  /** The context a `seats watchdog` run from a worktree build would hand the refresh. */
  const WORKTREE_CTX = { ...CTX, cliEntry: '/src/agent-chat/.worktrees/tc-x/dist/cli.js' }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-units-'))
    for (const key of Object.keys(files)) delete files[key]
    files['seat-a'] = seatFile('17,47 * * * *')
    files['seat-b'] = seatFile()
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  // Catches: a seat without a heartbeat_cron getting a timer, or one with a cron getting none.
  it('writes a service and timer per seat with a cron and skips the rest', () => {
    const result = installHeartbeats(input())
    expect(fs.readdirSync(dir).sort()).toEqual([
      'agent-chat-heartbeat-seat-a.service',
      'agent-chat-heartbeat-seat-a.timer',
    ])
    expect(result.lines).toContain('seat-b: skipped, no heartbeat_cron')
  })

  // Catches: install enabling the timers (the owner's decision), or an enable line built from every
  // seat name, which names seat-b's timer although seat-b has no cron and got no units.
  it('names the enable command for the rendered seats only, without running it', () => {
    expect(installHeartbeats(input()).lines.at(-1)).toBe(
      "not enabled: enabling is the owner's call; to enable, run systemctl --user daemon-reload && " +
        'systemctl --user enable --now agent-chat-heartbeat-seat-a.timer',
    )
  })

  // Catches: an install that writes units pointing into a worktree, which die once the tree is parked.
  it('refuses to write units whose CLI entry is inside a worktree, and names no timer to enable', () => {
    const result = installHeartbeats(input(false, WORKTREE_CTX))
    expect(result.ok).toBe(false)
    expect(result.errors).toEqual([expect.stringMatching(/^refused: CLI entry .* is inside a worktree/)])
    expect(result.lines).toEqual(['seat-b: skipped, no heartbeat_cron'])
    expect(fs.readdirSync(dir)).toEqual([])
  })

  // Catches: --dry-run writing files.
  it('prints the units and writes nothing under --dry-run', () => {
    const result = installHeartbeats(input(true))
    expect(fs.readdirSync(dir)).toEqual([])
    expect(result.lines).toContain(`# ${path.join(dir, 'agent-chat-heartbeat-seat-a.timer')}`)
  })

  // Catches: the relaunch hook installing a timer the owner never installed.
  it('refreshes nothing for a seat whose timer is not installed', () => {
    expect(refreshHeartbeat(input(), 'seat-a')).toBeUndefined()
    expect(fs.readdirSync(dir)).toEqual([])
  })

  // Catches: the relaunch hook leaving an installed timer on a cron the seat file no longer has.
  it('rewrites an installed timer after the seat cron changed, and is quiet when nothing did', () => {
    installHeartbeats(input())
    expect(refreshHeartbeat(input(), 'seat-a')).toBeUndefined()
    files['seat-a'] = seatFile('5,35 * * * *')
    expect(refreshHeartbeat(input(), 'seat-a')).toMatch(/^heartbeat units refreshed \(rewrite .*\.timer\)/)
    expect(fs.readFileSync(path.join(dir, 'agent-chat-heartbeat-seat-a.timer'), 'utf8')).toContain('*:05:00')
  })

  // Round 3 of #548. Catches: the watchdog's refresh path skipping the worktree guard, so a
  // `seats watchdog` run from a worktree build repoints the owner's installed units into that tree.
  it('refuses a refresh from a worktree build and leaves the installed unit untouched', () => {
    installHeartbeats(input())
    const service = path.join(dir, 'agent-chat-heartbeat-seat-a.service')
    const before = fs.readFileSync(service, 'utf8')
    expect(refreshHeartbeat(input(false, WORKTREE_CTX), 'seat-a')).toMatch(
      /^heartbeat units not refreshed: refused: CLI entry .* is inside a worktree/,
    )
    expect(fs.readFileSync(service, 'utf8')).toBe(before)
  })
})

const CHARTER =
  '---\nowner_seat: seat-hub\nseats: [seat-a]\npools:\n  p:  {config_dir: /srv/p, reserve_seven_day: 35, ceiling_five_hour: 70}\n---\n'

interface Rig {
  deps: HeartbeatCheckDeps
  logs: Map<number, string>
  sent: { at: number; seat: string; message: string }[]
  events: { event: string; detail: Record<string, unknown> }[]
  setNow: (ms: number) => void
  /** What the watchdog's readings say: who is connected, owner stops, owner messages, machine pressure. */
  world: { connected: string[]; stopped: Record<string, string>; owner: OwnerMessage[]; machine?: string }
}

const dayKey = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()

/** A fake clock, a fake broker, and the watchdog's readings over an in-memory log keyed by local day. */
function rig(cron = '17,47 * * * *'): Rig {
  let now = at(8, 0)
  const logs = new Map<number, string>()
  const sent: Rig['sent'] = []
  const events: Rig['events'] = []
  const world: Rig['world'] = { connected: ['seat-a'], stopped: {}, owner: [] }
  const watchdog: WatchdogDeps = {
    now: () => new Date(now),
    readCharter: () => CHARTER,
    readSeatFile: () => seatFile(cron),
    seatLogDays: () => [...logs.keys()].sort((x, y) => y - x).map(k => new Date(k + 12 * 60 * MIN)),
    readSeatLog: (_seat, day) => logs.get(dayKey(day)),
    readBudget: () => ({ found: false, path: '/x', reason: 'no_file' }),
    ownerMessages: () => world.owner,
    machineStop: () => world.machine,
    roster: async () => ({ agents: [], connected: world.connected }),
    presence: () => undefined,
    eligible: () => undefined,
    loadDoc: () => ({ seats: {}, pools: {}, stopped: world.stopped }),
    saveDoc: () => undefined,
    wake: async () => ({ ok: false, detail: 'the check never wakes through the watchdog' }),
    appendLog: () => undefined,
    lock: () => ({ held: true, release: () => undefined }),
  }
  const deps: HeartbeatCheckDeps = {
    watchdog,
    send: async (seat, message) => {
      sent.push({ at: now, seat, message })
      return { ok: true, detail: `message m${sent.length}` }
    },
    logEvent: (event, detail) => events.push({ event, detail }),
  }
  return { deps, logs, sent, events, world, setNow: ms => void (now = ms) }
}

const clock = (ms: number): string => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function appendLine(r: Rig, ms: number, text: string): void {
  const key = dayKey(new Date(ms))
  r.logs.set(key, `${r.logs.get(key) ?? ''}${clock(ms)} ${text}\n`)
}

const appendTick = (r: Rig, ms: number): void => appendLine(r, ms, 'tick: 0 implementers, nothing eligible')

const check = async (r: Rig): Promise<string> => (await checkHeartbeat(r.deps, 'seat-a', false)).line

describe('checkHeartbeat', () => {
  // Catches: a send without the heartbeat_external event, or with another message than the charter's.
  it('sends the charter heartbeat and logs heartbeat_external when the seat is quiet', async () => {
    const r = rig()
    appendTick(r, at(9, 17))
    r.setNow(at(9, 52))
    expect(await check(r)).toBe('seat-a: no tick for 35 min; heartbeat sent (message m1)')
    expect(r.sent).toEqual([{ at: at(9, 52), seat: 'seat-a', message: EXTERNAL_HEARTBEAT_MESSAGE }])
    expect(r.events).toEqual([
      {
        event: 'heartbeat_external',
        detail: { seat: 'seat-a', reason: 'no tick for 35 min', ok: true, detail: 'message m1' },
      },
    ])
  })

  // Round 1 of #548. Catches: a fixed 35-min limit; an hourly seat that ticked 40 min ago is healthy.
  it("holds an hourly seat until its own cron's gap plus five minutes", async () => {
    const r = rig('17 * * * *')
    appendTick(r, at(9, 17))
    r.setNow(at(9, 57))
    expect(await check(r)).toBe('seat-a: skip: ticked 40 min ago, under 65')
    r.setNow(at(10, 22))
    await check(r)
    expect(r.sent).toHaveLength(1)
  })

  // Round 1 of #548. Catches: units left behind after the cron is removed still ticking the seat.
  it('sends nothing once the seat file has no heartbeat_cron', async () => {
    const r = rig('')
    r.setNow(at(12, 0))
    expect(await check(r)).toBe('seat-a: skip: no heartbeat_cron')
    expect(r.sent).toEqual([])
  })

  // Catches: --dry-run sending or logging.
  it('sends and logs nothing under --dry-run', async () => {
    const r = rig()
    r.setNow(at(9, 52))
    expect((await checkHeartbeat(r.deps, 'seat-a', true)).line).toMatch(/WOULD SEND/)
    expect(r.sent).toEqual([])
    expect(r.events).toEqual([])
  })

  // Catches: reading only today's file, which would tick a seat that ticked at 23:50 at five past midnight.
  it("counts yesterday's tick just after midnight", async () => {
    const r = rig()
    appendTick(r, at(23, 50, 8))
    r.setNow(at(0, 5, 9))
    expect(await check(r)).toBe('seat-a: skip: ticked 15 min ago, under 35')
  })
})

/** Round 2 of #548: the check holds exactly where the watchdog's `seatGate` does. */
describe('checkHeartbeat holds where the watchdog holds', () => {
  const quietSeat = (): Rig => {
    const r = rig()
    appendTick(r, at(9, 17, 5))
    r.setNow(at(12, 0, 8))
    return r
  }

  // Catches: a two-day log window, which misses a WRAP three days old and ticks a seat that stopped itself.
  it('holds a seat whose stop line sits in a file older than yesterday', async () => {
    const r = quietSeat()
    appendLine(r, at(9, 30, 5), 'WRAP done until the owner is back')
    expect(await check(r)).toBe('seat-a: skip: held: seat logged "WRAP done until the owner is back"')
    expect(r.sent).toEqual([])
  })

  // Catches: a BUDGET-PAUSE ended by a fallback tick.
  it('holds a seat whose latest line is BUDGET-PAUSE', async () => {
    const r = quietSeat()
    appendLine(r, at(9, 5, 8), 'BUDGET-PAUSE until 14:00')
    expect(await check(r)).toMatch(/^seat-a: skip: held: seat logged "BUDGET-PAUSE/)
  })

  // Catches: ignoring the owner's stop in seat-watchdog.json.
  it('holds a seat the owner stopped', async () => {
    const r = quietSeat()
    r.world.stopped = { 'seat-a': 'off for the week' }
    expect(await check(r)).toBe('seat-a: skip: held: stopped by the owner: off for the week')
  })

  // Catches: ticking a seat inside an announced broker restart window.
  it('holds every seat while the owner seat has announced a restart without "restart done"', async () => {
    const r = quietSeat()
    r.world.owner = [{ ts: at(11, 50, 8), body: 'broker restart at 12:10' }]
    expect(await check(r)).toMatch(/^seat-a: skip: held: restart window open since/)
    expect(r.sent).toEqual([])
  })

  // Catches: ignoring machine pressure.
  it('holds a seat while the machine is under pressure', async () => {
    const r = quietSeat()
    r.world.machine = 'memory 3% free under 5%'
    expect(await check(r)).toBe('seat-a: skip: held: memory 3% free under 5%')
  })

  // Catches: a send to a dark seat, which piles held heartbeats in the broker's hold for it.
  it('sends nothing to a seat with no connected session', async () => {
    const r = quietSeat()
    r.world.connected = []
    expect(await check(r)).toBe('seat-a: skip: not connected')
    expect(r.sent).toEqual([])
  })
})

/** The minutes in a rendered timer's `OnCalendar=*-*-* *:MM:00` lines: the simulation fires what systemd would. */
const timerMinutes = (timer: string): number[] =>
  [...timer.matchAll(/^OnCalendar=\*-\*-\* \*:(\d\d):00$/gm)].map(m => Number(m[1]))

describe('with CronCreate disabled, the timer still ticks the seat', () => {
  // Catches: any change that leaves a seat untouched for more than 30 min past its first missed
  // slot, e.g. the watchdog's 65-min quiet threshold, timer minutes off the seat's cron, or no send.
  it('delivers a tick within 30 min of the first slot the dead cron missed', async () => {
    const units = heartbeatUnits('seat-a', '17,47 * * * *', CTX)
    if (typeof units === 'string') throw new Error(units)
    const fires = new Set(timerMinutes(units.timer ?? ''))
    const r = rig()
    const cronDiesAt = at(10, 20)
    const delivered: number[] = []
    for (let t = at(8, 0); t <= at(14, 0); t += MIN) {
      r.setNow(t)
      const minute = new Date(t).getMinutes()
      // The seat's own CronCreate heartbeat ticks it until the session that held the cron ends.
      if (t < cronDiesAt && (minute === 17 || minute === 47)) appendTick(r, t)
      if (!fires.has(minute)) continue
      const before = r.sent.length
      await checkHeartbeat(r.deps, 'seat-a', false)
      // The fake broker delivers at once, and the seat runs its tick and logs it a minute later.
      if (r.sent.length > before) {
        delivered.push(t)
        appendTick(r, t + MIN)
      }
    }
    const firstMissedSlot = at(10, 47)
    expect(delivered[0]).toBeDefined()
    expect((delivered[0] ?? Infinity) - firstMissedSlot).toBeLessThanOrEqual(30 * MIN)
    expect(r.sent.every(s => s.message === EXTERNAL_HEARTBEAT_MESSAGE)).toBe(true)
    expect(r.events.filter(e => e.event === 'heartbeat_external')).toHaveLength(delivered.length)
    // While the seat's own cron ran, the timer never doubled its tick.
    expect(delivered.every(t => t >= firstMissedSlot)).toBe(true)
  })
})
