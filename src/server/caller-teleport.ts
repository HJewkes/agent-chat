import { endHostSession } from '../agents/end-session.js'
import { writeLaunchFiles } from '../agents/launch-files.js'
import { surfaceFor } from '../agents/launcher.js'
import type { BrokerClient } from '../client/broker-client.js'
import type { RemoteLaunch, ServerMessage } from '../protocol.js'

/**
 * CC-881: the half of a teleport that runs on the caller's host. When the broker is on another
 * machine it can neither write this machine's launch files, nor open its terminal, nor signal its
 * Claude Code, so it hands the relaunch back and this process does all three, in that order.
 * Fail closed: nothing ends the parent until the successor's surface opened.
 */
export interface CallerLaunchDeps {
  writeFiles(launch: RemoteLaunch): void
  launch(launch: RemoteLaunch): Promise<void>
  endParent(pid: number): void
}

export const defaultCallerLaunch = (): CallerLaunchDeps => ({
  writeFiles: launch => writeLaunchFiles(launch.plan, launch.mcpConfig),
  launch: async launch => {
    await surfaceFor(launch.surface, launch.anchor === undefined ? {} : { anchor: launch.anchor }).launch(
      launch.plan,
    )
  },
  endParent: pid => void endHostSession('this session', pid),
})

type Broker = Pick<BrokerClient, 'request'>

async function report(broker: Broker, ok: boolean, reason?: string): Promise<void> {
  await broker.request(
    { t: 'teleport_launched', ok, ...(reason === undefined ? {} : { reason }) },
    'teleport_launched_result',
  )
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
    await launchLocally(reply.launch, hostPid, deps)
  } catch (err) {
    return report(broker, false, (err as Error).message)
  }
  await report(broker, true)
  deps.endParent(hostPid as number)
}
