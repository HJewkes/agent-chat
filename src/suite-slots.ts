import fs from 'node:fs'
import path from 'node:path'

/**
 * CC-406: one of N machine-wide full-suite test slots. Each slot is a directory
 * `<dir>/<i>` holding the owner's pid; `mkdir` is atomic, so whoever creates it
 * holds the slot. A slot whose pid is dead is stale and taken over, which is how
 * a runner killed mid-suite gives its slot back.
 *
 * Synchronous on purpose: a test-runner wrapper has nothing else to do while it waits.
 */

export const DEFAULT_FULL_SUITE_SLOTS = 4
export const DEFAULT_SLOT_WAIT_S = 1800
const POLL_MS = 2000
const OWNER_FILE = 'pid'
/** A slot with no pid file yet may be mid-write; only one ownerless this long is stale. */
const OWNERLESS_GRACE_MS = 10_000

export interface SlotDeps {
  dir: string
  total: number
  pid: number
  isAlive: (pid: number) => boolean
  now: () => number
  sleep: (ms: number) => void
}

export interface SlotUsage {
  inUse: number
  total: number
}

const slotPath = (dir: string, index: number): string => path.join(dir, String(index))

function ownerOf(slot: string): number | undefined {
  try {
    const pid = Number.parseInt(fs.readFileSync(path.join(slot, OWNER_FILE), 'utf8'), 10)
    return Number.isInteger(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

function ownerlessFor(slot: string, now: number): number {
  try {
    return now - fs.statSync(slot).mtimeMs
  } catch {
    return 0
  }
}

function isStale(slot: string, deps: SlotDeps): boolean {
  const owner = ownerOf(slot)
  if (owner === undefined) return ownerlessFor(slot, deps.now()) > OWNERLESS_GRACE_MS
  return !deps.isAlive(owner)
}

/** Renames a stale slot aside before deleting it, so two contenders cannot both remove a fresh one. */
function clearStale(slot: string, deps: SlotDeps): void {
  const aside = `${slot}.stale.${deps.pid}.${deps.now()}`
  try {
    fs.renameSync(slot, aside)
  } catch {
    return
  }
  fs.rmSync(aside, { recursive: true, force: true })
}

function tryTake(slot: string, deps: SlotDeps): boolean {
  try {
    fs.mkdirSync(slot)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    if (isStale(slot, deps)) clearStale(slot, deps)
    return false
  }
  try {
    fs.writeFileSync(path.join(slot, OWNER_FILE), String(deps.pid))
  } catch (err) {
    // A contender judged the old slot stale and renamed our fresh one aside.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
  return ownerOf(slot) === deps.pid
}

/** The index of the slot taken, or undefined when every slot is held by a live owner. */
export function tryAcquireSlot(deps: SlotDeps): number | undefined {
  fs.mkdirSync(deps.dir, { recursive: true })
  for (let i = 0; i < deps.total; i++) if (tryTake(slotPath(deps.dir, i), deps)) return i
  return undefined
}

/**
 * Waits up to `waitMs` for a slot. Past that it returns undefined and the caller
 * runs without one: a hung holder must not stop every test run on the machine.
 */
export function acquireSlot(
  deps: SlotDeps,
  waitMs: number,
  notice: (line: string) => void,
): number | undefined {
  const deadline = deps.now() + waitMs
  let told = false
  for (;;) {
    const index = tryAcquireSlot(deps)
    if (index !== undefined) return index
    if (deps.now() >= deadline) return undefined
    if (!told) notice(`suite-slot: all ${deps.total} full-suite slots in use; waiting`)
    told = true
    deps.sleep(POLL_MS)
  }
}

/** Removes the slot only while this process still owns it. */
export function releaseSlot(deps: Pick<SlotDeps, 'dir' | 'pid'>, index: number): void {
  const slot = slotPath(deps.dir, index)
  if (ownerOf(slot) === deps.pid) fs.rmSync(slot, { recursive: true, force: true })
}

/** Slots below `total` held by a live owner. */
export function slotUsage(deps: Pick<SlotDeps, 'dir' | 'total' | 'isAlive'>): SlotUsage {
  let inUse = 0
  for (let i = 0; i < deps.total; i++) {
    const owner = ownerOf(slotPath(deps.dir, i))
    if (owner !== undefined && deps.isAlive(owner)) inUse++
  }
  return { inUse, total: deps.total }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}
