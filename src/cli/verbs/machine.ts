import fs from 'node:fs'
import path from 'node:path'
import type { Command as Commander } from 'commander'
import { z } from 'zod'
import { requiredString } from '../../args.js'
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
import { laneHoldExpired, parseLanes, readLaneHold, type LaneHold } from '../../agents/seats/lane-hold.js'
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

/** What `hold` and `lift` act on, injected so a test never touches the real stop file or environment. */
export interface LaneHoldDeps {
  /** The agent running the verb: AGENT_CHAT_NAME, absent for a shell that is not an agent. */
  caller: string | undefined
  operators: readonly string[]
  now: Date
  read(): string | undefined
  write(text: string): void
  remove(): void
}

const refusedUnlessOperator = (deps: LaneHoldDeps, verb: string): Report | undefined =>
  deps.caller !== undefined && deps.operators.includes(deps.caller)
    ? undefined
    : {
        ok: false,
        lines: [],
        errors: [
          `machine ${verb} is for machineHoldOperators (${deps.operators.join(', ')}); ` +
            `${deps.caller === undefined ? 'this shell has no AGENT_CHAT_NAME' : `${deps.caller} is not one`}`,
        ],
      }

/** The live lane hold, or an error when the stop file holds something a lane verb must not overwrite. */
function currentLaneHold(deps: LaneHoldDeps): LaneHold | undefined | { error: string } {
  const text = deps.read()
  if (text === undefined) return undefined
  const hold = readLaneHold(text)
  if (hold === undefined)
    return { error: 'the stop file holds a machine-wide hold or is unreadable; leaving it' }
  return laneHoldExpired(hold, deps.now.getTime()) ? undefined : hold
}

export function machineHoldReport(
  args: { lanes: string; until: string; reason: string },
  deps: LaneHoldDeps,
): Report {
  const refused = refusedUnlessOperator(deps, 'hold')
  if (refused) return refused
  const until = new Date(args.until)
  if (!Number.isFinite(until.getTime()) || until.getTime() <= deps.now.getTime())
    return {
      ok: false,
      lines: [],
      errors: [`--until must be an ISO time in the future, not "${args.until}"`],
    }
  if (args.reason.trim() === '') return { ok: false, lines: [], errors: ['--reason must say why'] }
  const lanes = parseLanes(args.lanes)
  const held = currentLaneHold(deps)
  if (held !== undefined && 'error' in held) return { ok: false, lines: [], errors: [held.error] }
  const merged = [...new Set([...(held?.lanes ?? []), ...lanes])]
  const hold: LaneHold = {
    by: deps.caller ?? '',
    since: held?.since ?? deps.now.toISOString(),
    reason: args.reason.trim(),
    lanes: merged,
    until: until.toISOString(),
  }
  deps.write(`${JSON.stringify(hold, null, 2)}\n`)
  return { ok: true, lines: [`hold on ${merged.join(', ')} until ${hold.until}`] }
}

export function machineLiftReport(args: { lanes?: string | undefined }, deps: LaneHoldDeps): Report {
  const refused = refusedUnlessOperator(deps, 'lift')
  if (refused) return refused
  const held = currentLaneHold(deps)
  if (held !== undefined && 'error' in held) return { ok: false, lines: [], errors: [held.error] }
  if (held === undefined) {
    deps.remove()
    return { ok: true, lines: ['no lane hold to lift'] }
  }
  const lifted = args.lanes === undefined ? held.lanes : parseLanes(args.lanes)
  const left = held.lanes.filter(lane => !lifted.includes(lane))
  if (left.length === 0) deps.remove()
  else deps.write(`${JSON.stringify({ ...held, lanes: left }, null, 2)}\n`)
  return { ok: true, lines: [left.length === 0 ? 'lane hold lifted' : `still held: ${left.join(', ')}`] }
}

function liveLaneHoldDeps(): LaneHoldDeps {
  const file = operatorHoldPath()
  return {
    caller: process.env.AGENT_CHAT_NAME || undefined,
    operators: resolveMachineHoldOperators(),
    now: new Date(),
    read: () => readTextIfPresent(file),
    write(text) {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      fs.writeFileSync(tmp, text, { mode: 0o600 })
      fs.renameSync(tmp, file)
    },
    remove: () => fs.rmSync(file, { force: true }),
  }
}

export const machineHoldVerb = defineVerb({
  name: 'machine.hold',
  description:
    'hold named lanes (CC-1692): the broker refuses agent_spawn and agent_resume from those lanes and ' +
    'from the workers they spawned until --until or `machine lift`; other lanes are unaffected. Kept in ' +
    "the stop file, listed by `machine status`. Only config.json's machineHoldOperators may hold",
  args: z.object({
    lanes: requiredString('lanes'),
    until: requiredString('until'),
    reason: requiredString('reason'),
  }),
  result: Report,
  cli: {
    options: {
      lanes: { long: '--lanes', description: 'comma-separated lane (seat) names to hold' },
      until: { long: '--until', description: 'ISO time the hold ends' },
      reason: { long: '--reason', description: 'why, shown in the refusal and in machine status' },
    },
  },
  async run(args) {
    return machineHoldReport(args, liveLaneHoldDeps())
  },
})

export const machineLiftVerb = defineVerb({
  name: 'machine.lift',
  description:
    "lift a lane hold (CC-1692): the named lanes, or every lane without --lanes. Only config.json's " +
    'machineHoldOperators may lift',
  args: z.object({ lanes: z.string().optional() }),
  result: Report,
  cli: {
    options: { lanes: { long: '--lanes', description: 'comma-separated lanes to lift (default: all)' } },
  },
  async run(args) {
    return machineLiftReport(args, liveLaneHoldDeps())
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
  addVerb(machine, machineHoldVerb)
  addVerb(machine, machineLiftVerb)
}
