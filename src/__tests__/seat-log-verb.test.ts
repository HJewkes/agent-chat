import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { seatLogReport } from '../cli/verbs/seats.js'

/** CC-1058: `seats log` stamps journal lines from the clock. Every seat and path here is synthetic. */

const SEAT = 'sample-seat'

let root: string
let savedTz: string | undefined

const dayFile = (day: string, seat = SEAT): string => path.join(root, 'logs', seat, `${day}.md`)
const read = (day: string): string => fs.readFileSync(dayFile(day), 'utf8')

beforeAll(() => {
  savedTz = process.env.TZ
  // Denver is behind UTC, so a UTC stamp or day would differ from the local one.
  process.env.TZ = 'America/Denver'
})
afterAll(() => {
  if (savedTz === undefined) delete process.env.TZ
  else process.env.TZ = savedTz
})
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-log-'))
  fs.mkdirSync(path.join(root, 'seats'))
  fs.writeFileSync(path.join(root, 'seats', `${SEAT}.md`), '---\nprefix: sx\npool: p\n---\n')
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

describe('seats log writes', () => {
  it('appends a local HH:MM stamp and the text to the local day file', () => {
    const report = seatLogReport(root, SEAT, ['tick: impl 1/2'], new Date(2026, 9, 11, 9, 5))

    expect(report).toEqual({ ok: true, lines: [dayFile('2026-10-11')] })
    expect(read('2026-10-11')).toBe('09:05 tick: impl 1/2\n')
  })

  it('puts 23:59 and the next 00:00 in different day files', () => {
    seatLogReport(root, SEAT, ['late'], new Date(2026, 9, 11, 23, 59))
    seatLogReport(root, SEAT, ['early'], new Date(2026, 9, 12, 0, 0))

    expect(read('2026-10-11')).toBe('23:59 late\n')
    expect(read('2026-10-12')).toBe('00:00 early\n')
  })

  it('appends a second line after the first', () => {
    seatLogReport(root, SEAT, ['first'], new Date(2026, 9, 11, 10, 0))
    seatLogReport(root, SEAT, ['second'], new Date(2026, 9, 11, 10, 1))

    expect(read('2026-10-11')).toBe('10:00 first\n10:01 second\n')
  })

  it('joins separate words with one space', () => {
    seatLogReport(root, SEAT, ['a', 'b', 'c'], new Date(2026, 9, 11, 10, 0))

    expect(read('2026-10-11')).toBe('10:00 a b c\n')
  })

  it('accepts a log-only seat with a logs dir and no seat file', () => {
    fs.mkdirSync(path.join(root, 'logs', 'log-only'), { recursive: true })

    const report = seatLogReport(root, 'log-only', ['note'], new Date(2026, 9, 11, 10, 0))

    expect(report.ok).toBe(true)
    expect(fs.readFileSync(dayFile('2026-10-11', 'log-only'), 'utf8')).toBe('10:00 note\n')
  })

  it('accepts a time later in the text', () => {
    const report = seatLogReport(root, SEAT, ['tick 05:17 slot'], new Date(2026, 9, 11, 10, 0))

    expect(report.ok).toBe(true)
    expect(read('2026-10-11')).toBe('10:00 tick 05:17 slot\n')
  })
})

describe('seats log refuses and writes nothing', () => {
  const at = new Date(2026, 9, 11, 10, 0)

  it('refuses a seat with no seat file and no logs dir, creating no dir', () => {
    const report = seatLogReport(root, 'typo-seat', ['note'], at)

    expect(report.ok).toBe(false)
    expect(report.errors).toEqual([`no seat 'typo-seat' under ${root}`])
    expect(fs.existsSync(path.join(root, 'logs', 'typo-seat'))).toBe(false)
  })

  it('refuses a name that is not a seat slug', () => {
    const report = seatLogReport(root, '../escape', ['note'], at)

    expect(report.errors).toEqual(['not a seat name: ../escape'])
  })

  it.each(['05:17 tick', '05:1x SWARM'])('refuses text opening with a hand-typed clock: %s', text => {
    const report = seatLogReport(root, SEAT, [text], at)

    expect(report.errors).toEqual(['drop the hand-typed time; the verb stamps it'])
    expect(fs.existsSync(dayFile('2026-10-11'))).toBe(false)
  })

  it('refuses text with a line break', () => {
    const report = seatLogReport(root, SEAT, ['one\ntwo'], at)

    expect(report.errors).toEqual(['one line per entry: the text holds a line break'])
    expect(fs.existsSync(dayFile('2026-10-11'))).toBe(false)
  })

  it('refuses empty text', () => {
    const report = seatLogReport(root, SEAT, ['  '], at)

    expect(report.ok).toBe(false)
    expect(fs.existsSync(dayFile('2026-10-11'))).toBe(false)
  })
})
