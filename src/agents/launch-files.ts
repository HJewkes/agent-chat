import fs from 'node:fs'
import path from 'node:path'
import { resolvePermissionHookTimeout } from '../config.js'
import { GIT_SHIM_DIR_ENV, writeGitShim } from '../leak-guard/git-shim.js'
import { hooksDirOf, writeGitHooks } from '../leak-guard/hooks-dir.js'
import { agentDir, cliEntry } from '../paths.js'
import type { IsolationName, SurfaceName } from '../protocol.js'
import type { Allocation } from './isolation/index.js'
import { readLaunchPlan as readPlanFile, relaunchScript } from '@titan-design/agent-surface'
import { defaultConfigDir } from './config-dir.js'
import { agentChatLauncher, relaunchScriptPath } from './launcher.js'
import { AGENT_CHAT_PLUGIN } from './launch-plan.js'
import { strictMcpFor } from './launch-policy.js'
import type { AgentProfile, LaunchHandle, LaunchPlan } from './types.js'

/**
 * The launch files, and why they exist at all.
 *
 * NEVER interpolate a brief into a shell command line. Briefs are multi-line and
 * model-authored, and for a terminal surface they would have to survive
 * AppleScript's quoting AND the shell's. That is an injection surface and a
 * debugging nightmare in equal measure.
 *
 * So the plan goes to disk and every surface launches the same fixed command:
 * `agent-chat run-agent <id>`. AppleScript then only ever carries a short fixed
 * string with an 8-char id in it. The same file is what makes resume cheap — it
 * is already written.
 */

/** Owner-only: these files carry the brief, the argv, and the agent's identity. */
const DIR_MODE = 0o700
const FILE_MODE = 0o600
const SCRIPT_MODE = 0o700

export const planPath = (agentId: string): string => path.join(agentDir(agentId), 'plan.json')

/** Named as the plugin names it, so its tools still match the AGENT_CHAT_TOOLS grant. */
const AGENT_CHAT_SERVER = 'plugin:agent-chat:agent-chat'

export const mcpConfigPath = (agentId: string): string => path.join(agentDir(agentId), 'mcp.json')

/**
 * The MCP config a spawned agent starts with.
 *
 * EXPERIMENT (2026-07-31, CC-45/CC-46 live-push verification): agent-chat used
 * to force its own entry here unconditionally, on the theory that "an agent
 * that cannot reach the bus is not a peer, it is a subprocess". That guaranteed
 * tool access even if the agent-chat plugin isn't installed for the child, but
 * it means the child's agent-chat server is THIS custom --mcp-config entry, not
 * the one Claude Code actually grants `notifications/claude/channel` to via
 * `--channels plugin:agent-chat@agent-chat-local` (launch-plan.ts) — that grant
 * appears tied to the plugin-loaded server (`agent-chat-launch.sh mcp`), not a
 * same-named --mcp-config entry. Confirmed empirically: with --channels alone,
 * Claude Code's own banner confirmed injection was "enabled" for the session,
 * but a pushed chat_send message still never arrived. Dropping this entry and
 * relying on the plugin's normal auto-load (env vars still propagate via
 * envFor(), which the plugin's own subprocess reads identically) is the
 * unverified fix under test. If this breaks agent-chat tool access — e.g. a
 * setup where the plugin isn't installed, only `npm link`ed — that is the
 * regression to watch for and the reason this used to be unconditional.
 *
 * A strict launch is the exception, and a headless worker is strict unless its
 * profile says otherwise: --strict-mcp-config drops the plugin's server along
 * with every other one (observed 2026-09-28: `mcp_servers` was empty even with
 * --channels), so the entry comes back for it, and that agent reaches the bus by
 * tools and polling rather than live pushes.
 */
export function buildMcpConfig(
  profile: AgentProfile,
  entry: string,
  surface: SurfaceName = profile.surface,
): Record<string, unknown> {
  return {
    mcpServers: {
      ...(strictMcpFor(profile, surface)
        ? { [AGENT_CHAT_SERVER]: { command: process.execPath, args: [entry, 'mcp'] } }
        : {}),
      ...(profile.mcpServers ?? {}),
    },
  }
}

export const hookSettingsPath = (agentId: string): string => path.join(agentDir(agentId), 'settings.json')

/** The hook gives up this long before Claude Code would kill it, so it can withdraw its row itself. */
const HOOK_DEADLINE_MARGIN_S = 10

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`

const hookCommand = (entry: string, verb: string): string =>
  `${shellQuote(process.execPath)} ${shellQuote(entry)} ${verb}`

/** Bash spells the bypasses; the edit tools can rewrite the hook directory or the term list. */
const PRETOOL_MATCHER = 'Bash|Edit|Write|MultiEdit|NotebookEdit'

/** Seconds. The guard reads only regular files and never waits, so a run this long is already broken. */
const PRETOOL_TIMEOUT_S = 15

/**
 * What a launch without the user settings source still takes from that account. The user
 * file is where the bus plugin is enabled, and its deny rules only narrow, so dropping them
 * would hand a worker tools the owner denied everywhere (observed: Agent and SendMessage
 * came back under `--setting-sources project,local`).
 */
const withoutUserSettings = (denies: string[]): Record<string, unknown> => ({
  enabledPlugins: { [AGENT_CHAT_PLUGIN]: true },
  ...(denies.length === 0 ? {} : { permissions: { deny: denies } }),
})

/**
 * The `--settings` file every spawned agent runs with. The leak guard's PreToolUse hook
 * (CC-270) goes to all of them. A print-mode run, given `permissionTimeoutSeconds`, also
 * gets the PermissionRequest hook (CC-144) that files each prompt in the human queue and
 * blocks for the verdict. Claude Code runs hook commands through a shell, and both paths
 * can contain spaces. `userDenies` is set, even when empty, for a launch that loads no
 * user settings.
 */
export function buildHookSettings(
  entry: string,
  permissionTimeoutSeconds?: number,
  userDenies?: string[],
): Record<string, unknown> {
  const pretool = [
    {
      matcher: PRETOOL_MATCHER,
      hooks: [
        { type: 'command', command: hookCommand(entry, 'leak-guard pretool'), timeout: PRETOOL_TIMEOUT_S },
      ],
    },
  ]
  const carried = userDenies === undefined ? {} : withoutUserSettings(userDenies)
  if (permissionTimeoutSeconds === undefined) return { ...carried, hooks: { PreToolUse: pretool } }
  const deadline = Math.max(1, permissionTimeoutSeconds - HOOK_DEADLINE_MARGIN_S)
  const command = hookCommand(entry, `permission-hook --deadline ${deadline}`)
  return {
    ...carried,
    hooks: {
      PreToolUse: pretool,
      PermissionRequest: [
        { matcher: '*', hooks: [{ type: 'command', command, timeout: permissionTimeoutSeconds }] },
      ],
    },
  }
}

/** The deny rules in an account's own settings file. An unreadable file carries none, as Claude Code reads it. */
export function readUserDenies(configDir: string): string[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(configDir, 'settings.json'), 'utf8')) as {
      permissions?: { deny?: unknown }
    }
    const deny = parsed.permissions?.deny
    return Array.isArray(deny) ? deny.filter((rule): rule is string => typeof rule === 'string') : []
  } catch {
    return []
  }
}

/** The config dir the launched process sees: the plan's, else the broker's own, else the default account. */
function planConfigDir(plan: LaunchPlan): string {
  if (plan.env.CLAUDE_CONFIG_DIR !== undefined) return plan.env.CLAUDE_CONFIG_DIR
  if (plan.unsetEnv?.includes('CLAUDE_CONFIG_DIR')) return defaultConfigDir()
  return process.env.CLAUDE_CONFIG_DIR ?? defaultConfigDir()
}

/** Undefined when the plan loads user settings itself; the brief follows `--` and is never read as a flag. */
function carriedUserDenies(plan: LaunchPlan): string[] | undefined {
  const end = plan.args.indexOf('--')
  const options = end === -1 ? plan.args : plan.args.slice(0, end)
  const at = options.indexOf('--setting-sources')
  if (at === -1 || (options[at + 1] ?? '').split(',').includes('user')) return undefined
  return readUserDenies(planConfigDir(plan))
}

/** An interactive plan carries no `--settings`, so the guard's file is added to its argv here. */
function withSettings(plan: LaunchPlan): LaunchPlan {
  if (plan.args.includes('--settings')) return plan
  return { ...plan, args: ['--settings', hookSettingsPath(plan.agentId), ...plan.args] }
}

function writePrivate(file: string, body: string, mode: number = FILE_MODE): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: DIR_MODE })
  fs.writeFileSync(file, body, { mode })
  // writeFileSync's mode is ignored when the file already exists, which a resume
  // makes routine rather than exotic.
  fs.chmodSync(file, mode)
}

export function writeLaunchFiles(plan: LaunchPlan, config: Record<string, unknown>): void {
  const permissionTimeout = plan.args.includes('--settings') ? resolvePermissionHookTimeout() : undefined
  const settings = buildHookSettings(cliEntry(), permissionTimeout, carriedUserDenies(plan))
  writePrivate(hookSettingsPath(plan.agentId), JSON.stringify(settings, null, 2))
  writePrivate(mcpConfigPath(plan.agentId), JSON.stringify(config, null, 2))
  writePrivate(planPath(plan.agentId), JSON.stringify(withSettings(plan), null, 2))
  writePrivate(
    relaunchScriptPath(plan.agentId),
    relaunchScript(agentChatLauncher(), plan.agentId),
    SCRIPT_MODE,
  )
  const hooksDir = hooksDirOf(plan.env)
  if (hooksDir === undefined) return
  writeGitHooks(hooksDir)
  const shimDir = plan.env[GIT_SHIM_DIR_ENV]
  if (shimDir !== undefined && !writeGitShim(shimDir, hooksDir))
    process.stderr.write(`agent-chat: git shim not written to ${shimDir}: no git on PATH\n`)
}

export function readLaunchPlan(agentId: string): LaunchPlan {
  const file = planPath(agentId)
  if (!fs.existsSync(file)) throw new Error(`no launch plan for agent ${agentId} at ${file}`)
  return readPlanFile(file)
}

export const runtimeStatePath = (agentId: string): string => path.join(agentDir(agentId), 'runtime.json')

/**
 * What a running agent HOLDS, as opposed to how it was started (CC-78).
 *
 * The plan is a recipe and is written once; this is the pane that was actually
 * opened and the worktree that was actually allocated, and it exists because
 * `Supervisor.live` is memory only. A broker restart used to take both with it,
 * which left retire unable to release a worktree or close a pane for any agent
 * spawned before the restart — a leak of exactly the shape CC-77 fixed for the
 * process.
 *
 * `exited` is deliberately absent from `handle`: it is a Promise held by the
 * process that did the launching, and it cannot survive a restart in any form.
 * Its absence is already the signal for "infer this agent's exit from presence".
 */
export interface RuntimeState {
  handle: Omit<LaunchHandle, 'exited' | 'launchFailed'>
  allocation: Allocation
  isolation: IsolationName
  anchor?: string
}

export function writeRuntimeState(agentId: string, state: RuntimeState): void {
  writePrivate(runtimeStatePath(agentId), JSON.stringify(state, null, 2))
}

/**
 * Undefined for anything unreadable, never a throw: this is a best-effort
 * fallback used when the in-memory entry is already gone, so a missing or
 * corrupt file must degrade to the old behaviour (say what could not be done)
 * rather than fail the retire that is trying to clean up.
 */
export function readRuntimeState(agentId: string): RuntimeState | undefined {
  try {
    return JSON.parse(fs.readFileSync(runtimeStatePath(agentId), 'utf8')) as RuntimeState
  } catch {
    return undefined
  }
}

/**
 * Dropped once the agent is retired, so a released allocation can never be
 * released a second time. Worktree release runs `worktree remove` and
 * `branch -D`; replaying that against a branch name a later agent has since
 * taken would destroy someone else's work.
 */
export function clearRuntimeState(agentId: string): void {
  fs.rmSync(runtimeStatePath(agentId), { force: true })
}
