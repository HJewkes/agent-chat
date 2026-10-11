import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { handledThrough, readLogSection, readTeleportBlock } from '../agents/seats/boot-read.js'

/**
 * CC-863: the one reader of a `State at teleport` block, for teleport and `seats boot` alike.
 * Each fixture is the shape of a line seats have written in their logs; the ids are synthetic.
 */

const ID = '1a2b3c4d'

describe('handledThrough', () => {
  it.each([
    ['bare, as the charter shows it', `Inbox handled through ${ID}.`],
    ['after a clock', `09:41 Inbox handled through ${ID}.`],
    ['as a bullet', `- Inbox handled through ${ID}.`],
    ['inside a tick line', `09:41 tick: inbox handled through ${ID}; implementers 3/3`],
    ['with a note after it', `Inbox handled through ${ID} (supersedes 0f0f0f0f above).`],
    ['with a clause after it', `Inbox handled through ${ID}; also 0f0f0f0f (an agent report)`],
  ])('reads the cursor written %s', (_form, line) => {
    expect(handledThrough(`## State at teleport 2\n- an agent\n${line}\n`)).toBe(ID)
  })

  it('takes the last cursor when a later line supersedes the first', () => {
    expect(handledThrough(`Inbox handled through 0f0f0f0f.\n09:50 Inbox handled through ${ID}.`)).toBe(ID)
  })

  it('reads nothing from a line that names no msg_id', () => {
    expect(handledThrough('Inbox handled through the review thread.')).toBeUndefined()
  })
})

describe('readTeleportBlock', () => {
  it('reads the latest block’s number, author, cursor and the clock above it', () => {
    const log = `08:00 boot\n## State at teleport 3\nold\n09:10 writing\n## State at teleport 4\n- Inbox handled through ${ID}.\n`
    expect(readTeleportBlock(log)).toEqual({
      n: 4,
      generated: false,
      section: `## State at teleport 4\n- Inbox handled through ${ID}.`,
      cursor: ID,
      clockAbove: 9 * 60 + 10,
    })
  })

  it('tells agent-chat’s block from the seat’s by its heading mark', () => {
    expect(readTeleportBlock('## State at teleport 5 (agent-chat)\n- x\n')?.generated).toBe(true)
    expect(readTeleportBlock('## State at teleport 5 (after the move)\n- x\n')?.generated).toBe(false)
  })
})

describe('readLogSection', () => {
  let root: string
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'teleport-block-'))
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it('carries the block’s cursor, which `seats boot` reads the inbox after by default', () => {
    const now = new Date(2026, 9, 2, 9)
    fs.mkdirSync(path.join(root, 'logs', 'alpha'), { recursive: true })
    fs.writeFileSync(
      path.join(root, 'logs', 'alpha', '2026-10-02.md'),
      `## State at teleport 1\n- Inbox handled through ${ID}.\n`,
    )
    expect(readLogSection(root, 'alpha', now).cursor).toBe(ID)
  })
})
