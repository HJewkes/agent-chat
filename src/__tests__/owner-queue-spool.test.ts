import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeAnswer } from '@titan-design/owner-queue/spool'
import type { OwnerItemDeposit } from '@titan-design/owner-queue'
import { ownerQueueSpoolDir, spoolOwnerQueue } from '../agents/burndown/owner-queue-spool.js'

/** CC-864: the spool-backed owner-queue port reads back what it wrote, and an answered item is no longer open. */

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-oq-spool-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const deposit: OwnerItemDeposit = {
  depositId: 'one',
  asker: 'burndown-tick',
  kind: 'decide',
  door: 'two-way',
  summary: 'synthetic',
  context: 'synthetic',
  keys: ['scope-exhausted:alpha'],
}

describe('spoolOwnerQueue', () => {
  it('reads an empty spool as no open items', async () => {
    expect(await spoolOwnerQueue(path.join(dir, 'missing')).open()).toEqual([])
  })

  it('reads back the item it deposited', async () => {
    const port = spoolOwnerQueue(dir)

    await port.deposit(deposit)

    const open = await port.open()
    expect(open).toHaveLength(1)
    expect(open[0]).toMatchObject({ keys: ['scope-exhausted:alpha'], status: 'open', asker: 'burndown-tick' })
  })

  it('stops listing an item once an answer is filed', async () => {
    const port = spoolOwnerQueue(dir)
    await port.deposit(deposit)
    const [item] = await port.open()

    await writeAnswer(dir, item!.id, {
      text: 'done',
      by: { class: 'owner', id: 'owner', channel: 'test' },
      at: '2026-02-03T12:00:00.000Z',
    })

    expect(await port.open()).toEqual([])
  })
})

describe('ownerQueueSpoolDir', () => {
  it('resolves inside the per-run temp root under test, never the real console spool', () => {
    const root = process.env.TEST_HOME_ROOT ?? ''

    const relative = path.relative(root, ownerQueueSpoolDir())

    expect(root).not.toBe('')
    expect(relative.startsWith('..') || path.isAbsolute(relative)).toBe(false)
  })

  it('follows the console: TITAN_CONSOLE_INBOX_DIR first', () => {
    expect(ownerQueueSpoolDir({ TITAN_CONSOLE_INBOX_DIR: '/x/in', TITAN_CONSOLE_STATE: '/x/st' }, '/h')).toBe(
      '/x/in',
    )
  })

  it('falls back to inbox/deposits under TITAN_CONSOLE_STATE', () => {
    expect(ownerQueueSpoolDir({ TITAN_CONSOLE_STATE: '/x/st' }, '/h')).toBe(
      path.join('/x/st', 'inbox', 'deposits'),
    )
  })

  it('defaults to the console state dir under the home directory', () => {
    expect(ownerQueueSpoolDir({}, '/h')).toBe(
      path.join('/h', '.local', 'state', 'titan-console', 'inbox', 'deposits'),
    )
  })
})
