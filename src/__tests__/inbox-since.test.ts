import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { EventLog } from '../broker/event-log.js'

/**
 * CC-73. `inboxSince` is the read a watcher resumes from, and it differs from
 * `inboxFor` in the direction its limit cuts — which is the whole reason it
 * exists rather than being a parameter on the other one.
 */
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-since-'))
let log: EventLog
let dbCount = 0

beforeEach(() => {
  log?.close()
  log = new EventLog(path.join(HOME, `since-${dbCount++}.db`))
})

afterAll(() => {
  log?.close()
  fs.rmSync(HOME, { recursive: true, force: true })
})

const say = (actor: string, target: string, body: string, kind: 'message' | 'broadcast' = 'message') =>
  log.append({ kind, actor, target, body }).id

describe('inboxSince', () => {
  it('returns only what landed after the cursor', () => {
    say('bob', 'alice', 'one')
    const second = say('bob', 'alice', 'two')
    say('bob', 'alice', 'three')

    expect(log.inboxSince('alice', second, 10).map(m => m.text)).toEqual(['three'])
  })

  it('returns messages addressed to nobody else', () => {
    say('bob', 'alice', 'for alice')
    say('bob', 'dave', 'for dave')

    expect(log.inboxSince('alice', 0, 10).map(m => m.text)).toEqual(['for alice'])
  })

  it('includes broadcasts, which are fanned out one row per recipient', () => {
    say('erin', 'alice', 'to everyone', 'broadcast')

    const [message] = log.inboxSince('alice', 0, 10)
    expect(message?.broadcast).toBe(true)
  })

  it('carries the log id, so a caller can say where to resume', () => {
    const id = say('bob', 'alice', 'one')

    expect(log.inboxSince('alice', 0, 10)[0]?.id).toBe(id)
  })

  it('cuts the FAR end of a backlog, unlike inboxFor', () => {
    // The difference that matters: a watcher wants the oldest unseen rows, so a
    // limit must drop the newest. `inboxFor` answers the opposite question.
    say('bob', 'alice', 'oldest')
    say('bob', 'alice', 'middle')
    say('bob', 'alice', 'newest')

    expect(log.inboxSince('alice', 0, 2).map(m => m.text)).toEqual(['oldest', 'middle'])
    expect(log.inboxFor('alice', 2).map(m => m.text)).toEqual(['middle', 'newest'])
  })

  it('returns nothing for a name nobody has written to', () => {
    say('bob', 'alice', 'one')

    expect(log.inboxSince('nobody', 0, 10)).toEqual([])
  })

  it('returns nothing when the cursor is already at the head', () => {
    const last = say('bob', 'alice', 'one')

    expect(log.inboxSince('alice', last, 10)).toEqual([])
  })
})
