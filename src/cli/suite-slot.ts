import { spawnSync } from 'node:child_process'
import { resolveFullSuiteSlots } from '../config.js'
import { suiteSlotsDir } from '../paths.js'
import {
  DEFAULT_SLOT_WAIT_S,
  acquireSlot,
  isAlive,
  releaseSlot,
  sleepSync,
  type SlotDeps,
} from '../suite-slots.js'

export function suiteSlotDeps(): SlotDeps {
  return {
    dir: suiteSlotsDir(),
    total: resolveFullSuiteSlots(),
    pid: process.pid,
    isAlive,
    now: Date.now,
    sleep: sleepSync,
  }
}

/** Runs `command` holding one full-suite slot and exits with its status (CC-406). */
export function suiteSlotCommand(command: string[]): void {
  const deps = suiteSlotDeps()
  const notice = (line: string) => process.stderr.write(`${line}\n`)
  const slot = acquireSlot(deps, DEFAULT_SLOT_WAIT_S * 1000, notice)
  if (slot === undefined) notice('suite-slot: no slot freed in time; running without one')
  try {
    const [bin = '', ...args] = command
    const result = spawnSync(bin, args, { stdio: 'inherit' })
    if (result.error) notice(`suite-slot: ${result.error.message}`)
    process.exitCode = result.status ?? 1
  } finally {
    if (slot !== undefined) releaseSlot(deps, slot)
  }
}
