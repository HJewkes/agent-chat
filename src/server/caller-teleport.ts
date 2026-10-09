import fs from 'node:fs'
import { endHostSession } from '../agents/end-session.js'
import { writeLaunchFiles } from '../agents/launch-files.js'
import { surfaceFor } from '../agents/launcher.js'
import type { BrokerClient } from '../client/broker-client.js'
import { cliEntry, home } from '../paths.js'
import type { HostPaths, RemoteLaunch, ServerMessage } from '../protocol.js'

/**
 * CC-881: the half of a teleport that runs on the caller's host. When the broker is on another
 * machine it can neither write this machine's launch files, nor open its terminal, nor signal its
 * Claude Code, so it hands the relaunch back and this process does all three, in that order.
 * Fail closed: nothing ends the parent until the successor's surface opened AND the broker
 * accepted that report, since a late report finds the successor already released.
 */
export interface CallerLaunchDeps {
  /** This host's node, CLI entry and home, which replace the broker host's in the plan. */
  paths: HostPaths
  writeFiles(launch: RemoteLaunch): void
  launch(launch: RemoteLaunch): Promise<void>
  endParent(pid: number): void
}

export const defaultCallerLaunch = (): CallerLaunchDeps => ({
  paths: { execPath: process.execPath, cliEntry: cliEntry(), home: home() },
  writeFiles: launch => {
    if (!fs.existsSync(launch.plan.cwd))
      throw new Error(`the successor's cwd ${launch.plan.cwd} is not on this host`)
    writeLaunchFiles(launch.plan, launch.mcpConfig)
  },
  launch: async launch => {
    await surfaceFor(launch.surface, launch.anchor === undefined ? {} : { anchor: launch.anchor }).launch(
      launch.plan,
    )
  },
  endParent: pid => void endHostSession('this session', pid),
})

type Broker = Pick<BrokerClient, 'request'>

async function report(broker: Broker, ok: boolean, reason?: string): Promise<Ack> {
  return (await broker.request(
    { t: 'teleport_launched', ok, ...(reason === undefined ? {} : { reason }) },
    'teleport_launched_result',
  )) as Ack
}

type Ack = Extract<ServerMessage, { t: 'teleport_launched_result' }>

const swapPath = (value: string, from: string, to: string): string =>
  from === to ? value : value.replaceAll(from, to)

/** The home is swapped only as a whole path or a directory prefix, never inside a longer name. */
const swapHome = (value: string, from: string, to: string): string =>
  value === from ? to : swapPath(value, `${from}/`, `${to}/`)

function localizeValue(value: unknown, from: HostPaths, to: HostPaths): unknown {
  if (typeof value === 'string') {
    const swapped = swapPath(swapPath(value, from.cliEntry, to.cliEntry), from.execPath, to.execPath)
    return swapHome(swapped, from.home, to.home)
  }
  if (Array.isArray(value)) return value.map(item => localizeValue(item, from, to))
  if (typeof value === 'object' && value !== null)
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, localizeValue(v, from, to)]))
  return value
}

/** The plan and MCP config with every broker-host path replaced by this host's own. */
export function localizeLaunch(launch: RemoteLaunch, paths: HostPaths): RemoteLaunch {
  const { origin } = launch
  return {
    ...launch,
    plan: localizeValue(launch.plan, origin, paths) as RemoteLaunch['plan'],
    mcpConfig: localizeValue(launch.mcpConfig, origin, paths) as RemoteLaunch['mcpConfig'],
    origin: paths,
  }
}

async function launchLocally(
  launch: RemoteLaunch,
  hostPid: number | undefined,
  deps: CallerLaunchDeps,
): Promise<void> {
  if (hostPid === undefined) throw new Error('this MCP process does not know the pid of its Claude Code')
  deps.writeFiles(launch)
  await deps.launch(launch)
}

/** Waits out the countdown for the plan, runs it, reports, and only then ends `hostPid`. */
export async function runCallerTeleport(
  broker: Broker,
  hostPid: number | undefined,
  deps: CallerLaunchDeps,
): Promise<void> {
  const reply = (await broker.request({ t: 'teleport_plan_wait' }, 'teleport_plan')) as Extract<
    ServerMessage,
    { t: 'teleport_plan' }
  >
  if (!reply.ok || reply.launch === undefined) return
  try {
    await launchLocally(localizeLaunch(reply.launch, deps.paths), hostPid, deps)
  } catch (err) {
    await report(broker, false, (err as Error).message)
    return
  }
  const ack = await report(broker, true)
  if (!ack.ok) {
    process.stderr.write(
      `agent-chat: the broker refused this teleport's launch report (${ack.reason ?? 'no reason'}); ` +
        `this session stays live and successor ${reply.launch.agentId} is orphaned\n`,
    )
    return
  }
  deps.endParent(hostPid as number)
}
