import path from 'node:path'
import type { Command as Commander } from 'commander'
import { z } from 'zod'
import { home, operatorHoldPath } from '../../paths.js'
import { readDoc, readHoldMessages, readText } from '../../agents/seats/io.js'
import {
  BROADCAST_HOLD_MAX_MS,
  machineStopStatus,
  renderMachineStopStatus,
  type ChatLine,
  type StopInputs,
} from '../../agents/seats/operator-stops.js'
import { addVerb, defineVerb, Report } from '../command.js'
import { readMachineStop, readMachineStopReadings } from './seats.js'

/** Undefined when events.db cannot be read, which the status reports as a stop. */
function holdMessages(nowMs: number): ChatLine[] | undefined {
  try {
    return readHoldMessages(path.join(home(), 'events.db'), nowMs - BROADCAST_HOLD_MAX_MS)
  } catch {
    return undefined
  }
}

export function liveStopInputs(now: Date): StopInputs {
  const readings = readMachineStopReadings()
  return {
    now,
    chat: holdMessages(now.getTime()),
    stopFile: () => readText(operatorHoldPath()),
    ownerStops: () => readDoc().stopped,
    readings,
    machineStop: readMachineStop(readings),
  }
}

/** The status verb's body, taking its inputs explicitly so a test can hand it each kind of stop. */
export function machineStatusReport(inputs: StopInputs, json: boolean): Report {
  const status = machineStopStatus(inputs)
  return { ok: true, lines: json ? [JSON.stringify(status, null, 2)] : renderMachineStopStatus(status) }
}

export const machineStatusVerb = defineVerb({
  name: 'machine.status',
  description:
    'every stop on this machine, read-only (CC-957): operator HOLDs from the stop file and from chat ' +
    `messages (a "<sender>: HOLD (...)" line stands until that sender's "HOLD LIFTED" or LIFT, at most ` +
    `${BROADCAST_HOLD_MAX_MS / 3_600_000} h), the owner's stopped seats in seat-watchdog.json, and the ` +
    'memory, load, swap and pressure readings against the machine stop. `stopped` is a hold, the ' +
    'machine stop or a source that cannot be read; an owner stop holds only its own seat',
  args: z.object({ json: z.boolean().optional() }),
  result: Report,
  cli: {
    options: {
      json: {
        long: '--json',
        description:
          'one object: at, stopped, holds[{kind, by, since, reason, msgId?}], ownerStops, machine, errors',
      },
    },
  },
  async run({ json }) {
    return machineStatusReport(liveStopInputs(new Date()), json === true)
  },
})

export function addMachineCommands(program: Commander): void {
  const machine = program.command('machine').description('operator HOLDs, owner stops and the machine stop')
  addVerb(machine, machineStatusVerb)
}
