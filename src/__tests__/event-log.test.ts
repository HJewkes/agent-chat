import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventLog, isTerminalReport, reportKindOf } from '../broker/event-log.js'
import type { AgentEventRow } from '../broker/event-store.js'
import { AgentLog, foldAgent, groupByAgent } from '../agents/identity.js'

const dirs: string[] = []

function freshLog(): EventLog {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-log-'))
  dirs.push(dir)
  return new EventLog(path.join(dir, 'events.db'))
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const ask = (log: EventLog, actor: string, body: string) =>
  log.append({ kind: 'question', actor, target: 'human', body }).msgId

describe('notice expiry (CC-173)', () => {
  const HOUR = 3_600_000
  const T0 = new Date(2026, 8, 1, 9, 0).getTime()

  function logWithTtl(hours: number): EventLog {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-log-'))
    dirs.push(dir)
    return new EventLog(path.join(dir, 'events.db'), { noticeTtlMs: () => hours * HOUR })
  }

  afterEach(() => {
    vi.useRealTimers()
  })

  it('reads the TTL per query, not at construction', () => {
    vi.useFakeTimers({ now: T0 })
    const priorHome = process.env.AGENT_CHAT_HOME
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-log-ttl-'))
    dirs.push(home)
    process.env.AGENT_CHAT_HOME = home
    try {
      const log = new EventLog(path.join(home, 'events.db'))
      log.append({ kind: 'notice', actor: 'bob', target: 'human', body: 'migration finished' })
      vi.setSystemTime(T0 + 10 * HOUR)
      expect(log.humanQueue()).toHaveLength(1)

      fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ noticeTtlHours: 6 }))

      expect(log.humanQueue()).toHaveLength(0)
    } finally {
      if (priorHome === undefined) delete process.env.AGENT_CHAT_HOME
      else process.env.AGENT_CHAT_HOME = priorHome
    }
  })

  it('drops a plain notice from the queue once it is older than the TTL, without writing a row', () => {
    vi.useFakeTimers({ now: T0 })
    const log = logWithTtl(24)
    log.append({ kind: 'notice', actor: 'bob', target: 'human', body: 'migration finished' })
    const rowsBefore = log.latestId()

    vi.setSystemTime(T0 + 23 * HOUR)
    expect(log.humanQueue().map(i => i.text)).toEqual(['migration finished'])

    vi.setSystemTime(T0 + 25 * HOUR)
    expect(log.humanQueue()).toEqual([])
    expect(log.latestId()).toBe(rowsBefore)
  })

  it('never expires a question, a kinded notice or a hook approval, however old', () => {
    vi.useFakeTimers({ now: T0 })
    const log = logWithTtl(1)
    ask(log, 'alice', 'which branch?')
    log.append({
      kind: 'notice',
      actor: 'tick',
      target: 'human',
      body: 'PR #9',
      meta: { kind: 'ready-to-merge' },
    })
    log.append({
      kind: 'approval_request',
      actor: 'w',
      target: 'human',
      body: 'Bash',
      meta: { source: 'hook' },
    })
    log.append({ kind: 'notice', actor: 'bob', target: 'human', body: 'fyi' })

    vi.setSystemTime(T0 + 30 * 24 * HOUR)

    expect(log.humanQueue().map(i => i.kind)).toEqual(['question', 'notice', 'approval_request'])
    expect(log.humanQueue().find(i => i.kind === 'notice')?.meta.kind).toBe('ready-to-merge')
  })
})

describe('inbox as a projection', () => {
  it('returns only what was addressed to that session', () => {
    const log = freshLog()
    log.append({ kind: 'message', actor: 'alice', target: 'bob', body: 'for bob' })
    log.append({ kind: 'message', actor: 'alice', target: 'carol', body: 'for carol' })

    expect(log.inboxFor('bob', 10).map(m => m.text)).toEqual(['for bob'])
    expect(log.inboxFor('carol', 10).map(m => m.text)).toEqual(['for carol'])
  })

  it('survives a broker restart, because it is a query not a buffer', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-log-'))
    dirs.push(dir)
    const file = path.join(dir, 'events.db')

    const first = new EventLog(file)
    first.append({ kind: 'message', actor: 'alice', target: 'bob', body: 'survive me' })
    first.close()

    const second = new EventLog(file)
    expect(second.inboxFor('bob', 10).map(m => m.text)).toEqual(['survive me'])
  })

  it('returns the most recent messages when limited, oldest first', () => {
    const log = freshLog()
    for (const n of ['one', 'two', 'three'])
      log.append({ kind: 'message', actor: 'alice', target: 'bob', body: n })

    expect(log.inboxFor('bob', 2).map(m => m.text)).toEqual(['two', 'three'])
  })
})

describe('human queue as a projection', () => {
  it('collects questions, notices and messages addressed to the human', () => {
    const log = freshLog()
    ask(log, 'alice', 'which branch?')
    log.append({ kind: 'notice', actor: 'bob', target: 'human', body: 'migration finished' })
    log.append({ kind: 'message', actor: 'alice', target: 'carol', body: 'not for the human' })

    expect(log.humanQueue().map(i => i.kind)).toEqual(['question', 'notice'])
  })

  it('closes an item when an answer references it', () => {
    const log = freshLog()
    const msgId = ask(log, 'alice', 'which branch?')

    log.append({ kind: 'answer', actor: 'human', target: 'alice', ref: msgId, body: 'main' })

    expect(log.humanQueue()).toHaveLength(0)
    expect(log.isOpen(msgId)).toBe(false)
  })

  it('closes an item when it is dismissed', () => {
    const log = freshLog()
    const msgId = ask(log, 'alice', 'which branch?')

    log.append({ kind: 'resolution', actor: 'human', ref: msgId, body: 'dismissed' })

    expect(log.humanQueue()).toHaveLength(0)
  })

  it('keeps the resolution itself out of the queue', () => {
    const log = freshLog()
    const msgId = ask(log, 'alice', 'q')
    log.append({ kind: 'answer', actor: 'human', target: 'alice', ref: msgId, body: 'a' })

    expect(log.humanQueue()).toHaveLength(0)
  })

  it('routes an answer back to whoever raised the item', () => {
    const log = freshLog()
    const msgId = ask(log, 'alice', 'which branch?')

    expect(log.authorOf(msgId)).toBe('alice')
  })

  it('delivers the answer into the asker inbox', () => {
    const log = freshLog()
    const msgId = ask(log, 'alice', 'which branch?')
    log.append({ kind: 'answer', actor: 'human', target: 'alice', ref: msgId, body: 'use main' })

    const answer = log.inboxFor('alice', 10).at(-1)
    expect(answer?.text).toBe('use main')
    expect(answer?.inReplyTo).toBe(msgId)
  })
})

describe('question budget', () => {
  it('counts only unanswered questions from that session', () => {
    const log = freshLog()
    const first = ask(log, 'alice', 'q1')
    ask(log, 'alice', 'q2')
    ask(log, 'bob', 'q3')

    expect(log.openCount('alice', 'question')).toBe(2)
    expect(log.openCount('bob', 'question')).toBe(1)

    log.append({ kind: 'answer', actor: 'human', target: 'alice', ref: first, body: 'ok' })
    expect(log.openCount('alice', 'question')).toBe(1)
  })
})

/**
 * The log holds every brief verbatim — `supervisor.ts` appends `body: req.brief`
 * on `agent_spawned` — and briefs are routinely somebody else's text. Left at the
 * default the file was `-rw-r--r--`, a durable version of the `ps` disclosure
 * relay's R-68 closed.
 */
describe('on-disk permissions', () => {
  const modeOf = (file: string): number => fs.statSync(file).mode & 0o777

  const freshDir = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-perm-'))
    dirs.push(dir)
    return dir
  }

  it('keeps the log and its WAL sidecars owner-only', () => {
    const file = path.join(freshDir(), 'events.db')
    const log = new EventLog(file)
    log.append({ kind: 'message', actor: 'alice', target: 'bob', body: 'hi' })

    expect(modeOf(file)).toBe(0o600)
    // Written lazily by WAL mode, so assert only on what exists — the point is
    // that nothing readable is left behind, not that all three are present.
    for (const sidecar of [`${file}-wal`, `${file}-shm`]) {
      if (fs.existsSync(sidecar)) expect(modeOf(sidecar)).toBe(0o600)
    }
  })

  it('closes the directory too, since SQLite recreates sidecars under its own umask', () => {
    const nested = path.join(freshDir(), 'home')
    new EventLog(path.join(nested, 'events.db'))

    expect(modeOf(nested)).toBe(0o700)
  })

  it('tightens a log that already exists world-readable', () => {
    const file = path.join(freshDir(), 'events.db')
    new EventLog(file)
    fs.chmodSync(file, 0o644)

    new EventLog(file)
    expect(modeOf(file)).toBe(0o600)
  })
})

describe('history', () => {
  it('records routing failures alongside deliveries', () => {
    const log = freshLog()
    log.append({ kind: 'message', actor: 'alice', target: 'bob', body: 'hi' })
    log.append({ kind: 'route_failed', actor: 'alice', target: 'dave', body: 'no active session' })

    expect(log.history(10).map(i => i.kind)).toEqual(['message', 'route_failed'])
  })
})

describe('which openings are reports (CC-266, CC-763)', () => {
  it.each([
    ['Status: IN PROGRESS', 'status'],
    ['**Status:** DONE', 'status'],
    ['> `Verdict`: MERGE', 'verdict'],
    ['  ## VERDICT : FIX_FIRST', 'verdict'],
  ])('reads %j as a %s report', (text, kind) => {
    expect(reportKindOf(text)).toBe(kind)
  })

  it.each(['The status: DONE', 'Statuses: DONE', 'Status DONE', 'x Verdict: MERGE'])(
    'reads %j as no report',
    text => {
      expect(reportKindOf(text)).toBeUndefined()
    },
  )
})

describe("which reports are the sender's last word (CC-321, CC-337)", () => {
  it.each([
    'Status: DONE',
    '**Status:** DONE_WITH_CONCERNS',
    'Status: BLOCKED on review',
    'Status: NEEDS_CONTEXT',
    'Verdict: MERGE',
    '**Verdict:** FIX_FIRST',
    'Verdict: WAIT',
    'Verdict: APPROVE',
    'Verdict: CHANGES',
    'verdict: merge\nPR: x',
  ])('counts %j as terminal', text => {
    expect(isTerminalReport(text)).toBe(true)
  })

  it.each([
    'Status: IN PROGRESS',
    'Status: DONE-ish',
    'Status: DONEISH',
    'Verdict: pending',
    'Verdict: MERGE-ish',
    'Verdict:',
    'Status: working, DONE soon',
  ])('does not count %j as terminal', text => {
    expect(isTerminalReport(text)).toBe(false)
  })
})

describe('agent rows read in id order without a temp sort (TP-801 S1, CC-1313)', () => {
  function sqlsRunBy(log: EventLog, read: () => void): string[] {
    const db = log.ledgerHandle()
    const prepare = db.prepare.bind(db)
    const seen: string[] = []
    db.prepare = (sql: string) => {
      seen.push(sql)
      return prepare(sql)
    }
    try {
      read()
    } finally {
      db.prepare = prepare
    }
    return seen
  }

  function sqlRunBy(log: EventLog, read: () => void): string {
    const seen = sqlsRunBy(log, read)
    expect(seen).toHaveLength(1)
    return seen[0]!
  }

  const agentScanOf = (log: EventLog): string =>
    sqlsRunBy(log, () => log.agentEvents()).find(sql => sql.includes('kind IN'))!

  function planOf(log: EventLog, sql: string, ...params: string[]): string[] {
    const rows = log
      .ledgerHandle()
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...params) as { detail: string }[]
    return rows.map(r => r.detail)
  }

  function seedInterleaved(log: EventLog): void {
    for (let i = 0; i < 10; i++) {
      log.append({ kind: 'agent_spawned', actor: 'human', target: `a${i}`, msgId: `id${i}` })
      log.append({ kind: 'message', actor: 'human', target: `a${i}`, body: 'hello' })
      log.append({ kind: 'agent_attached', actor: `a${i}`, ref: `id${i}` })
      log.append({ kind: 'isolation_allocated', actor: `a${i}`, ref: `id${i}` })
    }
  }

  it('reads a rowid range in rowid order with no temp B-tree sort', () => {
    const log = freshLog()
    seedInterleaved(log)

    const plan = planOf(log, agentScanOf(log), '0')

    expect(plan.join('\n')).not.toContain('TEMP B-TREE')
    expect(plan).toEqual([expect.stringMatching(/^SEARCH events USING INTEGER PRIMARY KEY \(rowid>\?\)/)])
  })

  it('returns agent rows in append order across kinds, without other kinds', () => {
    const log = freshLog()
    log.append({ kind: 'agent_spawned', actor: 'human', target: 'a', msgId: 'A', body: '1' })
    log.append({ kind: 'message', actor: 'human', target: 'a', body: 'not agent' })
    log.append({ kind: 'agent_attached', actor: 'a', ref: 'A', body: '2' })
    log.append({ kind: 'agent_spawned', actor: 'human', target: 'b', msgId: 'B', body: '3' })
    log.append({ kind: 'isolation_allocated', actor: 'a', ref: 'A', body: '4' })
    log.append({ kind: 'agent_exited', actor: 'b', ref: 'B', body: '5' })

    const rows = log.agentEvents()

    expect(rows.map(r => r.body)).toEqual(['1', '2', '3', '4', '5'])
    expect(rows.map(r => r.kind)).toEqual([
      'agent_spawned',
      'agent_attached',
      'agent_spawned',
      'isolation_allocated',
      'agent_exited',
    ])
  })

  it('keeps temp sorts in memory, including after a reopen', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-log-'))
    dirs.push(dir)
    const file = path.join(dir, 'events.db')
    const tempStore = (log: EventLog) => log.ledgerHandle().prepare('PRAGMA temp_store').get()

    const first = new EventLog(file)
    expect(tempStore(first)).toEqual({ temp_store: 2 })
    first.close()

    expect(tempStore(new EventLog(file))).toEqual({ temp_store: 2 })
  })

  it("looks one agent's rows up by index, not by a table scan", () => {
    const log = freshLog()
    seedInterleaved(log)

    const sql = sqlRunBy(log, () => log.agentEventsFor('id3'))
    const plan = planOf(log, sql, 'id3', 'id3').join('\n')

    expect(plan).toContain('events_msg_id')
    expect(plan).toContain('events_ref')
    expect(plan).not.toContain('SCAN events')
  })

  it("finds a sender's last message by its own rows, not by walking every message", () => {
    const log = freshLog()
    seedInterleaved(log)

    const last = sqlRunBy(log, () => log.lastMessageFrom('a3', { since: 0 }))
    const report = sqlRunBy(log, () => log.lastStatusReport('a3', ['human'], 0))

    expect(planOf(log, last, 'a3', '0', 'human', 'human').join('\n')).toContain(
      'events_actor (actor=? AND kind=?)',
    )
    expect(planOf(log, report, 'a3', '0', 'human').join('\n')).toContain('events_actor (actor=? AND kind=?)')
  })
})

describe('agent rows cached between reads (CC-1459)', () => {
  function logAt(): { file: string; log: EventLog } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-log-'))
    dirs.push(dir)
    const file = path.join(dir, 'events.db')
    return { file, log: new EventLog(file) }
  }

  /** The id bound into, and the rows returned by, each agent-row read `read` runs. */
  function tailReadsBy(log: EventLog, read: () => void): { after: unknown; rows: number }[] {
    const db = log.ledgerHandle()
    const prepare = db.prepare.bind(db)
    const reads: { after: unknown; rows: number }[] = []
    db.prepare = (sql: string) => {
      const stmt = prepare(sql)
      if (!sql.includes('kind IN')) return stmt
      const all = stmt.all.bind(stmt)
      stmt.all = (...params: never[]) => {
        const rows = all(...params)
        reads.push({ after: params[0], rows: rows.length })
        return rows
      }
      return stmt
    }
    try {
      read()
    } finally {
      db.prepare = prepare
    }
    return reads
  }

  const appendSpawn = (log: EventLog, name: string) =>
    log.append({ kind: 'agent_spawned', actor: 'human', target: name, msgId: `id-${name}`, body: name })
  const roster = (rows: AgentEventRow[]) => [...groupByAgent(rows).values()].map(foldAgent)

  it('reads only rows past the highest id it has already seen', () => {
    const { log } = logAt()
    appendSpawn(log, 'scout')
    log.append({ kind: 'message', actor: 'human', target: 'scout', body: 'hello' })
    log.agentEvents()
    const seen = log.latestId()
    appendSpawn(log, 'agent-x')

    const reads = tailReadsBy(log, () => log.agentEvents())

    expect(reads).toEqual([{ after: seen, rows: 1 }])
    expect(log.agentEvents().map(r => r.body)).toEqual(['scout', 'agent-x'])
  })

  it('sees a row another connection appended', () => {
    const { file, log } = logAt()
    appendSpawn(log, 'scout')
    log.agentEvents()
    const other = new EventLog(file)
    appendSpawn(other, 'seat-x')
    other.close()

    const rows = log.agentEvents()

    expect(rows.map(r => r.body)).toEqual(['scout', 'seat-x'])
  })

  it('starts from a full read after close and reopen', () => {
    const { file, log } = logAt()
    appendSpawn(log, 'scout')
    log.agentEvents()
    log.close()
    const reopened = new EventLog(file)
    appendSpawn(reopened, 'agent-x')

    const reads = tailReadsBy(reopened, () => reopened.agentEvents())

    expect(reads).toEqual([{ after: 0, rows: 2 }])
  })

  it('folds the cached rows to the same roster as a full scan', () => {
    const { file, log } = logAt()
    const scout = appendSpawn(log, 'scout').msgId
    log.agentEvents()
    log.append({ kind: 'agent_attached', actor: 'scout', ref: scout })
    appendSpawn(log, 'agent-x')
    log.agentEvents()
    const other = new EventLog(file)
    other.append({ kind: 'agent_exited', actor: 'scout', ref: scout })
    appendSpawn(other, 'seat-x')
    other.close()

    const cached = roster(log.agentEvents())

    expect(cached).toEqual(roster(new EventLog(file).agentEvents()))
    expect(cached).toHaveLength(3)
  })

  it('keeps no row read inside a transaction that then rolls back', () => {
    const { log } = logAt()
    appendSpawn(log, 'scout')
    log.agentEvents()
    const db = log.ledgerHandle()
    db.exec('BEGIN IMMEDIATE')
    appendSpawn(log, 'rolled-back')
    expect(log.agentEvents().map(r => r.body)).toEqual(['scout', 'rolled-back'])
    db.exec('ROLLBACK')
    appendSpawn(log, 'agent-x')

    const rows = log.agentEvents()

    expect(rows.map(r => r.body)).toEqual(['scout', 'agent-x'])
  })

  it('hands each caller its own array of rows no caller can change', () => {
    const { log } = logAt()
    appendSpawn(log, 'scout')
    const first = log.agentEvents()

    first.pop()

    expect(log.agentEvents()).toHaveLength(1)
    expect(() => {
      log.agentEvents()[0]!.meta.extra = 'x'
    }).toThrow(TypeError)
  })
})

describe('long agent-row bodies read on demand (CC-1463)', () => {
  const brief = `do the task\n${'x'.repeat(2000)}`

  function logAt(): { file: string; log: EventLog } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-log-'))
    dirs.push(dir)
    const file = path.join(dir, 'events.db')
    return { file, log: new EventLog(file) }
  }

  const logSpawn = (log: EventLog, name: string, body: string) =>
    log.append({ kind: 'agent_spawned', actor: 'human', target: name, msgId: `id-${name}`, body }).msgId

  it('gives every reader of a cached row its full body', () => {
    const { log } = logAt()
    logSpawn(log, 'scout', brief)
    logSpawn(log, 'agent-x', 'short')
    log.agentEvents()

    const [long, short] = log.agentEvents()

    expect([long!.body, short!.body]).toEqual([brief, 'short'])
    expect({ ...long }.body).toBe(brief)
    expect(JSON.parse(JSON.stringify(long))).toEqual({ ...long, meta: {} })
    expect(Object.keys(long!)).not.toContain('id')
  })

  it('keeps the body of a row read inside a transaction that then rolls back', () => {
    const { log } = logAt()
    const db = log.ledgerHandle()
    db.exec('BEGIN IMMEDIATE')
    logSpawn(log, 'rolled-back', brief)
    const [row] = log.agentEvents()
    db.exec('ROLLBACK')

    expect(row!.body).toBe(brief)
  })

  it('gives the roster each brief, and keeps it out of a frame (CC-1484)', () => {
    const { log } = logAt()
    logSpawn(log, 'scout', brief)

    const [agent] = new AgentLog(log).roster()

    expect(agent!.brief).toBe(brief)
    expect(JSON.parse(JSON.stringify(agent))).not.toHaveProperty('brief')
  })

  it('reuses the fold until an agent row lands, then folds the new one in', () => {
    const { file, log } = logAt()
    const agents = new AgentLog(log)
    const scout = logSpawn(log, 'scout', brief)
    const [first] = agents.roster()
    log.append({ kind: 'message', actor: 'human', target: 'scout', body: 'hello' })

    expect(agents.roster()[0]).toBe(first)

    const other = new EventLog(file)
    other.append({ kind: 'agent_attached', actor: 'scout', ref: scout })
    logSpawn(other, 'agent-x', 'short')
    other.close()
    const roster = agents.roster()

    expect(Object.fromEntries(roster.map(a => [a.name, a.state]))).toEqual({
      'agent-x': 'spawning',
      scout: 'live',
    })
  })

  it('hands out identities no caller can change for the next one', () => {
    const { log } = logAt()
    logSpawn(log, 'scout', brief)
    const agents = new AgentLog(log)

    expect(() => {
      agents.roster()[0]!.state = 'retired'
    }).toThrow(TypeError)
    expect(agents.roster()[0]!.state).toBe('spawning')
  })
})
