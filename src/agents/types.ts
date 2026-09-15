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
   * The broker OPENED this surface, so the broker may also close it.
   *
   * Absent for a pane the broker only wrote INTO: an anchor belongs to whoever
   * was already sitting in it, and closing that from a bus any peer can reach is
   * the same thing `kill` refuses to do. Only a split, tab or window this launch
   * created sets it.
   */
  ownsSurface?: boolean
  /**
   * Resolves when the process ends. Headless ONLY, and its absence is the whole
   * asymmetry of §8.1 rather than an oversight: the broker does not own an iTerm
   * pane's process, so when a human types /exit nothing calls back into
   * agent-chat. A visible agent's exit is inferred from presence instead — a
   * detach with no reattach — which is why it can never carry an exit code.
   */
  exited?: Promise<{ code: number | null; signal: string | null }>
}

/**
 * The outcome of a teardown, and why `closed` alone was not enough (CC-95).
 *
 * A surface used to answer "did the close script run", which is a different
 * question from "is the pane gone" — and the two diverged in the wild: a close
 * logged `closed:true` at 06:16 and its pane was still sitting at a shell prompt
 * six and a half hours later. `closed` now means the surface went and looked,
 * and `reason` is what it saw when the answer is no.
 */
export interface CloseOutcome {
  closed: boolean
  reason?: string
}

export interface Surface {
  readonly name: SurfaceName
  readonly interactive: boolean
  launch(plan: LaunchPlan): Promise<LaunchHandle>
  /**
   * Tear down the surface this handle was launched on, and report whether it is
   * actually gone. A no-op unless `ownsSurface` is set — the check lives here,
   * in the only layer that knows what a pane is, so no caller can skip it.
   */
  close(handle: LaunchHandle): Promise<CloseOutcome>
}
