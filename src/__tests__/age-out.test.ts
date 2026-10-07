import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventLog } from '../broker/event-log.js'
import { AGED_OUT, startAgeOutSweep, sweepAgedOut } from '../broker/age-out.js'

const DAY = 24 * 3_600_000
const T0 = new Date(2026, 8, 1, 9, 0).getTime()
const dirs: string[] = []

/** The notice TTL is pushed past the window so CC-173's derived expiry cannot mask this one. */
function freshLog(): EventLog {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-age-out-'))
  dirs.push(dir)
  return new EventLog(path.join(dir, 'events.db'), { noticeTtlMs: () => 30 * DAY })
}

const brokerOf = (log: EventLog) => ({ events: log, append: log.append.bind(log) })

function toHuman(
  log: EventLog,
  kind: 'message' | 'notice',
  body: string,
  meta?: Record<string, string>,
): string {
  return log.append({ kind, actor: 'bob', target: 'human', body, ...(meta ? { meta } : {}) }).msgId
}

function agedOutRows(log: EventLog) {
  return log.history(100).filter(row => row.kind === 'resolution' && row.meta.status === AGED_OUT)
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0 })
})

afterEach(() => {
  vi.useRealTimers()
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('aging out notices and messages to the human (CC-811)', () => {
  it('closes an 8-day-old message and notice, keeping both in history as aged out', () => {
    const log = freshLog()
    const message = toHuman(log, 'message', 'build is green')
    const notice = toHuman(log, 'notice', 'migration finished')
    vi.setSystemTime(T0 + 8 * DAY)

    sweepAgedOut(brokerOf(log))

    expect(log.humanQueue()).toEqual([])
    const history = log.history(100)
    expect(history.filter(row => row.msgId === message || row.msgId === notice)).toHaveLength(2)
    expect(agedOutRows(log).map(row => row.meta.ref)).toEqual([message, notice])
    expect(log.isOpen(message)).toBe(false)
  })

  it('leaves a 6-day-old message and notice open', () => {
    const log = freshLog()
    toHuman(log, 'message', 'build is green')
    toHuman(log, 'notice', 'migration finished')
    vi.setSystemTime(T0 + 6 * DAY)

    const closed = sweepAgedOut(brokerOf(log))

    expect(closed).toEqual([])
    expect(log.humanQueue().map(item => item.kind)).toEqual(['message', 'notice'])
  })

  it('never closes a question, an endorse request or an approval, however old', () => {
    const log = freshLog()
    log.append({ kind: 'question', actor: 'alice', target: 'human', body: 'which branch?' })
    log.append({ kind: 'endorse_request', actor: 'alice', target: 'human', body: 'the decision' })
    log.append({
      kind: 'approval_request',
      actor: 'w',
      target: 'human',
      body: 'Bash',
      meta: { source: 'hook' },
    })
    vi.setSystemTime(T0 + 8 * DAY)
    const before = log.humanQueue()

    const closed = sweepAgedOut(brokerOf(log))

    expect(closed).toEqual([])
    expect(log.humanQueue()).toEqual(before)
    expect(before.map(item => item.kind)).toEqual(['question', 'endorse_request', 'approval_request'])
  })

  it('keeps a kinded notice open, since it still asks the human to act', () => {
    const log = freshLog()
    toHuman(log, 'notice', 'PR #9', { kind: 'ready-to-merge' })
    vi.setSystemTime(T0 + 8 * DAY)

    sweepAgedOut(brokerOf(log))

    expect(log.humanQueue().map(item => item.meta.kind)).toEqual(['ready-to-merge'])
  })

  it('leaves agent-to-agent messages and notices alone, however old', () => {
    const log = freshLog()
    const message = log.append({ kind: 'message', actor: 'bob', target: 'alice', body: 'rebase done' }).msgId
    const notice = log.append({ kind: 'notice', actor: 'bob', target: 'alice', body: 'pushed' }).msgId
    vi.setSystemTime(T0 + 8 * DAY)

    const closed = sweepAgedOut(brokerOf(log))

    expect(closed).toEqual([])
    expect(agedOutRows(log)).toEqual([])
    expect(log.isOpen(message)).toBe(true)
    expect(log.isOpen(notice)).toBe(true)
  })

  it('writes nothing on a second sweep', () => {
    const log = freshLog()
    toHuman(log, 'notice', 'migration finished')
    vi.setSystemTime(T0 + 8 * DAY)
    sweepAgedOut(brokerOf(log))
    const rowsAfterFirst = log.latestId()

    const closed = sweepAgedOut(brokerOf(log))

    expect(closed).toEqual([])
    expect(log.latestId()).toBe(rowsAfterFirst)
  })

  it('leaves an item already dismissed alone', () => {
    const log = freshLog()
    const notice = toHuman(log, 'notice', 'migration finished')
    log.append({ kind: 'resolution', actor: 'human', ref: notice, body: 'dismissed' })
    vi.setSystemTime(T0 + 8 * DAY)

    expect(sweepAgedOut(brokerOf(log))).toEqual([])
  })

  it('sweeps once at start and again on each interval', () => {
    const log = freshLog()
    toHuman(log, 'notice', 'first')
    vi.setSystemTime(T0 + 8 * DAY)
    const stop = startAgeOutSweep(brokerOf(log), DAY)
    expect(agedOutRows(log)).toHaveLength(1)

    toHuman(log, 'message', 'second')
    vi.advanceTimersByTime(8 * DAY)
    stop()

    expect(agedOutRows(log)).toHaveLength(2)
  })
})
