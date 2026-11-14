import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readHeldCandidates, readHolds } from '../agents/seats/held-relay-read.js'
import { seatsHeldRelayVerb } from '../cli/verbs/seats-held-relay.js'

const MIN = 60_000
const T0 = Date.parse('2030-01-01T00:00:00Z')
const at = (minutes: number): number => T0 + minutes * MIN

interface Seed {
  ts: number
  kind: string
  actor: string
  target?: string
  msgId?: string
  ref?: string
  body?: string
  meta?: Record<string, string>
}

const coordinator = { role: 'coordinator', profile: 'coord-profile' }

/** `seat-park` teleports into a park successor; `peer-one` then writes to it. `seat-live` answers its mail. */
const story: Seed[] = [
  { ts: at(0), kind: 'agent_spawned', actor: 'spawner', target: 'seat-park', msgId: 'p1', meta: coordinator },
  { ts: at(0), kind: 'agent_attached', actor: 'seat-park', ref: 'p1' },
  {
    ts: at(1),
    kind: 'agent_handoff',
    actor: 'seat-park',
    ref: 'p1',
    meta: { successor: 'p2', reason: 'park' },
  },
  {
    ts: at(1),
    kind: 'agent_spawned',
    actor: 'seat-park',
    target: 'seat-park',
    msgId: 'p2',
    meta: { ...coordinator, teleport_from: 'p1' },
  },
  { ts: at(1), kind: 'agent_retired', actor: 'seat-park', target: 'seat-park', ref: 'p1' },
  { ts: at(1), kind: 'agent_attached', actor: 'seat-park', ref: 'p2' },
  { ts: at(0), kind: 'agent_spawned', actor: 'spawner', target: 'seat-live', msgId: 'l1', meta: coordinator },
  { ts: at(0), kind: 'agent_attached', actor: 'seat-live', ref: 'l1' },
  {
    ts: at(10),
    kind: 'message',
    actor: 'peer-one',
    target: 'seat-park',
    msgId: 'm1',
    body: 'Status: sheet ready',
  },
  { ts: at(10), kind: 'message', actor: 'peer-two', target: 'seat-live', msgId: 'm2', body: 'Status: done' },
  { ts: at(12), kind: 'message', actor: 'seat-live', target: 'peer-two', msgId: 'm3', body: 'thanks' },
  { ts: at(40), kind: 'message', actor: 'human', target: 'seat-park', msgId: 'h1', body: 'go ahead' },
]

describe('held-relay reads', () => {
  let dir: string
  let db: string

  const seed = (rows: readonly Seed[]): void => {
    const sqlite = new DatabaseSync(db)
    const insert = sqlite.prepare(
      'INSERT INTO events (ts, kind, actor, target, msg_id, ref, body, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    for (const s of rows)
      insert.run(
        s.ts,
        s.kind,
        s.actor,
        s.target ?? null,
        s.msgId ?? null,
        s.ref ?? null,
        s.body ?? null,
        JSON.stringify(s.meta ?? {}),
      )
    sqlite.close()
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'held-relay-read-'))
    db = path.join(dir, 'events.db')
    const sqlite = new DatabaseSync(db)
    sqlite.exec(
      'CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, kind TEXT, actor TEXT, ' +
        'target TEXT, msg_id TEXT, ref TEXT, body TEXT, meta TEXT)',
    )
    sqlite.close()
    seed(story)
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('finds a park successor held before the human writes to it and free after', () => {
    const before = readHolds(db, [], at(30))
    const after = readHolds(db, [], at(45))

    expect(before.coordinators).toEqual(['seat-live', 'seat-park'])
    expect(before.holds.get('seat-park')).toBe('parked')
    expect(after.holds.get('seat-park')).toBeUndefined()
  })

  it('lists the waiting message, but not one the recipient answered after it arrived', () => {
    const { holds } = readHolds(db, [], at(30))

    const items = readHeldCandidates(db, holds, 15 * MIN, at(30))

    expect(items).toEqual([
      {
        recipient: 'seat-park',
        msgId: 'm1',
        from: 'peer-one',
        ts: at(10),
        body: 'Status: sheet ready',
        hold: 'parked',
      },
    ])
  })

  it('clears a message an inbox_read receipt names, but not on a receipt naming only another message', () => {
    const receipt = (msgIds: string): Seed => ({
      ts: at(20),
      kind: 'inbox_read',
      actor: 'seat-park',
      meta: { msgIds },
    })
    seed([receipt('other-1,other-2')])
    const { holds } = readHolds(db, [], at(30))
    const unnamed = readHeldCandidates(db, holds, 15 * MIN, at(30))

    seed([receipt('other-3,m1')])
    const named = readHeldCandidates(db, holds, 15 * MIN, at(30))

    expect(unnamed.map(i => i.msgId)).toEqual(['m1'])
    expect(named).toEqual([])
  })

  it('leaves a message younger than the threshold out', () => {
    const { holds } = readHolds(db, [], at(20))

    expect(readHeldCandidates(db, holds, 15 * MIN, at(20))).toEqual([])
  })

  it('reads without writing: the db file is byte-identical and no WAL appears', () => {
    const bytes = fs.readFileSync(db)

    readHeldCandidates(db, readHolds(db, ['seat-park'], at(30)).holds, 15 * MIN, at(30))

    expect(fs.readFileSync(db).equals(bytes)).toBe(true)
    expect(fs.existsSync(`${db}-wal`)).toBe(false)
  })

  describe('agent-chat seats held-relay', () => {
    let savedHome: string | undefined

    beforeEach(() => {
      savedHome = process.env.AGENT_CHAT_HOME
      process.env.AGENT_CHAT_HOME = dir
    })

    afterEach(() => {
      if (savedHome === undefined) delete process.env.AGENT_CHAT_HOME
      else process.env.AGENT_CHAT_HOME = savedHome
    })

    it('replays a past pass with --dry-run --now while the relay is disabled, and saves nothing', async () => {
      const report = await seatsHeldRelayVerb.run(
        { dryRun: true, now: '2030-01-01T00:30:00Z', db },
        {} as never,
      )

      expect(report.ok).toBe(true)
      expect(report.lines[0]).toContain(
        'Held 20 min for seat-park (parked): peer-one wrote "Status: sheet ready"',
      )
      expect(fs.existsSync(path.join(dir, 'held-relay.json'))).toBe(false)
    })

    it('refuses --now without --dry-run', async () => {
      const report = await seatsHeldRelayVerb.run({ now: '2030-01-01T00:30:00Z', db }, {} as never)

      expect(report.ok).toBe(false)
      expect(report.errors?.[0]).toContain('--dry-run')
    })
  })
})
