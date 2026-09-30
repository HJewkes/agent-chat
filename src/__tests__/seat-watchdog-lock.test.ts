import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LOCK_STALE_MS, acquireRunLock, type RunLock } from '../agents/seats/lock.js'

/** CC-326: one watchdog run at a time. Every pid and time here is synthetic. */

const NOW = Date.parse('2026-09-29T14:53:00.000Z')
const OTHER = 424242

let dir: string
let file: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-seat-lock-'))
  file = path.join(dir, 'seat-watchdog.lock')
})

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

const heldBy = (pid: number, at: number): void => fs.writeFileSync(file, JSON.stringify({ pid, at }))

const acquire = (alive: boolean, now = NOW): RunLock =>
  acquireRunLock(file, { now: () => now, alive: () => alive })

const release = (lock: RunLock): void => {
  if (lock.held) lock.release()
}

describe('the watchdog run lock', () => {
  it('is taken by the first run and refused to a second until the first releases it', () => {
    const first = acquireRunLock(file)
    const second = acquireRunLock(file)
    release(first)
    const third = acquireRunLock(file)

    expect(first).toMatchObject({ held: true })
    expect(second.held).toBe(false)
    expect(third).toMatchObject({ held: true })
    expect(third).not.toHaveProperty('note')
  })

  it('names the holder and when it started', () => {
    heldBy(OTHER, NOW - 60_000)
    expect(acquire(true)).toEqual({
      held: false,
      reason: 'another run holds seat-watchdog.lock (pid 424242, since 14:52Z)',
    })
  })

  it('takes over the lock of a run whose process is gone, and says so', () => {
    heldBy(OTHER, NOW - 60_000)
    const lock = acquire(false)
    expect(lock).toMatchObject({
      held: true,
      note: 'took over a stale run lock: its run (pid 424242) is gone',
    })
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ pid: process.pid, at: NOW })
  })

  it('sees a real exited process as gone without being told', () => {
    const exited = spawnSync(process.execPath, ['-e', '']).pid
    heldBy(exited, Date.now())
    expect(acquireRunLock(file)).toMatchObject({ held: true, note: expect.stringContaining('is gone') })
  })

  it('leaves a live run its lock at exactly the stale age and takes it one millisecond later', () => {
    heldBy(OTHER, NOW - LOCK_STALE_MS)
    expect(acquire(true).held).toBe(false)
    expect(acquire(true, NOW + 1)).toMatchObject({
      held: true,
      note: 'took over a stale run lock: it is over 30 min old',
    })
  })

  it('treats a lock it cannot parse as held until the file is older than the stale age', () => {
    fs.writeFileSync(file, 'not json')
    const written = fs.statSync(file).mtimeMs
    expect(acquire(true, written + 1000)).toEqual({
      held: false,
      reason: expect.stringContaining('pid unknown'),
    })
    expect(acquire(true, written + LOCK_STALE_MS + 1)).toMatchObject({ held: true })
  })

  it('lets one of two runs take over the same stale lock', () => {
    heldBy(OTHER, NOW - 60_000)
    const first = acquire(false)
    const second = acquire(true)
    expect([first.held, second.held]).toEqual([true, false])
  })

  it('backs off, leaving the fresh lock in place, when another run takes over the stale lock first', () => {
    heldBy(OTHER, NOW - 60_000)
    const fresh = JSON.stringify({ pid: OTHER + 1, at: NOW })
    const lock = acquireRunLock(file, {
      now: () => NOW,
      alive: () => {
        fs.writeFileSync(file, fresh)
        return false
      },
    })
    expect(lock).toEqual({ held: false, reason: 'another run took over a stale lock first' })
    expect(fs.readFileSync(file, 'utf8')).toBe(fresh)
    expect(fs.readdirSync(dir)).toEqual(['seat-watchdog.lock'])
  })

  it('does not remove a lock another run took over from it', () => {
    const mine = acquireRunLock(file, { now: () => NOW })
    heldBy(OTHER, NOW + LOCK_STALE_MS)
    release(mine)
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ pid: OTHER })
  })

  it('leaves nothing but the lock in its directory, and nothing once released', () => {
    heldBy(OTHER, NOW - 60_000)
    const lock = acquire(false)
    expect(fs.readdirSync(dir)).toEqual(['seat-watchdog.lock'])
    release(lock)
    expect(fs.readdirSync(dir)).toEqual([])
  })
})
