import fs from 'node:fs'
import path from 'node:path'
import { agentDir } from '../paths.js'
import type { AgentProfile, LaunchPlan } from './types.js'

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
 * The MCP config a spawned agent starts with. Always contains agent-chat itself
 * — an agent that cannot reach the bus is not a peer, it is a subprocess — plus
 * whatever the profile adds.
 */
export function buildMcpConfig(profile: AgentProfile, entry: string): Record<string, unknown> {
  return {
    mcpServers: {
      'plugin:agent-chat:agent-chat': { command: process.execPath, args: [entry, 'mcp'] },
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
