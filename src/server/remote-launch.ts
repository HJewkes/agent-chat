import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkConfigDir } from '../agents/config-dir.js'
import {
  buildMcpConfig,
  hookSettingsPath,
  mcpConfigPath,
  OFF_BROKER,
  writeLaunchFiles,
} from '../agents/launch-files.js'
import { buildLaunchPlan } from '../agents/launch-plan.js'
import { cwdHoldsUserSettings } from '../agents/launch-policy.js'
import { surfaceFor } from '../agents/launcher.js'
import { loadProfile, profileNameRefusal } from '../agents/profiles.js'
import { lexicalCwdRefusal } from '../agents/spawn-cwd.js'
import { isCacheTtl, isPushPolicy, type AgentProfile, type LaunchPlan } from '../agents/types.js'
import { isCarriedPermissionMode, isChannelToken } from '../broker/host-channels.js'
import { agentDir, cliEntry, gitHooksDir, home } from '../paths.js'
import { SURFACE_NAMES, type RemoteLaunch, type SurfaceName } from '../protocol.js'

/**
 * The one "check, build, write, open" unit for a launch the broker cannot make itself, because
 * it runs on another host. The broker sends a host-neutral spec; everything that names a path,
 * a binary or a variable is decided here, on the host that launches.
 *
 * CC-1059: a spawn from a caller on another host. Its cwd and account come from the spec, so both
 * are checked on this host's disk before anything is written. Its env and MCP servers come only
 * from this host's own profile file, never from the wire. The surface opens in a separate step,
 * so the caller can hold it until the broker has accepted the ready report.
 */

const AGENT_ID = /^[0-9a-f]{8}$/
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const CONTROL = /[\u0000-\u001f\u007f]/

/** A session id names a transcript file, so only a uuid may reach a path. */
export const isSessionId = (id: string): boolean => SESSION_ID.test(id)

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
  if (!isSessionId(spec.sessionId)) return 'the successor session id is not a uuid'
  if (badName(spec.name)) return `the name ${JSON.stringify(spec.name)} is not a valid session name`
  const profileName = profileNameRefusal(spec.profile.name)
  if (profileName !== undefined) return profileName
  if (!(SURFACE_NAMES as readonly string[]).includes(spec.surface)) return `unknown surface ${spec.surface}`
  if (flagWords(spec.profile).some(word => word.startsWith('-')))
    return 'the successor profile has a value that would be read as a flag'
  return carriedFlagReason(spec)
}

/** CC-951: carried flags reach this host's argv, so each passes the allowlist a local read applies. */
function carriedFlagReason(spec: RemoteLaunch): string | undefined {
  const bad = (spec.channels ?? []).find(token => !isChannelToken(token))
  if (bad !== undefined) return `the carried channel ${JSON.stringify(bad)} is not a channel target`
  if (spec.permissionMode !== undefined && !isCarriedPermissionMode(spec.permissionMode))
    return `the carried permission mode ${JSON.stringify(spec.permissionMode)} is not one a successor may inherit`
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
  // Unlike env, a TTL from the broker is one of two fixed values, so it may name the variable's value.
  ...(isCacheTtl(p.cacheTtl) ? { cacheTtl: p.cacheTtl } : {}),
  ...(isPushPolicy(p.pushPolicy) ? { pushPolicy: p.pushPolicy } : {}),
  promptPrelude: p.promptPrelude,
  ...(p.strictMcpConfig === undefined ? {} : { strictMcpConfig: p.strictMcpConfig }),
  ...(p.settingSources === undefined ? {} : { settingSources: [...p.settingSources] }),
  ...(p.disableSlashCommands === undefined ? {} : { disableSlashCommands: p.disableSlashCommands }),
})

/** Where the launch runs on this host: its cwd, and its account (undefined runs with the variable unset). */
export interface LaunchSite {
  cliEntry: string
  cwd: string
  configDir: string | undefined
}

/** The two profile fields that set the environment or run something, read only from this host. */
export type LocalProfileFields = Pick<AgentProfile, 'env' | 'mcpServers'>

export interface BuiltLaunch {
  plan: LaunchPlan
  mcpConfig: Record<string, unknown>
}

/** The plan and MCP config, every path, binary and variable from `site` and `local`. */
export function buildLaunch(
  spec: RemoteLaunch,
  site: LaunchSite,
  local: LocalProfileFields = {},
): BuiltLaunch {
  const profile = { ...profileOf(spec.profile), ...local }
  const { configDir } = site
  const plan = buildLaunchPlan({
    agentId: spec.agentId,
    sessionId: spec.sessionId,
    name: spec.name,
    profile,
    brief: spec.brief,
    cwd: site.cwd,
    cwdHoldsUserSettings: cwdHoldsUserSettings(site.cwd, configDir),
    surface: spec.surface,
    preamble: spec.preamble,
    adopted: spec.adopted === true,
    ...(spec.resume === true ? { resume: true } : {}),
    mcpConfigPath: mcpConfigPath(spec.agentId),
    hookSettingsPath: hookSettingsPath(spec.agentId),
    ...(spec.tags?.length ? { tags: spec.tags } : {}),
    ...(spec.subscriptions?.length ? { subscriptions: spec.subscriptions } : {}),
    agentChatHome: home(),
    gitHooksDir: gitHooksDir(),
    ...(configDir ? { configDir } : { configDirUnset: true }),
    // CC-883: checked again here, so a worker never gets Remote Control whatever the broker sent.
    ...(spec.remoteControl && profile.role === 'coordinator' ? { remoteControl: true } : {}),
    ...(spec.channels?.length ? { channels: spec.channels.filter(isChannelToken) } : {}),
    ...(spec.permissionMode !== undefined && isCarriedPermissionMode(spec.permissionMode)
      ? { permissionMode: spec.permissionMode }
      : {}),
  })
  return { plan, mcpConfig: buildMcpConfig(profile, site.cliEntry, plan.surface) }
}

/** What a spawn needs from the host it launches on. */
export interface SpawnHost {
  cliEntry: string
  homeDir: string
  loadProfile(name: string): AgentProfile | { error: string }
  writeFiles(plan: LaunchPlan, mcpConfig: Record<string, unknown>): void
  launch(surface: SurfaceName, plan: LaunchPlan, anchor: string | undefined): Promise<void>
  /** Removes what `prepareRemoteSpawn` wrote, for a spawn the broker would not let open. */
  discard(agentId: string): void
}

const realDir = (dir: string): string | undefined => {
  try {
    return fs.statSync(dir).isDirectory() ? fs.realpathSync(dir) : undefined
  } catch {
    return undefined
  }
}

/** The account a spawn spec names; a spec naming none is refused rather than billed to a guess. */
function accountOf(spec: RemoteLaunch, homeDir: string): { configDir: string | undefined } | string {
  if (spec.configDir !== undefined)
    return checkConfigDir(spec.configDir, { home: homeDir }) ?? { configDir: path.resolve(spec.configDir) }
  if (spec.configDirUnset === true) return { configDir: undefined }
  return 'the launch names no account (neither configDir nor configDirUnset)'
}

/** The spec's cwd and account resolved on this host's disk, or why they cannot be used here. */
export function checkRemoteSpawn(
  spec: RemoteLaunch,
  host: Pick<SpawnHost, 'cliEntry' | 'homeDir'>,
): LaunchSite | string {
  const bad = checkLaunch(spec)
  if (bad !== undefined) return bad
  if (spec.cwd === undefined) return 'the launch names no cwd'
  const cwd = realDir(spec.cwd)
  if (cwd === undefined) return `cwd does not exist on ${os.hostname()}: ${spec.cwd}`
  const cwdRefused = lexicalCwdRefusal(cwd, realDir(host.homeDir) ?? host.homeDir)
  if (cwdRefused !== undefined) return cwdRefused
  const account = accountOf(spec, host.homeDir)
  if (typeof account === 'string') return account
  return { cliEntry: host.cliEntry, cwd, configDir: account.configDir }
}

/** This host's own copy of the profile's env and MCP servers, with a warning when it has none. */
function localFields(spec: RemoteLaunch, host: SpawnHost): { local: LocalProfileFields; warnings: string[] } {
  const found = host.loadProfile(spec.profile.name)
  if ('error' in found) {
    const why = `${found.error} on ${os.hostname()}`
    return { local: {}, warnings: [`${why}, so the agent runs without its profile's env and MCP servers`] }
  }
  const { env, mcpServers } = found
  return {
    local: { ...(env === undefined ? {} : { env }), ...(mcpServers === undefined ? {} : { mcpServers }) },
    warnings: [],
  }
}

export type PreparedSpawn = { ok: true; plan: LaunchPlan; warnings: string[] } | { ok: false; reason: string }

/** Check, build and write. Nothing opens yet: the caller reports ready and waits for the broker's ack. */
export function prepareRemoteSpawn(spec: RemoteLaunch, host: SpawnHost): PreparedSpawn {
  const site = checkRemoteSpawn(spec, host)
  if (typeof site === 'string') return { ok: false, reason: site }
  const { local, warnings } = localFields(spec, host)
  try {
    const { plan, mcpConfig } = buildLaunch(spec, site, local)
    host.writeFiles(plan, mcpConfig)
    return { ok: true, plan, warnings }
  } catch (err) {
    return { ok: false, reason: (err as Error).message }
  }
}

/** Opens the surface for a prepared spawn; undefined when it opened, else why not. */
export async function placeRemoteSpawn(
  spec: RemoteLaunch,
  plan: LaunchPlan,
  host: Pick<SpawnHost, 'launch'>,
): Promise<string | undefined> {
  try {
    await host.launch(spec.surface, plan, spec.anchor)
    return undefined
  } catch (err) {
    return (err as Error).message
  }
}

export const defaultSpawnHost = (): SpawnHost => ({
  cliEntry: cliEntry(),
  homeDir: os.homedir(),
  loadProfile: name => loadProfile(name),
  writeFiles: (plan, mcpConfig) => void writeLaunchFiles(plan, mcpConfig, undefined, OFF_BROKER),
  launch: async (surface, plan, anchor) =>
    void (await surfaceFor(surface, anchor === undefined ? {} : { anchor }).launch(plan)),
  discard: agentId => fs.rmSync(agentDir(agentId), { recursive: true, force: true }),
})
