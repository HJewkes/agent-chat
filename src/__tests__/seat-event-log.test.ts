import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  appendSeatEvent,
  lastTeleportAt,
  readSeatState,
  seatEventsPath,
} from '../agents/seats/seat-event-log.js'

let root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-event-log-'))
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

const T1 = '2026-10-14T10:00:00.000Z'
const T2 = '2026-10-14T11:00:00.000Z'

describe('seat event log', () => {
  it('folds appended events into the seat state', () => {
    appendSeatEvent(root, 'seat-a', { kind: 'spawn', agent: 'worker-1' }, T1)
    appendSeatEvent(root, 'seat-a', { kind: 'hold', target: 'pr-1', reason: 'waiting on review' }, T1)
    appendSeatEvent(
      root,
      'seat-a',
      { kind: 'background', id: 'w1', command: 'npm run watch', cwd: '/srv/work' },
      T1,
    )
    appendSeatEvent(root, 'seat-a', { kind: 'authored', text: 'next: check pr-1' }, T1)
    appendSeatEvent(root, 'seat-a', { kind: 'teleport' }, T2)

    const { state, corruptLines } = readSeatState(root, 'seat-a', { tmpdir: os.tmpdir() })

    expect(corruptLines).toBe(0)
    expect(state.generation).toBe(1)
    expect(state.agents).toEqual(['worker-1'])
    expect(state.holds).toEqual([{ target: 'pr-1', reason: 'waiting on review' }])
    expect(state.background.map(b => b.id)).toEqual(['w1'])
    expect(state.authored).toBe('next: check pr-1')
    expect(lastTeleportAt(root, 'seat-a')).toBe(T2)
  })

  it('skips and counts a corrupt line in the middle', () => {
    appendSeatEvent(root, 'seat-a', { kind: 'spawn', agent: 'worker-1' }, T1)
    fs.appendFileSync(seatEventsPath(root, 'seat-a'), '{not json\n')
    appendSeatEvent(root, 'seat-a', { kind: 'spawn', agent: 'worker-2' }, T1)

    const { state, corruptLines } = readSeatState(root, 'seat-a')

    expect(corruptLines).toBe(1)
    expect(state.agents).toEqual(['worker-1', 'worker-2'])
  })

  it('refuses an invalid event without writing it', () => {
    const bad = { kind: 'hold' } as unknown as Parameters<typeof appendSeatEvent>[2]

    expect(() => appendSeatEvent(root, 'seat-a', bad, T1)).toThrow()
    expect(fs.existsSync(seatEventsPath(root, 'seat-a'))).toBe(false)
  })

  it('reports a background under the host tmpdir in errors and leaves it out of state', () => {
    const tmp = path.join(root, 'tmp')
    appendSeatEvent(
      root,
      'seat-a',
      { kind: 'background', id: 'w1', command: 'npm run watch', cwd: path.join(tmp, 'x') },
      T1,
    )

    const { state } = readSeatState(root, 'seat-a', { tmpdir: tmp })

    expect(state.background).toEqual([])
    expect(state.errors).toHaveLength(1)
  })

  it('reads a missing log as the empty state', () => {
    const { state, corruptLines } = readSeatState(root, 'seat-a')

    expect(corruptLines).toBe(0)
    expect(state.generation).toBe(0)
    expect(lastTeleportAt(root, 'seat-a')).toBeUndefined()
  })

  it('refuses a seat name that escapes the logs directory', () => {
    expect(() => seatEventsPath(root, '../x')).toThrow()
  })
})
