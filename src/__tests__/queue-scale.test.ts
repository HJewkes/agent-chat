import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EventLog } from '../broker/event-log.js'

/**
 * CC-1182: the restart guard's queue read stays cheap at the size the live queue reached.
 * CC-1187: cheapness is checked by the query plan, not a wall-clock bound that loaded CI
 * runners miss, and the seed runs in one transaction rather than 45,000 WAL commits.
 */

const OPEN = 5_000
const CLOSED = 20_000

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-queue-scale-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function seed(log: EventLog): void {
  const db = log.ledgerHandle()
  db.exec('BEGIN')
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
  db.exec('COMMIT')
}

describe('human queue at scale', () => {
  it('lists all 5,000 open items among 20,000 closed ones', () => {
    const log = new EventLog(path.join(dir, 'events.db'))
    seed(log)

    const items = log.humanQueue()

    expect(items).toHaveLength(OPEN)
  })

  it('finds human rows through the target index, so the read stays cheap however many closed rows pile up', () => {
    const log = new EventLog(path.join(dir, 'events.db'))

    const plan = log
      .ledgerHandle()
      .prepare(`EXPLAIN QUERY PLAN SELECT * FROM events WHERE target = 'human' ORDER BY id ASC`)
      .all() as { detail: string }[]

    expect(plan.map(step => step.detail).join('\n')).toContain('events_target')
  })
})
