import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventLog } from '../broker/event-log.js'
import type { AgentEventRow } from '../broker/event-store.js'
import {
  lastWatchRow,
  parseSeatStatus,
  readReports,
  readSeatBook,
  readUnread,
} from '../agents/seats/seat-watch-read.js'
import { runWatch, type WatchPorts } from '../agents/seats/seat-watch-run.js'
import type { WatchRow } from '../agents/seats/seat-watch.js'
import { seatsWatchVerb } from '../cli/verbs/seats-watch.js'

let clock = 0
const row = (kind: AgentEventRow['kind'], id: string, name: string, meta: Record<string, string> = {}) => ({
  kind,
  ts: ++clock,
  actor: kind === 'agent_spawned' ? 'spawner' : name,
  target: kind === 'agent_attached' ? null : name,
  msgId: kind === 'agent_spawned' ? id : `${kind}-${id}`,
  ref: kind === 'agent_spawned' ? null : id,
  body: null,
  meta,
})

const coordinator = { role: 'coordinator', profile: 'coord-profile' }
const seatRows = (id: string, name: string): AgentEventRow[] => [
  row('agent_spawned', id, name, coordinator),
  row('agent_attached', id, name),
]

/** Seats a and b are live; seat-c is in the charter but its coordinator was retired. */
const ROWS: AgentEventRow[] = [
  ...seatRows('a1', 'seat-a'),
  ...seatRows('b1', 'seat-b'),
  ...seatRows('c1', 'seat-c'),
  row('agent_retired', 'c1', 'seat-c'),
]

const CHARTER = '---\nseats: [seat-a, seat-b, seat-c]\n---\n'

let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-watch-'))
  fs.mkdirSync(path.join(root, 'seats', 'retired'), { recursive: true })
  fs.writeFileSync(path.join(root, 'seats', 'seat-a.md'), '---\nprefix: sa\npool: p\n---\n')
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function ports(over: Partial<WatchPorts> = {}): { ports: WatchPorts; written: WatchRow[] } {
  const written: WatchRow[] = []
  const ports: WatchPorts = {
    now: () => new Date(2026, 0, 5, 3),
    book: rows => readSeatBook(root, CHARTER, 'operator-seat', rows),
    owners: () => new Set(['human']),
    operator: 'operator-seat',
    agentRows: () => ROWS,
    unread: seat =>
      seat === 'seat-a' ? [{ from: 'human', kind: 'message', msgId: 'm1', ts: 1, body: 'go' }] : [],
    activity: () => new Map(),
    reports: () => new Map(),
    flights: async () => [],
    budget: async () => ({ implementers: 0, cap: 0, stop: null }),
    queue: () => 0,
    dispatcherCovers: () => false,
    lastRow: seat => written.filter(r => r.seat === seat).at(-1),
    append: r => written.push(r),
    ...over,
  }
  return { ports, written }
}

describe('seats watch pass', () => {
  it('in shadow mode records a wake and never calls the sender', async () => {
    const send = vi.fn(async () => true)
    const { ports: p, written } = ports({ send })

    const result = await runWatch(p, { shadow: true })

    expect(send).not.toHaveBeenCalled()
    expect(written.map(r => [r.seat, r.decision, r.shadow])).toEqual([
      ['seat-a', 'wake', true],
      ['seat-b', 'skip', true],
    ])
    expect(result.rows[0]?.delivery).toBeUndefined()
  })

  it('outside shadow mode sends only the wakes', async () => {
    const send = vi.fn(async () => true)
    const { ports: p, written } = ports({ send })

    await runWatch(p, { shadow: false })

    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]?.[0]).toBe('seat-a')
    expect(written[0]?.delivery).toBe('delivered')
  })

  it('refuses a live pass with no sender', async () => {
    await expect(runWatch(ports().ports, { shadow: false })).rejects.toThrow('needs a sender')
  })

  it('skips a charter seat whose coordinator is retired, and the operator when it is not running', async () => {
    const result = await runWatch(ports().ports, { shadow: true })

    expect(result.rows.map(r => r.seat)).toEqual(['seat-a', 'seat-b'])
    expect(result.retired).toEqual(['seat-c', 'operator-seat'])
  })

  it('re-reads the book each pass, so a seat retired between passes gets no row', async () => {
    let rows = ROWS
    const { ports: p, written } = ports({ agentRows: () => rows })
    await runWatch(p, { shadow: true })
    rows = [...ROWS, row('agent_retired', 'b1', 'seat-b')]

    await runWatch(p, { shadow: true })

    expect(written.map(r => r.seat)).toEqual(['seat-a', 'seat-b', 'seat-a'])
  })

  it('marks a pass with no state change as unchanged, with the same hash', async () => {
    const { ports: p, written } = ports()
    await runWatch(p, { shadow: true })

    await runWatch(p, { shadow: true })

    const seatB = written.filter(r => r.seat === 'seat-b')
    expect(seatB[1]?.hash).toBe(seatB[0]?.hash)
    expect(seatB.map(r => r.unchanged)).toEqual([false, true])
  })

  it('records a failed read with its error and builds the packet without it', async () => {
    const { ports: p, written } = ports({
      flights: async () => {
        throw new Error('shepherd status did not answer')
      },
    })

    await runWatch(p, { shadow: true })

    expect(written[1]?.packet.shepherd).toBeNull()
    expect(written[1]?.reads.shepherd?.error).toBe('shepherd status did not answer')
  })

  it('reads the prefix from the seat file and leaves a seat with none to spawnedBy', () => {
    const book = readSeatBook(root, CHARTER, 'operator-seat', ROWS)

    expect(book.live).toEqual([{ name: 'seat-a', prefix: 'sa' }, { name: 'seat-b' }])
  })
})

describe('seats watch verb', () => {
  it('refuses to run without --shadow', async () => {
    const report = await seatsWatchVerb.run({})

    expect(report.ok).toBe(false)
    expect(report.errors?.[0]).toContain('--shadow')
  })
})

describe('seat-watch reads', () => {
  it('reads unread messages since the seat last acted, and reports by the broker test', () => {
    const db = path.join(root, 'events.db')
    const log = new EventLog(db)
    log.append({ kind: 'message', actor: 'human', target: 'seat-a', body: 'old' })
    log.append({ kind: 'seat_activity', actor: 'seat-a' })
    log.append({ kind: 'message', actor: 'sa-1', target: 'seat-a', body: 'Status: DONE\nPR: x' })
    log.append({ kind: 'message', actor: 'seat-b', target: 'seat-a', body: 'fyi\nmore' })

    expect(readUnread(db, 'seat-a').map(m => [m.from, m.body])).toEqual([
      ['sa-1', 'Status: DONE\nPR: x'],
      ['seat-b', 'fyi\nmore'],
    ])
    expect([...readReports(db, 'seat-a', 0).keys()]).toEqual(['sa-1'])
  })

  it('takes caps and the stop from seats status --json, a machine stop first', () => {
    const body = { implementers: { active: 1, cap: 3 }, budget: { stop: null }, stop: 'machine' }

    expect(parseSeatStatus(JSON.stringify(body))).toEqual({ implementers: 1, cap: 3, stop: 'machine' })
    expect(() => parseSeatStatus('{"seat":"seat-a","error":"not a seat"}')).toThrow('not a seat')
  })

  it("keeps the newest whole row when the file's last line is torn", () => {
    const dir = path.join(root, 'watch')
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, 'seat-a.jsonl'), '{"seat":"seat-a","hash":"h1"}\n{"seat":"se')

    expect(lastWatchRow(dir, 'seat-a')?.hash).toBe('h1')
  })
})
