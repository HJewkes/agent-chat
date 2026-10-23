import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { coordinatorSeats, liveCoordinators } from '../agents/seats/coordinators.js'
import type { AgentEventRow } from '../broker/event-store.js'
import { seatsCoordinatorsVerb } from '../cli/verbs/seats-coordinators.js'

const charterWith = (seatsLine: string): string => `---\nname: charter\n${seatsLine}\n---\n\n# Charter\n`

describe('coordinatorSeats', () => {
  it('appends tp-operator to a flow-list seats line carrying a trailing comment', () => {
    const charter = charterWith('seats: [seat-a, seat-b, seat-c]  # one per initiative')

    expect(coordinatorSeats(charter)).toEqual(['seat-a', 'seat-b', 'seat-c', 'tp-operator'])
  })

  it('lists tp-operator once when the charter already names it', () => {
    const charter = charterWith('seats: [tp-operator, seat-a]')

    expect(coordinatorSeats(charter)).toEqual(['tp-operator', 'seat-a'])
  })

  it('yields nothing when the charter has no seats, so the operator alone never counts as a list', () => {
    expect(coordinatorSeats(charterWith('owner_seat: seat-a'))).toEqual([])
  })
})

type Kind = 'agent_spawned' | 'agent_attached' | 'agent_exited' | 'agent_retired'

let clock = 0
const row = (kind: Kind, id: string, name: string, meta: Record<string, string> = {}): AgentEventRow => ({
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
const worker = { role: 'worker', profile: 'impl-profile' }

/** A coordinator spawned and registered under `name`. */
const liveSeat = (id: string, name: string): AgentEventRow[] => [
  row('agent_spawned', id, name, coordinator),
  row('agent_attached', id, name),
]

describe('liveCoordinators', () => {
  it('omits a retired seat', () => {
    const rows = [
      ...liveSeat('a1', 'seat-a'),
      ...liveSeat('r1', 'seat-retired'),
      row('agent_retired', 'r1', 'seat-retired'),
    ]

    expect(liveCoordinators(rows)).toEqual(['seat-a'])
  })

  it('keeps an exited spawned coordinator, since it may be awaiting a resume and an extra name fails safe', () => {
    const rows = [
      ...liveSeat('a1', 'seat-a'),
      ...liveSeat('x1', 'seat-exited'),
      row('agent_exited', 'x1', 'seat-exited'),
    ]

    expect(liveCoordinators(rows)).toEqual(['seat-a', 'seat-exited'])
  })

  it('omits an exited adopted session, though an adopted session counts as a coordinator', () => {
    const rows = [
      ...liveSeat('a1', 'seat-a'),
      row('agent_spawned', 'h1', 'seat-hand', { origin: 'adopted', provisional: 'false' }),
      row('agent_attached', 'h1', 'seat-hand', { provisional: 'false' }),
      row('agent_exited', 'h1', 'seat-hand'),
    ]

    expect(liveCoordinators(rows)).toEqual(['seat-a'])
  })

  it('omits an exited spawned worker', () => {
    const rows = [
      ...liveSeat('a1', 'seat-a'),
      row('agent_spawned', 'w1', 'seat-w', worker),
      row('agent_attached', 'w1', 'seat-w'),
      row('agent_exited', 'w1', 'seat-w'),
    ]

    expect(liveCoordinators(rows)).toEqual(['seat-a'])
  })

  it('includes a live coordinator that no charter names', () => {
    const rows = [...liveSeat('n1', 'seat-new'), row('agent_spawned', 's1', 'seat-starting', coordinator)]

    expect(liveCoordinators(rows)).toEqual(['seat-new', 'seat-starting'])
  })

  it('never lists a live worker, however it is named', () => {
    const rows = [
      ...liveSeat('a1', 'seat-a'),
      row('agent_spawned', 'w1', 'seat-a-impl-1', worker),
      row('agent_attached', 'w1', 'seat-a-impl-1'),
      row('agent_spawned', 'w2', 'seat-b', worker),
      row('agent_attached', 'w2', 'seat-b'),
    ]

    expect(liveCoordinators(rows)).toEqual(['seat-a'])
  })

  it('lists a teleporting seat once at every step, since its successor spawns before the predecessor retires', () => {
    const predecessor = liveSeat('t1', 'seat-t')
    const successor = row('agent_spawned', 't2', 'seat-t', { ...coordinator, teleport_from: 't1' })
    const steps = [
      [...predecessor, successor],
      [...predecessor, successor, row('agent_retired', 't1', 'seat-t')],
      [
        ...predecessor,
        successor,
        row('agent_retired', 't1', 'seat-t'),
        row('agent_attached', 't2', 'seat-t'),
      ],
    ]

    expect(steps.map(liveCoordinators)).toEqual([['seat-t'], ['seat-t'], ['seat-t']])
  })

  it('keeps the predecessor when its teleport successor never started', () => {
    const rows = [
      ...liveSeat('t1', 'seat-t'),
      row('agent_spawned', 't2', 'seat-t', { ...coordinator, teleport_from: 't1' }),
      row('agent_retired', 't2', 'seat-t'),
    ]

    expect(liveCoordinators(rows)).toEqual(['seat-t'])
  })

  it('lists a named adopted session but not one still on its derived name', () => {
    const rows = [
      row('agent_spawned', 'h1', 'seat-hand', { origin: 'adopted', provisional: 'false' }),
      row('agent_attached', 'h1', 'seat-hand', { provisional: 'false' }),
      row('agent_spawned', 'h2', 'some-dir', { origin: 'adopted', provisional: 'true' }),
      row('agent_attached', 'h2', 'some-dir', { provisional: 'true' }),
    ]

    expect(liveCoordinators(rows)).toEqual(['seat-hand'])
  })
})

describe('agent-chat seats coordinators', () => {
  let dir: string
  let db: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seats-coordinators-'))
    db = path.join(dir, 'events.db')
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const writeEvents = (rows: AgentEventRow[]): void => {
    const sqlite = new DatabaseSync(db)
    sqlite.exec(
      'CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, kind TEXT, actor TEXT, target TEXT, msg_id TEXT, ref TEXT, body TEXT, meta TEXT)',
    )
    const insert = sqlite.prepare(
      'INSERT INTO events (ts, kind, actor, target, msg_id, ref, body, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    for (const r of rows)
      insert.run(r.ts, r.kind, r.actor, r.target, r.msgId, r.ref, r.body, JSON.stringify(r.meta))
    sqlite.close()
  }

  it('prints the live coordinators on one space-separated line', async () => {
    writeEvents([...liveSeat('d1', 'seat-d'), ...liveSeat('a1', 'seat-a')])

    const report = await seatsCoordinatorsVerb.run({ db }, {} as never)

    expect(report).toEqual({ ok: true, lines: ['seat-a seat-d'] })
  })

  it('fails with no line when events.db cannot be read', async () => {
    const report = await seatsCoordinatorsVerb.run({ db }, {} as never)

    expect(report.ok).toBe(false)
    expect(report.lines).toEqual([])
    expect(report.errors?.[0]).toContain('events.db')
  })

  it('fails with no line when no coordinator is live', async () => {
    writeEvents([
      ...liveSeat('r1', 'seat-r'),
      row('agent_retired', 'r1', 'seat-r'),
      row('agent_spawned', 'h1', 'seat-hand', { origin: 'adopted', provisional: 'false' }),
      row('agent_exited', 'h1', 'seat-hand'),
    ])

    const report = await seatsCoordinatorsVerb.run({ db }, {} as never)

    expect(report.ok).toBe(false)
    expect(report.lines).toEqual([])
  })
})
