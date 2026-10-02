import type { IsolationName, Subscription, SurfaceName } from '../protocol.js'

/**
 * What happens to an agent's pane when the agent itself ends (CC-95).
 *
 * A PROFILE decision, and that is the whole point of it being a field rather
 * than a rule. The human settled it that way after both global answers had been
 * tried and both were wrong for somebody: retire-only left four finished agents'
 * panes sitting at `-zsh` for six and a half hours, and close-on-exit throws
 * away the last output of a collaborator someone was reading.
 *
 * In their words: "it should be part of the profile for launching items. We
 * might be launching totally new agents - new window, independent of session.
 * Might be subagents, new pane to the right, closes when the session in the pane
 * closes." The lifetime of the surface follows what KIND of thing was launched.
 *
 * `keep` is not "leaks a pane": retire still closes it, as it always has. It
 * means the agent's own death is not what triggers that.
 */
export const SURFACE_LIFETIMES = ['close-on-exit', 'keep'] as const

export type SurfaceLifetime = (typeof SURFACE_LIFETIMES)[number]

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

export type EffortLevel = (typeof EFFORT_LEVELS)[number]

/**
 * The default for a profile that does not say, and for every profile file
 * written before the field existed.
 *
 * `keep`, deliberately: it is the behaviour those profiles were authored
 * against, and a silent upgrade to close-on-exit would start destroying panes
 * belonging to agents nobody opted in for. The builtins opt in explicitly.
 */
export const DEFAULT_SURFACE_LIFETIME: SurfaceLifetime = 'keep'

/**
 * CC-163: what an agent is allowed to do with the bus beyond its own work.
 * A coordinator may spawn agents and run with Remote Control; a worker may
 * do neither and reports needs to its spawner instead.
 */
export const AGENT_ROLES = ['coordinator', 'worker'] as const

export type AgentRole = (typeof AGENT_ROLES)[number]

/** CC-286: the report rules the broker appends to a spawned agent's brief. */
export const RETURN_CONTRACTS = ['implementer', 'reviewer'] as const

export type ReturnContract = (typeof RETURN_CONTRACTS)[number]

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
  /**
   * Whether this kind of agent's pane goes with it when it ends. Inert for a
   * headless profile, which has no surface to close. See {@link SurfaceLifetime}.
   */
  surfaceLifetime?: SurfaceLifetime
  /** Absent means `worker`: spawning and Remote Control are opted into, never granted by omission. */
  role?: AgentRole
  /** Absent means the contract is inferred from the name and grants; `none` opts out. */
  returnContract?: ReturnContract | 'none'
  /** Passed as --effort when set; unset leaves the harness default. */
  effort?: EffortLevel
  /** Appended via --append-system-prompt, after the standard peer preamble. */
  promptPrelude: string
  /** Extra MCP servers merged into the generated --mcp-config. */
  mcpServers?: Record<string, unknown>
  /** Load only the generated --mcp-config, dropping user-scope and plugin MCP servers. */
  strictMcpConfig?: boolean
  /** Drop every skill and slash command, which otherwise load into each turn. */
  disableSlashCommands?: boolean
  /** Extra environment for the launched process. Never overrides AGENT_CHAT_* or CLAUDE_CONFIG_DIR. */
  env?: Record<string, string>
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
  /**
   * A turn to hand the resumed conversation, for the caller that has something
   * to SAY rather than something to look at (R-59). Ignored unless `resume` is
   * true; the same session id is reused, so the turn lands in the existing
   * transcript rather than a `--fork-session` copy.
   *
   * It makes the interactive resume print-and-exit rather than open on the
   * conversation — `-p` is what delivers the message — which is the point: this
   * is for driving an agent that nobody is watching a pane for. Leave it unset
   * for the surfacing case, where the pane IS the deliverable.
   */
  resumeMessage?: string
  /**
   * CC-44: an absolute path to the transcript this agent's conversation starts
   * as a COPY of, rather than starting empty. Mutually exclusive with `resume` —
   * a fork mints `sessionId` instead of reattaching to it, so the inherited
   * conversation is branched and the original is never written to.
   *
   * A path, not a session id, because `--resume` accepts either and only the path
   * form works from a cwd that is not the transcript's own project directory —
   * which is exactly where a forked agent lives.
   *
   * What it does NOT buy, since the name invites the assumption: this is still a
   * separate process paying its own input tokens. The built-in `fork` subagent's
   * shared prompt cache does not transfer. And a transcript holds only COMPLETED
   * turns, so the fork cannot see the turn its parent is part way through.
   */
  forkFrom?: string
  mcpConfigPath: string
  /** The PermissionRequest hook's `--settings` file, passed only to a print-mode run (CC-144). */
  hookSettingsPath?: string
  /** From the isolation strategy: dirs outside cwd the agent may still read. */
  extraDirs?: string[]
  /** Propagated so a spawned agent joins the same bus rather than a default one. */
  agentChatHome?: string
  /** The leak guard's hooks dir, set as the agent's `core.hooksPath` through `GIT_CONFIG_*` (CC-268). */
  gitHooksDir?: string
  /**
   * The resolved `CLAUDE_CONFIG_DIR` — the Claude ACCOUNT this agent runs on
   * (CC-100). Resolved by the supervisor from `config-dir.ts`'s precedence, never
   * left to the broker's own environment, which is an accident of which session
   * autostarted the daemon.
   */
  configDir?: string
  /** CC-200: run with `CLAUDE_CONFIG_DIR` deleted, mirroring a default-account spawner; wins over `configDir`. */
  configDirUnset?: boolean
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
  /** Emit `--remote-control` on an interactive run; a print-mode run cannot use it and ignores this. */
  remoteControl?: boolean
}

export type { CloseOutcome, LaunchHandle, LaunchPlan, Surface } from '@titan-design/agent-surface'
