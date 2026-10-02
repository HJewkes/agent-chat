import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { acquireSlot, releaseSlot, slotUsage, tryAcquireSlot, type SlotDeps } from '../suite-slots.js'

/** CC-406: machine-wide full-suite slots, with process liveness and the clock mocked. */

let dir: string
let alive: Set<number>
let clock: number

const runner = (pid: number, over: Partial<SlotDeps> = {}): SlotDeps => ({
  dir,
  total: 2,
  pid,
  isAlive: p => alive.has(p),
  now: () => clock,
  sleep: async ms => {
    clock += ms
  },
  ...over,
})

beforeEach(() => {
  dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ac-suite-slots-')), 'suite-slots')
  alive = new Set([101, 102, 103])
  clock = 1_000_000
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(path.dirname(dir), { recursive: true, force: true })
})

describe('full-suite slots', () => {
  it('hands out one slot per runner until all are held', () => {
    const first = tryAcquireSlot(runner(101))
    const second = tryAcquireSlot(runner(102))
    const third = tryAcquireSlot(runner(103))

    expect([first, second, third]).toEqual([0, 1, undefined])
    expect(slotUsage(runner(103))).toEqual({ inUse: 2, total: 2 })
  })

  it('gives a released slot to the next runner', () => {
    tryAcquireSlot(runner(101))
    const held = tryAcquireSlot(runner(102))
    releaseSlot(runner(102), held ?? -1)

    expect(tryAcquireSlot(runner(103))).toBe(1)
  })

  it('takes over the slot of a runner that died without releasing it', async () => {
    tryAcquireSlot(runner(101))
    tryAcquireSlot(runner(102))
    alive.delete(101)

    expect(slotUsage(runner(103))).toEqual({ inUse: 1, total: 2 })
    expect(await acquireSlot(runner(103), 10_000, () => undefined)).toBe(0)
  })

  it('does not release a slot another runner now owns', () => {
    const slot = tryAcquireSlot(runner(101)) ?? -1
    releaseSlot(runner(102), slot)

    expect(slotUsage(runner(103)).inUse).toBe(1)
  })

  it('waits for a slot, says so once, and gives up after the wait', async () => {
    tryAcquireSlot(runner(101))
    tryAcquireSlot(runner(102))
    const notices: string[] = []

    const slot = await acquireSlot(runner(103), 10_000, line => notices.push(line))

    expect(slot).toBeUndefined()
    expect(notices).toEqual(['suite-slot: all 2 full-suite slots in use; waiting'])
  })

  it('counts no slot above a lowered total as in use', () => {
    tryAcquireSlot(runner(101, { total: 3 }))
    tryAcquireSlot(runner(102, { total: 3 }))
    tryAcquireSlot(runner(103, { total: 3 }))

    expect(slotUsage(runner(101, { total: 2 }))).toEqual({ inUse: 2, total: 2 })
  })

  it('treats a slot renamed aside before its pid is written as not taken', () => {
    vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('renamed aside'), { code: 'ENOENT' })
    })

    const slot = tryAcquireSlot(runner(101, { total: 1 }))

    expect(slot).toBeUndefined()
  })
})

describe('waiting for a slot', () => {
  it('stops waiting as soon as it is told to', async () => {
    tryAcquireSlot(runner(101))
    tryAcquireSlot(runner(102))
    let polls = 0

    const slot = await acquireSlot(
      runner(103),
      60_000,
      () => undefined,
      () => ++polls > 2,
    )

    expect(slot).toBeUndefined()
    expect(clock).toBe(1_000_000 + 2 * 2000)
  })
})

describe('the suite-slot wrapper under a signal', () => {
  const entry = path.join(import.meta.dirname, '..', '..', 'dist', 'cli.js')

  it.each(['SIGTERM', 'SIGINT'] as const)(
    'releases its slot and exits by %s',
    async signal => {
      const home = path.dirname(dir)
      const wrapper = spawn(process.execPath, [entry, 'suite-slot', '--', 'sleep', '30'], {
        env: { ...process.env, AGENT_CHAT_HOME: home },
        stdio: 'ignore',
      })
      const pidFile = path.join(home, 'suite-slots', '0', 'pid')
      for (let i = 0; i < 400 && !fs.existsSync(pidFile); i++) await new Promise(r => setTimeout(r, 50))
      expect(fs.readFileSync(pidFile, 'utf8')).toBe(String(wrapper.pid))

      const exited = new Promise<NodeJS.Signals | null>(resolve =>
        wrapper.on('exit', (_c, sig) => resolve(sig)),
      )
      wrapper.kill(signal)

      expect(await exited).toBe(signal)
      expect(fs.existsSync(path.join(home, 'suite-slots', '0'))).toBe(false)
    },
    30_000,
  )
})
