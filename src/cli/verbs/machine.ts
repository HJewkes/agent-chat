import path from 'node:path'
import type { Command as Commander } from 'commander'
import { z } from 'zod'
import { resolveMachineHoldOperators } from '../../config.js'
import { home, logPath, operatorHoldPath } from '../../paths.js'
import type {
  AgentCostEstimate,
  AgentCosts,
  CostMetric,
  RunningAgentCost,
  ServerMessage,
} from '../../protocol.js'
import {
  defaultAutonomyRoot,
  readDoc,
  readChatMessages,
  readRouteAddressees,
  readTextIfPresent,
  seatFileNames,
} from '../../agents/seats/io.js'
import {
  BROADCAST_HOLD_MAX_MS,
  machineStopStatus,
  renderMachineStopStatus,
  type ChatLine,
  type StopInputs,
} from '../../agents/seats/operator-stops.js'
import type { MachineStopReadings } from '../../agents/seats/stops.js'
import { addVerb, defineVerb, Report } from '../command.js'
import { readMachineStop, readMachineStopReadings } from './seats.js'

/**
 * Undefined when events.db or a broker.log cannot be read, which the status reports as a stop. Each
 * send carries the seats it named, from broker.log, so a fan-out that reached one seat is still one.
 */
function holdMessages(nowMs: number): ChatLine[] | undefined {
  const sinceMs = nowMs - BROADCAST_HOLD_MAX_MS
  try {
    const db = path.join(home(), 'events.db')
    const named = readRouteAddressees([readTextIfPresent(`${logPath()}.1`), readTextIfPresent(logPath())])
    return readChatMessages(db, sinceMs).map(line => {
      const addressed = line.msgId === null ? undefined : named.get(line.msgId)
      return addressed === undefined ? line : { ...line, addressed }
    })
  } catch {
    return undefined
  }
}

/** A test passes its own readings, so the host's load, memory, swap and pressure never decide `stopped`. */
export function liveStopInputs(
  now: Date,
  readings: MachineStopReadings = readMachineStopReadings(),
): StopInputs {
  return {
    now,
    chat: holdMessages(now.getTime()),
    operators: resolveMachineHoldOperators(),
    stopFile: () => readTextIfPresent(operatorHoldPath()),
    ownerStops: () => readDoc().stopped,
    seatNames: () => seatFileNames(defaultAutonomyRoot()),
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
    "(a broadcast or fan-out to two or more seats by one of config.json's machineHoldOperators, default " +
    'tp-operator, counted by the seats it named in broker.log, whose first sentence carries HOLD, STOP ' +
    'ALL, MACHINE STOP, STEP-BACK or REBOOT NOTICE/QUIET, standing until an operator send starting with ' +
    'LIFT, CLEAR or "hold LIFTED" has reached every seat it went to, or a broadcast lift, at most ' +
    `${BROADCAST_HOLD_MAX_MS / 3_600_000} h; a fan-out part for a seat that is stopped or has no seat ` +
    "file does not count), the owner's stopped seats in seat-watchdog.json, and the " +
    'memory, load, swap and pressure readings against the machine stop. `stopped` is a hold, the ' +
    'machine stop or a source that cannot be read; an owner stop holds only its own seat',
  args: z.object({ json: z.boolean().optional() }),
  result: Report,
  cli: {
    options: {
      json: {
        long: '--json',
        description:
          'one object: at, stopped, holds[{kind, by, since, reason, msgId?, seats?}], ownerStops, machine, errors',
      },
    },
  },
  async run({ json }) {
    return machineStatusReport(liveStopInputs(new Date()), json === true)
  },
})

const gib = (kb: number): string => `${(kb / 1024 ** 2).toFixed(1)}G`
const pair = ({ median, p90 }: CostMetric, show: (value: number) => string): string =>
  `${show(median)}/${show(p90)}`
const count = (value: number): string => String(Math.round(value))
const decimal = (value: number): string => value.toFixed(1)

function runningLine(agent: RunningAgentCost): string {
  const { name, profile, role, cpuSeconds, rssPeakKb, childrenPeak, tmpFilesPeak } = agent
  const measured =
    cpuSeconds === undefined || rssPeakKb === undefined
      ? 'no sample yet'
      : `cpu ${Math.round(cpuSeconds)}s, rss ${gib(rssPeakKb)}, children ${childrenPeak ?? 0}` +
        (tmpFilesPeak === undefined ? '' : `, tmp files ${tmpFilesPeak}`)
  return `  ${name} (${profile}, ${role}): ${measured}`
}

function estimateLine(estimate: AgentCostEstimate): string {
  const { profile, role, exits, source, rssKb, cpuCores, children, tmpFiles } = estimate
  return (
    `  ${profile}, ${role}: rss ${pair(rssKb, gib)}, cores ${pair(cpuCores, decimal)}, ` +
    `children ${pair(children, count)}, tmp files ${pair(tmpFiles, count)} (${exits} exits, ${source})`
  )
}

/** Each measure reads median/p90. */
export function renderAgentCosts(costs: AgentCosts): string[] {
  return [
    `running: ${costs.running.length}`,
    ...costs.running.map(runningLine),
    'cost by profile and role, median/p90:',
    ...(costs.estimates.length === 0 ? ['  no measured exits yet'] : costs.estimates.map(estimateLine)),
  ]
}

export const machineCostsVerb = defineVerb({
  name: 'machine.costs',
  description:
    "what is running and what it costs (CC-1671): each live agent's CPU, peak RSS, children and TMPDIR " +
    'files so far, then the median and p90 of each per profile and role over their last exits. Linux ' +
    'only; an agent reads "no sample yet" until the broker has sampled it',
  args: z.object({ json: z.boolean().optional() }),
  result: Report,
  cli: { options: { json: { long: '--json', description: 'one object: running[], estimates[]' } } },
  async run({ json }, ctx) {
    const reply = (await ctx.withBroker(b =>
      b.request({ t: 'agents', costs: true }, 'agents_result'),
    )) as Extract<ServerMessage, { t: 'agents_result' }>
    if (reply.costs === undefined)
      return { ok: false, lines: [], errors: ['this broker reports no costs; restart it to update'] }
    return { ok: true, lines: json === true ? [JSON.stringify(reply.costs)] : renderAgentCosts(reply.costs) }
  },
})

export function addMachineCommands(program: Commander): void {
  const machine = program.command('machine').description('operator HOLDs, owner stops and the machine stop')
  addVerb(machine, machineStatusVerb)
  addVerb(machine, machineCostsVerb)
}
