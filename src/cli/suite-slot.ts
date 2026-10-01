import { spawn } from 'node:child_process'
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

const FORWARDED = ['SIGINT', 'SIGTERM'] as const

interface Finished {
  code: number
  signal?: NodeJS.Signals
}

/** Runs the command, passing SIGINT and SIGTERM to it, and settles once it has exited. */
function runForwarding(command: string[], notice: (line: string) => void): Promise<Finished> {
  return new Promise(resolve => {
    const [bin = '', ...args] = command
    const child = spawn(bin, args, { stdio: 'inherit' })
    let received: NodeJS.Signals | undefined
    const forward = (signal: NodeJS.Signals) => {
      received = signal
      child.kill(signal)
    }
    for (const signal of FORWARDED) process.on(signal, forward)
    const finish = (done: Finished) => {
      for (const signal of FORWARDED) process.off(signal, forward)
      resolve(done)
    }
    child.on('error', err => {
      notice(`suite-slot: ${err.message}`)
      finish({ code: 127 })
    })
    child.on('close', (code, signal) => {
      const raised = received ?? signal ?? undefined
      finish(raised === undefined ? { code: code ?? 1 } : { code: code ?? 1, signal: raised })
    })
  })
}

/** Runs `command` holding one full-suite slot and exits as it did (CC-406). */
export async function suiteSlotCommand(command: string[]): Promise<void> {
  const deps = suiteSlotDeps()
  const notice = (line: string) => process.stderr.write(`${line}\n`)
  const slot = acquireSlot(deps, DEFAULT_SLOT_WAIT_S * 1000, notice)
  if (slot === undefined) notice('suite-slot: no slot freed in time; running without one')
  let finished: Finished = { code: 1 }
  try {
    finished = await runForwarding(command, notice)
  } finally {
    if (slot !== undefined) releaseSlot(deps, slot)
  }
  // Re-raised with the handlers gone, so the caller sees the conventional signal exit.
  if (finished.signal !== undefined) process.kill(process.pid, finished.signal)
  else process.exitCode = finished.code
}
