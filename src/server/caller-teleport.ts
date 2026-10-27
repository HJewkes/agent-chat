import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { endHostSession } from '../agents/end-session.js'
import { OFF_BROKER, writeLaunchFiles } from '../agents/launch-files.js'
import type { LaunchPlan } from '../agents/types.js'
import type { BrokerClient } from '../client/broker-client.js'
import { agentDir, cliEntry } from '../paths.js'
import type { RemoteLaunch, ServerMessage } from '../protocol.js'
import { buildLaunch, checkLaunch, type BuiltLaunch } from './remote-launch.js'

/**
 * CC-881: the half of a teleport that runs on the caller's host. When the broker is on another
 * machine it can neither write this machine's launch files, nor open its terminal, nor signal its
 * Claude Code. It sends a host-neutral spec; this process validates it, builds the plan, every
 * path, the env and the MCP config from its OWN host, arms a detached helper, and ends its parent
 * only once the broker accepted the report. A refused or lost report disarms the helper instead.
 *
 * CC-913: the report means armed, not launched. The successor reuses the predecessor's pane, which
 * frees only when the predecessor exits, so the launch (`caller-land.ts`) runs after that exit.
 *
 * CC-951: successor first. A plan with `endSelf` means the broker launched the successor elsewhere
 * and it attached, so this ends its parent and writes nothing. A `successorFirst` spec opens a new
 * surface at once, and this waits for the `endSelf` plan that follows the successor's attach.
 */

/** What this host contributes to the plan: never taken from the broker. */
export interface LocalHost {
  cliEntry: string
  cwd: string
  env: NodeJS.ProcessEnv
  /** The node binary that runs the helper; this process's own unless a test says otherwise. */
  node?: string
}

export interface Armed {
  /** Release the helper, handing it the landing token, to place the successor once this session's Claude Code exits; false when it already died. */
  go(token: string): boolean
  /** Disarm the helper, so it never places the successor. */
  abandon(): void
}

export interface CallerLaunchDeps {
  local: LocalHost
  writeFiles(plan: LaunchPlan, mcpConfig: Record<string, unknown>): void
  arm(spec: RemoteLaunch, hostPid: number): Promise<Armed>
  endParent(pid: number): void
}

function landArgs(local: LocalHost, spec: RemoteLaunch, hostPid: number): string[] {
  const anchor = spec.anchor === undefined ? [] : [`--anchor=${spec.anchor}`]
  return [
    local.cliEntry,
    'teleport-land',
    spec.agentId,
    `--pid=${hostPid}`,
    `--surface=${spec.surface}`,
    ...anchor,
    ...(spec.successorFirst === true ? ['--now'] : []),
  ]
}

/** Node reports a missing cwd as `spawn <node> ENOENT`, so each input is checked and named before the spawn. */
function missingCommand(node: string, local: LocalHost): string | undefined {
  return [node, local.cliEntry].find(file => !fs.existsSync(file))
}

/** Detached and in its own session, so it outlives this process and the Claude Code it is about to end. */
export async function armHelper(local: LocalHost, spec: RemoteLaunch, hostPid: number): Promise<Armed> {
  const node = local.node ?? process.execPath
  const gone = missingCommand(node, local)
  if (gone !== undefined) throw new Error(`the landing helper command ${gone} does not exist on this host`)
  const log = fs.openSync(path.join(agentDir(spec.agentId), 'land.log'), 'a', 0o600)
  const cwdGone = !fs.existsSync(local.cwd)
  if (cwdGone) fs.writeSync(log, `cwd ${local.cwd} no longer exists; the helper runs in ${os.homedir()}\n`)
  const child = spawn(node, landArgs(local, spec, hostPid), {
    cwd: cwdGone ? os.homedir() : local.cwd,
    env: local.env,
    detached: true,
    stdio: ['pipe', log, log],
  })
  fs.closeSync(log)
  await once(child, 'spawn')
  child.unref()
  const alive = () => child.exitCode === null && child.signalCode === null
  return {
    go: token => {
      if (!alive()) return false
      child.stdin?.end(`go ${token}\n`)
      return true
    },
    abandon: () => {
      child.stdin?.destroy()
      child.kill()
    },
  }
}

export const defaultCallerLaunch = (): CallerLaunchDeps => {
  const local = { cliEntry: cliEntry(), cwd: process.cwd(), env: process.env }
  return {
    local,
    writeFiles: (plan, mcpConfig) => void writeLaunchFiles(plan, mcpConfig, undefined, OFF_BROKER),
    arm: (spec, hostPid) => armHelper(local, spec, hostPid),
    endParent: pid => void endHostSession('this session', pid),
  }
}

/** The plan and MCP config from this process's own cwd and account; a teleport carries neither. */
export function buildCallerLaunch(spec: RemoteLaunch, local: LocalHost): BuiltLaunch {
  return buildLaunch(spec, {
    cliEntry: local.cliEntry,
    cwd: local.cwd,
    configDir: local.env.CLAUDE_CONFIG_DIR || undefined,
  })
}

type Broker = Pick<BrokerClient, 'request'>

type Ack = Extract<ServerMessage, { t: 'teleport_launched_result' }>

type LandFailedResult = Extract<ServerMessage, { t: 'teleport_land_failed_result' }>

/** CC-913: the one report that retires an armed successor, from whichever side holds its token. */
export async function reportUnplaced(
  broker: Broker,
  agentId: string,
  token: string,
  reason: string,
): Promise<LandFailedResult> {
  try {
    return (await broker.request(
      { t: 'teleport_land_failed', agentId, token, reason },
      'teleport_land_failed_result',
    )) as LandFailedResult
  } catch (err) {
    return { t: 'teleport_land_failed_result', ok: false, reason: (err as Error).message }
  }
}

/** The broker's verdict on the report; a report that could not be delivered is not accepted. */
async function report(broker: Broker, agentId: string, ok: boolean, reason?: string): Promise<Ack> {
  try {
    return (await broker.request(
      { t: 'teleport_launched', agentId, ok, ...(reason === undefined ? {} : { reason }) },
      'teleport_launched_result',
    )) as Ack
  } catch (err) {
    return { t: 'teleport_launched_result', ok: false, reason: (err as Error).message }
  }
}

async function armLocally(spec: RemoteLaunch, hostPid: number | undefined, deps: CallerLaunchDeps) {
  const refused = checkLaunch(spec)
  if (refused !== undefined) throw new Error(refused)
  if (hostPid === undefined) throw new Error('this MCP process does not know the pid of its Claude Code')
  const { plan, mcpConfig } = buildCallerLaunch(spec, deps.local)
  deps.writeFiles(plan, mcpConfig)
  return deps.arm(spec, hostPid)
}

type Plan = Extract<ServerMessage, { t: 'teleport_plan' }>

const awaitPlan = async (broker: Broker): Promise<Plan> =>
  (await broker.request({ t: 'teleport_plan_wait' }, 'teleport_plan')) as Plan

/** CC-951: the successor attached, so this session's Claude Code ends; anything else leaves it live. */
function endOnAttach(plan: Plan, hostPid: number | undefined, deps: CallerLaunchDeps): void {
  if (plan.ok && plan.endSelf === true && hostPid !== undefined) return deps.endParent(hostPid)
  warn(`did not complete (${plan.reason ?? 'no successor attached'})`)
}

/** Waits out the countdown for the spec, arms it, and ends `hostPid` only on an accepted report. */
export async function runCallerTeleport(
  broker: Broker,
  hostPid: number | undefined,
  deps: CallerLaunchDeps,
): Promise<void> {
  const reply = await awaitPlan(broker)
  if (reply.ok && reply.endSelf === true) return endOnAttach(reply, hostPid, deps)
  if (!reply.ok || reply.launch === undefined) return
  const spec = reply.launch
  let armed: Armed
  try {
    armed = await armLocally(spec, hostPid, deps)
  } catch (err) {
    await report(broker, spec.agentId, false, (err as Error).message)
    return
  }
  const ack = await report(broker, spec.agentId, true)
  if (!ack.ok) {
    // The broker already released the successor, so it is never placed and this session stays live.
    armed.abandon()
    return warn(`report not accepted (${ack.reason ?? 'no reason'}); disarmed successor ${spec.agentId}`)
  }
  const token = spec.landToken ?? ''
  if (!armed.go(token)) return helperLost(broker, spec, token, hostPid as number, deps)
  if (spec.successorFirst !== true) return deps.endParent(hostPid as number)
  endOnAttach(await awaitPlan(broker), hostPid, deps)
}

/**
 * CC-913: the broker has already accepted the report and is retiring this session, so a helper that
 * died unreleased is reported here with the token. Only the broker's answer says this session stays.
 */
async function helperLost(
  broker: Broker,
  spec: RemoteLaunch,
  token: string,
  hostPid: number,
  deps: CallerLaunchDeps,
) {
  const reason = 'its helper exited before it was released'
  const answer = await reportUnplaced(broker, spec.agentId, token, reason)
  if (answer.ok && answer.predecessorLive === true)
    return warn(`successor ${spec.agentId} was not placed: ${reason}`)
  if (answer.ok) return deps.endParent(hostPid)
  process.stderr.write(
    `agent-chat: teleport successor ${spec.agentId} was not placed (${reason}) and the broker did not ` +
      `confirm this session stays live: ${answer.reason ?? 'no reason'}\n`,
  )
}

const warn = (what: string): void =>
  void process.stderr.write(`agent-chat: teleport ${what}, and this session stays live\n`)
