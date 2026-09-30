import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stringify } from 'yaml'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readAccountBudget } from '../agents/budget.js'
import { scoredPlanFromDisk } from '../agents/burndown/score-render.js'
import type { WatchdogDoc } from '../agents/seats/io.js'
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
import { statusReport } from '../cli/verbs/seats.js'
import type { ServerMessage } from '../protocol.js'

/**
 * CC-317: `seats status` answers a seat's tick questions in one read-only call.
 * The broker, the autonomy root, the pool's status file and every name are synthetic.
 */

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'score-2026-09-29')
const fixture = (file: string) => fs.readFileSync(path.join(FIXTURE, file), 'utf8')

const SEAT = 'sample-seat'
const POOL = 'pool-a'
const NOW = new Date(2026, 8, 29, 10, 0)
const SEAT_EXTRA = [
  'prefix: ss',
  `pool: ${POOL}`,
  'concurrency: {implementers: 2, reviewers: 1, planners: 1}',
  'spend:',
  '  per_day_points: 10',
].join('\n')

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

function writeAutonomy(): void {
  const pools = `pools:\n  ${POOL}: {config_dir: ${poolDir}, human_uses: false, reserve_seven_day: 35, ceiling_five_hour: 70}`
  fs.mkdirSync(path.join(autonomy, 'seats'), { recursive: true })
  fs.writeFileSync(path.join(autonomy, 'charter.md'), beforeFrontmatterEnd(fixture('charter.md'), pools))
  fs.writeFileSync(
    path.join(autonomy, 'seats', `${SEAT}.md`),
    beforeFrontmatterEnd(fixture('seats/sample-seat.md'), SEAT_EXTRA),
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

/** The pool's status file, as the status line writes it, `ageSeconds` before `NOW`. */
function writeReading(fiveHour: number, sevenDay: number, ageSeconds = 30): void {
  const dir = path.join(poolDir, 'status-cache', 'sessions')
  fs.mkdirSync(dir, { recursive: true })
  const reading = {
    session_id: 'session-1',
    written_at: NOW.getTime() / 1000 - ageSeconds,
    rate_limits: { five_hour: { used_pct: fiveHour }, seven_day: { used_pct: sevenDay } },
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
  cwd?: string
}

function seedAgent({ name, profile, spawnedBy = SEAT, exited = false, cwd = tmp }: AgentSeed): void {
  const id = `agent-${++agentIds}`
  core.append({
    kind: 'agent_spawned',
    actor: spawnedBy,
    target: name,
    msgId: id,
    body: 'synthetic brief',
    meta: { profile, cwd, isolation: 'worktree' },
  })
  core.append({ kind: 'agent_attached', actor: name, ref: id })
  if (exited) core.append({ kind: 'agent_exited', actor: name, ref: id })
}

function deps(over: Partial<StatusDeps> = {}): StatusDeps {
  return {
    now: () => NOW,
    autonomyRoot: autonomy,
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
    ...over,
  }
}

const status = (over: Partial<StatusDeps> = {}): Promise<SeatStatus> => seatStatus(deps(over), SEAT)

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ac-seat-status-')))
  autonomy = path.join(tmp, 'autonomy')
  activeWork = path.join(tmp, 'active-work')
  poolDir = path.join(tmp, 'pool')
  doc = { seats: {}, pools: {}, stopped: {} }
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

    expect(implementers).toEqual({ active: 2, cap: 2, atCap: true, names: ['helper', 'ss-al-1'] })
  })

  it('reports a seat one implementer under its cap as not at cap', async () => {
    seedAgent({ name: 'ss-al-1', profile: 'implementer' })

    const { implementers } = await status()

    expect(implementers).toMatchObject({ active: 1, cap: 2, atCap: false })
  })

  it('counts running reviewers and planners against their own caps', async () => {
    seedAgent({ name: 'ss-al-1-review', profile: 'reviewer' })
    seedAgent({ name: 'ss-al-9-review', profile: 'reviewer', exited: true })

    const { reviewers, planners } = await status()

    expect(reviewers).toEqual({ active: 1, cap: 1, atCap: true, names: ['ss-al-1-review'] })
    expect(planners).toEqual({ active: 0, cap: 1, atCap: false, names: [] })
  })

  it('counts exited implementers as parked and names the ones whose tree is still on disk', async () => {
    seedAgent({ name: 'ss-al-3', profile: 'implementer', exited: true, cwd: path.join(tmp, 'removed-tree') })
    seedAgent({ name: 'ss-al-4', profile: 'implementer', exited: true, cwd: autonomy })

    const { parked, implementers } = await status()

    expect(parked).toEqual({ count: 2, names: ['ss-al-3', 'ss-al-4'], treeOnDisk: ['ss-al-4'] })
    expect(implementers.active).toBe(0)
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
    })
    expect(budget.margin).toContain('seven_day 41% vs line 65%')
  })

  it('names the stop for a seat past its seven_day line', async () => {
    writeReading(12, 70)

    const { budget } = await status()

    expect(budget.stop).toBe(`BUDGET-PAUSE pool ${POOL}: seven_day 70% at or above line 65%`)
    expect(budget.margin).toBeNull()
  })

  it("names the day spend stop from the watchdog's saved pool meter", async () => {
    const since = new Date(2026, 8, 29, 7, 30).getTime()
    doc.pools[POOL] = { since, last: 30, spent: 0 }

    const { budget } = await status()

    expect(budget.stop).toContain("day spend 11 points since 07:00 at or above the seat's per_day_points 10")
  })

  it('shows the age of a stale reading and closes the gate on it', async () => {
    writeReading(12, 41, 1200)

    const { budget } = await status()

    expect(budget).toMatchObject({ sevenDay: 41, ageSeconds: 1200, stale: true })
    expect(budget.stop).toContain('reading is 1200s old')
  })

  it('reports a pool with no status file as having no reading, and stops on it', async () => {
    fs.rmSync(poolDir, { recursive: true })

    const { budget } = await status()

    expect(budget).toMatchObject({ sevenDay: null, fiveHour: null, ageSeconds: null, stale: true })
    expect(budget.stop).toContain('no seven_day and five_hour reading')
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

  it('keeps every other reading and carries the error when the scorer throws', async () => {
    seedAgent({ name: 'ss-al-1', profile: 'implementer' })
    const scored = (): never => {
      throw new Error('scorer exploded')
    }

    const result = await status({ scored })

    expect(result.eligible).toEqual({ top: [], skipped: 0, today: '2026-09-29', error: 'scorer exploded' })
    expect(result.implementers.active).toBe(1)
    expect(result.budget.sevenDay).toBe(41)
    expect(result.inbox.unread).toBe(0)
  })
})

describe('the status verb', () => {
  it('refuses a name the charter does not list as a seat', async () => {
    const report = await statusReport(deps(), 'no-such-seat', true)

    expect(report.ok).toBe(false)
    expect(report.lines).toEqual([])
    expect(report.errors?.[0]).toContain('no-such-seat is not a seat')
  })

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
      'planners      0/1',
      'parked        1  tree on disk: ss-al-4',
      `budget        pool ${POOL}: seven_day 70%, five_hour 12% (reading 30s old)`,
      `stop          BUDGET-PAUSE pool ${POOL}: seven_day 70% at or above line 65%`,
      'inbox         0 unread (the seat has sent nothing)',
      'eligible      AL-1  72.0  alpha  Harden the secret store against injection',
      '              AL-2  51.6  alpha  Add the export feature to the dashboard',
      '              BE-3  51.2  beta  Survey the queue behaviour',
    ])
  })

  it('marks a stale reading, an open gate and a failed scorer in the table', async () => {
    writeReading(12, 41, 300)
    const scored = (): never => {
      throw new Error('scorer exploded')
    }

    const { lines } = await statusReport(deps({ scored }), SEAT, false)

    expect(lines.slice(5)).toEqual([
      `budget        pool ${POOL}: seven_day 41%, five_hour 12% (reading 300s old, STALE)`,
      `stop          none; pool ${POOL}: five_hour 12% vs ceiling 70%, seven_day 41% vs line 65%`,
      'inbox         0 unread (the seat has sent nothing)',
      'eligible      unavailable: scorer exploded',
    ])
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
