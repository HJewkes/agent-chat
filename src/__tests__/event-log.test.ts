import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EventLog } from '../broker/event-log.js'

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
