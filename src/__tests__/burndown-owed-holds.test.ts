import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readOwedHolds, writeOwedHolds } from '../agents/burndown/owed-holds.js'

let dir: string
let file: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-owed-holds-'))
  file = path.join(dir, 'state', 'burndown-owed-holds.json')
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const owed = { seat: 'seat-a', repo: 'Acme/Widgets', pr: 7, reason: 'burndown: sensitive word "gate" in T-1' }

describe('the owed holds file (CC-931)', () => {
  it('owes nothing before it is written', () => {
    expect(readOwedHolds(file)).toEqual([])
  })

  it('reads back what was written', () => {
    writeOwedHolds(file, [owed])

    expect(readOwedHolds(file)).toEqual([owed])
  })

  it('keeps the well-formed entries of a file with a malformed one', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify([owed, { seat: 'seat-a', pr: 'seven' }]))

    expect(readOwedHolds(file)).toEqual([owed])
  })
})
