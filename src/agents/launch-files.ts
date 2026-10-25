import fs from 'node:fs'
import path from 'node:path'
import { resolveGitShellAliases, resolvePermissionHookTimeout } from '../config.js'
import { GIT_SHIM_DIR_ENV, writeGitShim } from '../leak-guard/git-shim.js'
import { defaultScanInputs, hooksDirOf, probeScanner, writeGitHooks } from '../leak-guard/hooks-dir.js'
import { agentDir, cliEntry } from '../paths.js'
import type { IsolationName, SurfaceName } from '../protocol.js'
import { inboxSpoolDir } from '../server/inbox-spool.js'
import type { Allocation } from './isolation/index.js'
import { readLaunchPlan as readPlanFile, relaunchScript } from '@titan-design/agent-surface'
import { defaultConfigDir } from './config-dir.js'
import { agentChatLauncher, relaunchScriptPath } from './launcher.js'
import { AGENT_CHAT_PLUGIN } from './launch-plan.js'
import { strictMcpFor } from './launch-policy.js'
import type { CreatedWorktree } from './resume-session.js'
import { gitCommonDir, linkedWorktreeRoot, REPO_SKILLS_RULE, type SelfGrantPin } from './skill-self-grant.js'
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

/** Written when a teleport retires this identity; a session resumed from its transcript afterwards is stale. */
export const supersededMarkerPath = (agentId: string): string => path.join(agentDir(agentId), 'superseded')

export function markSuperseded(agentId: string): void {
  fs.mkdirSync(agentDir(agentId), { recursive: true, mode: DIR_MODE })
  fs.writeFileSync(supersededMarkerPath(agentId), '', { mode: FILE_MODE })
}

/** CC-951: a successor that never attached leaves its predecessor live, so its prompts must reach the model again. */
export function clearSuperseded(agentId: string): void {
  fs.rmSync(supersededMarkerPath(agentId), { force: true })
}

/** The hook gives up this long before Claude Code would kill it, so it can withdraw its row itself. */
const HOOK_DEADLINE_MARGIN_S = 10

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`

const hookCommand = (entry: string, verb: string): string =>
  `${shellQuote(process.execPath)} ${shellQuote(entry)} ${verb}`

/** Bash spells the bypasses; the edit tools can rewrite the hook directory or the term list. */
const PRETOOL_MATCHER = 'Bash|Edit|Write|MultiEdit|NotebookEdit'

/** Seconds. The guard reads only regular files and never waits, so a run this long is already broken. */
const PRETOOL_TIMEOUT_S = 15

const SEAT_HOOK_TIMEOUT_S = 10

const seatHookEntry = (entry: string, phase: 'pre' | 'post' | 'end', matcher?: string): HookEntry => ({
  ...(matcher === undefined ? {} : { matcher }),
  hooks: [
    { type: 'command', command: hookCommand(entry, `seat-hook ${phase}`), timeout: SEAT_HOOK_TIMEOUT_S },
  ],
})

const INBOX_HOOK_TIMEOUT_S = 10

/**
 * CC-1455: a print-mode session drops channel pushes, so its MCP server spools them and
 * this hook shows them. It runs on every tool call, so the guard uses only shell builtins
 * and execs node only when a record is waiting. The glob stays outside the quotes.
 * At Stop it blocks the turn end once (S6), since a print run otherwise exits with the
 * message unseen; only a print host's server spools, so an interactive Stop never blocks.
 */
export function inboxHookCommand(entry: string, agentId: string, phase: 'post' | 'prompt' | 'stop'): string {
  const verb = `${shellQuote(process.execPath)} ${shellQuote(entry)} inbox-hook ${shellQuote(agentId)} ${phase}`
  const block = phase === 'stop' ? ' --block' : ''
  return `for f in ${shellQuote(inboxSpoolDir(agentId))}/*.json; do [ -e "$f" ] && exec ${verb}${block}; break; done`
}

const inboxHookEntry = (entry: string, agentId: string, phase: 'post' | 'prompt' | 'stop'): HookEntry => ({
  hooks: [
    { type: 'command', command: inboxHookCommand(entry, agentId, phase), timeout: INBOX_HOOK_TIMEOUT_S },
  ],
})

/**
 * CC-1056: the block instrument. A question opens a block at PreToolUse and closes it at
 * PostToolUse; a prompt, stop or session end also closes it, since an interrupted question
 * fires no PostToolUse. Only spawned agents get these, so a plain session pays nothing.
 */
function seatHooks(
  entry: string,
  staleGuard: { UserPromptSubmit?: HookEntry[] },
  agentId?: string,
): Record<string, HookEntry[]> {
  const inbox = (phase: 'post' | 'prompt' | 'stop'): HookEntry[] =>
    agentId === undefined ? [] : [inboxHookEntry(entry, agentId, phase)]
  return {
    PostToolUse: [seatHookEntry(entry, 'post', 'AskUserQuestion'), ...inbox('post')],
    UserPromptSubmit: [
      ...(staleGuard.UserPromptSubmit ?? []),
      ...inbox('prompt'),
      seatHookEntry(entry, 'end'),
    ],
    Stop: [seatHookEntry(entry, 'end'), ...inbox('stop')],
    SessionEnd: [seatHookEntry(entry, 'end')],
  }
}

/**
 * What a launch without the user settings source still takes from that account. Its deny
 * rules only narrow, so dropping them would hand a worker tools the owner denied everywhere
 * (observed: Agent and SendMessage came back under `--setting-sources project,local`). The
 * git-safety hook only blocks, so it travels too. No other user hook does: a hook is a
 * shell command, and one that is not a known guard could widen what a worker does.
 */
export interface CarriedUserSettings {
  denies: string[]
  /** The user PreToolUse entries, cut down to their git-safety commands. */
  pretool: HookEntry[]
}

interface HookEntry {
  matcher?: string
  hooks: Record<string, unknown>[]
}

/** The user file is also where the bus plugin is enabled, so the launch enables it here. */
const withoutUserSettings = (denies: string[]): Record<string, unknown> => ({
  enabledPlugins: { [AGENT_CHAT_PLUGIN]: true },
  ...(denies.length === 0 ? {} : { permissions: { deny: denies } }),
})

/**
 * The `--settings` file every spawned agent runs with. The leak guard's PreToolUse hook
 * (CC-270) goes to all of them. A print-mode run, given `permissionTimeoutSeconds`, also
 * gets the PermissionRequest hook (CC-144) that files each prompt in the human queue and
 * blocks for the verdict. Claude Code runs hook commands through a shell, and both paths
 * can contain spaces. `carried` is set for a launch that loads no user settings.
 * `selfGrant` lets the hook allow repo skill writes in that worktree (CC-694) while the
 * root and common dir still match the pin (CC-1200).
 */
export function buildHookSettings(
  entry: string,
  permissionTimeoutSeconds?: number,
  carried?: CarriedUserSettings,
  agentId?: string,
  selfGrant?: SelfGrantPin,
): Record<string, unknown> {
  const staleGuard: { UserPromptSubmit?: HookEntry[] } =
    agentId === undefined
      ? {}
      : {
          UserPromptSubmit: [
            {
              hooks: [
                {
                  type: 'command',
                  command: hookCommand(entry, `stale-session-guard ${shellQuote(agentId)}`),
                  timeout: PRETOOL_TIMEOUT_S,
                },
              ],
            },
          ],
        }
  const pretool = [
    {
      matcher: PRETOOL_MATCHER,
      hooks: [
        { type: 'command', command: hookCommand(entry, 'leak-guard pretool'), timeout: PRETOOL_TIMEOUT_S },
      ],
    },
    ...(carried?.pretool ?? []),
    seatHookEntry(entry, 'pre'),
  ]
  const account = carried === undefined ? {} : withoutUserSettings(carried.denies)
  if (permissionTimeoutSeconds === undefined)
    return { ...account, hooks: { PreToolUse: pretool, ...seatHooks(entry, staleGuard, agentId) } }
  const deadline = Math.max(1, permissionTimeoutSeconds - HOOK_DEADLINE_MARGIN_S)
  const pinArgs =
    selfGrant === undefined
      ? ''
      : ` --self-grant-skills ${shellQuote(selfGrant.root)} --self-grant-common-dir ${shellQuote(selfGrant.commonDir)}`
  const command = hookCommand(entry, `permission-hook --deadline ${deadline}${pinArgs}`)
  return {
    ...account,
    hooks: {
      PreToolUse: pretool,
      ...seatHooks(entry, staleGuard, agentId),
      PermissionRequest: [
        { matcher: '*', hooks: [{ type: 'command', command, timeout: permissionTimeoutSeconds }] },
      ],
    },
  }
}

/**
 * The owner's git-safety hook: the command's script, run directly or by `node` (bare or an
 * absolute path such as /usr/bin/node), ends in this path. A quoted path may hold spaces; a
 * double-quoted one holds no backtick or parenthesis, so no command substitution rides along.
 */
const GIT_SAFETY_SCRIPT = String.raw`\/git-safety\/git-safety\.mjs`
const GIT_SAFETY_COMMAND = new RegExp(
  String.raw`^(?:(?:\/[^\s"']*\/)?node\s+)?` +
    String.raw`(?:"[^"\x60()]*${GIT_SAFETY_SCRIPT}"|'[^']*${GIT_SAFETY_SCRIPT}'|[^\s"']*${GIT_SAFETY_SCRIPT})` +
    String.raw`(?:\s|$)`,
)

const commandOf = (hook: unknown): string | undefined => {
  const command =
    typeof hook === 'object' && hook !== null ? (hook as { command?: unknown }).command : undefined
  return typeof command === 'string' ? command : undefined
}

const isGitSafety = (hook: unknown): hook is Record<string, unknown> =>
  commandOf(hook)?.match(GIT_SAFETY_COMMAND) != null

/** A command naming the script in a form the match does not take would drop git-safety unseen. */
function warnUncarried(hook: unknown): void {
  const command = commandOf(hook)
  if (command === undefined || !command.includes('git-safety.mjs') || isGitSafety(hook)) return
  process.stderr.write(
    `agent-chat: git-safety hook not carried into a worker launch, unrecognised form: ${command}\n`,
  )
}

/** Each user PreToolUse entry with only its git-safety commands, and no entry that has none. */
function gitSafetyEntries(pretool: unknown): HookEntry[] {
  if (!Array.isArray(pretool)) return []
  return pretool.flatMap((entry: { matcher?: unknown; hooks?: unknown } | null) => {
    if (Array.isArray(entry?.hooks)) entry.hooks.forEach(warnUncarried)
    const hooks = Array.isArray(entry?.hooks) ? entry.hooks.filter(isGitSafety) : []
    if (hooks.length === 0) return []
    return [{ ...(typeof entry?.matcher === 'string' ? { matcher: entry.matcher } : {}), hooks }]
  })
}

/** Read from an account's own settings file. An unreadable file carries nothing, as Claude Code reads it. */
export function readCarriedUserSettings(configDir: string): CarriedUserSettings {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(configDir, 'settings.json'), 'utf8')) as {
      permissions?: { deny?: unknown }
      hooks?: { PreToolUse?: unknown }
    }
    const deny = parsed.permissions?.deny
    return {
      denies: Array.isArray(deny) ? deny.filter((rule): rule is string => typeof rule === 'string') : [],
      pretool: gitSafetyEntries(parsed.hooks?.PreToolUse),
    }
  } catch {
    return { denies: [], pretool: [] }
  }
}

/** The config dir the launched process sees: the plan's, else the broker's own, else the default account. */
function planConfigDir(plan: LaunchPlan): string {
  if (plan.env.CLAUDE_CONFIG_DIR !== undefined) return plan.env.CLAUDE_CONFIG_DIR
  if (plan.unsetEnv?.includes('CLAUDE_CONFIG_DIR')) return defaultConfigDir()
  return process.env.CLAUDE_CONFIG_DIR ?? defaultConfigDir()
}

/** Undefined when the plan loads user settings itself; the brief follows `--` and is never read as a flag. */
function carriedUserSettings(plan: LaunchPlan): CarriedUserSettings | undefined {
  const end = plan.args.indexOf('--')
  const options = end === -1 ? plan.args : plan.args.slice(0, end)
  const at = options.indexOf('--setting-sources')
  if (at === -1 || (options[at + 1] ?? '').split(',').includes('user')) return undefined
  return readCarriedUserSettings(planConfigDir(plan))
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

/**
 * The worktree whose repo skills the hook may allow writes to: the plan's cwd, only when
 * the profile opted in with the owner-approved rule, the cwd is the worktree the broker
 * recorded agent-chat creating for this agent, and git still has that registered as a
 * linked worktree of the recorded repository. A shared or main checkout stays behind the
 * owner prompt (CC-694), and so does a hand-written common dir at the cwd, or one swapped
 * in behind a symlink at the recorded path: git checks its layout, not who made it (CC-1110).
 * The pin carries the root and the repository's common dir, which the hook rechecks on
 * every call (CC-1200).
 */
export function selfGrantPinOf(plan: LaunchPlan, created?: CreatedWorktree): SelfGrantPin | undefined {
  const end = plan.args.indexOf('--')
  const options = end === -1 ? plan.args : plan.args.slice(0, end)
  const at = options.indexOf('--allowed-tools')
  if (at === -1 || !(options[at + 1] ?? '').split(',').includes(REPO_SKILLS_RULE)) return undefined
  if (created === undefined) return undefined
  const cwd = path.resolve(plan.cwd)
  if (cwd !== path.resolve(created.worktree) || realpathOrUndefined(cwd) !== cwd) return undefined
  const root = linkedWorktreeRoot(cwd)
  const repoGitDir = realpathOrUndefined(path.join(created.gitRoot, '.git'))
  if (root === undefined || repoGitDir === undefined) return undefined
  return gitCommonDir(root) === repoGitDir ? { root, commonDir: repoGitDir } : undefined
}

function realpathOrUndefined(dir: string): string | undefined {
  try {
    return fs.realpathSync(dir)
  } catch {
    return undefined
  }
}

export function writeLaunchFiles(
  plan: LaunchPlan,
  config: Record<string, unknown>,
  createdWorktree?: CreatedWorktree,
): void {
  const permissionTimeout = plan.args.includes('--settings') ? resolvePermissionHookTimeout() : undefined
  const settings = buildHookSettings(
    cliEntry(),
    permissionTimeout,
    carriedUserSettings(plan),
    plan.agentId,
    selfGrantPinOf(plan, createdWorktree),
  )
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
  writeGitHooks(hooksDir, { ...defaultScanInputs(), probe: probeScanner })
  const shimDir = plan.env[GIT_SHIM_DIR_ENV]
  if (
    shimDir !== undefined &&
    !writeGitShim(shimDir, hooksDir, process.env.PATH ?? '', resolveGitShellAliases())
  )
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
