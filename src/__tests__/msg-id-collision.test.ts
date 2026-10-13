import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventLog } from '../broker/event-log.js'

/** CC-1187: an 8-hex msg_id that repeats a closed item's id would be born closed. */

const uuids = vi.hoisted(() => ({ queue: [] as string[] }))

vi.mock('node:crypto', async importOriginal => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  return { ...actual, randomUUID: () => uuids.queue.shift() ?? actual.randomUUID() }
})

const uuidStarting = (prefix: string): string => `${prefix}-0000-4000-8000-000000000000`

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-msg-id-'))
  uuids.queue = []
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('minting a msg_id the log already holds', () => {
  it('keeps a new open item in the queue when its first random id repeats a resolved one', () => {
    const log = new EventLog(path.join(dir, 'events.db'))
    uuids.queue.push(uuidStarting('aaaaaaaa'))
    const closed = log.append({ kind: 'message', actor: 'agent-chat', target: 'human', body: 'closed' })
    log.append({ kind: 'resolution', actor: 'human', ref: closed.msgId, body: 'dismissed' })

    uuids.queue.push(uuidStarting('aaaaaaaa'), uuidStarting('bbbbbbbb'))
    const open = log.append({ kind: 'message', actor: 'agent-chat', target: 'human', body: 'open' })

    expect(open.msgId).toBe('bbbbbbbb')
    expect(log.humanQueue().map(item => item.msgId)).toEqual(['bbbbbbbb'])
  })

  it('does not mint an id that a resolution already references', () => {
    const log = new EventLog(path.join(dir, 'events.db'))
    log.append({ kind: 'resolution', actor: 'human', ref: 'cccccccc', body: 'dismissed' })

    uuids.queue.push(uuidStarting('cccccccc'), uuidStarting('dddddddd'))
    const open = log.append({ kind: 'message', actor: 'agent-chat', target: 'human', body: 'open' })

    expect(open.msgId).toBe('dddddddd')
    expect(log.humanQueue()).toHaveLength(1)
  })

  it('keeps a caller-supplied msg_id as given', () => {
    const log = new EventLog(path.join(dir, 'events.db'))
    log.append({ kind: 'message', actor: 'agent-chat', target: 'human', msgId: 'eeeeeeee', body: 'first' })

    const second = log.append({ kind: 'message', actor: 'peer-a', target: 'peer-b', msgId: 'eeeeeeee' })

    expect(second.msgId).toBe('eeeeeeee')
  })
})
