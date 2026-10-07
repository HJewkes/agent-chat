import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Runner } from '../agents/burndown/exec.js'
import { readLedger, writeLedger, type Claim } from '../agents/burndown/ledger.js'
import {
  SERVICE_CHECK_WINDOW_MS,
  lineStopFrom,
  readServiceCheck,
  serviceCheckNote,
} from '../agents/burndown/service-check.js'

/** CC-785: the service-check read and the two-read rule, over a counting fake runner and synthetic JSON. */

const NOW = new Date(2026, 1, 3, 12, 0)
const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString()
const TICK_MS = SERVICE_CHECK_WINDOW_MS / 2

const check = (ok: boolean, cause: string | null, message = 'synthetic message') =>
  JSON.stringify({ ok, cause, message, health: null, detail: {} })

function counting(answer: { status: number | null; stdout: string }) {
  const calls: string[][] = []
  const exec: Runner = (bin, args) => (calls.push([bin, ...args]), { ...answer, stderr: '' })
  return { exec, calls }
}

describe('readServiceCheck', () => {
  it("parses a failed check's cause from --json on exit 1", () => {
    const fake = counting({ status: 1, stdout: check(false, 'crash loop', 'serve restarted 3 times') })

    const read = readServiceCheck(fake.exec)

    expect(read).toEqual({ cause: 'crash loop', message: 'serve restarted 3 times' })
    expect(fake.calls).toEqual([['titan-factory', 'service', 'check', '--json']])
  })

  it('reads a passing check on exit 0 as no cause', () => {
    const fake = counting({ status: 0, stdout: check(true, null, 'serve answers') })

    expect(readServiceCheck(fake.exec)).toEqual({ cause: null, message: 'serve answers' })
  })

  it.each([
    ['an exec failure', { status: null, stdout: '' }],
    ['an unexpected exit', { status: 2, stdout: check(false, 'stale pid') }],
    ['bad JSON', { status: 1, stdout: 'not json' }],
    ['JSON that is not the check', { status: 0, stdout: '[]' }],
    ['a failed check with no cause', { status: 1, stdout: check(false, null) }],
  ])('%s reads as unreadable', (_, answer) => {
    const fake = counting(answer)

    expect(readServiceCheck(fake.exec).cause).toBe('unreadable')
    expect(fake.calls).toHaveLength(1)
  })
})

describe('lineStopFrom', () => {
  const stopping = { cause: 'crash loop', message: 'serve restarted 3 times' }

  it('one stopping read does not stop the line', () => {
    expect(lineStopFrom(stopping, undefined, NOW)).toBeUndefined()
  })

  it('two consecutive stopping reads stop it, naming both causes and the current message', () => {
    const stop = lineStopFrom(stopping, { at: ago(TICK_MS), cause: 'stale pid' }, NOW)

    expect(stop).toEqual({ previous: 'stale pid', current: 'crash loop', message: 'serve restarted 3 times' })
  })

  it('an unreadable read counts as stopping', () => {
    const unreadable = { cause: 'unreadable', message: 'titan-factory service check exited abnormally' }

    expect(lineStopFrom(unreadable, { at: ago(TICK_MS), cause: 'GitHub down' }, NOW)).toMatchObject({
      previous: 'GitHub down',
      current: 'unreadable',
    })
  })

  it('an ok read clears a stop', () => {
    const ok = { cause: null, message: 'serve answers' }

    expect(lineStopFrom(ok, { at: ago(TICK_MS), cause: 'stale pid' }, NOW)).toBeUndefined()
  })

  it('a previous read older than two tick intervals does not count', () => {
    const atWindow = lineStopFrom(stopping, { at: ago(SERVICE_CHECK_WINDOW_MS), cause: 'not loaded' }, NOW)
    const past = lineStopFrom(stopping, { at: ago(SERVICE_CHECK_WINDOW_MS + 1), cause: 'not loaded' }, NOW)

    expect(atWindow).toBeDefined()
    expect(past).toBeUndefined()
  })

  it.each(['stale build', 'tick failing', 'tick stale'])('%s is a note, not a stop', cause => {
    const read = { cause, message: 'synthetic note' }

    expect(lineStopFrom(read, { at: ago(TICK_MS), cause }, NOW)).toBeUndefined()
    expect(lineStopFrom(stopping, { at: ago(TICK_MS), cause }, NOW)).toBeUndefined()
    expect(serviceCheckNote(read)).toBe(`service check: ${cause} (a note, the line runs): synthetic note`)
  })

  it('a stopping read carries no note', () => {
    expect(serviceCheckNote(stopping)).toBeUndefined()
  })
})

describe('the ledger serviceCheck field', () => {
  let dir: string
  const file = (): string => path.join(dir, 'ledger.json')
  const claim: Claim = {
    taskId: 'T-1',
    initiative: 'demo',
    spawnedAt: NOW.toISOString(),
    phase: 'implementing',
    phaseAt: NOW.toISOString(),
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-service-check-'))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('an old ledger without the field loads', () => {
    fs.writeFileSync(file(), JSON.stringify({ version: 1, claims: [claim] }))

    const ledger = readLedger(file())

    expect(ledger.serviceCheck).toBeUndefined()
    expect(ledger.claims).toEqual([claim])
  })

  it('a write that changes only serviceCheck passes the phase-edge check and reads back', () => {
    writeLedger(file(), { version: 1, claims: [claim] })
    const serviceCheck = { at: NOW.toISOString(), cause: 'stale pid' }

    writeLedger(file(), { version: 1, claims: [claim], serviceCheck })

    expect(readLedger(file()).serviceCheck).toEqual(serviceCheck)
  })
})
