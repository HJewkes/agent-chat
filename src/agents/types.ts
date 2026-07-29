import type { IsolationName, Subscription, SurfaceName } from '../protocol.js'

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
  /**
   * Reattach to `sessionId` instead of minting it: `--resume` rather than
   * `--session-id`. What makes a mode switch a continuation of one agent rather
   * than a second one wearing its name.
   *
   * The two surfaces diverge here, and not symmetrically. An interactive resume
   * takes NO positional prompt — the pane opens on the conversation as it stands,
   * which is the whole point when the thing to look at is a permission prompt
   * nobody could answer. A headless resume still needs one, because `-p` refuses
   * without input; the caller supplies a continuation instruction there, never
   * the original brief, which would restart the work rather than continue it.
   */
  resume?: boolean
  mcpConfigPath: string
  /** From the isolation strategy: dirs outside cwd the agent may still read. */
  extraDirs?: string[]
  /** Propagated so a spawned agent joins the same bus rather than a default one. */
  agentChatHome?: string
  workingOn?: string
  /** Tags and subscriptions the spawner chose; applied at the agent's own register. */
  tags?: string[]
  subscriptions?: Subscription[]
  /**
   * Replaces `PEER_PREAMBLE`. Teleport's descendant is not a freshly spawned
   * agent being told it outlives its spawner — it is the continuation of a
   * session that ended on purpose, and telling it the wrong story about its own
   * origin is how it ends up reporting to a predecessor that no longer exists.
   */
  preamble?: string
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
  /**
   * Resolves when the process ends. Headless ONLY, and its absence is the whole
   * asymmetry of §8.1 rather than an oversight: the broker does not own an iTerm
   * pane's process, so when a human types /exit nothing calls back into
   * agent-chat. A visible agent's exit is inferred from presence instead — a
   * detach with no reattach — which is why it can never carry an exit code.
   */
  exited?: Promise<{ code: number | null; signal: string | null }>
}

export interface Surface {
  readonly name: SurfaceName
  readonly interactive: boolean
  launch(plan: LaunchPlan): Promise<LaunchHandle>
}
