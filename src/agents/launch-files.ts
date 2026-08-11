import fs from 'node:fs'
import path from 'node:path'
import { agentDir } from '../paths.js'
import type { IsolationName } from '../protocol.js'
import type { Allocation } from './isolation/index.js'
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

export const planPath = (agentId: string): string => path.join(agentDir(agentId), 'plan.json')

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
 */
export function buildMcpConfig(profile: AgentProfile, _entry: string): Record<string, unknown> {
  return {
    mcpServers: {
      ...(profile.mcpServers ?? {}),
    },
  }
}

function writePrivate(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: DIR_MODE })
  fs.writeFileSync(file, body, { mode: FILE_MODE })
  // writeFileSync's mode is ignored when the file already exists, which a resume
  // makes routine rather than exotic.
  fs.chmodSync(file, FILE_MODE)
}

export function writeLaunchFiles(plan: LaunchPlan, config: Record<string, unknown>): void {
  writePrivate(mcpConfigPath(plan.agentId), JSON.stringify(config, null, 2))
  writePrivate(planPath(plan.agentId), JSON.stringify(plan, null, 2))
}

export function readLaunchPlan(agentId: string): LaunchPlan {
  const file = planPath(agentId)
  if (!fs.existsSync(file)) throw new Error(`no launch plan for agent ${agentId} at ${file}`)
  return JSON.parse(fs.readFileSync(file, 'utf8')) as LaunchPlan
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
  handle: Omit<LaunchHandle, 'exited'>
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
