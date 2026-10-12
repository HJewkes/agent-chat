import fs from 'node:fs'
import type net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Conn } from '../broker/core.js'
import type { ProcessProbe } from '../agents/detached-reap.js'
import { readPresence, type WatchdogDoc } from '../agents/seats/io.js'
import { runWatchdog, type WatchdogDeps } from '../agents/seats/run.js'
import { transcriptPath } from '../agents/transcript.js'
import { startSupervisor, type RestartHarness } from './helpers/restart-harness.js'

/**
 * CC-344: a broker that dies writes no `deregistered` for a seat, so the seat's last row is an
 * open `registered` and its identity stays `live` with no process. The watchdog's first-seen
 * clock then resumes it, and the restarted broker must accept that resume rather than answer
 * "is already live; message it instead" until the eight tries run out.
 * The harness's stand-in child has pid 4242.
 */

const SEAT_NAME = 'seat-hub'
const PID = 4242
const RUN_MS = 15 * 60_000
/** The seat's pool is the account it was spawned on, else the watchdog refuses to resume it by name (CC-959). */
const charter = (poolDir: string): string => `---
owner_seat: ${SEAT_NAME}
seats: [${SEAT_NAME}]
pools:
  claude:  {config_dir: ${poolDir}, human_uses: true, reserve_seven_day: 35, ceiling_five_hour: 70, per_day_points: 13}
---
`
const SEAT = '---\nprefix: sh\npool: claude\nspend:\n  per_run_points: 6\n  per_day_points: 10\n---\n'

let sup: RestartHarness
let configDir: string
let alive: Set<number>

const probe: ProcessProbe = {
  isAlive: pid => alive.has(pid),
  readArgv: () => undefined,
  sessionRecords: () => [],
}

const fakeConn = (): Conn => ({}) as unknown as net.Socket
const stateOf = (): string | undefined => sup.core.agents.byName(SEAT_NAME)?.state
const kindsOf = (agentId: string): string[] =>
  sup.core.events
    .agentEvents()
    .filter(row => row.ref === agentId)
    .map(row => row.kind)

/** A spawned seat with a transcript, registered with the broker that is about to die. */
beforeEach(async () => {
  alive = new Set()
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-unclean-restart-'))
  sup = startSupervisor({ slots: 5, settleMs: 1000, processProbe: probe })
  const spawned = await sup.supervisor.spawn({
    name: SEAT_NAME,
    profile: 'explorer',
    brief: 'a seat',
    requestedBy: 'human',
    cwd: configDir,
    isolation: 'none',
    surface: 'headless',
    spawnerConfigDir: configDir,
  })
  const agent = sup.core.agents.get(String(spawned.agentId))
  if (agent?.state !== 'live') throw new Error('the spawned seat is not live')
  const file = transcriptPath(agent.cwd, agent.sessionId, agent.configDir)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '{}\n')
  sup.core.append({ kind: 'registered', actor: SEAT_NAME })
})

afterEach(() => {
  sup.close()
  fs.rmSync(configDir, { recursive: true, force: true })
})

interface Watchdog {
  deps: WatchdogDeps
  /** Runs one pass, then moves the clock on to the next scheduled run; returns the seat's lines. */
  run: () => Promise<string[]>
  /** Seats the pass resumed; a connected seat is messaged instead, which is not recorded. */
  resumes: string[]
  doc: WatchdogDoc
}

/** The watchdog over the restarted broker: its roster, its events.db, and resume through its supervisor. */
function watchdog(): Watchdog {
  let now = Date.now()
  const w: Watchdog = {
    resumes: [],
    doc: { seats: {}, pools: {}, stopped: {} },
    run: async () => {
      const out = await runWatchdog(w.deps, { seats: [SEAT_NAME], dryRun: false })
      now += RUN_MS
      return out.filter(line => line.startsWith(`${SEAT_NAME}: `))
    },
    deps: {
      now: () => new Date(now),
      readCharter: () => charter(configDir),
      readSeatFile: seat => (seat === SEAT_NAME ? SEAT : undefined),
      seatLogDays: () => [],
      readSeatLog: () => undefined,
      readBudget: () => ({
        found: true,
        path: '/x',
        age_seconds: 5,
        stale: false,
        budget: {
          session_id: 's',
          written_at: 0,
          context: { exceeds_200k: false },
          cost: {},
          rate_limits: { five_hour: { used_pct: 41 }, seven_day: { used_pct: 19 } },
        },
      }),
      ownerMessages: () => [],
      roster: async () => ({
        agents: sup.core.agents.roster({ includeRetired: false }),
        connected: sup.core.registry.list().map(session => session.name),
      }),
      presence: seat => readPresence(path.join(sup.home, 'events.db'), seat),
      eligible: () => ({ count: 7, skipped: 0 }),
      loadDoc: () => structuredClone(w.doc),
      saveDoc: doc => void (w.doc = { ...doc, stopped: w.doc.stopped }),
      wake: async (seat, message, connected) => {
        if (connected) return { ok: true, detail: 'message m1' }
        w.resumes.push(seat)
        const res = await sup.supervisor.resume(seat, { message, source: 'watchdog', surface: 'headless' })
        return { ok: res.ok, detail: res.ok ? 'resumed' : (res.reason ?? 'resume refused') }
      },
      appendLog: () => undefined,
      lock: () => ({ held: true, release: () => undefined }),
    },
  }
  return w
}

describe('a watchdog run after an unclean broker restart', () => {
  // Catches: staleLiveRefusal back to refusing any live row, which logs "resume FAILED … message it instead".
  it('resumes the seat on the first run past the dark threshold, and the broker accepts it', async () => {
    const agentId = sup.core.agents.byName(SEAT_NAME)?.agentId ?? ''
    sup.restart()
    const w = watchdog()

    const first = await w.run()
    const second = await w.run()

    expect(first).toEqual([])
    expect(second).toEqual([expect.stringMatching(/absent 15 min since first seen .*; resumed seat-hub/)])
    expect([...first, ...second].join('\n')).not.toContain('already live')
    expect(w.resumes).toEqual([SEAT_NAME])
    expect(w.doc.seats[SEAT_NAME]?.resumeRetry).toBeUndefined()
    expect(kindsOf(agentId)).toContain('agent_resumed')
  })

  it('is never refused as live across eight runs, so no path spends the eight tries', async () => {
    sup.restart()
    const w = watchdog()

    const lines: string[] = []
    for (let run = 0; run < 8; run++) lines.push(...(await w.run()))

    expect(w.resumes).toEqual([SEAT_NAME])
    expect(lines.join('\n')).not.toMatch(/already live|resume FAILED|try \d of 8|giving up/)
  })

  // Catches: staleLiveRefusal back to refusing any live row; the boot reap spared this one, so only resume can see it dead.
  it('resumes a seat whose process died after the new broker booted, once the live-row grace is past', async () => {
    alive.add(PID)
    sup.restart()
    alive.delete(PID)
    expect(stateOf()).toBe('live')
    const w = watchdog()

    const lines: string[] = []
    for (let run = 0; run < 4; run++) lines.push(...(await w.run()))

    expect(w.resumes).toEqual([SEAT_NAME])
    expect(lines.at(-1)).toMatch(/absent 45 min since first seen .*; resumed seat-hub/)
    expect(lines.join('\n')).not.toMatch(/already live|resume FAILED/)
    expect(w.doc.seats[SEAT_NAME]?.resumeRetry).toBeUndefined()
  })

  // Pins the refusal text CC-344 slice b matches; catches a dead verdict for a live, unreadable pid.
  it('is refused with "is already live" when the old process may still run, once the live-row grace is past', async () => {
    alive.add(PID)
    sup.restart()
    expect(stateOf()).toBe('live')
    const w = watchdog()

    const lines: string[] = []
    for (let run = 0; run < 4; run++) lines.push(...(await w.run()))

    expect(w.resumes).toEqual([SEAT_NAME])
    expect(lines.at(-1)).toMatch(
      /resume REFUSED seat-hub \(seat-hub is already live: .+\); seat may be live, not counted as a try/,
    )
    expect(lines.join('\n')).not.toContain('message it instead')
    expect(stateOf()).toBe('live')
  })

  // Catches: dropping judgeLiveness's connected early return, which would resume a seat that reconnected.
  it('leaves a seat that reconnected to the new broker alone', async () => {
    sup.restart()
    sup.reattach([SEAT_NAME])
    sup.core.registry.register(fakeConn(), { name: SEAT_NAME, workingOn: '', cwd: configDir, pid: 1 })
    sup.core.append({ kind: 'registered', actor: SEAT_NAME })
    const w = watchdog()

    const lines = [...(await w.run()), ...(await w.run())]

    expect(w.resumes).toEqual([])
    expect(lines.join('\n')).not.toMatch(/resume|absent/)
  })
})
