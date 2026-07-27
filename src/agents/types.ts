import type { IsolationName, SurfaceName } from '../protocol.js'

/**
 * A profile bundles the things that always travel together, so a spawn is one
 * noun rather than six flags.
 *
 * There is deliberately no `permissionMode` field — not `bypassPermissions`, and
 * not a milder alias for it. A profile widens a posture by naming tools, which
 * is auditable and reviewable in a diff; a mode flag widens it by category,
 * which is neither. agent-chat already refuses to let one Claude answer
 * another's permission prompt; spawning an agent that is never prompted is the
 * larger hole, not the smaller one.
 */
export interface AgentProfile {
  name: string
  description: string
  model: string
  /**
   * Passed to --allowed-tools, and THE permission lever. Declare the narrowest
   * set that actually completes the work: too wide leaks authority, too narrow
   * yields an agent that silently produces degraded output.
   */
  allowedTools: string[]
  disallowedTools?: string[]
  isolation: IsolationName
  surface: SurfaceName
  /** Appended via --append-system-prompt, after the standard peer preamble. */
  promptPrelude: string
  /** Extra MCP servers merged into the generated --mcp-config. */
  mcpServers?: Record<string, unknown>
}

/**
 * Everything `buildLaunchPlan` needs, with nothing left for it to go and find.
 * Ids, the session uuid and paths are all supplied by the caller — that is what
 * lets the builder stay pure and therefore snapshot-testable.
 */
export interface LaunchPlanInput {
  agentId: string
  /** The --session-id value, and the resume handle. Minted by the supervisor. */
  sessionId: string
  name: string
  profile: AgentProfile
  brief: string
  cwd: string
  /** Overrides `profile.surface` when the request asked for a different one. */
  surface?: SurfaceName
  mcpConfigPath: string
  /** From the isolation strategy: dirs outside cwd the agent may still read. */
  extraDirs?: string[]
  /** Propagated so a spawned agent joins the same bus rather than a default one. */
  agentChatHome?: string
  workingOn?: string
}

export interface LaunchPlan {
  agentId: string
  bin: string
  args: string[]
  cwd: string
  env: Record<string, string>
  /** Headless only: the prompt goes on stdin, never in argv. */
  stdin?: string
  title: string
  surface: SurfaceName
}

export interface LaunchHandle {
  surface: SurfaceName
  /** Headless only. */
  pid?: number
  /** iTerm session UUID, for `agent attach`. */
  paneRef?: string
}

export interface Surface {
  readonly name: SurfaceName
  readonly interactive: boolean
  launch(plan: LaunchPlan): Promise<LaunchHandle>
}
