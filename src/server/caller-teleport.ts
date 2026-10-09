import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { endHostSession } from '../agents/end-session.js'
import { buildMcpConfig, hookSettingsPath, mcpConfigPath, writeLaunchFiles } from '../agents/launch-files.js'
import { buildLaunchPlan } from '../agents/launch-plan.js'
import { cwdHoldsUserSettings } from '../agents/launch-policy.js'
import type { AgentProfile, LaunchPlan } from '../agents/types.js'
import type { BrokerClient } from '../client/broker-client.js'
import { agentDir, cliEntry, gitHooksDir, home } from '../paths.js'
import { SURFACE_NAMES, type RemoteLaunch, type ServerMessage, type SurfaceName } from '../protocol.js'

/**
 * CC-881: the half of a teleport that runs on the caller's host. When the broker is on another
 * machine it can neither write this machine's launch files, nor open its terminal, nor signal its
 * Claude Code. It sends a host-neutral spec; this process validates it, builds the plan, every
 * path, the env and the MCP config from its OWN host, arms a detached helper, and ends its parent
 * only once the broker accepted the report. A refused or lost report disarms the helper instead.
 *
 * CC-913: the report means armed, not launched. The successor reuses the predecessor's pane, which
 * frees only when the predecessor exits, so the launch (`caller-land.ts`) runs after that exit.
 */

/** What this host contributes to the plan: never taken from the broker. */
export interface LocalHost {
  cliEntry: string
  cwd: string
  env: NodeJS.ProcessEnv
}

export interface Armed {
  /** Release the helper to place the successor once this session's Claude Code exits; false when it already died. */
  go(): boolean
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
  ]
}

/** Detached and in its own session, so it outlives this process and the Claude Code it is about to end. */
export async function armHelper(local: LocalHost, spec: RemoteLaunch, hostPid: number): Promise<Armed> {
  const log = fs.openSync(path.join(agentDir(spec.agentId), 'land.log'), 'a', 0o600)
  const child = spawn(process.execPath, landArgs(local, spec, hostPid), {
    cwd: local.cwd,
    env: local.env,
    detached: true,
    stdio: ['pipe', log, log],
  })
  fs.closeSync(log)
  await once(child, 'spawn')
  child.unref()
  const alive = () => child.exitCode === null && child.signalCode === null
  return {
    go: () => {
      if (!alive()) return false
      child.stdin?.end('go\n')
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
    writeFiles: writeLaunchFiles,
    arm: (spec, hostPid) => armHelper(local, spec, hostPid),
    endParent: pid => void endHostSession('this session', pid),
  }
}

const AGENT_ID = /^[0-9a-f]{8}$/
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const CONTROL = /[\u0000-\u001f\u007f]/

/** A name becomes a pane title and a registry key; it must never steer a path. */
const badName = (name: string): boolean =>
  name === '' || name.length > 128 || /[/\\]/.test(name) || name.includes('..') || CONTROL.test(name)

/** Profile values that become argv words: one starting with `-` would be read as a flag. */
function flagWords(profile: RemoteLaunch['profile']): string[] {
  return [
    profile.model,
    ...profile.allowedTools,
    ...(profile.disallowedTools ?? []),
    ...(profile.settingSources ?? []),
    profile.effort ?? '',
  ]
}

/** Why the spec cannot be run here, or undefined when it can. */
export function checkLaunch(spec: RemoteLaunch): string | undefined {
  if (!AGENT_ID.test(spec.agentId))
    return `the successor id ${JSON.stringify(spec.agentId)} is not an agent id`
  if (!SESSION_ID.test(spec.sessionId)) return 'the successor session id is not a uuid'
  if (badName(spec.name)) return `the name ${JSON.stringify(spec.name)} is not a valid session name`
  if (!(SURFACE_NAMES as readonly string[]).includes(spec.surface)) return `unknown surface ${spec.surface}`
  if (flagWords(spec.profile).some(word => word.startsWith('-')))
    return 'the successor profile has a value that would be read as a flag'
  return undefined
}

/** Only these profile fields are read from the broker; env and MCP servers never are. */
const profileOf = (p: RemoteLaunch['profile']): AgentProfile => ({
  name: p.name,
  description: p.description,
  model: p.model,
  allowedTools: [...p.allowedTools],
  ...(p.disallowedTools === undefined ? {} : { disallowedTools: [...p.disallowedTools] }),
  isolation: p.isolation,
  surface: p.surface,
  ...(p.surfaceLifetime === undefined ? {} : { surfaceLifetime: p.surfaceLifetime }),
  ...(p.role === undefined ? {} : { role: p.role }),
  ...(p.returnContract === undefined ? {} : { returnContract: p.returnContract }),
  ...(p.effort === undefined ? {} : { effort: p.effort }),
  promptPrelude: p.promptPrelude,
  ...(p.strictMcpConfig === undefined ? {} : { strictMcpConfig: p.strictMcpConfig }),
  ...(p.settingSources === undefined ? {} : { settingSources: [...p.settingSources] }),
  ...(p.disableSlashCommands === undefined ? {} : { disableSlashCommands: p.disableSlashCommands }),
})

/** The plan and MCP config, every path, binary and variable from this host. */
export function buildCallerLaunch(
  spec: RemoteLaunch,
  local: LocalHost,
): { plan: LaunchPlan; mcpConfig: Record<string, unknown> } {
  const profile = profileOf(spec.profile)
  const configDir = local.env.CLAUDE_CONFIG_DIR
  const plan = buildLaunchPlan({
    agentId: spec.agentId,
    sessionId: spec.sessionId,
    name: spec.name,
    profile,
    brief: spec.brief,
    cwd: local.cwd,
    cwdHoldsUserSettings: cwdHoldsUserSettings(local.cwd, configDir),
    surface: spec.surface,
    preamble: spec.preamble,
    mcpConfigPath: mcpConfigPath(spec.agentId),
    hookSettingsPath: hookSettingsPath(spec.agentId),
    ...(spec.tags?.length ? { tags: spec.tags } : {}),
    ...(spec.subscriptions?.length ? { subscriptions: spec.subscriptions } : {}),
    agentChatHome: home(),
    gitHooksDir: gitHooksDir(),
    ...(configDir ? { configDir } : { configDirUnset: true }),
    // CC-883: checked again here, so a worker never gets Remote Control whatever the broker sent.
    ...(spec.remoteControl && profile.role === 'coordinator' ? { remoteControl: true } : {}),
  })
  return { plan, mcpConfig: buildMcpConfig(profile, local.cliEntry, plan.surface) }
}

type Broker = Pick<BrokerClient, 'request'>

type Ack = Extract<ServerMessage, { t: 'teleport_launched_result' }>

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

/** Waits out the countdown for the spec, arms it, and ends `hostPid` only on an accepted report. */
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
  if (!armed.go()) return warn(`helper for successor ${spec.agentId} exited before it was released`)
  deps.endParent(hostPid as number)
}

const warn = (what: string): void =>
  void process.stderr.write(`agent-chat: teleport ${what}, and this session stays live\n`)
