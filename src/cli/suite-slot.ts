import { spawn, type ChildProcess } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { resolveFullSuiteSlots } from '../config.js'
import { suiteSlotsDir } from '../paths.js'
import { DEFAULT_SLOT_WAIT_S, acquireSlot, isAlive, releaseSlot, type SlotDeps } from '../suite-slots.js'

export function suiteSlotDeps(): SlotDeps {
  return {
    dir: suiteSlotsDir(),
    total: resolveFullSuiteSlots(),
    pid: process.pid,
    isAlive,
    now: Date.now,
    sleep: async ms => {
      await sleep(ms)
    },
  }
}

const FORWARDED = ['SIGINT', 'SIGTERM'] as const

interface SignalTrap {
  received: () => NodeJS.Signals | undefined
  attach: (child: ChildProcess) => void
  restore: () => void
}

/** Installed before the slot is taken, so no signal can kill the wrapper while it holds one. */
function trapSignals(): SignalTrap {
  let received: NodeJS.Signals | undefined
  let child: ChildProcess | undefined
  const onSignal = (signal: NodeJS.Signals) => {
    received = signal
    child?.kill(signal)
  }
  for (const signal of FORWARDED) process.on(signal, onSignal)
  return {
    received: () => received,
    attach: c => {
      child = c
    },
    restore: () => {
      for (const signal of FORWARDED) process.off(signal, onSignal)
    },
  }
}

interface Finished {
  code: number
  signal?: NodeJS.Signals
}

function run(command: string[], trap: SignalTrap, notice: (line: string) => void): Promise<Finished> {
  return new Promise(resolve => {
    const [bin = '', ...args] = command
    const child = spawn(bin, args, { stdio: 'inherit' })
    trap.attach(child)
    child.on('error', err => {
      notice(`suite-slot: ${err.message}`)
      resolve({ code: 127 })
    })
    child.on('close', (code, signal) => resolve(signal === null ? { code: code ?? 1 } : { code: 1, signal }))
  })
}

async function runHoldingSlot(command: string[], trap: SignalTrap): Promise<Finished> {
  const deps = suiteSlotDeps()
  const notice = (line: string) => process.stderr.write(`${line}\n`)
  const stopped = () => trap.received() !== undefined
  const slot = await acquireSlot(deps, DEFAULT_SLOT_WAIT_S * 1000, notice, stopped)
  try {
    if (stopped()) return { code: 1 }
    if (slot === undefined) notice('suite-slot: no slot freed in time; running without one')
    return await run(command, trap, notice)
  } finally {
    if (slot !== undefined) releaseSlot(deps, slot)
  }
}

/** Runs `command` holding one full-suite slot and exits as it did (CC-406). */
export async function suiteSlotCommand(command: string[]): Promise<void> {
  const trap = trapSignals()
  let finished: Finished
  try {
    finished = await runHoldingSlot(command, trap)
  } finally {
    trap.restore()
  }
  // Re-raised with the handlers gone, so the caller sees the conventional signal exit.
  const signal = trap.received() ?? finished.signal
  if (signal !== undefined) process.kill(process.pid, signal)
  else process.exitCode = finished.code
}
