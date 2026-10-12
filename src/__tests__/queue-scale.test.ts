import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EventLog } from '../broker/event-log.js'

/** CC-1182: the restart guard's queue read stays cheap at the size the live queue reached. */

const OPEN = 5_000
const CLOSED = 20_000
const BOUND_MS = 2_000

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-queue-scale-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function seed(log: EventLog): void {
  for (let i = 0; i < CLOSED; i++) {
    const { msgId } = log.append({
      kind: 'message',
      actor: 'agent-chat',
      target: 'human',
      body: `closed ${i}`,
    })
    log.append({ kind: 'resolution', actor: 'human', ref: msgId, body: 'dismissed' })
  }
  for (let i = 0; i < OPEN; i++) {
    log.append({
      kind: 'message',
      actor: 'agent-chat',
      target: 'human',
      body: `rv-${i} exited with no Status report`,
      meta: { event: 'unreported-exit' },
    })
  }
}

describe('human queue at scale', () => {
  it('lists 5,000 open items among 20,000 closed ones within 2 s', () => {
    const log = new EventLog(path.join(dir, 'events.db'))
    seed(log)

    const started = performance.now()
    const items = log.humanQueue()
    const elapsed = performance.now() - started

    expect(items).toHaveLength(OPEN)
    expect(elapsed).toBeLessThan(BOUND_MS)
  })

  it('finds human rows through the target index, since the 2 s bound alone does not catch a full scan at this size', () => {
    const log = new EventLog(path.join(dir, 'events.db'))

    const plan = log
      .ledgerHandle()
      .prepare(`EXPLAIN QUERY PLAN SELECT * FROM events WHERE target = 'human' ORDER BY id ASC`)
      .all() as { detail: string }[]

    expect(plan.map(step => step.detail).join('\n')).toContain('events_target')
  })
})
