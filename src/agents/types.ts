import type { SurfaceLifetime, AgentProfile } from '@titan-design/agent-protocol/wire'
export {
  SURFACE_LIFETIMES,
  EFFORT_LEVELS,
  AGENT_ROLES,
  SETTING_SOURCES,
  RETURN_CONTRACTS,
} from '@titan-design/agent-protocol/wire'
export type {
  SurfaceLifetime,
  EffortLevel,
  AgentRole,
  SettingSource,
  ReturnContract,
  AgentProfile,
} from '@titan-design/agent-protocol/wire'
import type { CarriedPermissionMode } from '../broker/host-channels.js'
import type { Subscription, SurfaceName } from '../protocol.js'

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
  /**
   * `cwdHoldsUserSettings(cwd, configDir)`: the project settings at `cwd` are an
   * account's user settings. Required, so no launch path can leave the check out.
   */
  cwdHoldsUserSettings: boolean
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
  /** CC-281: a human's own session, which no agent spawned, so it is never told to report to a spawner. */
  adopted: boolean
  /** Emit `--remote-control` on an interactive run; a print-mode run cannot use it and ignores this. */
  remoteControl?: boolean
  /** CC-951: channel targets beside agent-chat's own, carried from a teleport predecessor. */
  channels?: string[]
  /** CC-951: an interactive run's `--permission-mode`, carried from a teleport predecessor; headless stays pinned. */
  permissionMode?: CarriedPermissionMode
}

export type { CloseOutcome, LaunchHandle, LaunchPlan, Surface } from '@titan-design/agent-surface'
