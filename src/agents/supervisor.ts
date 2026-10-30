import { brokerHost, isLocalHost, signalSessionPid } from '../broker/host-guard.js'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { BrokerCore } from '../broker/core.js'
import type { IdentityBinding } from '../broker/registry.js'
import type { ArgvReader } from '../broker/host-channels.js'
import { INTEGRITY_CLEARED, newMsgId } from '../broker/event-log.js'
import {
  HUMAN_ROOT,
  type AdmitRequest,
  type IntegrityLedger,
  type Parent,
  type Verdict,
} from '../broker/integrity-ledger.js'
import type { IntegrityCall, NoteWouldDeny } from '../broker/integrity-shadow.js'
import { latchReason, readmitRecorder, type ReadmitRecord } from '../broker/integrity-readmit.js'
import {
  encode,
  HUMAN,
  RESERVED_NAMES,
  type AgentCostEstimate,
  type AgentCosts,
  type AgentIdentity,
  type ExperimentArm,
  type IsolationName,
  type Launcher,
  type RemoteLaunch,
  type Subscription,
  type SurfaceName,
  type WakeSource,
} from '../protocol.js'
import {
  BACKGROUNDED_BRIEF,
  checkBackgroundable,
  checkSurfaceable,
  placementFor,
  SURFACED_NOTICE,
  type SwitchOutcome,
} from './mode-switch.js'
import { AGENT_CHAT_TOOLS, buildLaunchPlan, PEER_PREAMBLE, permModeFor } from './launch-plan.js'
import { cwdHoldsUserSettings } from './launch-policy.js'
import { lintBrief, mentionsSyntheticData, type BriefLint, type RepoVisibility } from './brief-lint.js'
import {
  buildMcpConfig,
  clearRuntimeState,
  clearSuperseded,
  hookSettingsPath,
  mcpConfigPath,
  readRuntimeState,
  markSuperseded,
  OFF_BROKER,
  survivingLaunch,
  writeLaunchFiles,
  writeRuntimeState,
} from './launch-files.js'
import {
  agentLiveness,
  awaitsExit,
  DetachedReaper,
  hostProbe,
  isStaleLive,
  batchProbe,
  launcherPid,
  remoteHostOf,
  staleAtStart,
  type DeadLiveness,
  type ProcessProbe,
} from './detached-reap.js'
import { ledgerParentOf, spawnRowIndex, survivorRoot, type SurvivorRoot } from './survivor-root.js'
import { HARNESS_UNSUPPORTED, harnessRefusal, loadProfileSource, recordedRole, roleOf } from './profiles.js'
import { loadSeatPolicy, seatPolicyPath } from './seat-policy.js'
import {
  ceilingDriftRefusal,
  ceilingRefusal,
  policySeat,
  seatRootGap,
  seatRootOf,
  startsSeatRoot,
  type SeatClaim,
} from './seat-root.js'
import {
  refusalOf,
  resolve as resolveIsolation,
  type Allocation,
  type IsolationContext,
  type ReleaseOptions,
} from './isolation/index.js'
import {
  SurfaceRefused,
  itermSessionPresent,
  tmuxWindowPresent,
  loginGap,
  readOutputTail,
  type SurfaceOptions,
} from '@titan-design/agent-surface'
import { defaultSpawnSurface, resolveSurface, surfaceBlockerFor } from './surface-resolution.js'
import { psLauncherProbe, relaunchScriptPath, surfaceFor, type LauncherProbe } from './launcher.js'
import { Semaphore, type SlotUsage } from './semaphore.js'
import {
  countLiveHeadless,
  machineDecision,
  type MachineDecision,
  type MachineRefusalCode,
  type CpuPressureReading,
  type MachineLimits,
  type MemoryReading,
} from './machine-guard.js'
import type { HeadroomReadings } from './host-headroom.js'
import { canonicalPath, checkSpawnCwd, isAtOrUnder, lexicalCwdRefusal } from './spawn-cwd.js'
import {
  callerHomeFor,
  remoteScopeRefusal,
  remoteSurface,
  RemoteSpawns,
  REPORT_WINDOW_MS,
  spawnSiteFor,
  type ReportReply,
  type RemoteSpawnRecord,
  type SpawnSite,
} from './remote-spawn.js'
import {
  HOST_RESUME_TIMEOUT_MS,
  localCopyWarning,
  probeTranscript,
  remoteResumeRefusal,
  resumeLaunchFor,
  resumeRouteFor,
  type LauncherRoute,
  type RemoteResumeSite,
  type ResumeRoute,
} from './remote-resume.js'
import { isReviewerSpawn, primaryCheckoutOf } from './reviewer-tree.js'
import {
  REVIEWER_TREE_CHANGED,
  reviewerDirtyText,
  treeChange,
  treeFingerprint,
  type TreeFingerprint,
} from './reviewer-tree-guard.js'
import {
  REVIEWER_ACCOUNT_LIMIT,
  reviewerAccountGate,
  type ReviewerAccountRead,
} from './reviewer-account-gate.js'
import { activeWorkRoot, resolveSpawnBriefing, type BriefingResult } from './active-work.js'
import { withLinkedDirs } from './linked-dirs.js'
import { crossingBriefPaths } from './brief-paths.js'
import { childConfigDir, defaultConfigDir, resolveConfigDir, type ConfigDirResolution } from './config-dir.js'
import { pickAccount, rotationText, type RotationConfig, type RotationRecord } from './account-rotation.js'
import { chooseAccount, LEAST_USED, remoteAccountDir, type AccountChoice } from './account-request.js'
import type { AccountUsage } from './account-budget.js'
import { configDir, findTranscript } from './transcript.js'
import { resolvePredecessor, type PredecessorResult } from './predecessor.js'
import { contractOf, withReturnContract } from './return-contract.js'
import {
  checkResumeSession,
  allocationRecord,
  createdWorktreeFor,
  type CreatedWorktree,
  goneWorktree,
  identityBlocker,
  identityTranscript,
  missingAgent,
  RESUMED_BRIEF,
  resumeBlocker,
  retiredWorktree,
  type TranscriptVerdict,
} from './resume-session.js'
import { recreateWorktree, treeHoldersOf, type WorktreeRecord } from './isolation/worktree.js'
import {
  allocatedWorktree,
  lsofCwds,
  parkBlocker,
  parkWorktree,
  type CwdLister,
  type ParkTarget,
} from './isolation/park.js'
import {
  retireFinished,
  type FinishedRetireOutcome,
  type FinishedRetirePort,
  type NamePresence,
  type RetireScope,
} from './isolation/retire-finished.js'
import type { MergedPr } from './isolation/merged-pr.js'
import { readPrState } from './isolation/pr-state.js'
import { retireAtReport, type ReportRetirePort } from './isolation/retire-at-report.js'
import {
  MERGED_RETIRE_EVERY_MS,
  passPrReads,
  retireMerged,
  startMergedRetireSweep,
  type PrRead,
} from './isolation/retire-merged.js'
import { parkReviewerAtReport, type ReviewerParkPort } from './isolation/park-reviewer-at-report.js'
import { parkImplementerAtExit, type ImplementerParkPort } from './isolation/park-implementer-at-exit.js'
import { fixRoundBlocker, type ShepherdSkipPort } from './isolation/shepherd-skip.js'
import { findGitRoot } from '../git.js'
import {
  predictedCostDecision,
  SpawnSlots,
  type AdmissionDecision,
  type AdmissionLimits,
  type AdmissionRefusalCode,
  type CpuPressure,
} from './spawn-admission.js'
import {
  FOOTPRINT_INTERVAL_MS,
  FootprintSampler,
  footprintMeta,
  footprintTargets,
  startFootprintSampling,
} from './agent-footprint.js'
import { CostTable, exitFootprints } from './agent-cost.js'
import {
  CRASH_LOOP,
  CRASH_LOOP_REFUSAL,
  crashLoopNotice,
  crashLoopRefusal,
  crashStreak,
  isAutomaticRelaunch,
  stderrTail,
  type CrashLoopLimits,
} from './crash-loop.js'
import { canonicalRootOf, gitRootOf, isTrusted, trustGap } from './trust.js'
import { launchedByBroker, stoppedAt } from './identity.js'
import { inheritedProfile } from './teleport-config.js'
import { agentDir, cliEntry, gitHooksDir, home, profilesDir } from '../paths.js'
import { logEvent } from '../broker/log.js'
import { DrainState } from '../broker/drain.js'
import { resolveCoordinatorGrantableTools, resolveCrashLoop, resolveProfileDriftMode } from '../config.js'
import { knownMachineAliases } from './machine-registry.js'
import { ProfileBaseline, type ProfileDriftMode } from './profile-baseline.js'
import { runHooks, type HookEvent, type HookSpawnFn } from './hooks.js'
import type { SeatJournal } from './seats/journal.js'
import { watchSeatFollow } from './seat-follow.js'
import type { SeatDispatchLog, SpawnFacts } from './seats/dispatch-log.js'
import type { SeatSpawnRead, SeatSpawnRequest } from './seats/spawn-gate-read.js'
import {
  SEAT_BUDGET_STOP,
  SEAT_HAND_RESERVE,
  SEAT_SPAWN_OVERLAP,
  SEAT_SPAWN_UNPREFIXED,
  handReserveOverflow,
  seatSpawnGate,
  spawnOverlap,
  unprefixedSeatSpawn,
  type SeatBudgetRefusalCode,
  type SeatHandReserveRefusalCode,
  type SeatOverlapRefusalCode,
  type SeatSpawnMode,
  type SeatUnprefixedRefusalCode,
} from './seats/spawn-gate.js'
import type {
  HandReserveFacts,
  OverlapFacts,
  OverlapRequest,
  SpawnerSeatFacts,
} from './seats/spawn-gate-read.js'
import type { RetireSpend } from './seats/dispatch-record.js'
import { branchHead, retireOutcomeOf } from './seats/retire-outcome.js'
import {
  assignmentMeta,
  assignmentRefusal,
  fixRoundRoot,
  inferWorkRole,
  spawnProvenance,
  worktreeProvenance,
} from './spawn-provenance.js'
import {
  homeClosedRefusal,
  poolPickText,
  routePool,
  type PoolPickRead,
  type PoolPickRecord,
  type PoolPickRequest,
  type PoolRoute,
} from './seats/pool-route.js'
import type { PoolPickMode } from './seats/pool-pick.js'
import { readTranscriptSpend, type TranscriptSpendRead } from './transcript-spend.js'
import { finalAssistantText } from './turns.js'
import { completionPayload, type CompletionPayload, type ExitFacts } from './worker-facts.js'
import type { ShadowLedger } from './ledger/shadow-ledger.js'
import { exitTerminal, LifecycleShadow } from './ledger/lifecycle-shadow.js'
import { readExitTail, unreportedExitText, UNREPORTED_EXIT, type ExitTail } from './exit-report.js'
import {
  BACKGROUND_RESUME,
  BACKGROUND_RESUME_MESSAGE,
  backgroundResumeDecision,
  resumedForBackground,
} from './background-resume.js'
import {
  IDLE_PRINT_WAKE,
  IDLE_PRINT_WAKE_EVERY_MS,
  idlePrintWakeDue,
  idlePrintWakePrompt,
  oldestSpooledAt,
  readTurnEnded,
} from './idle-print-wake.js'
import { drainInbox, releaseClaims } from '../inbox-spool/drain.js'
import { inboxSpoolDir } from '../server/inbox-spool.js'
import { returnClaims } from '../codex/supervisor.js'
import { loadResolvedConfig } from './burndown/settings-store.js'
import { handSpawnRoles } from './burndown/seat-plan.js'
import type { SeatTeleportDeps } from './seats/teleport-state.js'
import { defaultAutonomyRoot } from './seats/io.js'
import {
  isAdoptedSuccessor,
  SuccessorNotStarted,
  Teleport,
  type InheritedIsolation,
  type LandFailedReply,
  type RelaunchInput,
  type RemoteLaunchReport,
  type RemotePlanReply,
  type TeleportHost,
  type TeleportOutcome,
  type TeleportRequest,
  type TeleportSubject,
  type LauncherSite,
} from './teleport.js'
import {
  accountMoveRefusal,
  realAccountMoves,
  type AccountMoveRequest,
  type AccountMoves,
} from './teleport-account.js'
import {
  DEFAULT_SURFACE_LIFETIME,
  type AgentProfile,
  type AgentRole,
  type LaunchHandle,
  type LaunchPlan,
  type SurfaceLifetime,
} from './types.js'

/**
 * Spawn, supervise and retire agents. Runs inside the BROKER, never inside a
 * requesting session, and that placement carries the whole feature:
 *
 * - the broker outlives every session, so an agent is not orphaned when whoever
 *   asked for it exits — which is the point of agent teams;
 * - `core.append` is the single write path, and a spawn writes 2-4 rows;
 * - the semaphore and depth cap need exactly one enforcement point, because
 *   per-session enforcement is not enforcement.
 */

/**
 * How long a detached agent has to come back before its exit is inferred.
 *
 * Visible surfaces give no exit signal at all — the broker does not own the
 * pane's process — so a detach with no reattach is the only evidence there is.
 * It must clear the client's reconnect ladder, whose worst case is 8.85s, by
 * enough that a slow machine is not declared dead.
 */
export const SETTLE_MS = 30_000

/**
 * How long a spawn waits for its agent to register before calling the launch a
 * failure (CC-95).
 *
 * The number this replaces was infinity. `agent_spawn` returned "Spawned" as
 * soon as AppleScript had written a command line into a pane, which says nothing
 * about whether Claude Code then started: one agent sat in `starting` with no
 * transcript for six and a half hours, and nothing anywhere surfaced it.
 *
 * 30s is the bound, and it is generous on purpose. What has to fit inside it is
 * a cold Claude Code start plus its MCP servers coming up far enough to call
 * `register` — seconds on a quiet machine, and this is rarely a quiet machine.
 * Waiting too long costs a coordinator one slow tool call; not waiting at all
 * cost six hours of a worktree slot and a coordinator that believed it had help.
 *
 * NOTHING BLOCKS THE BROKER HERE. This is a timer and a promise, so the event
 * loop stays free for every other session while it runs; the only thing held is
 * the ONE requester's reply, which is the entire point.
 */
export const ATTACH_TIMEOUT_MS = 30_000

/**
 * How long a VISIBLE spawn still starting at the attach window keeps its pane
 * before it is recorded as failed (CC-124).
 *
 * The 30s window stays the point at which `agent_spawn` answers; this is how
 * long the answer "still starting" is allowed to stay true. An iterm-pane agent
 * into a trusted directory registered 10m18s after launch, and the two spawned
 * beside it lost their panes at 30s to a prompt nobody could see to answer.
 */
export const ATTACH_CEILING_MS = 10 * 60_000

/**
 * CC-163: the longest coordinator-to-coordinator chain. Without a cap an agent
 * team is a fork bomb with a model picking the branching factor; workers cannot
 * spawn at all, so only coordinator links need counting.
 */
export const MAX_COORDINATOR_DEPTH = 3

/** How long a process gets to exit on SIGTERM before the ladder reaches SIGKILL. */
const KILL_GRACE_MS = 3000

/**
 * CC-455: a headless launcher starts detached, so it leads a process group that claude shares.
 * SIGKILL to the launcher's pid alone left a claude that ignored SIGTERM running with no parent.
 */
function killLauncherGroup(pid: number): void {
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, 'SIGKILL')
      return
    } catch {
      // No such group, or the process exited on the polite signal, which is the good case.
    }
  }
}

/** How long to wait for a stopped agent's socket to go before reclaiming its name. */
const NAME_FREE_TIMEOUT_MS = 8_000
const NAME_FREE_POLL_MS = 100

/**
 * CC-1468: how long a resume waits on a park of its tree before refusing. A resume answers on
 * `spawn_result`, whose client ceiling is 60s, and the launch after the wait can take the 30s
 * attach window, so this leaves the launch its time inside that ceiling.
 */
const PARK_WAIT_MS = 20_000

/** CC-402: the pause before a teleport successor's one relaunch retry, so a surface that just failed can come back. */
export const RELAUNCH_RETRY_MS = 10_000

/** CC-118: the cancellation reason a surface switch writes for the process it stops. */
const MODE_SWITCH = 'mode switch'

/**
 * Did this descendant land in the very pane its predecessor was closing, and was
 * that pane one the broker opened?
 *
 * The subtle half of CC-37. A teleport reuses the predecessor's own session, so
 * the launch itself cannot tell whether the broker created it — that fact may be
 * several generations old. Carrying it forward is what stops an agent that has
 * teleported once ending up in a pane nothing is ever allowed to close; matching
 * on the pane ref is what stops it being carried when the descendant fell back to
 * a fresh window, or when the predecessor was sitting in a human's own pane.
 */
const succeedsInto = (handle: LaunchHandle, predecessor: LaunchHandle | undefined): boolean =>
  predecessor?.ownsSurface === true && handle.paneRef !== undefined && handle.paneRef === predecessor.paneRef

/** What a teleport successor's launch and its one retry share (CC-402). */
interface SuccessorLaunch {
  input: RelaunchInput
  plan: LaunchPlan
  sessionId: string
  predecessor: Live | undefined
  allocation: Allocation
  isolation: IsolationName
}

/** Why a teleport successor's retry did not launch; `tell` when the human must hear of it. */
interface RetryRefusal {
  reason: string
  tell: boolean
}

const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** CC-1453: who holds a name lease and in what state, so a refusal never calls an exited row live. */
const describeHolder = (holder: AgentIdentity): string => {
  const since = new Date(stoppedAt(holder) ?? holder.lastEventAt).toISOString()
  return `${holder.agentId} (${holder.state} since ${since}, spawned by ${holder.spawnedBy})`
}

/**
 * A mode switch, resolved by the socket layer before it reaches here.
 *
 * `hostPid` is present only for backgrounding, where it comes from the caller's
 * OWN registry entry — which is what makes "background someone else" impossible
 * rather than merely refused. Surfacing does not need it: the broker owns the
 * headless child it is about to stop.
 */
export interface SwitchRequest {
  name: string
  to: 'headless' | 'interactive'
  requestedBy: string
  /** The requester's own pane. Decides same-window placement; absent is not an error. */
  anchor?: string
  hostPid?: number
  /** The machine `hostPid` lives on (CC-880). */
  host?: string
  /** CC-225: the requester's own agent id, resolved by the broker from its connection. */
  requesterAgentId?: string
  /** CC-1614: how that id was bound to the connection. */
  requesterBinding?: IdentityBinding
}

type AttachOutcome =
  | { kind: 'attached' | 'timeout' }
  | { kind: 'exited'; code: number | null }
  | { kind: 'launch_failed'; reason: string }

/** CC-158: when a failed spawn's isolation may be released, by the evidence that its process is gone. */
type FailedRelease = 'now' | 'if-pane-closed' | 'keep'

/** What the attach window concluded: up, dead, or a visible agent still starting in a pane that exists. */
type AttachVerdict =
  | { kind: 'attached' }
  | { kind: 'failed'; reason: string; release: FailedRelease }
  | { kind: 'pending'; warning: string }

/**
 * What `spawn` worked out before committing a slot, handed to `launch` as one
 * noun rather than three trailing optionals.
 */
/** CC-126: an existing conversation to continue; CC-140: with the removed worktree it ran in. */
interface ResumedSession {
  sessionId: string
  path: string
  reattach?: WorktreeRecord
}

/** Who is asking for a spawn, as its own `agent_spawned` row recorded it. */
interface Requester {
  role: AgentRole
  /** Coordinator links above the requester; a human-started root is 0. */
  coordinatorDepth: number
  profile: string
  /** CC-1615: the policy seat the requester holds, which makes it a root under that seat's ceiling. */
  seat?: string
}

/** Where a new agent sits: its spawn-tree depth and its coordinator depth. */
interface Lineage {
  depth: number
  coordinatorDepth: number
  /** CC-1615: the root seat whose ceiling admitted this spawn, recorded as `seat_ceiling`. */
  seat?: string
}

interface Resolved {
  /** CC-100: the account, already validated. Never absent — there is always an answer. */
  account: Account
  briefing?: { text: string; slug: string }
  fork?: { path: string; sessionId: string }
  /** CC-126: an existing conversation to continue, its transcript already checked. */
  resumed?: ResumedSession
  /** CC-133: the rendered section on the agent this one takes over from. */
  predecessor?: string
  /** CC-118: the shadow execution this launch belongs to, when the ledger is on. */
  executionId?: string
  /** CC-451: tools granted past the escalation check by the coordinator exemption. */
  exempted?: string[]
  /** CC-1654: scoped tools admitted because the parent holds their bare name. */
  covered?: string[]
}

/** CC-1059: a spawn the requester launches on its own host. */
type RemoteSite = Extract<SpawnSite, { site: 'caller' }>

type SeatRefusalCause = { code: typeof SEAT_BUDGET_STOP | typeof REVIEWER_ACCOUNT_LIMIT; retryable: boolean }

/** What a remote spawn's gates settled: everything but its account and id. */
interface RemoteGated {
  site: RemoteSite
  surface: SurfaceName
  isolation: IsolationName
  cwd: string
  /** The requester's home, which its cwd and account are held under. */
  home: string
  /** The caller's brief with its return contract and isolation note, before any briefing. */
  brief: string
  warnings: string[]
  exempted: string[]
  covered: string[]
}

interface RemoteDraft extends RemoteGated {
  agentId: string
  account: Account
  injected: { slug: string; text: string } | undefined
}

const ACCOUNT_TWICE = 'account and config_dir both name the account; pass one'

/**
 * TP-4214: a requested account on another host. The readings are this host's, so least-used
 * refuses there, and a name passes as the explicit config dir it names under that host's home.
 */
function remoteAccountRequest(
  req: SpawnRequest,
  gated: RemoteGated,
): { configDir?: string } | { refusal: string } {
  if (req.account === undefined) return req.configDir === undefined ? {} : { configDir: req.configDir }
  if (req.configDir !== undefined) return { refusal: ACCOUNT_TWICE }
  if (req.account === LEAST_USED)
    return {
      refusal: `${LEAST_USED} reads ${brokerHost()}'s accounts; on ${gated.site.host} pass --account <name>`,
    }
  return { configDir: remoteAccountDir(req.account, gated.home) }
}

const toolsetOf = (profile: AgentProfile): NonNullable<IsolationContext['toolset']> => ({
  allowedTools: [...profile.allowedTools],
  ...(profile.disallowedTools ? { disallowedTools: [...profile.disallowedTools] } : {}),
})

/**
 * A remote spawn's brief with its return contract and isolation note. Only the host-neutral
 * isolations reach here, and neither touches a disk to allocate.
 */
async function remoteBrief(
  req: SpawnRequest,
  profile: AgentProfile,
  isolation: IsolationName,
  lintWarnings: string[],
): Promise<{ brief: string; warnings: string[] }> {
  const ctx: IsolationContext = {
    agentId: '',
    agentName: req.name,
    baseCwd: req.cwd ?? '',
    toolset: toolsetOf(profile),
  }
  const strategy = resolveIsolation([isolation])
  const allocation = await strategy.allocate(ctx)
  const contracted = withReturnContract({
    brief: req.brief,
    profile,
    spawner: req.requestedBy,
    resumed: false,
    ...(req.returnContract === undefined ? {} : { requested: req.returnContract }),
  })
  const floor = floorWarning(isolation, profile.isolation)
  const warnings = [
    ...(profile.warnings ?? []),
    ...lintWarnings,
    ...(floor ? [floor] : []),
    ...(await strategy.check(ctx)),
    ...contracted.warnings,
  ]
  return { brief: [contracted.brief, allocation.note].filter(Boolean).join('\n\n'), warnings }
}

/** CC-1615: on the row so an audit can tell a spawn the seat ceiling admitted from one CC-39/40 did. */
const seatCeilingMeta = (lineage: Lineage): { seat_ceiling?: string } =>
  lineage.seat === undefined ? {} : { seat_ceiling: lineage.seat }

/** The remote spawn's `agent_spawned` meta: the local row's facts, with `host` and `site` naming where it runs. */
function remoteSpawnMeta(
  req: SpawnRequest,
  profile: AgentProfile,
  lineage: Lineage,
  draft: RemoteDraft,
  sessionId: string,
): Record<string, string> {
  const { account, injected } = draft
  return {
    name: req.name,
    ...(injected ? { briefing: injected.slug, briefing_chars: String(injected.text.length) } : {}),
    parent: req.parentAgentId ?? '',
    profile: profile.name,
    model: profile.model,
    surface: draft.surface,
    isolation: draft.isolation,
    cwd: draft.cwd,
    session_id: sessionId,
    config_dir: account.dir,
    config_dir_source: account.source,
    ...(account.unset ? { config_dir_unset: 'true' } : {}),
    allowed_tools: profile.allowedTools.join(','),
    disallowed_tools: (profile.disallowedTools ?? []).join(','),
    ...grantMeta(draft),
    perm_mode: permModeFor(draft.surface),
    surface_lifetime: lifetimeOf(profile),
    depth: String(lineage.depth),
    role: roleOf(profile),
    coordinator_depth: String(lineage.coordinatorDepth),
    ...seatCeilingMeta(lineage),
    ...(req.predecessor === undefined ? {} : { predecessor: req.predecessor }),
    ...(req.spawnedAs === undefined ? {} : { spawned_as: req.spawnedAs }),
    ...callerAgentMeta(req),
    ...launchMeta(req),
    // The worktree half of provenance reads git on this host, which holds no copy of that cwd.
    ...assignmentMeta(req, profile.name),
    host: draft.site.host,
    site: 'caller',
  }
}

/** The dispatched row's facts for a spawn, local or remote; only a local spawn knows its config dir. */
const spawnFactsOf = (
  req: SpawnRequest,
  profile: AgentProfile,
  agentId: string,
  configDir?: string,
): SpawnFacts => ({
  agent: req.name,
  agent_id: agentId,
  spawner: req.requestedBy,
  profile: profile.name,
  model: profile.model,
  predecessor: req.predecessor ?? null,
  ...(req.tier === undefined ? {} : { tier: req.tier }),
  ...(req.spawnedAs === undefined ? {} : { spawnedAs: req.spawnedAs }),
  ...(configDir === undefined ? {} : { configDir }),
})

/** A duration as a reader would say it: seconds under a minute, minutes above. */
const span = (ms: number): string =>
  ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)} min`

/** A profile that predates the field keeps its pane. See {@link DEFAULT_SURFACE_LIFETIME}. */
const lifetimeOf = (profile: Pick<AgentProfile, 'surfaceLifetime'>): SurfaceLifetime =>
  profile.surfaceLifetime ?? DEFAULT_SURFACE_LIFETIME

/** Where an agent was launched: its folder and the `CLAUDE_CONFIG_DIR` whose trust entries it reads, undefined when unset. */
interface LaunchSite {
  cwd: string
  configDir: string | undefined
}

/**
 * The most likely cause of a spawn that never registered, named (CC-95).
 *
 * A coordinator has to learn what it can run, and "the spawn failed" teaches it
 * nothing it can act on. The trust gap is checked first because it is the one
 * that produces exactly the observed symptom — a pane at a prompt, no
 * transcript, no exit code — and because `worktree` isolation walks into it by
 * construction: a freshly created worktree is a path Claude Code has never been
 * run in, so it has no trust entry by definition.
 */
function attachDiagnosis(
  site: LaunchSite,
  handle: LaunchHandle,
  outcome: 'waiting' | 'exited',
  /** What the launched claude printed before it exited, when the surface could keep it. */
  output?: string,
): string {
  const login = loginGap(output, site.configDir)
  if (login !== undefined) return login
  const trust = trustGap(site.cwd, outcome, site.configDir)
  if (trust !== undefined) return trust
  if (handle.surface !== 'headless' && handle.paneRef === undefined)
    return 'iTerm2 returned no session id, so nothing was ever launched into a pane.'
  if (outcome === 'waiting' && isTrusted(site.cwd, site.configDir) === true)
    return (
      `The directory is trusted, so this is not the trust prompt; Claude Code is still starting. ` +
      `Look at the surface itself (${handle.surface}) and at ~/.claude for this agent's transcript.`
    )
  return `Look at the surface itself (${handle.surface}) and at ~/.claude for this agent's transcript.`
}

export interface SpawnRequest {
  name: string
  profile: string
  brief: string
  cwd?: string
  isolation?: IsolationName
  surface?: SurfaceName
  /**
   * CC-63: an active-work slug, or `auto`, whose brief/tasks/sessions are read
   * and prepended to `brief`. Absent means the brief is exactly what was passed.
   */
  briefing?: string
  /** CC-72: a worktree the task system assigned. Adopted, never allocated. */
  worktree?: string
  /** CC-81: path globs inside the worktree this agent owns. */
  owns?: string[]
  /** CC-952: globs the broker claims for the agent in its worktree at spawn; isolates nothing. */
  claimPaths?: string[]
  /** CC-44: start from a copy of the REQUESTER's own conversation, not an empty one. */
  inherit?: 'context'
  /** H-12: explicit opt-in to `--remote-control`; a spawned agent never gets it otherwise. */
  remoteControl?: boolean
  /**
   * CC-100: the account to run this agent on, named explicitly. Validated and
   * REFUSED when unusable — see `config-dir.ts` for why this one step does not
   * fall back.
   */
  configDir?: string
  /** TP-4214: an account name or `least-used`, resolved to an explicit `configDir`; never with one. */
  account?: string
  /** The requester's own `CLAUDE_CONFIG_DIR`, observed rather than claimed (CC-100). */
  spawnerConfigDir?: string
  /** CC-156: the requester is a known Claude Code session, so no `spawnerConfigDir` means `~/.claude`. */
  spawnerIsSession?: boolean
  /** The session id the requester claims as its own. Checked, never trusted. */
  forkFrom?: string
  /** CC-126: continue this Claude session uuid instead of minting one. */
  resumeSession?: string
  /** CC-133: the agent whose work this one takes over; its last report and branch are briefed. */
  predecessor?: string
  /** CC-168: the experiment and arm this spawn runs, written on the `agent_spawned` row. */
  experiment?: ExperimentArm
  /** CC-286: `none` keeps the broker's return contract out of a brief that states its own report format. */
  returnContract?: 'none'
  /** CC-774: the burndown plan's tier for the task, written on the `dispatched` row. */
  tier?: number
  /** CC-802: the automation a human-requested spawn runs for; the `dispatched` row's spawner. */
  spawnedAs?: 'burndown' | 'shepherd'
  /** CC-1206: an agent the broker found behind an unregistered CLI spawn; such a spawn is not the human's. */
  callerAgent?: string
  /** CC-1246: why an unregistered CLI spawn with no agent found is still not proven the human's. */
  humanUnproven?: string
  /** CC-915: the task id this agent runs; required for a burndown spawn. */
  task?: string
  /** CC-915: one of `WORK_ROLES` or `fix-round-<n>`; inferred from profile and name when absent. */
  workRole?: string
  /** CC-932: `fix-round` passes the seat spawn gate on a claimed or brief-ready task. */
  override?: 'fix-round'
  /** CC-1666: the plan slice of `task` this agent runs; written on the spawn row as `slice`. */
  slice?: string
  /** CC-1666: why the caller keeps `profile` unrouted; written on the spawn row as `route_override`. */
  routeOverride?: string
  /** Empty for a human-initiated spawn; otherwise the requesting agent's id. */
  parentAgentId?: string
  /** CC-1614: how `parentAgentId` was bound to the requester's connection. */
  requesterBinding?: IdentityBinding
  requestedBy: string
  forceReset?: boolean
  /** CC-1158: the `origin/<branch>` a new worktree is cut from; absent, origin's default branch. */
  baseRef?: string
  /** Applied at the spawned agent's own registration, before its first turn. */
  tags?: string[]
  subscriptions?: Subscription[]
  /**
   * The requester's pane, resolved by the caller from its OWN connection. Passed
   * in rather than looked up here because only the socket layer holds the
   * connection — which is also what stops a request naming someone else's pane.
   */
  anchor?: string
  /** CC-1059: the requester's host, from its registration; the CLI's own frame only when unregistered. */
  callerHost?: string
  /** CC-1059: the requester's OS, which picks the surface when it launches on its own host. */
  hostPlatform?: NodeJS.Platform
  /** CC-1059: the requester can launch on its own host. Absent is an older client, launched here. */
  launchesHere?: true
  /** CC-1059: the machine to launch on, an alias from config `machines` or a hostname. */
  host?: string
  /** CC-1059: the requester's home, which a cwd on its host must sit under. */
  callerHome?: string
  /** CC-1466: the automation behind a human-requested spawn; written to the row, read by no gate. */
  launchedBy?: Launcher
  launchReason?: string
  /** CC-1466: an earlier identity of this name whose depth and coordinator depth the spawn keeps. */
  lineageFrom?: string
}

/** CC-1466: what a spawn or resume row records of its launcher. Audit only: no gate reads it back. */
/** CC-1206: the agent found behind a CLI spawn the row would otherwise credit to the human. */
const callerAgentMeta = (req: { callerAgent?: string; humanUnproven?: string }): Record<string, string> => ({
  ...(req.callerAgent === undefined ? {} : { caller_agent: req.callerAgent }),
  ...(req.humanUnproven === undefined ? {} : { human_unproven: req.humanUnproven }),
})

const launchMeta = (req: { launchedBy?: Launcher; launchReason?: string }): Record<string, string> =>
  req.launchedBy === undefined
    ? {}
    : {
        launched_by: req.launchedBy,
        ...(req.launchReason === undefined ? {} : { launch_reason: req.launchReason }),
      }

/** A recorded depth that only raises `computed`, so naming an earlier identity never lifts a cap. */
function raised(computed: number, recorded: string | undefined): number {
  const value = Number.parseInt(recorded ?? '', 10)
  return Number.isFinite(value) ? Math.max(computed, value) : computed
}

export type SpawnRefusalCode =
  | 'surface_refused'
  | 'spawn_rate_limit'
  | AdmissionRefusalCode
  | typeof CRASH_LOOP_REFUSAL
  | 'broker_draining'
  | typeof ACCOUNT_EXHAUSTED
  | MachineRefusalCode
  | SeatBudgetRefusalCode
  | SeatOverlapRefusalCode
  | SeatHandReserveRefusalCode
  | SeatUnprefixedRefusalCode
  | typeof REVIEWER_ACCOUNT_LIMIT
  | typeof HARNESS_UNSUPPORTED

/** CC-1078: reads the five_hour window and ceiling of the account a reviewer spawn bills. Absent in tests, which own no account. */
export interface ReviewerAccountReaders {
  read: (configDir: string, nowMs: number) => ReviewerAccountRead
}

/** CC-288: reads a seat-prefixed spawn's pool and meters. Absent in tests, which own no autonomy root. */
export interface SeatBudgetReaders {
  read: (spawn: SeatSpawnRequest) => SeatSpawnRead
}

/** CC-932: the seat spawn gate's mode and its reader of the claims and tags a task holds; absent in tests. */
export interface SeatOverlapReaders {
  mode: () => SeatSpawnMode
  read: (spawn: OverlapRequest) => OverlapFacts | undefined
  /** CC-936: the seat's hand reserve; absent where the seat reserves nothing. */
  handReserve?: (spawn: OverlapRequest) => HandReserveFacts | undefined
  /** CC-965: the seat the spawner is, by its own name; absent where no spawner is checked. */
  spawnerSeat?: (spawn: OverlapRequest) => SpawnerSeatFacts | undefined
}

/** CC-606: the pool pick's disk reader and its `poolPick` config mode, both read per spawn. */
export interface PoolPickReaders {
  read: (spawn: PoolPickRequest) => PoolPickRead
  mode: () => PoolPickMode
}

/** CC-1546: the readings a worker spawn's account rotation compared, kept or rotated. */
/** TP-4214: `choice` is a requested account's line: the pick and every reading it compared. */
type Account = Extract<ConfigDirResolution, { dir: string }> & { rotation?: RotationRecord; choice?: string }

/** CC-1546: the `accountRotation` config and every account's reading, both read per spawn. */
export interface AccountRotationReaders {
  config: () => RotationConfig
  readings: () => AccountUsage[]
  /** TP-4214: a config dir's login, so a requested account's pick sees one row per login. */
  identify?: (configDir: string) => string | undefined
}

/** TP-4214: every account a requested pick could launch on is closed; the readings say until when. */
export const ACCOUNT_EXHAUSTED = 'account_exhausted'

type RequestedAccount = { dir: string; text: string; warning?: string } | { refused: SpawnOutcome }
/** The profile facts the seat budget gate reads: its name for the inferred role, and its model. */
type SpawnProfile = { name: string; model: string }

/** The default account runs with the variable unset (CC-200), as a spawner on it would leave its child. */
const pickedAccount =
  (source: 'pool' | 'rotation') =>
  (dir: string): Account => ({
    dir,
    source,
    ...(path.resolve(dir) === defaultConfigDir() ? { unset: true as const } : {}),
  })
const poolAccount = pickedAccount('pool')
const rotationAccount = pickedAccount('rotation')

/** TP-4214: a requested account that lands on the default one runs it unset too, as a pick would. */
const requestedBilling = (account: Account, choice: string): Account => ({
  ...account,
  choice,
  ...(path.resolve(account.dir) === defaultConfigDir() ? { unset: true as const } : {}),
})

/**
 * CC-1546: only a fresh worker spawn rotates. A coordinator keeps its spawner's account, and a
 * predecessor's successor or a fix round continues work, and a resumable transcript, under its account.
 */
const rotatesAccount = (req: SpawnRequest, profile: AgentProfile): boolean =>
  roleOf(profile) === 'worker' &&
  req.predecessor === undefined &&
  req.override !== 'fix-round' &&
  !(req.workRole ?? '').startsWith('fix-round')

export interface SpawnOutcome {
  ok: boolean
  agentId?: string
  name?: string
  reason?: string
  /** CC-441: see protocol.ts's `spawn_result`. */
  code?: SpawnRefusalCode
  /** CC-445: whether the same spawn may succeed later without changes; set with a machine-guard or seat budget `code`. */
  retryable?: boolean
  /** CC-1179: set with `broker_draining`, the time until the drain lifts at its ttl. */
  retryAfterMs?: number
  warnings?: string[]
  /** The profile's own deny list. See protocol.ts's `spawn_result` for why this matters. */
  disallowedTools?: string[]
  /** CC-126: whether the conversation a resume asked for was there. */
  transcript?: TranscriptVerdict
  /** CC-151: where a freshly allocated worktree branch was cut from. */
  base?: { ref: string; sha: string }
  /** CC-1059: recorded, not launched: the requester launches this on `host`, then reports. */
  launch?: RemoteLaunch
  /** CC-1059: the host the agent launches on, when that is not the broker's. */
  host?: string
  /** CC-1546: the account a worker spawn's rotation chose, and the readings it compared. */
  account?: string
}

/** Who asks to act on an existing agent, as the broker resolved it from the connection. */
type OwnershipClaim = Pick<ResumeRequest, 'requestedBy' | 'requesterAgentId' | 'requesterBinding'>

/** CC-126: how `resume` relaunches. Headless unless the caller asks for a pane. */
/** CC-282: who asked, resolved by the broker from the connection, for the worker ownership rule. */
export type ParkRequest = Pick<ResumeRequest, 'requestedBy' | 'requesterAgentId' | 'requesterBinding'> & {
  /** CC-1039: refuse a tree a process still sits in, for a tracked agent too. */
  checkProcesses?: boolean
  /** CC-1470: skip the Shepherd fix-round check, for Shepherd itself: its own park would wait on its own status. */
  noFixRoundCheck?: boolean
  /** CC-1678: a done PR's head, which backs HEAD where a merge deleted the branch on origin. Broker-internal. */
  prHead?: MergedPr
}

export interface ResumeRequest {
  surface?: SurfaceName
  /** The turn a headless resume starts on; {@link RESUMED_BRIEF} when absent. */
  message?: string
  /** CC-203: who asked for the wake, when it was not the human; written to `agent_resumed` meta. */
  source?: WakeSource
  requestedBy?: string
  /** CC-216: the requester's own agent id, resolved by the broker from its connection. */
  requesterAgentId?: string
  /** CC-1614: how that id was bound to the connection. */
  requesterBinding?: IdentityBinding
  /** CC-497: the requester's pane, resolved by the broker from its connection, as for a spawn. */
  anchor?: string
  /** CC-883: `--remote-control` for a coordinator; a worker resumes without it and is told so. */
  remoteControl?: boolean
  /** CC-336: the supervisor's own resume of an agent that exited on a background task; CC-1669: of an idle print host. */
  cause?: typeof BACKGROUND_RESUME | typeof IDLE_PRINT_WAKE
  /** CC-1466: as on {@link SpawnRequest}. */
  launchedBy?: Launcher
  launchReason?: string
  /** CC-1472: resume on this machine, through its host launcher; never falls back to resuming here. */
  host?: string
  /** TP-4256 A3: as on {@link SpawnRequest}; an unregistered resume carrying either is not the human's. */
  callerAgent?: string
  humanUnproven?: string
  /** TP-4313: the broker's own resume of this agent so that child's admit finds a known parent. */
  forChild?: string
}

interface Live {
  agentId: string
  name: string
  handle: LaunchHandle
  allocation: Allocation
  isolation: IsolationName
  /** Which anchor this agent was placed beside, so later spawns can stack on it. */
  anchor?: string
  settle?: NodeJS.Timeout
  /** CC-124: armed while a visible spawn is still starting past the attach window. */
  attachCeiling?: NodeJS.Timeout
  /** CC-118: this process's shadow execution; absent when the ledger is off. */
  executionId?: string
  /** CC-118: someone asked this process to stop, so its exit finishes cancelled with this reason. */
  cancelReason?: string
  /** CC-118: `observe_running` is written once; a later attach is presence, not lifecycle. */
  runningObserved?: boolean
  /** CC-951: kept while its successor-first successor starts, so its own exit is not a finish. */
  teleporting?: boolean
  /** CC-233: a reviewer's cwd as it was before launch, compared again at exit. */
  reviewerTree?: TreeFingerprint
}

export interface SupervisorOptions {
  /** CC-334: lists process working directories for parking a detached agent. Injected in tests. */
  cwdLister?: CwdLister
  semaphore?: Semaphore
  /** CC-1671 S3: the per-requester burst guard, which any spawn's slot frees at register or exit. */
  spawnSlots?: SpawnSlots
  /** CC-1671 S4: read at each exit; defaults to config. */
  crashLoop?: () => CrashLoopLimits
  /** CC-1671 S3: absent turns predicted-cost admission off, as in tests that do not exercise it. */
  predictedCost?: PredictedCostReaders
  /** CC-1671: reads each live agent's process tree; only `startFootprintSampling` ticks it. */
  footprint?: FootprintSampler
  settleMs?: number
  /** CC-95's attach window. Shortened in tests; never shortened in production. */
  attachMs?: number
  /** CC-124's ceiling for a visible spawn still starting. Shortened in tests. */
  attachCeilingMs?: number
  /** CC-1059: how long a remote spawn's ready report may take. Shortened in tests. */
  remoteReportMs?: number
  /** CC-1468: how long a resume waits on a park of its tree. Shortened in tests. */
  parkWaitMs?: number
  /**
   * Merged into every surface built here. Without it a test naming `iterm-pane`
   * reaches the real AppleScript and opens a real window on any machine that
   * happens to be running iTerm — passing on CI and spawning panes on a laptop.
   */
  surface?: Pick<SurfaceOptions, 'runAppleScript' | 'spawn' | 'platform' | 'probeProcesses' | 'launchCheck'>
  /** Teleport's human-veto window. Shortened in tests; never shortened in production. */
  countdownMs?: number
  /** CC-402: finds a successor's `run-agent` before a relaunch retry, so a slow launch is never started twice. */
  launcherRunning?: LauncherProbe
  /** How teleport reads a predecessor's argv for `--remote-control`. Faked in tests. */
  argvReader?: ArgvReader
  /** CC-863: where a seat's teleport State block is written and how Shepherd is read. Faked in tests. */
  seatTeleport?: SeatTeleportDeps
  /** CC-951: the host launchers a teleport can land a successor through, owned by the socket layer. */
  hosts?: LauncherSite
  /** TP-4256 A3: the broker's ledger. Absent, a launch is written `OFF_BROKER`, without `--integrity`. */
  integrity?: LaunchLedger
  /** TP-4347: set only in `shadow`; every refusal the ledger would make is written here and none is made. */
  wouldDeny?: NoteWouldDeny
  /** CC-892: the account checks and transcript move behind `account_move`. Faked in tests. */
  accountMoves?: AccountMoves
  /**
   * How long a mode switch waits for the stopped process's socket to go before
   * reclaiming its name. Shortened in tests, where nothing ever closes a fake
   * connection and the full window would just be dead time.
   */
  nameFreeMs?: number
  /**
   * CC-71: injectable so a test can assert exactly which lifecycle hook fired
   * with which payload, without a real `hooks.json` or a real shell command.
   */
  hookSpawn?: HookSpawnFn
  /** CC-118's write-only shadow ledger. Present only when `ledgerShadow` is on. */
  ledger?: ShadowLedger
  /** CC-316: writes a seat agent's spawn, retire and park lines. Absent in tests, which own no autonomy root. */
  seatJournal?: SeatJournal
  /** CC-904: the open-PR and Shepherd reads every bulk or automatic retire skips on. Faked in tests. */
  shepherdSkip?: ShepherdSkipPort
  /** CC-921: whether a spawner opted in to retire-at-final-report. Needs `shepherdSkip` too. */
  autoRetireOnReport?: (spawner: string) => boolean
  /** CC-1039: whether a non-reviewer's tree is parked at exit (`autoPark.onExit`). Absent is off, so tests own it. */
  autoParkOnExit?: () => boolean
  /** CC-1039: why a held burndown claim still reads a tree. Absent is no hold. */
  burndownTreeHold?: (tree: string) => string | undefined
  /** CC-331: appends a seat agent's dispatched and retired rows. Absent in tests, which own no autonomy root. */
  seatDispatch?: SeatDispatchLog
  /** CC-406: the machine-wide guard's readers. Absent in tests, which must not read the host's memory. */
  machineGuard?: MachineGuardReaders
  /** CC-288: the seat budget gate's reader. */
  seatBudget?: SeatBudgetReaders
  /** CC-1078: the reviewer account gate's reader. */
  reviewerAccount?: ReviewerAccountReaders
  /** CC-932: the seat spawn gate's readers. */
  seatOverlap?: SeatOverlapReaders
  /** CC-606: the pool pick's readers. Absent in tests, which own no autonomy root. */
  poolPick?: PoolPickReaders
  /** CC-1546: account rotation's readers. Absent, no spawn rotates. */
  accountRotation?: AccountRotationReaders
  /** CC-450: how an unwatched agent's recorded launcher pid is checked. Faked in tests. */
  processProbe?: ProcessProbe
  /** CC-398: the brief lint's repo visibility read. Absent in tests, which must not call GitHub. */
  repoVisibility?: (cwd: string) => Promise<RepoVisibility>
  /** CC-1094: profile file hashes at start. Defaults to a snapshot of `profilesDir()`. */
  profileBaseline?: ProfileBaseline
  /** CC-1094: `profileDrift` from config, pinned at construction (CC-1202). Injected in tests. */
  profileDriftMode?: ProfileDriftMode
}

/** A dispatch row is bookkeeping: a writer that throws despite its contract leaves the spawn or retire as it was. */
function writeDispatch(write: () => void): void {
  try {
    write()
  } catch (err) {
    dispatchUnavailable(err)
  }
}

function dispatchUnavailable(err: unknown): void {
  logEvent('seat_dispatch_unavailable', { reason: err instanceof Error ? err.message : String(err) })
}

function retireSpendOf(read: TranscriptSpendRead): RetireSpend {
  if (!read.ok) return { usage_miss: read.reason }
  if (read.unpriced.length > 0) logEvent('seat_dispatch_unpriced', { level: 'warn', models: read.unpriced })
  const { tokens, usd_est, usage, models, price_table } = read
  return { tokens, usd_est, usage, models, price_table }
}

/**
 * Burndown and Shepherd spawn over unregistered CLI sockets, so they arrive as HUMAN but carry `spawnedAs`.
 * CC-1206: so does an agent's own CLI spawn, which the broker marks with `callerAgent`.
 * CC-1246: and one the broker could not prove came from the human at a terminal (`humanUnproven`).
 */
const isHumanSpawn = (req: SpawnRequest): boolean =>
  req.requestedBy === HUMAN &&
  req.spawnedAs === undefined &&
  req.callerAgent === undefined &&
  req.humanUnproven === undefined

/** TP-4256 A3: the human's own resume, the one resume that clears a quarantine; a wake, a seat or an agent does not. */
const isHumanResume = (req: ResumeRequest): boolean =>
  req.requestedBy === HUMAN &&
  req.requesterAgentId === undefined &&
  req.source === undefined &&
  req.cause === undefined &&
  req.launchedBy === undefined &&
  req.callerAgent === undefined &&
  req.humanUnproven === undefined &&
  req.forChild === undefined

/** The ledger calls a launch needs; `SocketServer` passes its own ledger. */
export type LaunchLedger = Pick<IntegrityLedger, 'admit' | 'readmit' | 'verdict' | 'knows' | 'parentOf'>

/** TP-4345 S3: an admit under `root`; a skipped ancestor's recorded quarantine latches it unless a human's resume clears. */
const rootAdmission = (agentId: string, root: SurvivorRoot, humanProof?: boolean): AdmitRequest => ({
  agentId,
  parent: root.parent,
  ...(humanProof === undefined ? {} : { humanProof }),
  ...(root.inherited === undefined ? {} : { recorded: root.inherited.mismatch }),
})

/** TP-4313: how many unadmitted ancestors one resume brings back before it refuses. */
const LINEAGE_DEPTH = 8

/** The unadmitted ancestors to resume, outermost first, or why the child may not be admitted. */
type ResumeLineage = { ancestors: AgentIdentity[] } | { refusal: string }

/** Why an unadmitted parent cannot be resumed for its child; undefined when it can. */
function unresumableParent(child: string, parent: AgentIdentity): string | undefined {
  const lead = `integrity: ${child} is not resumed: its parent ${parent.name} (${parent.agentId})`
  if (parent.state === 'exited') return undefined
  if (parent.state === 'retired') return `${lead} is retired`
  return (
    `${lead} is ${parent.state} but has no baseline in this broker ` +
    `(it outlived a broker restart); resume ${child} once ${parent.name} has exited and been resumed`
  )
}

/** The parent's resume carries the child's requester, so ownership is checked as for the child, but never human proof. */
const parentResume = (req: ResumeRequest, child: string): ResumeRequest => ({
  ...(req.requestedBy === undefined ? {} : { requestedBy: req.requestedBy }),
  ...(req.requesterAgentId === undefined ? {} : { requesterAgentId: req.requesterAgentId }),
  ...(req.requesterBinding === undefined ? {} : { requesterBinding: req.requesterBinding }),
  ...(req.callerAgent === undefined ? {} : { callerAgent: req.callerAgent }),
  ...(req.humanUnproven === undefined ? {} : { humanUnproven: req.humanUnproven }),
  ...(req.launchedBy === undefined ? {} : { launchedBy: req.launchedBy }),
  forChild: child,
})

/** TP-4341: an agent in one of these never runs again under its id, so no broker re-admits it. */
const DEPARTED: ReadonlySet<string> = new Set(['exited', 'retired'])

/** Why the ledger refuses a launch, as a launch error and a notice say it. */
function integrityRefusal(agentId: string, verdict: Exclude<Verdict, { ok: true }>): string {
  if (verdict.reason === 'no baseline') return `integrity: ${agentId} has no baseline in this broker`
  return (
    `integrity: ${agentId} is quarantined: ${verdict.file} changed (${verdict.field}) under ` +
    `${verdict.principal}; only the human's own \`agent-chat agent resume\` re-baselines it`
  )
}

/** Who a run's return-contract report may go to. */
const reportRecipients = (spawner: string): string[] =>
  spawner === HUMAN ? [spawner, ...burndownReportTo()] : [spawner]

/** Burndown spawns as the human, but its agents report to the configured `reportTo` (CC-266). */
function burndownReportTo(): string[] {
  try {
    const { reportTo } = loadResolvedConfig().tick
    return reportTo === undefined ? [] : [reportTo]
  } catch {
    return []
  }
}

/**
 * CC-1654: the allow-side mirror of `stillDenied`. A parent granted a tool's bare
 * name holds every scoped form of it, so `Bash` covers `Bash(fetch-pdf *)`. One
 * level and one way: a scoped grant never covers the bare tool or another scope.
 */
function held(granted: Set<string>, tool: string): boolean {
  if (granted.has(tool)) return true
  const base = tool.split('(')[0] ?? tool
  return base !== tool && granted.has(base)
}

/** What the allow side admitted that the parent does not hold by name: CC-451's exemption, CC-1654's bare grants. */
interface Admitted {
  exempted: string[]
  covered: string[]
}

const NOTHING_ADMITTED: Admitted = { exempted: [], covered: [] }

/** CC-1654: the spawn row's record of how the allow side admitted what the parent did not hold by name. */
function grantMeta(admitted: { exempted?: string[]; covered?: string[] }): Record<string, string> {
  const { exempted = [], covered = [] } = admitted
  return {
    ...(exempted.length > 0 ? { granted_by_exemption: exempted.join(',') } : {}),
    ...(covered.length > 0 ? { covered_by_bare_grant: covered.join(',') } : {}),
  }
}

/**
 * CC-69: unlike the allow side, a blanket deny genuinely does subsume a scoped
 * one — denying all of `Bash` is strictly stronger than denying `Bash(x:*)`, so
 * a child that denies plain `Bash` still satisfies a parent that was only
 * denied `Bash(x:*)`. Checked one level: a child denying the tool's base name
 * (the part before its first `(`) covers any of that tool's scoped variants.
 */
function stillDenied(childDenied: Set<string>, tool: string): boolean {
  if (childDenied.has(tool)) return true
  const base = tool.split('(')[0] ?? tool
  return base !== tool && childDenied.has(base)
}

/** CC-451: what a web-exempt child may hold besides the exempt tools. None of them runs code. */
const NON_EXEC_TOOLS: ReadonlySet<string> = new Set([
  'Read',
  'Write',
  'Edit',
  'Grep',
  'Glob',
  AGENT_CHAT_TOOLS,
])

/**
 * CC-451: the tools a requester of `role` may grant `profile` without holding
 * them. Only a coordinator, and only to a child that denies all of Bash and
 * allows nothing outside `grantable` and `NON_EXEC_TOOLS`, so a fetched page
 * cannot talk it into running code. Fails closed: Monitor, any Bash form and
 * any MCP tool, including ones added later, void the exemption.
 */
export function coordinatorExemption(
  role: AgentRole,
  profile: Pick<AgentProfile, 'allowedTools' | 'disallowedTools'>,
  grantable: readonly string[],
): Set<string> {
  if (role !== 'coordinator') return new Set()
  if (!(profile.disallowedTools ?? []).includes('Bash')) return new Set()
  const exempt = new Set(grantable)
  const confined = profile.allowedTools.every(tool => exempt.has(tool) || NON_EXEC_TOOLS.has(tool))
  return confined ? exempt : new Set()
}

/** Only a worktree the strategy cut records `base_ref`; an adopted one has no base to report. */
function branchBaseOf(allocation: Allocation): { base?: { ref: string; sha: string } } {
  const ref = allocation.ref
  return ref?.base_ref && ref.base ? { base: { ref: ref.base_ref, sha: ref.base } } : {}
}

/**
 * Which isolation this spawn actually gets (CC-72, CC-81).
 *
 * The task system's assignment outranks the profile, because isolation is a
 * property of the WORK and the profile only ever guessed. An assigned worktree
 * means `worktree`; declared paths with no worktree mean `file-ownership`. Both
 * beat `req.isolation`, which is the caller saying what strategy to run rather
 * than what the work needs.
 */
export function isolationFor(
  req: { worktree?: string; owns?: string[]; isolation?: IsolationName },
  profile: { isolation: IsolationName },
): IsolationName {
  if (req.worktree) return 'worktree'
  if (req.owns?.length) return 'file-ownership'
  return req.isolation ?? profile.isolation
}

/**
 * CC-356: `owns` means file-ownership in the shared checkout, so a spawn that would
 * otherwise get a worktree, by request or by profile default, must not silently lose it.
 * Refuse rather than cut a worktree: file-ownership's peer claims are keyed to the base
 * checkout. An assigned worktree is fine, since the paths then live inside it.
 */
export function worktreeOwnsConflict(
  req: { worktree?: string; owns?: string[]; isolation?: IsolationName },
  profile: { isolation: IsolationName },
): string | undefined {
  if ((req.isolation ?? profile.isolation) !== 'worktree' || !req.owns?.length || req.worktree)
    return undefined
  return (
    'owns conflicts with worktree isolation: owns scopes paths in the shared checkout and would put the ' +
    'agent there. Drop owns to get a worktree, or pass an assigned worktree so owns scopes paths inside it.'
  )
}

/**
 * The floor: a request may narrow a profile's isolation, never widen it.
 *
 * Only one widening actually costs anything, so only one is named — an agent the
 * profile put in its own worktree landing in the shared checkout instead. The
 * others are not comparable (`toolset-limited` confines tools, `file-ownership`
 * confines paths), and inventing a total order over four incomparable strategies
 * would refuse combinations that are fine.
 *
 * Warn rather than refuse, matching `file-ownership.check` — an override is a
 * legitimate thing to do deliberately (a throwaway probe that must not cost a
 * worktree slot), and a refusal here would break it with no way through.
 */
export function floorWarning(requested: IsolationName, profileIsolation: IsolationName): string | undefined {
  if (profileIsolation !== 'worktree' || requested === 'worktree') return undefined
  return (
    `isolation "${requested}" widens this profile's "worktree": the agent will write in the shared ` +
    'checkout rather than its own. Intended for a short-lived agent that must not hold a worktree ' +
    'slot; pass an assigned worktree instead if the work needs isolating.'
  )
}

const reviewerOwnsRefusal = (root: string): string =>
  `a reviewer cannot own paths in the primary checkout ${root}: it gets a disposable worktree instead, ` +
  'and owns would scope paths in the shared tree. Drop owns.'

const reviewerRewriteWarning = (root: string): string =>
  `reviewer spawned in the primary checkout ${root}; it runs in a disposable worktree cut from the ` +
  "repository's default branch instead, so its git writes cannot reach the primary tree (CC-916)."

export interface MachineGuardReaders {
  readMemoryFree: () => MemoryReading
  readCpuPressure: () => CpuPressureReading
  readHeadroom: () => HeadroomReadings
  limits: () => MachineLimits
}

export interface PredictedCostReaders {
  readMemoryFree: () => MemoryReading
  totalMemoryKb: () => number
  /** Absent until a host wires CC-1670's reading; the CPU check is then skipped. */
  readCpuPressure?: () => CpuPressure
  cpuCount: () => number
  limits: () => AdmissionLimits
}

/** What retire did to an agent's process; the `reaped` meta on its `agent_retired` row. */
type Reaped =
  'true' | 'not_registered' | 'another_agent' | 'no_host_pid' | 'already_gone' | 'remote_end_requested'

export class Supervisor implements TeleportHost {
  private readonly live = new Map<string, Live>()
  /** CC-881: a remote successor's session id, held between its plan and its host's report. */
  private readonly remoteSessions = new Map<string, string>()
  private readonly cwdLister: CwdLister
  /** CC-282: agents mid-park, to the canonical tree being removed; CC-1468: and the park's end, for a resume to wait on. */
  private readonly parking = new Map<string, { tree: string; done: Promise<void> }>()
  private readonly parkWaitMs: number
  /** CC-1456: agents with a resume in flight, to when it started. */
  private readonly resuming = new Map<string, number>()
  /** CC-1457: session ids with a launch in flight, to the name launching it and when it started. */
  private readonly launchingSessions = new Map<string, { name: string; since: number }>()
  private readonly semaphore: Semaphore
  private readonly spawnSlots: SpawnSlots
  private readonly predictedCost: PredictedCostReaders | undefined
  private readonly crashLoop: () => CrashLoopLimits
  private readonly footprint: FootprintSampler
  private stopFootprint: (() => void) | undefined
  private stopMergedRetire: (() => void) | undefined
  private readonly drainState = new DrainState()
  private readonly settleMs: number
  private readonly attachMs: number
  private readonly attachCeilingMs: number
  /** Resolved by `onRow` when the agent's own `agent_attached` lands. Spawn-time only. */
  private readonly attachWaiters = new Map<string, () => void>()
  /** CC-109: agents counted on reattach that are not in `live`, with any pending release. */
  private readonly reattached = new Map<string, NodeJS.Timeout | undefined>()
  /** TP-4341: agents whose re-admit is resolving its lineage, so a looped chain stops. */
  private readonly readmitting = new Set<string>()
  /** TP-4345 S3: the lineage walk's spawn rows, so a long chain is not one copy of the log per step. */
  private readonly spawnRow = spawnRowIndex(() => this.core.events.agentEvents())
  /** TP-4345 S2: survivors that reattached inside the start's settle window, for its sweep row. */
  private readonly reattachedAtStart = new Set<string>()
  private readmitSweep: NodeJS.Timeout | undefined
  /** CC-1669 S2: the idle print host check, armed by the broker once it serves. */
  private idlePrintTimer: NodeJS.Timeout | undefined
  private readonly readmits: ReadmitRecord | undefined
  private readonly nameFreeMs: number
  private readonly surfaceOptions: SupervisorOptions['surface']
  private readonly hookSpawn: HookSpawnFn | undefined
  private readonly seatJournal: SeatJournal | undefined
  private readonly shepherdSkip: ShepherdSkipPort | undefined
  private readonly autoRetireOnReport: ((spawner: string) => boolean) | undefined
  private readonly autoParkOnExit: (() => boolean) | undefined
  private readonly burndownTreeHold: ((tree: string) => string | undefined) | undefined
  private readonly launcherRunning: LauncherProbe
  private readonly seatDispatch: SeatDispatchLog | undefined
  private readonly unwatch: () => void
  private readonly unwatchSeatFollow: () => void
  private readonly teleporter: Teleport
  private readonly shadow: LifecycleShadow
  private readonly machineGuard: MachineGuardReaders | undefined
  private readonly seatBudget: SeatBudgetReaders | undefined
  private readonly reviewerAccount: ReviewerAccountReaders | undefined
  private readonly seatOverlap: SeatOverlapReaders | undefined
  private readonly poolPick: PoolPickReaders | undefined
  private readonly accountRotation: AccountRotationReaders | undefined
  private readonly processProbe: ProcessProbe
  private readonly repoVisibility: ((cwd: string) => Promise<RepoVisibility>) | undefined
  private readonly reaper: DetachedReaper
  /** CC-1059: spawns recorded here for a requester on another host to launch. */
  private readonly remoteSpawns: RemoteSpawns
  private readonly hosts: LauncherSite | undefined
  private readonly ledger: LaunchLedger | undefined
  private readonly wouldDeny: NoteWouldDeny | undefined
  /** CC-1592: the one seam both a move and its dry run read, so they refuse alike. */
  private readonly accountMoves: AccountMoves
  /** CC-489: rows the previous broker left without an exit, to their `lastEventAt`; each is probed once. */
  private readonly staleAtBoot: Map<string, number>
  private readonly profileBaseline: ProfileBaseline
  private readonly profileDriftMode: ProfileDriftMode

  constructor(
    private readonly core: BrokerCore,
    options: SupervisorOptions = {},
  ) {
    this.cwdLister = options.cwdLister ?? lsofCwds
    this.semaphore = options.semaphore ?? new Semaphore()
    this.spawnSlots = options.spawnSlots ?? new SpawnSlots()
    this.predictedCost = options.predictedCost
    this.crashLoop = options.crashLoop ?? resolveCrashLoop
    this.footprint = options.footprint ?? new FootprintSampler()
    this.settleMs = options.settleMs ?? SETTLE_MS
    this.attachMs = options.attachMs ?? ATTACH_TIMEOUT_MS
    this.attachCeilingMs = options.attachCeilingMs ?? ATTACH_CEILING_MS
    this.parkWaitMs = options.parkWaitMs ?? PARK_WAIT_MS
    this.nameFreeMs = options.nameFreeMs ?? NAME_FREE_TIMEOUT_MS
    this.surfaceOptions = options.surface ?? {}
    this.hookSpawn = options.hookSpawn
    this.seatJournal = options.seatJournal
    this.shepherdSkip = options.shepherdSkip
    this.autoRetireOnReport = options.autoRetireOnReport
    this.autoParkOnExit = options.autoParkOnExit
    this.burndownTreeHold = options.burndownTreeHold
    this.launcherRunning = options.launcherRunning ?? psLauncherProbe
    this.seatDispatch = options.seatDispatch
    this.machineGuard = options.machineGuard
    this.seatBudget = options.seatBudget
    this.reviewerAccount = options.reviewerAccount
    this.seatOverlap = options.seatOverlap
    this.poolPick = options.poolPick
    this.accountRotation = options.accountRotation
    this.processProbe = options.processProbe ?? hostProbe
    this.repoVisibility = options.repoVisibility
    this.hosts = options.hosts
    this.ledger = options.integrity
    this.wouldDeny = options.wouldDeny
    this.readmits = this.ledger && readmitRecorder(input => void core.append(input))
    this.profileBaseline = options.profileBaseline ?? new ProfileBaseline(profilesDir())
    this.profileDriftMode = options.profileDriftMode ?? resolveProfileDriftMode()
    this.remoteSpawns = new RemoteSpawns({
      reportMs: options.remoteReportMs ?? REPORT_WINDOW_MS,
      attachMs: this.attachMs,
      ceilingMs: this.attachCeilingMs,
      retire: (record, reason) => this.retireRemoteSpawn(record, reason),
    })
    this.reaper = new DetachedReaper(this.settleMs, this.processProbe, (agentId, probe) =>
      this.reapIfDead(agentId, probe),
    )
    this.unwatch = core.onAppend(row => this.onRow(row))
    this.unwatchSeatFollow = watchSeatFollow(core, {
      onError: err =>
        logEvent('seat_follow_failed', {
          level: 'warn',
          reason: err instanceof Error ? err.message : String(err),
        }),
    })
    this.accountMoves =
      options.accountMoves ?? realAccountMoves(options.seatTeleport?.autonomyRoot ?? defaultAutonomyRoot())
    this.teleporter = new Teleport(
      core,
      this,
      options.countdownMs,
      options.argvReader,
      options.seatTeleport,
      options.hosts,
      this.accountMoves,
    )
    this.shadow = new LifecycleShadow(options.ledger)
    this.staleAtBoot = staleAtStart(core.agents.roster())
    for (const agentId of [...this.staleAtBoot.keys()]) this.reapAtStart(agentId)
    if (this.readmits !== undefined) {
      this.readmitSweep = setTimeout(() => this.sweepReadmits(), this.settleMs)
      this.readmitSweep.unref?.()
    }
  }

  /**
   * A launcher pid is direct evidence now; a session lookup waits one settle window for a reconnect.
   * SETTLE_MS (30 s) is the boot window too: it clears the client's 8.85 s reconnect ladder with room for a slow start.
   */
  private reapAtStart(agentId: string): void {
    if (launcherPid(agentId) === undefined) this.reaper.schedule(agentId)
    else this.reapIfDead(agentId)
  }

  private fireHook(event: HookEvent, payload: Record<string, unknown>): void {
    runHooks(event, payload, this.hookSpawn ? { spawn: this.hookSpawn } : {})
  }

  /**
   * Presence changes are the only exit signal a visible agent gives, so the
   * supervisor listens to the log rather than to processes. Reattach cancels a
   * pending settle, which is what stops a broker restart from reading as a room
   * full of dead agents.
   */
  private onRow(row: { kind: string; ref?: string }): void {
    const agentId = row.ref
    if (agentId === undefined) return
    if (['agent_attached', 'agent_exited', 'agent_retired'].includes(row.kind))
      this.spawnSlots.release(agentId)
    if (row.kind === 'agent_attached') this.remoteSpawns.attached(agentId)
    // TP-4341: a reconnect is a surviving agent's first contact with a restarted broker.
    if (row.kind === 'agent_attached') this.readmit(agentId)
    if (row.kind === 'agent_attached' && this.readmitSweep !== undefined && !this.live.has(agentId))
      this.reattachedAtStart.add(agentId)
    const entry = this.live.get(agentId)
    if (!entry) return this.onUnwatchedRow(row.kind, agentId)

    if (row.kind === 'agent_attached') {
      if (entry.settle) {
        clearTimeout(entry.settle)
        delete entry.settle
      }
      this.attachWaiters.get(agentId)?.()
      this.observeRunning(entry)
    }
    if (row.kind === 'agent_detached') this.scheduleSettle(entry)
  }

  private observeRunning(entry: Live): void {
    if (entry.executionId === undefined || entry.runningObserved) return
    entry.runningObserved = true
    const meta = this.core.agents.spawnMeta(entry.agentId)
    this.shadow.running(
      entry.executionId,
      entry.handle,
      meta['session_id'] ?? '',
      meta['config_dir'] ?? configDir(),
    )
  }

  /**
   * CC-109: slot accounting for a spawned agent this broker did not launch,
   * which after a restart is every agent that reattaches. Nothing is added to
   * `live`, for the reasons on `rehydrate`. CC-450: a detach that outlasts the
   * settle window infers an exit only once its launcher pid or its Claude Code session is gone.
   */
  private onUnwatchedRow(kind: string, agentId: string): void {
    this.staleAtBoot.delete(agentId)
    if (kind === 'agent_detached') this.reaper.schedule(agentId)
    else this.reaper.cancel(agentId)
    if (kind === 'agent_attached') return this.countReattach(agentId)
    if (kind === 'agent_exited' && !this.reattached.has(agentId)) this.releaseRemoteSlot(agentId)
    if (!this.reattached.has(agentId)) return
    if (kind === 'agent_detached') this.scheduleReattachRelease(agentId)
    if (kind === 'agent_exited' || kind === 'agent_retired') this.releaseReattach(agentId)
  }

  private countReattach(agentId: string): void {
    if (this.reattached.has(agentId)) {
      clearTimeout(this.reattached.get(agentId))
      this.reattached.set(agentId, undefined)
      return
    }
    if (this.semaphore.has(agentId)) return
    const identity = this.core.agents.get(agentId)
    if (identity?.origin !== 'spawned' || identity.state === 'retired') return
    this.semaphore.adopt(agentId)
    this.reattached.set(agentId, undefined)
    logEvent('agent_slot_reattached', { agentId, name: identity.name, slots: this.semaphore.summary() })
  }

  /** The same settle window a watched agent gets, so a reconnect blip keeps its slot. */
  private scheduleReattachRelease(agentId: string): void {
    clearTimeout(this.reattached.get(agentId))
    const timer = setTimeout(() => this.releaseReattach(agentId), this.settleMs)
    timer.unref?.()
    this.reattached.set(agentId, timer)
  }

  /** CC-1059: a remote spawn holds the slot it took at spawn, never counted as a reattach, until it exits. */
  private releaseRemoteSlot(agentId: string): void {
    const identity = this.core.agents.get(agentId)
    if (identity === undefined || remoteHostOf(identity) === undefined) return
    this.semaphore.release(agentId)
  }

  private releaseReattach(agentId: string): void {
    clearTimeout(this.reattached.get(agentId))
    this.reattached.delete(agentId)
    this.semaphore.release(agentId)
  }

  /** CC-450: the row and the ledger only; the process is not ours to signal and has no surface to close. */
  private reapIfDead(agentId: string, probe: ProcessProbe = this.processProbe): void {
    const agent = this.core.agents.get(agentId)
    const since = this.staleAtBoot.get(agentId)
    this.staleAtBoot.delete(agentId)
    if (agent === undefined || this.live.has(agentId)) return
    if (isStaleLive(agent, since)) {
      if (this.core.registry.connFor(agent.name) !== undefined) return
      return this.reapProven(
        agent,
        probe,
        'exit inferred at broker start: no reconnect since the previous broker stopped; ',
      )
    }
    if (awaitsExit(agent)) this.reapProven(agent, probe, 'exit inferred while detached: ')
  }

  private reapProven(agent: AgentIdentity, probe: ProcessProbe, prefix: string): void {
    const liveness = agentLiveness(agent, probe)
    if (liveness.dead) this.recordInferredExit(agent, liveness, `${prefix}${liveness.reason}`)
  }

  /** The row and ledger write both the boot reaper and a resume of a stale `live` row make. */
  private recordInferredExit(agent: AgentIdentity, liveness: DeadLiveness, body: string): void {
    this.core.append({
      kind: 'agent_exited',
      actor: agent.name,
      ref: agent.agentId,
      body,
      meta: {
        inferred: 'true',
        ...(liveness.pid === undefined ? {} : { pid: String(liveness.pid) }),
        ...footprintMeta(this.footprint.take(agent.agentId)),
      },
    })
    logEvent('agent_exited', {
      agentId: agent.agentId,
      name: agent.name,
      code: null,
      inferred: true,
      reason: liveness.reason,
    })
    this.shadow.finishByAgent(
      agent.agentId,
      exitTerminal({ code: null, signal: null, inferred: true }, undefined, undefined),
    )
  }

  /** CC-488: a `live` row is resumable only when no connection, launcher or session holds it; records the exit if so. */
  private async staleLiveRefusal(identity: AgentIdentity): Promise<string | undefined> {
    if (this.core.registry.connFor(identity.name) !== undefined || this.live.has(identity.agentId))
      return `${identity.name} is already live; message it instead`
    const running = await this.launcherRunning(identity.agentId)
    if (running === true) return `${identity.name} is already live: its run-agent is still running`
    if (running === undefined)
      return `${identity.name} is marked live and the process table could not be read, so it is not resumed`
    const liveness = agentLiveness(identity, this.processProbe)
    if (!liveness.dead) return `${identity.name} is already live: ${liveness.reason}`
    this.recordInferredExit(
      identity,
      liveness,
      `live row with no process (no connection, no run-agent, ${liveness.reason})`,
    )
    return undefined
  }

  /** A launch takes over the slot, so its release moves to `recordExit`. */
  private forgetReattach(agentId: string): void {
    clearTimeout(this.reattached.get(agentId))
    this.reattached.delete(agentId)
  }

  private scheduleSettle(entry: Live): void {
    if (entry.settle) clearTimeout(entry.settle)
    entry.settle = setTimeout(() => {
      // Still detached after the window: infer the exit. No code and no cost,
      // and the roster says so rather than showing zeros it did not measure.
      void this.recordExit(entry.agentId, { code: null, signal: null, inferred: true }, entry)
    }, this.settleMs)
    entry.settle.unref?.()
  }

  /**
   * CC-951: a predecessor that ended while its successor starts. Its slot already moved
   * to the successor, and it did not finish its work, so the exit is recorded and nothing
   * else: no completion hook, no report check, no auto-retire. The teleport is told.
   */
  private recordTeleportingExit(
    entry: Live,
    outcome: { code: number | null; signal: string | null; inferred?: boolean },
  ): void {
    this.live.delete(entry.agentId)
    this.core.append({
      kind: 'agent_exited',
      actor: entry.name,
      ref: entry.agentId,
      body: 'exited while its teleport successor was starting',
      meta: {
        ...(outcome.code === null ? {} : { code: String(outcome.code) }),
        ...(outcome.signal === null ? {} : { signal: outcome.signal }),
        ...(outcome.inferred ? { inferred: 'true' } : {}),
        ...footprintMeta(this.footprint.take(entry.agentId)),
      },
    })
    logEvent('agent_exited', {
      agentId: entry.agentId,
      name: entry.name,
      code: outcome.code,
      teleporting: true,
    })
    this.teleporter.predecessorExited(entry.agentId)
  }

  /**
   * Idempotent: a headless child's exit and its detach settle can both arrive.
   *
   * `launch`, when given, is the exact `Live` object this exit belongs to —
   * captured at `track()` time, when the process it reports on was started.
   * A mode switch replaces `this.live`'s entry for the same agentId with a NEW
   * launch before the OLD process has actually exited; when it finally does,
   * this callback still fires with the OLD `agentId`, and without the identity
   * check below it would delete and record-exited the agent that replaced it —
   * one that is live and well. Comparing against the CURRENT entry, rather than
   * trusting `agentId` alone, is what makes a stale exit a no-op.
   */
  private async recordExit(
    agentId: string,
    outcome: { code: number | null; signal: string | null; inferred?: boolean; failed?: string },
    launch?: Live,
  ): Promise<void> {
    const entry = this.live.get(agentId)
    if (!entry) return
    if (launch !== undefined && launch !== entry) return
    if (entry.settle) clearTimeout(entry.settle)
    if (entry.attachCeiling) clearTimeout(entry.attachCeiling)
    this.attachWaiters.delete(agentId)
    if (entry.teleporting === true) return this.recordTeleportingExit(entry, outcome)
    this.live.delete(agentId)
    this.semaphore.release(agentId)

    // An agent that dies without ever having registered FAILED TO START, and the
    // rule lives here rather than only in `failSpawn` because two listeners race
    // for a headless child's exit: `track` wires one, `verifyAttach` wires
    // another, and `track`'s was registered first. When it won, the spawn was
    // recorded as an ordinary exit, `failSpawn` found no live entry and returned
    // early, and the roster read `finished` for a process that never came up —
    // the exact distinction this task exists to draw. Deriving it from the log
    // makes whichever listener arrives first produce the same terminal state.
    const failed = outcome.failed ?? this.unattachedExit(entry.name, agentId, outcome)
    const crash = this.crashAtExit(entry, outcome, failed !== undefined)

    this.core.append({
      kind: 'agent_exited',
      actor: entry.name,
      ref: agentId,
      body: failed ?? (outcome.inferred ? 'exit inferred from presence; no exit code available' : ''),
      meta: {
        ...(outcome.code === null ? {} : { code: String(outcome.code) }),
        ...(outcome.signal === null ? {} : { signal: outcome.signal }),
        ...(outcome.inferred ? { inferred: 'true' } : {}),
        ...(failed === undefined ? {} : { failed: 'true' }),
        ...footprintMeta(this.footprint.take(agentId)),
        ...crash.meta,
      },
    })
    if (crash.looped) this.noticeCrashLoop(agentId)
    logEvent('agent_exited', { agentId, name: entry.name, code: outcome.code, inferred: outcome.inferred })
    if (entry.cancelReason !== MODE_SWITCH && entry.cancelReason !== IDLE_PRINT_WAKE)
      await this.reportReviewerTree(entry)
    const resumeOn =
      failed === undefined &&
      entry.cancelReason === undefined &&
      entry.handle.surface === 'headless' &&
      !crash.looped
        ? this.reportIfUnreported(agentId, entry.name)
        : undefined
    this.shadow.finish(entry.executionId, exitTerminal(outcome, failed, entry.cancelReason))
    // CC-95: the surface goes with the agent, including on an INFERRED exit —
    // which is the only exit an iTerm agent ever gets, and therefore the only
    // path that could have closed the panes found sitting at `-zsh` for six
    // hours. The old rule ("an exit closes nothing; a human reading its last
    // output should not have the pane vanish") lost to what actually happened:
    // four agents finished, nobody read anything, and a human retired them by
    // hand at 12:47Z to reclaim the screen. Retire still closes panes the same
    // way; this only makes the agent's own death do it too. Only a surface the
    // broker OPENED is ever a candidate — that constraint is untouched, and it
    // is what still protects a human's own pane and an adopted session's window.
    // CC-95, as the human settled it: the profile decides, not the exit path.
    // Both global answers had been tried and both were wrong for somebody —
    // retire-only left four finished agents' panes at `-zsh` for six and a half
    // hours, and closing unconditionally throws away the last output of a
    // collaborator somebody is reading. A row written before the field existed
    // has no value here and keeps its pane, which is the safe direction: a
    // silent upgrade would start destroying panes nobody opted in for.
    if (this.closesOnExit(agentId)) await this.closeSurface(entry)
    const exit = { code: outcome.code, signal: outcome.signal, inferred: outcome.inferred ?? false }
    this.fireHook('on_complete', { ...(await this.completionPayloadFor(agentId, exit)) })
    if (failed === undefined && entry.cancelReason === undefined) {
      await this.retireIfReported(agentId)
      await this.parkReviewerIfReported(agentId)
      if (resumeOn === undefined) await this.parkImplementerIfExited(agentId)
    }
    if (resumeOn !== undefined) await this.resumeForBackground(agentId, entry.name, resumeOn)
    if (entry.cancelReason === IDLE_PRINT_WAKE) await this.resumeIdlePrint(agentId, entry.name)
  }

  /** CC-1671 S4: this exit's place in the identity's run of crashes at launch, as `agent_exited` meta. */
  private crashAtExit(
    entry: Live,
    outcome: { code: number | null; signal: string | null; inferred?: boolean },
    failed: boolean,
  ): { meta: Record<string, string>; looped: boolean } {
    const identity = this.core.agents.get(entry.agentId)
    if (identity === undefined) return { meta: {}, looped: false }
    const { streak, looped } = crashStreak(
      {
        ...outcome,
        failed,
        cancelled: entry.cancelReason !== undefined,
        ranMs: Date.now() - this.core.runStartedAt(identity),
        priorStreak: identity.crashStreak ?? 0,
      },
      this.crashLoop(),
    )
    if (streak === 0) return { meta: {}, looped: false }
    const tail = looped ? stderrTail(readOutputTail(agentDir(entry.agentId))) : undefined
    const meta = {
      crash_streak: String(streak),
      ...(looped ? { crash_loop: 'true' } : {}),
      ...(tail === undefined ? {} : { stderr_tail: tail }),
    }
    return { meta, looped }
  }

  /** CC-1671 S4: said once, when the mark lands; a refused relaunch after it is silent to the spawner. */
  private noticeCrashLoop(agentId: string): void {
    const identity = this.core.agents.get(agentId)
    if (identity?.crashLoop === undefined) return
    const { name, spawnedBy: spawner } = identity
    const body = crashLoopNotice(name, identity.crashLoop)
    const { msgId } = this.core.append({
      kind: spawner === HUMAN ? 'notice' : 'message',
      actor: 'agent-chat',
      target: spawner,
      body,
      meta: { event: CRASH_LOOP, agent: name, agent_id: agentId },
    })
    this.core.deliverTo(spawner, { msgId, from: 'agent-chat', text: body, at: Date.now(), event: CRASH_LOOP })
    logEvent(CRASH_LOOP, { agentId, name, spawner, count: identity.crashLoop.count })
  }

  /** CC-763: never rejects; anything that goes wrong gathering the facts leaves the legacy fields. */
  private async completionPayloadFor(agentId: string, exit: ExitFacts): Promise<CompletionPayload> {
    const identity = this.core.agents.get(agentId)
    if (identity === undefined) return { agentId, ...exit }
    try {
      const report = this.core.events.lastStatusReport(
        identity.name,
        reportRecipients(identity.spawnedBy),
        this.core.runStartedAt(identity),
      )
      const transcript = identity.sessionId ? identityTranscript(identity).path : undefined
      return completionPayload({
        agentId,
        agent: identity.name,
        profile: this.core.agents.spawnMeta(agentId).profile ?? identity.profile,
        spawner: identity.spawnedBy,
        exit,
        ...(report === undefined ? {} : { report }),
        ...(transcript === undefined ? {} : { spend: await readTranscriptSpend(transcript) }),
        ...(report === undefined ? { lastAction: readExitTail(transcript).lastAction } : {}),
      })
    } catch (err) {
      logEvent('worker_facts_invalid', { agentId, error: String(err) })
      return { agentId, ...exit }
    }
  }

  /**
   * CC-266: a headless agent that ended its run without a report to its spawner
   * or to burndown's `reportTo` gets one written for it, naming its last action.
   * CC-336: when it ended on a background task, the tail is returned instead, for
   * one resume once the exit is fully recorded; a second such exit is noticed.
   */
  private reportIfUnreported(agentId: string, name: string): ExitTail | undefined {
    const identity = this.core.agents.get(agentId)
    if (identity === undefined) return undefined
    const recipients = reportRecipients(identity.spawnedBy)
    if (this.core.events.hasStatusReport(name, recipients, this.core.runStartedAt(identity))) return undefined
    const tail = readExitTail(identity.sessionId ? identityTranscript(identity).path : undefined)
    const decision = backgroundResumeDecision({
      pendingBackground: tail.pendingBackground,
      resumedForBackgroundThisChain: resumedForBackground(this.core.events.agentEventsFor(agentId)),
    })
    if (decision === 'resume') return tail
    this.notifyUnreported(agentId, name, identity.spawnedBy, tail)
    return undefined
  }

  /** CC-233: undefined for a non-reviewer, so only a reviewer's exit is checked. */
  private async reviewerTreeBefore(profile: string, name: string, cwd: string) {
    return isReviewerSpawn(profile, name) ? treeFingerprint(cwd) : undefined
  }

  /** CC-233: tells the spawner which paths a reviewer left changed in the tree it reviewed. */
  private async reportReviewerTree(entry: Live): Promise<void> {
    if (entry.reviewerTree === undefined) return
    const cwd = entry.allocation.cwd
    const after = await treeFingerprint(cwd)
    const paths = after === undefined ? [] : treeChange(entry.reviewerTree, after)
    if (paths.length === 0) return
    const spawner = this.core.agents.get(entry.agentId)?.spawnedBy ?? HUMAN
    const body = reviewerDirtyText(entry.name, cwd, paths)
    const { msgId } = this.core.append({
      kind: spawner === HUMAN ? 'notice' : 'message',
      actor: 'agent-chat',
      target: spawner,
      body,
      meta: {
        event: REVIEWER_TREE_CHANGED,
        agent: entry.name,
        agent_id: entry.agentId,
        cwd,
        paths: paths.join('\n'),
      },
    })
    this.core.deliverTo(spawner, {
      msgId,
      from: 'agent-chat',
      text: body,
      at: Date.now(),
      event: REVIEWER_TREE_CHANGED,
    })
    logEvent(REVIEWER_TREE_CHANGED, {
      agentId: entry.agentId,
      name: entry.name,
      spawner,
      paths: paths.length,
    })
  }

  /** CC-336: a refused resume (budget, machine stop, no transcript) falls back to the notice. */
  private async resumeForBackground(agentId: string, name: string, tail: ExitTail): Promise<void> {
    const spawner = this.core.agents.get(agentId)?.spawnedBy ?? HUMAN
    const outcome = await this.resume(name, {
      message: BACKGROUND_RESUME_MESSAGE,
      requestedBy: spawner,
      cause: BACKGROUND_RESUME,
    })
    logEvent(BACKGROUND_RESUME, { agentId, name, spawner, ok: outcome.ok })
    if (!outcome.ok) this.notifyUnreported(agentId, name, spawner, tail)
  }

  /** CC-1671 S2: what is running now and what each profile has cost. */
  agentCosts(): AgentCosts {
    const running = this.core.agents
      .roster()
      .filter(agent => agent.state !== 'exited')
      .map(agent => ({
        name: agent.name,
        profile: agent.profile,
        role: agent.workRole ?? 'other',
        ...this.footprint.peek(agent.agentId),
      }))
    return { running, estimates: this.costTable().rows() }
  }

  private costTable(): CostTable {
    return new CostTable(exitFootprints(this.core.events.agentEvents()))
  }

  /** CC-1671 S1: samples each live local agent's process tree on an unref'd interval. Linux reads /proc. */
  startFootprintSampling(everyMs = FOOTPRINT_INTERVAL_MS): void {
    this.stopFootprint?.()
    if (process.platform !== 'linux') return
    const roster = {
      agents: () => this.core.agents.roster(),
      launcherPid,
      hostPid: (name: string) => this.core.registry.hostPidFor(name),
      isRemote: (agent: AgentIdentity) => remoteHostOf(agent) !== undefined,
    }
    this.stopFootprint = startFootprintSampling(this.footprint, () => footprintTargets(roster), everyMs)
  }

  /** CC-1678: retires exited workers whose PR is done on an unref'd interval; without Shepherd's reads it never runs. */
  startMergedRetire(everyMs = MERGED_RETIRE_EVERY_MS): void {
    this.stopMergedRetire?.()
    const skip = this.shepherdSkip
    if (skip === undefined) return
    const reads = passPrReads(readPrState)
    const pass = (): Promise<void> => this.retireMergedPass(skip, reads())
    this.stopMergedRetire = startMergedRetireSweep(pass, everyMs)
  }

  private async retireMergedPass(skip: ShepherdSkipPort, readPr: PrRead): Promise<void> {
    const treeHold = this.burndownTreeHold
    const results = await retireMerged({
      roster: () => this.core.agents.roster(),
      events: () => this.core.events.agentEvents(),
      current: agentId => this.core.agents.get(agentId),
      tracked: agentId => this.live.has(agentId),
      parking: agentId => this.parking.has(agentId),
      presence: agent => this.namePresence(agent),
      lastReport: agent => this.lastReportText(agent),
      treeHold: tree => treeHold?.(tree),
      skip,
      readPr,
      park: (agentId, prHead) => this.parkById(agentId, { checkProcesses: true, prHead }),
      retire: agentId => this.retireById(agentId, 'agent-chat', { keepBranch: true }),
    })
    for (const { action, ...detail } of results)
      logEvent(action === 'retired' ? 'merged_retired' : 'merged_retire_kept', detail)
  }

  /** CC-1669 S2: checks for idle print hosts with waiting mail on an unref'd interval. */
  startIdlePrintWake(everyMs = IDLE_PRINT_WAKE_EVERY_MS): void {
    clearInterval(this.idlePrintTimer)
    this.idlePrintTimer = setInterval(() => this.wakeIdlePrintHosts(), everyMs)
    this.idlePrintTimer.unref?.()
  }

  /**
   * CC-1669 S2: ends each headless print host whose turn has ended and whose oldest spooled
   * message has waited past the threshold. Its exit resumes it with that mail as the prompt
   * ({@link resumeIdlePrint}). Returns the names it ended.
   */
  wakeIdlePrintHosts(now = Date.now()): string[] {
    const woken: string[] = []
    for (const entry of this.live.values())
      if (this.idlePrintWakeIsDue(entry, now) && this.endIdlePrintHost(entry)) woken.push(entry.name)
    return woken
  }

  /** A pane, an interactive host, a process already being stopped or a turn in flight is left alone. */
  private idlePrintWakeIsDue(entry: Live, now: number): boolean {
    if (entry.handle.surface !== 'headless' || entry.cancelReason !== undefined) return false
    if (this.resuming.has(entry.agentId)) return false
    if (this.core.registry.printVerdict(entry.name) === undefined) return false
    const spooledAt = oldestSpooledAt(inboxSpoolDir(entry.agentId))
    if (spooledAt === undefined) return false
    const identity = this.core.agents.get(entry.agentId)
    const transcript = identity?.sessionId ? identityTranscript(identity).path : undefined
    return idlePrintWakeDue({ spooledAt, turnEnded: readTurnEnded(transcript), now })
  }

  /** Ended the way a mode switch ends a process: the tree stays and nothing is retired. */
  private endIdlePrintHost(entry: Live): boolean {
    const hostPid = this.core.registry.hostPidFor(entry.name)
    if (hostPid === undefined) return false
    const ended = this.endSession(entry.name, hostPid, this.core.registry.hostFor(entry.name))
    logEvent(IDLE_PRINT_WAKE, { agentId: entry.agentId, name: entry.name, hostPid, ended: ended.ok })
    if (ended.ok) entry.cancelReason = IDLE_PRINT_WAKE
    return ended.ok
  }

  /**
   * CC-1669 S2: the ended host's spool is drained into the resumed turn's prompt. The claims
   * are deleted once the resume launched and returned to the spool if it did not, so each
   * message is shown once: here, or by the resumed run's own hooks if it did not fit.
   */
  private async resumeIdlePrint(agentId: string, name: string): Promise<void> {
    await this.waitForNameFree(name)
    const dir = inboxSpoolDir(agentId)
    const drained = drainInbox(dir)
    const spawner = this.core.agents.get(agentId)?.spawnedBy ?? HUMAN
    const outcome = await this.resume(name, {
      message: idlePrintWakePrompt(drained.blocks),
      requestedBy: spawner,
      cause: IDLE_PRINT_WAKE,
    })
    logEvent('idle_print_wake_resumed', { agentId, name, ok: outcome.ok, messages: drained.msgIds.length })
    if (!outcome.ok) {
      returnClaims(dir, drained.claimed)
      return this.notifyIdlePrintRefused(name, spawner, outcome.reason)
    }
    releaseClaims(drained.claimed)
    if (drained.msgIds.length > 0)
      this.core.append({ kind: 'inbox_shown', actor: name, meta: { msgIds: drained.msgIds.join(',') } })
  }

  /** The waiting mail stays in the spool; the spawner learns the agent is down and why. */
  private notifyIdlePrintRefused(name: string, spawner: string, reason: string | undefined): void {
    const body =
      `${name} was idle on a background task with messages waiting, so it was ended to deliver them, ` +
      `but its resume was refused: ${reason ?? 'no reason given'}. Resume it with agent_resume.`
    const { msgId } = this.core.append({
      kind: spawner === HUMAN ? 'notice' : 'message',
      actor: 'agent-chat',
      target: spawner,
      body,
      meta: { event: IDLE_PRINT_WAKE, agent: name },
    })
    this.core.deliverTo(spawner, {
      msgId,
      from: 'agent-chat',
      text: body,
      at: Date.now(),
      event: IDLE_PRINT_WAKE,
    })
  }

  /** CC-1182: to the human it is a plain notice, so it leaves the queue on the notice TTL, not the 7-day sweep. */
  private notifyUnreported(agentId: string, name: string, spawner: string, tail: ExitTail): void {
    const body = unreportedExitText(name, tail)
    const { msgId } = this.core.append({
      kind: spawner === HUMAN ? 'notice' : 'message',
      actor: 'agent-chat',
      target: spawner,
      body,
      meta: {
        event: UNREPORTED_EXIT,
        agent: name,
        agent_id: agentId,
        last_action: tail.lastAction,
        ...(tail.pendingBackground ? { pending_background: 'true' } : {}),
      },
    })
    this.core.deliverTo(spawner, {
      msgId,
      from: 'agent-chat',
      text: body,
      at: Date.now(),
      event: UNREPORTED_EXIT,
    })
    logEvent(UNREPORTED_EXIT, { agentId, name, spawner, lastAction: tail.lastAction })
  }

  private refuse(
    req: SpawnRequest,
    reason: string,
    cause:
      | {
          code:
            | 'spawn_rate_limit'
            | MachineRefusalCode
            | AdmissionRefusalCode
            | typeof CRASH_LOOP_REFUSAL
            | SeatBudgetRefusalCode
            | typeof REVIEWER_ACCOUNT_LIMIT
            | typeof ACCOUNT_EXHAUSTED
          retryable: boolean
        }
      | { code: 'broker_draining'; retryable: true; retryAfterMs: number }
      | { code: 'surface_refused' }
      | { code: typeof HARNESS_UNSUPPORTED; retryable: false }
      | {} = {},
  ): SpawnOutcome {
    // An event, not just a reply string: refusals are the security-relevant
    // thing and belong in the log whether or not anyone was watching.
    this.core.append({
      kind: 'agent_spawn_refused',
      actor: req.requestedBy,
      target: req.name,
      body: reason,
      meta: { profile: req.profile },
    })
    logEvent('agent_spawn_refused', { name: req.name, by: req.requestedBy, reason })
    return { ok: false, reason, ...cause }
  }

  /**
   * §11.2: the spawn request is attacker-controlled, and `cwd` decides where a
   * process with the profile's tools gets to read. The policy itself lives in
   * `spawn-cwd.ts`, which is where the reasoning — and CC-62's widening of it
   * from "somewhere a session already sits" to "somewhere in your own workspace
   * that is not a credential directory" — is written down.
   *
   * The human at the CLI is exempt from the location rules, not from existence.
   * They hold no registry entry to be contained by, and reaching a 0600 socket
   * already means being the local user — the same reasoning that lets them spawn
   * at all.
   */
  private checkCwd(cwd: string, requestedBy: string): string | undefined {
    if (requestedBy === HUMAN) {
      try {
        if (!fs.statSync(cwd).isDirectory()) return `cwd is not a directory: ${cwd}`
      } catch {
        return `cwd does not exist: ${cwd}`
      }
      return undefined
    }
    return checkSpawnCwd(cwd, { sessionRoots: this.core.registry.list().map(session => session.cwd) })
  }

  /** Everything checkable before anything is allocated or written. */
  private preflight(req: SpawnRequest, requester: Requester): string | undefined {
    if (RESERVED_NAMES.has(req.name.toLowerCase()))
      return `"${req.name}" is reserved and cannot be used as an agent name`
    const holder = this.core.agents.nameHolder(req.name)
    if (holder !== undefined)
      return `the name "${req.name}" is held by ${describeHolder(holder)}; retire it or choose another`
    if (this.core.registry.connFor(req.name) !== undefined)
      return `a session is already registered as "${req.name}"`
    if (req.requestedBy !== HUMAN && requester.role === 'worker')
      return (
        `${req.requestedBy} is a worker (profile ${requester.profile || 'unknown'}) and cannot spawn ` +
        'agents; report the need to your spawner via chat_send'
      )
    return assignmentRefusal(req)
  }

  /**
   * Checked right after preflight's cheap gates and first of the stateful ones:
   * the human at the CLI is exempt, same reasoning as checkCwd's exemption — they
   * hold no registry entry to be rate-limited by and reaching the socket already
   * means being the local user. Retryable (CC-717): the same spawn succeeds once
   * one of the requester's launches registers or exits.
   */
  private rateRefusal(req: SpawnRequest): SpawnOutcome | undefined {
    if (req.requestedBy === HUMAN) return undefined
    const rate = this.spawnSlots.check(req.requestedBy)
    if (rate.ok) return undefined
    return this.refuse(req, rate.reason, { code: 'spawn_rate_limit', retryable: true })
  }

  /** CC-1671 S3: whether this profile's p90, on top of the readings and recent admissions, clears the limits. */
  private predictedRefusal(
    readers: PredictedCostReaders,
    estimate: AgentCostEstimate,
  ): Extract<AdmissionDecision, { ok: false }> | undefined {
    const memory = readers.readMemoryFree()
    const cpuPressure = readers.readCpuPressure?.() ?? null
    const decision = predictedCostDecision(
      { memory, totalMemoryKb: readers.totalMemoryKb(), cpuPressure, cpuCount: readers.cpuCount() },
      estimate,
      this.spawnSlots.reserved(),
      readers.limits(),
    )
    return decision.ok ? undefined : decision
  }

  /** CC-1671 S3: the burst guard and the slot are one synchronous step, so concurrent spawns cannot overshoot. */
  private holdLaunchSlot(req: SpawnRequest, agentId: string, profile: string): SpawnOutcome | undefined {
    const rateLimited = this.rateRefusal(req)
    if (rateLimited) return rateLimited
    const readers = this.predictedCost
    if (readers === undefined) return void this.spawnSlots.hold(req.requestedBy, agentId)
    const role = req.workRole ?? inferWorkRole(profile, req.name)
    const estimate = this.costTable().estimate(profile, role)
    const predicted = this.predictedRefusal(readers, estimate)
    if (predicted) {
      const { code, retryable, reason } = predicted
      return this.refuse(req, reason, { code, retryable })
    }
    const reservation = { rssKb: estimate.rssKb.p90, cpuCores: estimate.cpuCores.p90 }
    return void this.spawnSlots.hold(req.requestedBy, agentId, reservation)
  }

  /** CC-406, CC-1670: refuses at the headless-agent total, below the memory-free floor or under CPU pressure. */
  private machineRefusal(surface: SurfaceName): Extract<MachineDecision, { ok: false }> | undefined {
    if (this.machineGuard === undefined) return undefined
    const memory = this.machineGuard.readMemoryFree()
    if ('error' in memory) logEvent('machine_guard_reader_failed', { reader: 'memory', error: memory.error })
    const headroom = this.machineGuard.readHeadroom()
    for (const [reader, reading] of Object.entries(headroom))
      if ('error' in reading) logEvent('machine_guard_reader_failed', { reader, error: reading.error })
    const cpuPressure = this.machineGuard.readCpuPressure()
    if (cpuPressure !== null && 'error' in cpuPressure)
      logEvent('machine_guard_reader_failed', { reader: 'cpu_pressure', error: cpuPressure.error })
    const liveHeadless = countLiveHeadless(this.core.agents.roster())
    const decision = machineDecision(
      { liveHeadless, memory, cpuPressure, headroom },
      this.machineGuard.limits(),
      surface === 'headless',
    )
    return decision.ok ? undefined : decision
  }

  /**
   * CC-936: a hand implementer spawn once the seat holds its `handReserve` of them. Follows the overlap gate's
   * mode: warn logs `seat_hand_reserve` and spawns. An unreadable config or ledger lets the spawn through.
   */
  private handReserveRefusal(req: SpawnRequest, profileName: string): string | undefined {
    const gate = this.seatOverlap
    const mode = gate?.mode() ?? 'off'
    if (gate?.handReserve === undefined || mode === 'off' || req.spawnedAs !== undefined) return undefined
    try {
      const facts = gate.handReserve({ name: req.name, spawner: req.requestedBy, task: req.task })
      if (facts === undefined) return undefined
      const overflow = handReserveOverflow({
        mode,
        role: req.workRole ?? inferWorkRole(profileName, req.name),
        override: req.override,
        reserve: facts.reserve,
        held: handSpawnRoles(this.core.agents.roster(), facts.prefix, facts.held).filter(
          role => role === 'implementers',
        ).length,
      })
      if (overflow === undefined) return undefined
      logEvent(SEAT_HAND_RESERVE, { name: req.name, mode, requested_by: req.requestedBy })
      return mode === 'refuse' ? overflow.reason : undefined
    } catch (err) {
      logEvent('seat_spawn_gate_failed', {
        name: req.name,
        error: err instanceof Error ? err.message : String(err),
      })
      return undefined
    }
  }

  /**
   * CC-965: a seat's implementer spawn named without the seat's prefix, which would escape its reserve and logs.
   * Follows the overlap gate's mode: warn logs `seat_spawn_unprefixed` and spawns. An unreadable seat lets it through.
   */
  private unprefixedRefusal(req: SpawnRequest, profileName: string): string | undefined {
    const gate = this.seatOverlap
    const mode = gate?.mode() ?? 'off'
    if (gate?.spawnerSeat === undefined || mode === 'off' || req.spawnedAs !== undefined) return undefined
    try {
      const seat = gate.spawnerSeat({ name: req.name, spawner: req.requestedBy, task: req.task })
      if (seat === undefined) return undefined
      const unprefixed = unprefixedSeatSpawn({
        mode,
        role: req.workRole ?? inferWorkRole(profileName, req.name),
        override: req.override,
        prefix: seat.prefix,
        name: req.name,
      })
      if (unprefixed === undefined) return undefined
      logEvent(SEAT_SPAWN_UNPREFIXED, { name: req.name, mode, requested_by: req.requestedBy })
      return mode === 'refuse' ? unprefixed.reason : undefined
    } catch (err) {
      logEvent('seat_spawn_gate_failed', {
        name: req.name,
        error: err instanceof Error ? err.message : String(err),
      })
      return undefined
    }
  }

  /**
   * CC-932: a hand spawn of a task burndown has claimed or that is brief-ready. Warn mode logs
   * `seat_spawn_overlap` and lets it through; refuse mode returns the reason. The tick's and Shepherd's own
   * spawns carry `spawnedAs` and never pass through. An unreadable ledger lets the spawn through.
   */
  private seatOverlapRefusal(req: SpawnRequest, profileName: string): string | undefined {
    const gate = this.seatOverlap
    const mode = gate?.mode() ?? 'off'
    if (gate === undefined || mode === 'off' || req.spawnedAs !== undefined) return undefined
    try {
      const facts = gate.read({ name: req.name, spawner: req.requestedBy, task: req.task })
      const overlap = spawnOverlap({
        mode,
        role: req.workRole ?? inferWorkRole(profileName, req.name),
        override: req.override,
        task: facts?.task,
        claims: facts?.claims ?? [],
        briefReady: facts?.briefReady,
      })
      if (overlap === undefined) return undefined
      logEvent(SEAT_SPAWN_OVERLAP, {
        name: req.name,
        task: overlap.task,
        holder: overlap.holder,
        mode,
        requested_by: req.requestedBy,
      })
      return mode === 'refuse' ? overlap.reason : undefined
    } catch (err) {
      logEvent('seat_spawn_gate_failed', {
        name: req.name,
        error: err instanceof Error ? err.message : String(err),
      })
      return undefined
    }
  }

  /** CC-288: refuses a seat-prefixed spawn whose billed pool is past a charter budget stop; an unreadable seat lets it through. */
  private seatBudgetRefusal(req: SpawnRequest, profile: SpawnProfile, configDir: string): string | undefined {
    if (this.seatBudget === undefined) return undefined
    let read: SeatSpawnRead
    try {
      read = this.seatBudget.read({
        name: req.name,
        spawner: this.seatSpawner(req),
        configDir,
        now: new Date(),
      })
    } catch (err) {
      logEvent('seat_spawn_gate_failed', {
        name: req.name,
        error: err instanceof Error ? err.message : String(err),
      })
      return undefined
    }
    if (read.kind === 'none') return undefined
    if (read.kind === 'skip') {
      logEvent('seat_spawn_gate', { name: req.name, allow: true, reason: read.reason })
      return undefined
    }
    const role = req.workRole ?? inferWorkRole(profile.name, req.name)
    const verdict = seatSpawnGate({ ...read.input, model: profile.model, role })
    logEvent('seat_spawn_gate', { name: req.name, allow: verdict.allow, reason: verdict.reason })
    return verdict.allow ? undefined : `seat budget stop: ${verdict.reason}`
  }

  /**
   * TP-4560: Shepherd spawns a successor over the CLI, so `human` does not say whose work it continues. The seat
   * gate reads the spawner recorded for the agent the successor's chain started from; unrecorded, `human` stands.
   */
  private seatSpawner(req: SpawnRequest): string {
    if (req.requestedBy !== HUMAN) return req.requestedBy
    const origin = fixRoundRoot(req.predecessor ?? req.name)
    if (origin === req.name) return HUMAN
    const agent = this.core.agents
      .roster({ includeRetired: true })
      .find(a => a.name === origin && a.origin === 'spawned')
    return agent?.spawnedBy ?? HUMAN
  }

  /** CC-1078: refuses a reviewer spawn into an account at or past its five_hour ceiling; a reader failure lets it through. */
  private reviewerAccountRefusal(
    req: SpawnRequest,
    profile: SpawnProfile,
    configDir: string,
  ): string | undefined {
    if (this.reviewerAccount === undefined) return undefined
    const role = req.workRole
    if (!isReviewerSpawn(profile.name, req.name) && role !== 'reviewer' && role !== 'shepherd-review')
      return undefined
    const now = Date.now()
    let read: ReviewerAccountRead
    try {
      read = this.reviewerAccount.read(configDir, now)
    } catch (err) {
      logEvent('reviewer_account_gate_failed', {
        name: req.name,
        error: err instanceof Error ? err.message : String(err),
      })
      return undefined
    }
    const verdict = reviewerAccountGate(read, now)
    logEvent('reviewer_account_gate', { name: req.name, allow: verdict.allow, reason: verdict.reason })
    return verdict.allow ? undefined : verdict.reason
  }

  /**
   * CC-606: the pick for a seat's spawn, walked past the budget gate and recorded; undefined when no seat
   * owns it or the pick is off. Any failure logs and returns undefined, so the spawn bills as it would unrouted.
   */
  private poolRoute(
    req: SpawnRequest,
    site: { homeDir: string; cwd: string; initiative?: string },
    gate: (configDir: string) => string | undefined,
  ): PoolRoute | undefined {
    const pinned = req.configDir !== undefined && req.configDir !== ''
    try {
      const mode = this.poolPick?.mode() ?? 'off'
      if (this.poolPick === undefined || mode === 'off') return undefined
      const read = this.poolPick.read({
        name: req.name,
        spawner: req.requestedBy,
        pinned,
        now: new Date(),
        ...site,
      })
      if (read.kind === 'none') return undefined
      const route = routePool(read, mode, gate)
      this.recordPoolPick(req.name, route.record, pinned)
      return pinned ? { record: route.record } : route
    } catch (err) {
      logEvent('pool_pick_failed', {
        name: req.name,
        error: err instanceof Error ? err.message : String(err),
      })
      return undefined
    }
  }

  /** A pinned spawn's pick is logged only: its row would say nothing a shadow comparison needs. */
  private recordPoolPick(agent: string, record: PoolPickRecord, pinned: boolean): void {
    if (!pinned) this.appendPoolPick(agent, record)
    // CC-615: logged after the row, so a throwing append never leaves a line naming a pool the spawn does not bill.
    logEvent('pool_pick', { name: agent, ...record })
  }

  private appendPoolPick(agent: string, record: PoolPickRecord): void {
    this.core.append({
      kind: 'notice',
      actor: 'agent-chat',
      target: record.seat,
      body: poolPickText(agent, record),
      meta: {
        pool_pick: record.mode,
        would: String(record.would),
        agent,
        home: record.home ?? '',
        chosen: record.chosen ?? '',
        candidates: JSON.stringify(record.candidates),
      },
    })
  }

  /**
   * The account the spawn bills, past the seat budget gate. Shadow mode records the pool pick and keeps
   * `account`; enforce mode bills the picked pool, and refuses only when every eligible pool and `account` are closed.
   */
  private billedAccount(
    req: SpawnRequest,
    profile: SpawnProfile,
    account: Account,
    site: { cwd: string; initiative?: string; keepsAccount: boolean; rotates: boolean },
  ): { account: Account } | { refusal: string } {
    const refusals = new Map<string, string | undefined>()
    const gate = (dir: string): string | undefined => {
      if (!refusals.has(dir)) refusals.set(dir, this.seatBudgetRefusal(req, profile, dir))
      return refusals.get(dir)
    }
    const { keepsAccount, rotates, ...where } = site
    const route = keepsAccount ? undefined : this.poolRoute(req, { homeDir: account.dir, ...where }, gate)
    if (route?.redirect !== undefined) return { account: poolAccount(route.redirect.configDir) }
    // A seat spawn's account belongs to its pool pick (CC-606), so only an unrouted one rotates.
    const billed =
      rotates && !keepsAccount && route === undefined ? this.rotated(req, profile, account, gate) : account
    const overBudget = gate(billed.dir)
    if (overBudget === undefined) return { account: billed }
    return { refusal: homeClosedRefusal(route, overBudget) }
  }

  /**
   * CC-1546: the account with the most fresh seven_day headroom, or `account` when none is fresher
   * or the read fails. An explicit `config_dir` never rotates. Every gate that would refuse this
   * spawn on a candidate (the seat budget, the reviewer account gate) disqualifies it before the
   * pick, so rotation never moves a spawn onto an account that then refuses it.
   */
  private rotated(
    req: SpawnRequest,
    profile: SpawnProfile,
    account: Account,
    gate: (dir: string) => string | undefined,
  ): Account {
    const readers = this.accountRotation
    if (readers === undefined || account.source === 'explicit') return account
    try {
      const config = readers.config()
      if (!config.enabled) return account
      const refuses = (dir: string): boolean =>
        gate(dir) !== undefined || this.reviewerAccountRefusal(req, profile, dir) !== undefined
      const { dir, record: rotation } = pickAccount(account.dir, readers.readings(), config, refuses)
      logEvent('account_rotation', { name: req.name, from: rotation.from, chosen: rotation.chosen })
      return rotation.rotated ? { ...rotationAccount(dir), rotation } : { ...account, rotation }
    } catch (err) {
      logEvent('account_rotation_failed', {
        name: req.name,
        error: err instanceof Error ? err.message : String(err),
      })
      return account
    }
  }

  /**
   * TP-4214: a requested account, picked here and then pinned as an explicit `config_dir`, so no
   * pool route or rotation moves it. The spawn's own gates disqualify a candidate before the pick,
   * as rotation's do, and a refusal carries every reading the pick compared.
   */
  private requestedAccount(req: SpawnRequest, profile: SpawnProfile): RequestedAccount | undefined {
    const wanted = req.account
    if (wanted === undefined) return undefined
    if (req.configDir !== undefined) return { refused: this.refuse(req, ACCOUNT_TWICE) }
    const readers = this.accountRotation
    if (readers === undefined)
      return { refused: this.refuse(req, `account ${wanted}: this broker reads no account usage`) }
    const choice = this.pickRequested(req, profile, readers, wanted)
    if ('error' in choice) return { refused: this.refuse(req, choice.error) }
    if (choice.ok) return choice
    const cause = choice.unknown ? {} : ({ code: ACCOUNT_EXHAUSTED, retryable: true } as const)
    return { refused: { ...this.refuse(req, choice.reason, cause), account: choice.text } }
  }

  private pickRequested(
    req: SpawnRequest,
    profile: SpawnProfile,
    readers: AccountRotationReaders,
    wanted: string,
  ): AccountChoice | { error: string } {
    const refuses = (dir: string): boolean =>
      this.seatBudgetRefusal(req, profile, dir) !== undefined ||
      this.reviewerAccountRefusal(req, profile, dir) !== undefined
    const preferDir = req.spawnerConfigDir ?? (req.spawnerIsSession === true ? defaultConfigDir() : undefined)
    try {
      return chooseAccount(readers.readings(), readers.config(), {
        account: wanted,
        refuses,
        ...(preferDir === undefined ? {} : { preferDir }),
        ...(readers.identify === undefined ? {} : { identify: readers.identify }),
      })
    } catch (err) {
      return { error: `account ${wanted}: the readings could not be read (${(err as Error).message})` }
    }
  }

  /** The requester's OWN `agent_spawned` row — the only record of what it was granted. */
  private spawnEventOf(agentId: string) {
    return this.core.events.agentEvents().find(row => row.kind === 'agent_spawned' && row.msgId === agentId)
  }

  /**
   * Spawn-tree depth of a spawn requested by `parentAgentId`, read from the
   * parent's own recorded depth rather than recomputed by walking the chain,
   * because the parent may itself be retired. Placement reads it; the cap is
   * `MAX_COORDINATOR_DEPTH`, counted by `requesterOf`.
   */
  private depthOf(parentAgentId: string | undefined): number {
    if (!parentAgentId) return 1
    const parentDepth = Number.parseInt(this.spawnEventOf(parentAgentId)?.meta.depth ?? '1', 10)
    return (Number.isFinite(parentDepth) ? parentDepth : 1) + 1
  }

  /**
   * CC-1466: a seat relaunch keeps where its earlier identity sat. Only an identity of the same name
   * counts, and each depth only rises, so the carry can tighten the coordinator cap but never loosen it.
   */
  private lineageOf(req: SpawnRequest, computed: Lineage): Lineage {
    const row = req.lineageFrom === undefined ? undefined : this.spawnEventOf(req.lineageFrom)
    if (row === undefined || row.target !== req.name) return computed
    return {
      ...computed,
      depth: raised(computed.depth, row.meta.depth),
      coordinatorDepth: raised(computed.coordinatorDepth, row.meta.coordinator_depth ?? row.meta.depth),
    }
  }

  /**
   * The requester's role and coordinator depth, read from its own spawn row so
   * both survive its spawner. No parent is a human-started root; a parent with
   * no row resolves to a worker, because a cap that opens on missing data is not one.
   *
   * CC-1615: the holder of a policy seat is a root coordinator whatever depth its row carried.
   * The policy is read per request, so a revoke applies to the next one.
   */
  private requesterOf(parentAgentId: string | undefined, claim: SeatClaim = {}): Requester {
    if (!parentAgentId) return { role: 'coordinator', coordinatorDepth: 0, profile: '' }
    const row = this.spawnEventOf(parentAgentId)
    const meta = row?.meta ?? {}
    const profile = meta.profile ?? ''
    const seat = seatRootOf(row, claim, loadSeatPolicy())
    if (seat !== undefined) return { role: 'coordinator', coordinatorDepth: 0, profile, seat }
    // A row from before CC-163 has only `depth`, which counts every link and so never undercounts.
    const recorded = Number.parseInt(meta.coordinator_depth ?? meta.depth ?? '1', 10)
    return {
      role: recordedRole(meta),
      coordinatorDepth: Number.isFinite(recorded) ? recorded : 1,
      profile,
    }
  }

  /** The requester of a spawn, with what its connection proved about the seat it holds. */
  private requesterFor(req: SpawnRequest): Requester {
    return this.requesterOf(req.parentAgentId, { binding: req.requesterBinding, name: req.requestedBy })
  }

  /**
   * CC-1094: loads a profile for a launch. A profile file rewritten since broker start may have lost its
   * denies to the agent that rewrote it, so an agent launch of it is flagged or, under `refuse`, refused.
   * Only a human's own spawn accepts it. A resume or surface switch never does: the background
   * auto-resume and the decider's CLI resume both arrive as HUMAN.
   */
  private loadCheckedProfile(
    name: string,
    by: string | undefined,
    human: boolean,
    humanUnproven?: string,
  ): AgentProfile | { error: string } {
    const { profile, source } = loadProfileSource(name)
    if ('error' in profile) return profile
    const drift = this.profileBaseline.drift(profile.name, source)
    if (drift === undefined) return profile
    const refused = !human && this.profileDriftMode === 'refuse'
    logEvent('profile_drift', { profile: profile.name, by, human, drift, refused, humanUnproven })
    const why = humanUnproven === undefined ? '' : ` (not proven human: ${humanUnproven})`
    if (refused)
      return {
        error: `${drift}; profileDrift=refuse holds agent launches of it until a human spawns it, from a shell outside Claude Code${why}`,
      }
    if (human) this.profileBaseline.accept(profile.name, source)
    const note = human ? 'taken as the new baseline' : 'review it before trusting its denies'
    return { ...profile, warnings: [...(profile.warnings ?? []), `${drift}; ${note}`] }
  }

  /** CC-1516: a resume, surface switch or teleport launches too, so a harness with no launch plan refuses there as well. */
  private loadLaunchableProfile(name: string, by: string | undefined): AgentProfile | { error: string } {
    const profile = this.loadCheckedProfile(name, by, false)
    if ('error' in profile) return profile
    const harness = harnessRefusal(profile)
    return harness === undefined ? profile : { error: harness }
  }

  /**
   * CC-1615: a launch under a policy seat's name. With a listed launch profile it starts the seat's
   * root holder, which the coordinator depth cap does not bound. With any other profile it is an
   * ordinary agent, and the spawn result says so.
   */
  private seatLaunchOf(
    req: SpawnRequest,
    profile: AgentProfile,
  ): { profile: AgentProfile; startsRoot: boolean } {
    const policy = loadSeatPolicy()
    if (policySeat(policy, req.name) === undefined) return { profile, startsRoot: false }
    if (startsSeatRoot(policy, req.name, profile.name)) return { profile, startsRoot: true }
    logEvent('seat_root_denied', { name: req.name, profile: profile.name, by: req.requestedBy })
    const warning =
      `"${req.name}" is a root seat in ${seatPolicyPath()}, but profile "${profile.name}" is not one ` +
      'of its launch profiles, so this agent holds no seat authority'
    return { profile: { ...profile, warnings: [...(profile.warnings ?? []), warning] }, startsRoot: false }
  }

  /**
   * CC-163: what the TARGET profile's role allows, checked once the profile is loaded. CC-1675: a
   * depth refusal names the seat-policy entry that would have made the requester a root.
   */
  private checkRole(
    req: SpawnRequest,
    profile: AgentProfile,
    coordinatorDepth: number,
    requester: Requester,
  ): string | undefined {
    if (req.remoteControl && roleOf(profile) === 'worker')
      return (
        `profile "${profile.name}" is a worker and cannot run with Remote Control; only a ` +
        'coordinator profile may. Spawn without remote_control, or choose a coordinator profile'
      )
    if (coordinatorDepth > MAX_COORDINATOR_DEPTH)
      return (
        `coordinator depth ${coordinatorDepth} exceeds the cap of ${MAX_COORDINATOR_DEPTH}, and ` +
        `${seatRootGap(loadSeatPolicy(), req.requestedBy, requester.profile)}, so it is not a root seat; ` +
        'spawn a worker profile instead, ask the owner to add that entry, or ask the human to start this coordinator'
      )
    return undefined
  }

  /**
   * What the requester itself was granted, or undefined when nothing granted it
   * anything — which is the exemption, not a failure to find one.
   *
   * A session a human started directly has no profile: it runs under that
   * human's own Claude Code settings, and the broker has no bound on it to hold
   * a spawn to. An ADOPTED session is that same case wearing an identity, so its
   * row is skipped by origin rather than by its empty tool list. Only an agent
   * the broker handed a profile to has a boundary here to be held to.
   */
  private toolSetOf(
    parentAgentId: string | undefined,
    field: 'allowed_tools' | 'disallowed_tools',
  ): Set<string> | undefined {
    if (!parentAgentId) return undefined
    const spawn = this.spawnEventOf(parentAgentId)
    if (!spawn || spawn.meta.origin === 'adopted') return undefined
    const tools = (spawn.meta[field] ?? '')
      .split(',')
      .map(tool => tool.trim())
      .filter(tool => tool !== '')
    return tools.length === 0 ? undefined : new Set(tools)
  }

  private grantedTools(parentAgentId: string | undefined): Set<string> | undefined {
    return this.toolSetOf(parentAgentId, 'allowed_tools')
  }

  /**
   * CC-39: an agent may not spawn a peer more capable than itself.
   *
   * `agent_spawn` resolves a profile BY NAME, and `AGENT_CHAT_TOOLS` is appended
   * to every profile's allowlist unconditionally (`launch-plan.ts`) while no
   * profile denies `agent_spawn` — so a read-only `explorer` could already ask
   * for `profile: "peer"` and get a `Bash`-capable agent back, with no Write and
   * no custom profile file needed. The privilege was never checked against the
   * requester's own; this is that check, at the one enforcement point a spawn
   * has to pass through.
   *
   * CC-1654: a bare grant covers its scoped forms (see `held`), one level and one
   * way, and nothing else: a parent scoped to `Bash(git:*)` does not satisfy a
   * child asking for plain `Bash` or for `Bash(git push:*)`, and a mismatch
   * nobody here can reason about refuses. Over-refusing costs a human one
   * explicit spawn; under-refusing hands out a shell. What a bare grant covered
   * comes back so the spawn row can record it.
   *
   * CC-40: the allow-side check above is not the whole story. `profiles.ts`
   * itself says the deny list is what actually confines a profile — allowedTools
   * only grants — so a parent could pass the allow-side check while spawning a
   * child whose deny list is strictly weaker than its own (same allowedTools,
   * fewer disallowedTools). Symmetric check: every tool the parent was denied
   * must still be denied to the child, or refuse the same way.
   *
   * CC-451: the one hole in the allow side. `exemptionFor` lets a coordinator
   * grant the configured web-read tools it lacks; what was exempted comes back
   * so the spawn row can record it.
   */
  private checkEscalation(req: SpawnRequest, profile: AgentProfile): { refusal: string } | Admitted {
    if (req.requestedBy === HUMAN) return NOTHING_ADMITTED
    const { seat } = this.requesterFor(req)
    if (seat !== undefined) return this.checkCeiling(seat, profile)

    const admitted = this.allowSide(req, profile)
    if ('refusal' in admitted) return admitted
    const relaxed = this.relaxedDenies(req, profile)
    return relaxed ?? admitted
  }

  /** CC-39 and CC-451: every tool the child allows is held by the parent, or exempted for it. */
  private allowSide(req: SpawnRequest, profile: AgentProfile): { refusal: string } | Admitted {
    const granted = this.grantedTools(req.parentAgentId)
    if (granted === undefined) return NOTHING_ADMITTED
    const missing = profile.allowedTools.filter(tool => !held(granted, tool))
    const exempt = this.exemptionFor(req, profile)
    const escalated = missing.filter(tool => !exempt.has(tool))
    if (escalated.length > 0) {
      return {
        refusal:
          `profile "${profile.name}" grants tools you were not granted (${escalated.join(', ')}); ` +
          'an agent cannot spawn a peer more capable than itself — ask the human to spawn it',
      }
    }
    return {
      exempted: missing.filter(tool => exempt.has(tool)),
      covered: profile.allowedTools.filter(tool => !granted.has(tool) && held(granted, tool)),
    }
  }

  /** CC-40: the refusal when the child does not deny every tool its parent was denied. */
  private relaxedDenies(req: SpawnRequest, profile: AgentProfile): { refusal: string } | undefined {
    const parentDenied = this.toolSetOf(req.parentAgentId, 'disallowed_tools')
    if (parentDenied === undefined) return undefined
    const childDenied = new Set(profile.disallowedTools ?? [])
    const relaxed = [...parentDenied].filter(tool => !stillDenied(childDenied, tool))
    if (relaxed.length === 0) return undefined
    return {
      refusal:
        `profile "${profile.name}" does not deny tools you were denied (${relaxed.join(', ')}); ` +
        'a spawned peer cannot have a weaker deny list than its parent — ask the human to spawn it',
    }
  }

  /**
   * CC-1615: a root seat spawns exactly its ceiling, by profile name, in place of CC-39/40. Trusting a
   * name means trusting its file, so a ceiling profile changed since broker start is refused under
   * any `profileDrift` mode.
   */
  private checkCeiling(seat: string, profile: AgentProfile): { refusal: string } | Admitted {
    const entry = policySeat(loadSeatPolicy(), seat)
    if (entry === undefined) return { refusal: `seat "${seat}" is no longer in ${seatPolicyPath()}` }
    const outside = ceilingRefusal(seat, entry, profile.name)
    if (outside !== undefined) return { refusal: outside }
    const { source } = loadProfileSource(profile.name)
    const drift = this.profileBaseline.drift(profile.name, source)
    if (drift !== undefined) return { refusal: ceilingDriftRefusal(seat, profile.name, drift) }
    return NOTHING_ADMITTED
  }

  private exemptionFor(req: SpawnRequest, profile: AgentProfile): Set<string> {
    return coordinatorExemption(this.requesterFor(req).role, profile, resolveCoordinatorGrantableTools())
  }

  /**
   * CC-63. Nothing when the spawn did not ask for a briefing; otherwise the
   * orientation block, or the reason there is not one.
   *
   * The requester's cwd comes from the REGISTRY, not from the request — the same
   * discipline `anchor` and `parentAgentId` follow. A slug is a pointer to a
   * directory that gets read and handed to a new process, so letting the caller
   * assert where it is standing would turn `auto` into "read me any initiative".
   *
   * CC-1596: scoped by the profile's contract, not the spawn's `return_contract`, which
   * only says the brief carries its own report format.
   */
  private async briefingFor(
    req: SpawnRequest,
    targetCwd: string,
    profile: AgentProfile,
  ): Promise<BriefingResult | undefined> {
    if (req.briefing === undefined) return undefined
    const requester = this.core.registry.list().find(session => session.name === req.requestedBy)
    return resolveSpawnBriefing({
      briefing: req.briefing,
      brief: req.brief,
      scope: contractOf(profile) === 'implementer' ? 'implementer' : 'full',
      ...(requester ? { requesterCwd: requester.cwd } : {}),
      targetCwd,
    })
  }

  /**
   * CC-44. The transcript a fork starts from, which is ALWAYS the requester's own.
   *
   * Resolved from the REGISTRY, exactly as `briefingFor` resolves a cwd and for a
   * sharper version of the same reason: a fork copies a whole conversation into a
   * new process, so a request that could name someone else's would be "hand me
   * that agent's context" wearing a spawn's clothes. The request may only SAY
   * which session it is, and saying the wrong one is refused rather than
   * corrected — a client that believes it is forking a peer should learn it is
   * not, instead of silently getting its own transcript back.
   */
  private forkSource(req: SpawnRequest): { path: string; sessionId: string } | { error: string } {
    const requester = this.core.registry.list().find(session => session.name === req.requestedBy)
    const own = requester?.observed?.claudeSessionId ?? ''
    if (requester === undefined || own === '') {
      return {
        error:
          'inherit: "context" forks the conversation of the session that asked for it, and the broker ' +
          'has no Claude Code session id for you — the human at the CLI has none, and neither does a ' +
          'client that is not a session. Spawn without it and put what the agent needs in the brief.',
      }
    }
    if (req.forkFrom !== undefined && req.forkFrom !== own) {
      return {
        error:
          `refusing to fork session ${req.forkFrom}: it is not yours. A fork hands an entire ` +
          'conversation to a new process, so only the session that holds one may fork it — ask that ' +
          'session to fork itself.',
      }
    }
    const found = findTranscript(requester.cwd, own)
    if (!found.exists) {
      return {
        error:
          `no transcript on disk for your session yet (${found.path}), so there is nothing to inherit. ` +
          'A session that has not completed a turn, or one started with --no-session-persistence, ' +
          'cannot be forked.',
      }
    }
    return { path: found.path, sessionId: own }
  }

  async spawn(req: SpawnRequest): Promise<SpawnOutcome> {
    const session = req.resumeSession
    if (session === undefined) return this.spawnUnguarded(req)
    const inFlight = this.sessionLaunchRefusal(session)
    if (inFlight) return this.refuse(req, inFlight)
    return this.holdingLaunch({ name: req.name, sessionId: session }, () => this.spawnUnguarded(req))
  }

  private async spawnUnguarded(req: SpawnRequest): Promise<SpawnOutcome> {
    const requester = this.requesterFor(req)
    const blocked = this.preflight(req, requester)
    if (blocked) return this.refuse(req, blocked)
    const drained = this.drainRefusal()
    if (drained) {
      const { reason, ...cause } = drained
      return this.refuse(req, reason, cause)
    }
    const crashLooping = this.lineageCrashRefusal(req)
    if (crashLooping) return this.refuse(req, crashLooping, { code: CRASH_LOOP_REFUSAL, retryable: false })
    const rateLimited = this.rateRefusal(req)
    if (rateLimited) return rateLimited

    const loaded = this.loadCheckedProfile(req.profile, req.requestedBy, isHumanSpawn(req), req.humanUnproven)
    if ('error' in loaded) return this.refuse(req, loaded.error)
    const { profile, startsRoot } = this.seatLaunchOf(req, loaded)
    const harness = harnessRefusal(profile)
    if (harness) return this.refuse(req, harness, { code: HARNESS_UNSUPPORTED, retryable: false })
    const lineage = this.lineageOf(req, {
      depth: this.depthOf(req.parentAgentId),
      coordinatorDepth: requester.coordinatorDepth + (roleOf(profile) === 'coordinator' ? 1 : 0),
      ...(requester.seat === undefined ? {} : { seat: requester.seat }),
    })
    const roleBlocked = this.checkRole(req, profile, startsRoot ? 0 : lineage.coordinatorDepth, requester)
    if (roleBlocked) return this.refuse(req, roleBlocked)
    const overlap = this.seatOverlapRefusal(req, profile.name)
    if (overlap) return this.refuse(req, overlap, { code: SEAT_SPAWN_OVERLAP, retryable: false })
    const reserve = this.handReserveRefusal(req, profile.name)
    if (reserve) return this.refuse(req, reserve, { code: SEAT_HAND_RESERVE, retryable: false })
    const unprefixed = this.unprefixedRefusal(req, profile.name)
    if (unprefixed) return this.refuse(req, unprefixed, { code: SEAT_SPAWN_UNPREFIXED, retryable: false })
    const site = this.siteFor(req)
    if ('refusal' in site) return this.refuse(req, site.refusal)
    if (site.site === 'caller') return this.spawnRemote(req, profile, lineage, site)
    const machine = this.machineRefusal(this.spawnSurface(req, profile))
    if (machine) return this.refuse(req, machine.reason, { code: machine.code, retryable: machine.retryable })
    const escalation = this.checkEscalation(req, profile)
    if ('refusal' in escalation) return this.refuse(req, escalation.refusal)
    const lint = await this.lintBrief(req, profile)
    if (lint.refusal !== undefined) return this.refuse(req, lint.refusal)
    const fork = req.inherit === 'context' ? this.forkSource(req) : undefined
    if (fork !== undefined && 'error' in fork) return this.refuse(req, fork.error)

    const cwd = req.cwd ?? process.cwd()
    const cwdError = this.checkCwd(cwd, req.requestedBy) ?? this.parkingRefusal(req.worktree ?? cwd)
    if (cwdError) return this.refuse(req, cwdError)
    const conflict = worktreeOwnsConflict(req, profile)
    if (conflict) return this.refuse(req, conflict)
    const reviewerRoot = this.reviewerPrimaryRoot(req, cwd)
    if (reviewerRoot !== undefined && req.owns?.length)
      return this.refuse(req, reviewerOwnsRefusal(reviewerRoot))
    const isolationName = reviewerRoot === undefined ? isolationFor(req, profile) : 'worktree'
    // Minted before the slot is taken so that acquire and release are keyed the
    // same way. Keying acquire on the name and release on the id leaks a slot on
    // every exit, and the leak is invisible until spawning stops working.
    const agentId = newMsgId()
    const ctx: IsolationContext = {
      agentId,
      agentName: req.name,
      baseCwd: cwd,
      ...(req.worktree ? this.assignment(req.worktree) : {}),
      ...(req.owns?.length ? { declaredPaths: [...req.owns] } : {}),
      // The claim ledger is the live answer to "who holds what here", leased by
      // presence: a claim whose owner has disconnected is already gone from it,
      // so a spawn never blocks on a peer that no longer exists. Supplying it is
      // what makes file-ownership's conflict check able to fire at all — without
      // it the strategy allocated against an empty roster and silently behaved
      // like `none`.
      peers: this.core.claims.inWorktree(cwd).map(c => ({
        agentId: c.owner,
        name: c.owner,
        cwd: c.worktreePath,
        // A whole-worktree claim carries NO patterns — it owns everything — and
        // `leaseholders()` drops any peer with an empty claim list. Mapping it to
        // `**` keeps the strongest claim there is from being the one silently
        // ignored, and says the same thing in the vocabulary the manifest speaks.
        claims: c.kind === 'worktree' ? ['**'] : [...c.patterns],
      })),
      // Without this the toolset strategy sees no tool lists and warns on every
      // spawn. It is the DENY list that silences the warning, because that is the
      // only one that confines — an earlier version of this comment argued the
      // warning was false because --allowed-tools was passed regardless, which was
      // the exact misreading that let a read-only profile keep a shell.
      toolset: {
        allowedTools: [...profile.allowedTools],
        ...(profile.disallowedTools ? { disallowedTools: [...profile.disallowedTools] } : {}),
      },
      ...(req.forceReset ? { forceReset: true } : {}),
      ...(req.baseRef === undefined ? {} : { baseRef: req.baseRef }),
      treeHolders: this.treeHolders,
    }

    const floor = floorWarning(isolationName, profile.isolation)
    const warnings = [
      ...(profile.warnings ?? []),
      ...lint.warnings,
      ...(reviewerRoot === undefined ? [] : [reviewerRewriteWarning(reviewerRoot)]),
      ...(floor ? [floor] : []),
      ...(await resolveIsolation([isolationName]).check(ctx)),
    ]
    // A briefing is an improvement to the brief, never a precondition for one:
    // an unresolvable initiative warns and spawns anyway. The alternative is a
    // spawn that fails for a reason unrelated to the work.
    const briefing = await this.briefingFor(req, cwd, profile)
    if (briefing?.warning !== undefined) warnings.push(briefing.warning)
    const injected = briefing !== undefined && 'text' in briefing ? briefing : undefined

    // CC-100. Resolved here rather than at launch time so a bad `config_dir`
    // refuses before anything is allocated, and so the WARNING from a missing
    // initiative profile dir reaches the requester with every other spawn warning.
    // TP-4214: a requested account resolves first and is pinned, so billing never moves it.
    const requested = this.requestedAccount(req, profile)
    if (requested !== undefined && 'refused' in requested) return requested.refused
    if (requested?.warning !== undefined) warnings.push(requested.warning)
    const pinned = requested === undefined ? req : { ...req, configDir: requested.dir }
    const resolved = resolveConfigDir({
      ...(pinned.configDir === undefined ? {} : { explicit: pinned.configDir }),
      ...(req.spawnerConfigDir === undefined ? {} : { spawner: req.spawnerConfigDir }),
      ...(req.spawnerIsSession === true ? { spawnerIsSession: true } : {}),
      ...(injected?.profile === undefined ? {} : { profile: injected.profile }),
    })
    if ('error' in resolved) return this.refuse(req, resolved.error)
    if (resolved.warning !== undefined) warnings.push(resolved.warning)
    // A fork or a resumed session continues a transcript that lives under its account, so neither is routed.
    const billed = this.billedAccount(pinned, profile, resolved, {
      cwd,
      ...(injected === undefined ? {} : { initiative: injected.slug }),
      keepsAccount: fork !== undefined || req.resumeSession !== undefined,
      rotates: rotatesAccount(req, profile),
    })
    if ('refusal' in billed)
      return this.refuse(req, billed.refusal, { code: SEAT_BUDGET_STOP, retryable: true })
    const account =
      requested === undefined ? billed.account : requestedBilling(billed.account, requested.text)
    const limited = this.reviewerAccountRefusal(req, profile, account.dir)
    if (limited) return this.refuse(req, limited, { code: REVIEWER_ACCOUNT_LIMIT, retryable: true })
    const resumed = await this.resumeSource(req, isolationName, cwd, account.dir)
    if (resumed !== undefined && 'error' in resumed) return this.refuse(req, resumed.error)
    const predecessor = req.predecessor === undefined ? undefined : this.predecessorFor(req.predecessor, req)
    if (predecessor !== undefined && 'error' in predecessor) return this.refuse(req, predecessor.error)
    if (predecessor?.warning !== undefined) warnings.push(predecessor.warning)

    const unadmitted = this.holdLaunchSlot(req, agentId, profile.name)
    if (unadmitted) return unadmitted
    if (!this.semaphore.acquire(agentId)) {
      this.spawnSlots.release(agentId)
      return this.refuse(req, `no free agent slots (${this.semaphore.summary()}); retire one first`)
    }
    const executionId = this.shadow.open(agentId, account.dir)

    try {
      return await this.launch(req, ctx, agentId, isolationName, warnings, profile, lineage, {
        account,
        ...(injected ? { briefing: injected } : {}),
        ...(fork ? { fork } : {}),
        ...(resumed ? { resumed } : {}),
        ...(predecessor ? { predecessor: predecessor.text } : {}),
        ...(executionId ? { executionId } : {}),
        ...(escalation.exempted.length > 0 ? { exempted: escalation.exempted } : {}),
        ...(escalation.covered.length > 0 ? { covered: escalation.covered } : {}),
      })
    } catch (err) {
      this.semaphore.release(agentId)
      this.spawnSlots.release(agentId)
      const reason = err instanceof SurfaceRefused ? err.message : `spawn failed: ${(err as Error).message}`
      this.shadow.finish(executionId, { outcome: 'failed', reason, retryable: false })
      if (!this.live.has(agentId)) await this.abandonLaunch(req, agentId, reason)
      // CC-959: typed as resume's is, so a caller can fall back to headless without reading the text.
      return this.refuse(req, reason, err instanceof SurfaceRefused ? { code: 'surface_refused' } : {})
    }
  }

  /** CC-1059: where a spawn launches, from the requester's host, its capability and any `host` it named. */
  private siteFor(req: SpawnRequest): SpawnSite {
    return spawnSiteFor({
      host: req.host,
      callerHost: req.callerHost,
      hostPlatform: req.hostPlatform,
      launchesHere: req.launchesHere,
      brokerHost: brokerHost(),
      launchers: this.hosts?.launchers() ?? [],
      aliases: knownMachineAliases(),
    })
  }

  /**
   * CC-1059: a spawn the requester launches on its own host. Only host-neutral gates run here,
   * plus the lexical cwd policy: that host's disk, account and terminal are its own to check.
   */
  private async spawnRemote(
    req: SpawnRequest,
    profile: AgentProfile,
    lineage: Lineage,
    site: RemoteSite,
  ): Promise<SpawnOutcome> {
    const gated = await this.remoteGates(req, profile, site)
    if ('refusal' in gated) return this.refuse(req, gated.refusal, gated.cause ?? {})
    const briefing = await this.briefingFor(req, gated.cwd, profile)
    const injected = briefing !== undefined && 'text' in briefing ? briefing : undefined
    if (briefing?.warning !== undefined) gated.warnings.push(briefing.warning)
    const account = this.remoteAccount(req, profile, gated, injected)
    if ('refusal' in account) return this.refuse(req, account.refusal, account.cause ?? {})
    if (account.warning !== undefined) gated.warnings.push(account.warning)
    const predecessor = req.predecessor === undefined ? undefined : this.predecessorFor(req.predecessor, req)
    if (predecessor !== undefined && 'error' in predecessor) return this.refuse(req, predecessor.error)
    if (predecessor?.warning !== undefined) gated.warnings.push(predecessor.warning)
    const agentId = newMsgId()
    if (!this.semaphore.acquire(agentId))
      return this.refuse(req, `no free agent slots (${this.semaphore.summary()}); retire one first`)
    const brief = [injected?.text, predecessor?.text, gated.brief].filter(Boolean).join('\n\n')
    const launch = this.recordRemoteSpawn(req, profile, lineage, {
      ...gated,
      agentId,
      brief,
      account,
      injected,
    })
    return {
      ok: true,
      agentId,
      name: req.name,
      host: site.host,
      launch,
      ...(gated.warnings.length > 0 ? { warnings: gated.warnings } : {}),
      ...(profile.disallowedTools?.length ? { disallowedTools: [...profile.disallowedTools] } : {}),
    }
  }

  /** The surface, scope, escalation, brief and cwd gates, in the order a local spawn runs them. */
  private async remoteGates(
    req: SpawnRequest,
    profile: AgentProfile,
    site: RemoteSite,
  ): Promise<RemoteGated | { refusal: string; cause?: { code: 'surface_refused' } }> {
    const seatSpawn = req.surface === undefined && this.isSeatSpawn(req)
    const role = roleOf(profile)
    const chosen = remoteSurface(
      { requested: req.surface, profileSurface: profile.surface, role, seatSpawn },
      site.platform,
      site.host,
    )
    if ('refusal' in chosen) return { refusal: chosen.refusal, cause: { code: 'surface_refused' } }
    const isolation = isolationFor(req, profile)
    const scope = remoteScopeRefusal({ ...req, isolation }, site.host, brokerHost())
    if (scope !== undefined) return { refusal: scope }
    const escalation = this.checkEscalation(req, profile)
    if ('refusal' in escalation) return { refusal: escalation.refusal }
    const lint = await this.lintBrief(req, profile, chosen.surface)
    if (lint.refusal !== undefined) return { refusal: lint.refusal }
    if (req.cwd === undefined) return { refusal: `a spawn launched on ${site.host} needs a cwd` }
    const home = callerHomeFor(site.platform, os.userInfo().username, req.callerHome)
    const cwdRefusal = lexicalCwdRefusal(req.cwd, home)
    if (cwdRefusal !== undefined) return { refusal: cwdRefusal }
    const { brief, warnings } = await remoteBrief(req, profile, isolation, lint.warnings)
    return {
      site,
      surface: chosen.surface,
      isolation,
      cwd: req.cwd,
      home,
      brief,
      warnings,
      exempted: escalation.exempted,
      covered: escalation.covered,
    }
  }

  /**
   * The account a remote spawn bills, resolved against the requester's home. Whether it exists
   * is the launching host's check, so nothing here reads this host's disk or environment.
   */
  private remoteAccount(
    req: SpawnRequest,
    profile: AgentProfile,
    gated: RemoteGated,
    injected: { slug: string; profile?: string } | undefined,
  ): (Account & { warning?: string }) | { refusal: string; cause?: SeatRefusalCause } {
    const named = remoteAccountRequest(req, gated)
    if ('refusal' in named) return named
    const resolved = resolveConfigDir({
      ...(named.configDir === undefined ? {} : { explicit: named.configDir }),
      ...(req.spawnerConfigDir === undefined ? {} : { spawner: req.spawnerConfigDir }),
      ...(req.spawnerIsSession === true ? { spawnerIsSession: true } : {}),
      ...(injected?.profile === undefined ? {} : { profile: injected.profile }),
      home: gated.home,
      env: {},
      isDirectory: () => true,
    })
    if ('error' in resolved) return { refusal: resolved.error }
    const billed = this.billedAccount({ ...req, ...named }, profile, resolved, {
      cwd: gated.cwd,
      ...(injected === undefined ? {} : { initiative: injected.slug }),
      keepsAccount: false,
      // The readings are this host's, so a spawn launching on another host keeps its account.
      rotates: false,
    })
    if ('refusal' in billed)
      return { refusal: billed.refusal, cause: { code: SEAT_BUDGET_STOP, retryable: true } }
    const limited = this.reviewerAccountRefusal(req, profile, billed.account.dir)
    if (limited) return { refusal: limited, cause: { code: REVIEWER_ACCOUNT_LIMIT, retryable: true } }
    const unset = path.resolve(billed.account.dir) === defaultConfigDir(gated.home)
    return {
      ...billed.account,
      ...(unset ? { unset: true as const } : {}),
      ...(resolved.warning ? { warning: resolved.warning } : {}),
    }
  }

  /** Writes the `agent_spawned` row, holds the spawn for its reports, and returns what the requester launches. */
  private recordRemoteSpawn(
    req: SpawnRequest,
    profile: AgentProfile,
    lineage: Lineage,
    draft: RemoteDraft,
  ): RemoteLaunch {
    const { agentId, site, surface, account } = draft
    const sessionId = randomUUID()
    this.core.append({
      kind: 'agent_spawned',
      actor: req.requestedBy,
      target: req.name,
      msgId: agentId,
      body: req.brief,
      meta: remoteSpawnMeta(req, profile, lineage, draft, sessionId),
    })
    logEvent('agent_spawned', { agentId, name: req.name, surface, cwd: draft.cwd, host: site.host })
    this.remoteSpawns.open({
      agentId,
      name: req.name,
      host: site.host,
      announce: () => this.announceRemote(req, profile, agentId, sessionId, draft),
    })
    const { env: _env, mcpServers: _servers, warnings: _warnings, ...remoteProfile } = profile
    return {
      agentId,
      sessionId,
      name: req.name,
      profile: remoteProfile,
      brief: draft.brief,
      preamble: PEER_PREAMBLE,
      surface,
      ...(req.tags?.length ? { tags: req.tags } : {}),
      ...(req.subscriptions?.length ? { subscriptions: req.subscriptions } : {}),
      ...((req.remoteControl ?? profile.remoteControl) ? { remoteControl: true } : {}),
      ...(req.anchor === undefined ? {} : { anchor: req.anchor }),
      cwd: draft.cwd,
      ...(account.unset ? { configDirUnset: true as const } : { configDir: account.dir }),
    }
  }

  /** The hooks, journal and dispatch row a local spawn writes once its agent attaches. */
  private announceRemote(
    req: SpawnRequest,
    profile: AgentProfile,
    agentId: string,
    sessionId: string,
    draft: RemoteDraft,
  ): void {
    this.fireHook('on_spawn', {
      agentId,
      name: req.name,
      session_id: sessionId,
      cwd: draft.cwd,
      parent: req.parentAgentId ?? null,
      profile: profile.name,
      briefing: draft.injected?.slug ?? null,
    })
    this.seatJournal?.({ event: 'spawn', agent: req.name })
    writeDispatch(() => this.seatDispatch?.dispatched(spawnFactsOf(req, profile, agentId)))
  }

  /** CC-1059: a remote spawn that was refused, failed or lost before it registered. */
  private retireRemoteSpawn(record: RemoteSpawnRecord, reason: string): void {
    this.semaphore.release(record.agentId)
    this.core.append({
      kind: 'agent_retired',
      actor: 'agent-chat',
      target: record.name,
      ref: record.agentId,
      body: `spawn not launched on ${record.host}: ${reason}`,
    })
    logEvent('remote_spawn_retired', {
      agentId: record.agentId,
      name: record.name,
      host: record.host,
      reason,
    })
  }

  /** CC-1059: the requester checked and wrote a remote spawn; an ok reply lets it open the surface. */
  remoteSpawnReady(agentId: string, report: ReportReply): ReportReply {
    return this.remoteSpawns.ready(agentId, report)
  }

  /** CC-1059: the requester opened the surface, or could not; answers once the agent registers or the attach window passes. */
  async remoteSpawnPlaced(agentId: string, report: ReportReply): Promise<SpawnOutcome> {
    const verdict = await this.remoteSpawns.placed(agentId, report)
    const name = this.core.agents.get(agentId)?.name
    const named = name === undefined ? {} : { name }
    if (verdict.kind === 'failed') return { ok: false, agentId, ...named, reason: verdict.reason }
    if (verdict.kind === 'attached') return { ok: true, agentId, ...named }
    const warning =
      `still starting ${span(this.attachMs)} after it was placed; it attaches when it registers, and is ` +
      `retired if it has not within ${span(this.attachCeilingMs)} of the ready report`
    return { ok: true, agentId, ...named, warnings: [warning] }
  }

  /** CC-398: lints the caller's brief alone, before the return contract is appended to it. */
  private async lintBrief(
    req: SpawnRequest,
    profile: AgentProfile,
    surface: SurfaceName = this.spawnSurface(req, profile),
  ): Promise<BriefLint> {
    const read = mentionsSyntheticData(req.brief) ? undefined : this.repoVisibility
    const repoVisibility =
      read === undefined ? 'unknown' : await read(req.worktree ?? req.cwd ?? process.cwd())
    return lintBrief({ brief: req.brief, profile, surface, repoVisibility })
  }

  /**
   * CC-1384: the visibility the implementer contract states, so the agent never runs the `gh api`
   * read its profile denies. A failed read is `unknown`, which the contract turns into "treat it as public".
   */
  private async contractVisibility(
    profile: AgentProfile,
    resumed: boolean,
    cwd: string,
  ): Promise<RepoVisibility> {
    if (resumed || this.repoVisibility === undefined || contractOf(profile) !== 'implementer')
      return 'unknown'
    return this.repoVisibility(cwd).catch(() => 'unknown' as const)
  }

  /** CC-916: the primary checkout a reviewer spawn would run in, which it must not touch; an assigned worktree is the caller's own. */
  private reviewerPrimaryRoot(req: SpawnRequest, cwd: string): string | undefined {
    if (req.worktree || !isReviewerSpawn(req.profile, req.name)) return undefined
    return primaryCheckoutOf(cwd)
  }

  /** The write-and-launch half, after every check has passed. */
  private async launch(
    req: SpawnRequest,
    ctx: IsolationContext,
    agentId: string,
    isolationName: IsolationName,
    warnings: string[],
    profile: AgentProfile,
    lineage: Lineage,
    resolved: Resolved,
  ): Promise<SpawnOutcome> {
    const { briefing, fork, account, resumed, predecessor } = resolved
    const allocated = resumed?.reattach
      ? await recreateWorktree(resumed.reattach, { treeHolders: this.treeHolders })
      : await resolveIsolation([isolationName]).allocate(ctx)
    const allocation = withLinkedDirs(allocated, activeWorkRoot())
    warnings.push(...(allocation.warnings ?? []))
    this.core.append({
      kind: 'isolation_allocated',
      actor: req.name,
      ref: agentId,
      body: allocation.note ?? '',
      meta: { strategy: isolationName, ...(allocation.ref ?? {}) },
    })
    const surface = this.spawnSurface(req, profile)
    // CC-158: on disk before anything can fail, so a launch that dies still leaves something to release.
    writeRuntimeState(agentId, { handle: { surface }, allocation, isolation: isolationName })

    if (resumed && surface !== 'headless')
      warnings.push(
        'a visible resume opens on the conversation as it was left; send the brief with chat_send',
      )
    const sessionId = resumed?.sessionId ?? randomUUID()
    const contracted = withReturnContract({
      brief: req.brief,
      profile,
      spawner: req.requestedBy,
      resumed: resumed !== undefined,
      ...(req.returnContract === undefined ? {} : { requested: req.returnContract }),
      visibility: await this.contractVisibility(profile, resumed !== undefined, allocation.cwd),
    })
    warnings.push(...contracted.warnings)
    warnings.push(...crossingBriefPaths(req.brief, allocation.cwd, allocation.addDirs ?? []))
    const plan = buildLaunchPlan({
      agentId,
      sessionId,
      ...(resumed ? { resume: true } : {}),
      name: req.name,
      profile,
      adopted: false,
      brief: [briefing?.text, predecessor, contracted.brief, allocation.note].filter(Boolean).join('\n\n'),
      cwd: allocation.cwd,
      cwdHoldsUserSettings: cwdHoldsUserSettings(allocation.cwd, account.dir),
      surface,
      mcpConfigPath: mcpConfigPath(agentId),
      hookSettingsPath: hookSettingsPath(agentId),
      ...(allocation.addDirs ? { extraDirs: allocation.addDirs } : {}),
      ...(req.tags?.length ? { tags: req.tags } : {}),
      ...(req.subscriptions?.length ? { subscriptions: req.subscriptions } : {}),
      ...(fork ? { forkFrom: fork.path } : {}),
      ...((req.remoteControl ?? profile.remoteControl) ? { remoteControl: true } : {}),
      agentChatHome: home(),
      gitHooksDir: gitHooksDir(),
      configDir: account.dir,
      ...(account.unset ? { configDirUnset: true } : {}),
    })
    this.writeAdmitted(
      { agentId, parent: req.parentAgentId || HUMAN_ROOT, humanProof: isHumanSpawn(req) },
      plan,
      profile,
      this.createdWorktree(agentId, allocation, isolationName),
    )
    const provenance = await spawnProvenance(allocation, req, profile.name)

    // Appended BEFORE the launch. If the launch then fails, the identity exists
    // in `spawning` with a refusal beside it, which is exactly what you want when
    // debugging why a pane never opened. The reverse order loses failed spawns.
    this.core.append({
      kind: 'agent_spawned',
      actor: req.requestedBy,
      target: req.name,
      msgId: agentId,
      // The coordinator's own brief, not the injected briefing in front of it:
      // the log records what was ASKED FOR, and an initiative's onboarding doc
      // pasted into every spawn row would bury it. The slug in `meta` is the
      // pointer back to what the agent was actually handed.
      body: req.brief,
      meta: {
        name: req.name,
        // CC-171: the delivered brief's first `briefing_chars` characters are the
        // injected block, so a reader can find the assignment without matching
        // this module's heading strings.
        ...(briefing ? { briefing: briefing.slug, briefing_chars: String(briefing.text.length) } : {}),
        ...this.inheritedCrashStreak(req),
        parent: req.parentAgentId ?? '',
        profile: profile.name,
        model: profile.model,
        surface,
        isolation: isolationName,
        cwd: allocation.cwd,
        session_id: sessionId,
        // CC-100: the account this agent spends, and where its transcript and
        // status-cache live. On the row rather than in memory because every later
        // reader of either — `agent ls`, `agent_list`, `session_budget` — is a
        // different process from the one that resolved it, and looking in its own
        // `CLAUDE_CONFIG_DIR` is precisely the bug.
        config_dir: account.dir,
        config_dir_source: account.source,
        ...(account.unset ? { config_dir_unset: 'true' } : {}),
        ...(account.rotation ? { account_rotation: JSON.stringify(account.rotation) } : {}),
        ...(account.choice === undefined ? {} : { account_choice: account.choice }),
        allowed_tools: profile.allowedTools.join(','),
        // Recorded for symmetry with the allowlist the escalation check reads:
        // the deny list is the half that actually confines (see `profiles.ts`),
        // so a row that names one and not the other under-describes the agent.
        disallowed_tools: (profile.disallowedTools ?? []).join(','),
        ...grantMeta(resolved),
        perm_mode: permModeFor(surface),
        // Recorded rather than carried in memory so the exit path can read it
        // after a broker restart, and so `agent ls`/the log can show what an
        // agent's pane was promised. See `SurfaceLifetime`.
        surface_lifetime: lifetimeOf(profile),
        depth: String(lineage.depth),
        // CC-163: on the row so the agent's own spawns are judged by it after its spawner is gone.
        role: roleOf(profile),
        coordinator_depth: String(lineage.coordinatorDepth),
        ...seatCeilingMeta(lineage),
        // Recorded because a fork carries content the profile's tool list says
        // nothing about: reading the row later is the only way to know this
        // agent started holding someone else's conversation, and whose.
        ...(fork ? { inherit: 'context', fork_from: fork.sessionId } : {}),
        ...(resumed ? { resumed_session: resumed.sessionId, transcript: resumed.path } : {}),
        ...(req.predecessor === undefined ? {} : { predecessor: req.predecessor }),
        // CC-802: stored so the retire row names the same spawner as the dispatched one.
        ...(req.spawnedAs === undefined ? {} : { spawned_as: req.spawnedAs }),
        ...callerAgentMeta(req),
        ...launchMeta(req),
        // CC-915: read by the session-origin miner, which sees only this row's meta.
        ...provenance,
        // CC-1059: where it launched, so a later reader can tell a remote agent from a local one.
        host: brokerHost(),
        site: 'broker',
      },
    })

    const reviewerTree = await this.reviewerTreeBefore(profile.name, req.name, allocation.cwd)
    const launchedAt = Date.now()
    const handle = await this.launchOn(surface, plan, req.anchor, false, 'spawn')
    this.track(agentId, req.name, handle, allocation, isolationName, req.anchor, reviewerTree)
    this.claimAtSpawn(req, allocation.cwd, ctx.baseCwd)
    this.bindExecution(agentId, resolved.executionId)
    logEvent('agent_spawned', { agentId, name: req.name, surface: handle.surface, cwd: allocation.cwd })

    const announce = (): void =>
      this.fireHook('on_spawn', {
        agentId,
        name: req.name,
        session_id: sessionId,
        cwd: allocation.cwd,
        parent: req.parentAgentId ?? null,
        profile: profile.name,
        briefing: briefing?.slug ?? null,
      })

    // CC-95's first case. Everything above proves a pane was opened, which is
    // not the claim `agent_spawn` was making. Nothing is reported as spawned
    // until the agent's own MCP server has said hello, or (CC-124) its pane is
    // still there to say it in.
    const site = { cwd: allocation.cwd, configDir: childConfigDir(account) }
    const verdict = await this.verifyAttach(agentId, handle, site)
    if (verdict.kind === 'failed') return await this.failSpawn(req, agentId, verdict.reason, verdict.release)
    const facts = spawnFactsOf(req, profile, agentId, site.configDir)
    if (verdict.kind === 'pending') {
      this.awaitLateAttach(req, agentId, handle, site, launchedAt, announce, facts)
      warnings.push(verdict.warning)
    } else announce()
    this.seatJournal?.({ event: 'spawn', agent: req.name })
    writeDispatch(() => this.seatDispatch?.dispatched(facts))
    return {
      ok: true,
      agentId,
      name: req.name,
      ...(warnings.length > 0 ? { warnings } : {}),
      ...(profile.disallowedTools?.length ? { disallowedTools: [...profile.disallowedTools] } : {}),
      ...(resumed ? { transcript: { path: resumed.path, found: true } } : {}),
      ...(account.rotation ? { account: rotationText(account.rotation) } : {}),
      ...(account.choice === undefined ? {} : { account: account.choice }),
      ...branchBaseOf(allocation),
    }
  }

  private bindExecution(agentId: string, executionId: string | undefined): void {
    const entry = this.live.get(agentId)
    if (entry === undefined || executionId === undefined) return
    entry.executionId = executionId
    // An attach can land before `track` made the entry that `onRow` looks for.
    if (this.attachedSinceLaunch(agentId)) this.observeRunning(entry)
  }

  /** A resumed agent's attach rows from an earlier life say nothing about the process just launched. */
  private attachedSinceLaunch(agentId: string): boolean {
    const latest = this.core.events
      .agentEvents()
      .findLast(row =>
        row.kind === 'agent_spawned'
          ? row.msgId === agentId
          : row.ref === agentId && (row.kind === 'agent_attached' || row.kind === 'agent_resumed'),
      )
    return latest?.kind === 'agent_attached'
  }

  /** CC-133. Refused when unknown or not the requester's; resolved against the log, never the request. */
  private predecessorFor(name: string, req: SpawnRequest): PredecessorResult {
    return resolvePredecessor(this.core.agents, this.core.events, name, req.requestedBy)
  }

  /** CC-1469: one fold of the agent log, paid only when a worktree pool refuses. */
  private readonly treeHolders = (): ReadonlyMap<string, string> =>
    treeHoldersOf(this.core.agents.roster({ includeRetired: true }).filter(launchedByBroker))

  /** CC-283: an assigned worktree, with the record that re-creates it when it has been removed. */
  private assignment(worktree: string): Pick<IsolationContext, 'assignedWorktree' | 'assignedRecord'> {
    if (fs.existsSync(worktree)) return { assignedWorktree: worktree }
    const record = allocationRecord(this.core.events.agentEvents(), worktree)
    return { assignedWorktree: worktree, ...(record ? { assignedRecord: record } : {}) }
  }

  /** CC-126: the checked transcript a `resume_session` spawn continues, or why it cannot. */
  private async resumeSource(
    req: SpawnRequest,
    isolation: IsolationName,
    cwd: string,
    configDir: string,
  ): Promise<ResumedSession | { error: string } | undefined> {
    if (req.resumeSession === undefined) return undefined
    const reattach =
      isolation === 'worktree' ? await this.reattachFor(req.resumeSession, req.worktree, cwd) : undefined
    if (reattach !== undefined && 'error' in reattach) return reattach
    const checked = checkResumeSession({
      resumeSession: req.resumeSession,
      ...(req.inherit === undefined ? {} : { inherit: req.inherit }),
      ...(req.worktree === undefined ? {} : { worktree: req.worktree }),
      ...(reattach === undefined ? {} : { reattach }),
      isolation,
      cwd,
      configDir,
    })
    if ('error' in checked) return checked
    return { sessionId: req.resumeSession, path: checked.path, ...(reattach ? { reattach } : {}) }
  }

  /** CC-140: a retired agent's removed worktree, unless the caller named a different one or another repository. */
  private async reattachFor(
    sessionId: string,
    worktree: string | undefined,
    cwd: string,
  ): Promise<WorktreeRecord | { error: string } | undefined> {
    const retired = this.core.agents.roster({ includeRetired: true })
    const gone = retiredWorktree(retired, this.core.events.agentEvents(), sessionId)
    if (gone === undefined || (worktree !== undefined && path.resolve(worktree) !== gone.worktree))
      return undefined
    const root = await findGitRoot(cwd)
    if (root === null || canonicalPath(root) !== canonicalPath(gone.gitRoot))
      return {
        error:
          `session ${sessionId} ran in a worktree of ${gone.gitRoot}, but cwd ${cwd} is in ` +
          `${root ?? 'no git repository'}. Pass a cwd inside ${gone.gitRoot}. Not spawned`,
      }
    return gone
  }

  /** Has this identity ever registered? The one fact that settles an attach race. */
  private hasAttached(agentId: string): boolean {
    return this.core.events.agentEvents().some(row => row.kind === 'agent_attached' && row.ref === agentId)
  }

  /**
   * Does this agent's pane go with it when it ends?
   *
   * Read from its own `agent_spawned` row rather than held in memory, so it
   * survives a broker restart and so a reader of the log can see what a pane was
   * promised. An unrecognised or absent value keeps the pane.
   */
  private closesOnExit(agentId: string): boolean {
    return this.core.agents.spawnMeta(agentId).surface_lifetime === 'close-on-exit'
  }

  /**
   * The failure line for an exit by an agent that never registered, or undefined
   * when it had. An INFERRED exit is excluded: that path only exists for an agent
   * whose presence was being watched, which means it attached at least once.
   */
  private unattachedExit(
    name: string,
    agentId: string,
    outcome: { code: number | null; inferred?: boolean },
  ): string | undefined {
    if (outcome.inferred === true || this.hasAttached(agentId)) return undefined
    return `${name} was launched but never registered: claude exited before registering (exit code ${outcome.code ?? 'unknown'})`
  }

  /**
   * Wait for the agent to register, and say what went wrong if it does not
   * (CC-95). A failed verdict's reason is ready to hand to the coordinator verbatim.
   *
   * The process-exit outcome is why this is not just a timer: for a headless
   * agent the wrapper's own exit is direct evidence, arriving in milliseconds
   * with a code on it, and waiting the full window for something already known
   * to be dead helps nobody. A visible agent has no such promise — the broker
   * does not own a pane's process — and CC-124 showed the timeout is not
   * evidence either: one registered after ten minutes. While its pane exists it
   * is pending, not failed.
   */
  private async verifyAttach(
    agentId: string,
    handle: LaunchHandle,
    site: LaunchSite,
  ): Promise<AttachVerdict> {
    if (this.hasAttached(agentId)) return { kind: 'attached' }

    const outcome = await this.awaitAttach(agentId, handle)
    if (outcome.kind === 'attached') return { kind: 'attached' }
    if (outcome.kind === 'exited') {
      const cause = `claude exited before registering (exit code ${outcome.code ?? 'unknown'})`
      const output = readOutputTail(agentDir(agentId))
      return {
        kind: 'failed',
        reason: `${cause}. ${attachDiagnosis(site, handle, 'exited', output)}`,
        release: 'now',
      }
    }
    if (outcome.kind === 'launch_failed') return { kind: 'failed', reason: outcome.reason, release: 'now' }

    const window = span(this.attachMs)
    const diagnosis = attachDiagnosis(site, handle, 'waiting')
    // CC-124: for a visible agent the timeout is not evidence of death while its pane exists.
    const paneOpen = await this.paneStillOpen(handle)
    if (this.hasAttached(agentId)) return { kind: 'attached' }
    if (!paneOpen)
      return {
        kind: 'failed',
        reason: `no registration within ${window} of launching into ${handle.surface}. ${diagnosis}`,
        // A headless timeout is no evidence of death: the child may still be starting in that tree.
        release: handle.surface === 'headless' ? 'keep' : 'now',
      }
    const ceiling = span(this.attachCeilingMs)
    return {
      kind: 'pending',
      warning:
        `still starting ${window} after launching into ${handle.surface}; the pane was kept open and it will ` +
        `attach when it registers. ${diagnosis} If it has not registered within ${ceiling} of launch, the ` +
        'spawn is recorded as failed on agent_list; its agent_exited is pushed only if you subscribed to your ' +
        'spawns (chat_subscribe scope "spawned").',
    }
  }

  /** Registration, exit or the window, whichever lands first. */
  private awaitAttach(agentId: string, handle: LaunchHandle): Promise<AttachOutcome> {
    return new Promise<AttachOutcome>(resolve => {
      let timer: NodeJS.Timeout
      const finish = (result: AttachOutcome): void => {
        clearTimeout(timer)
        this.attachWaiters.delete(agentId)
        resolve(result)
      }
      timer = setTimeout(() => finish({ kind: 'timeout' }), this.attachMs)
      timer.unref?.()
      this.attachWaiters.set(agentId, () => finish({ kind: 'attached' }))
      // A headless agent can finish its whole turn inside the window, so an exit
      // is only a failure when nothing ever registered. Re-checked here rather
      // than assumed, because both signals can land in the same tick.
      void handle.exited?.then(({ code }) => {
        finish(this.hasAttached(agentId) ? { kind: 'attached' } : { kind: 'exited', code })
      })
      // CC-175: a pane whose run-agent never started fails in seconds, not at the ceiling.
      handle.launchFailed
        ?.then(reason => {
          finish(this.hasAttached(agentId) ? { kind: 'attached' } : { kind: 'launch_failed', reason })
        })
        .catch(err => logEvent('launch_failed_watch_error', { agentId, error: (err as Error).message }))
    })
  }

  /** A pane iTerm2 or tmux still lists. Unknown counts as gone: keeping a pane needs a positive answer. */
  private async paneStillOpen(handle: LaunchHandle): Promise<boolean> {
    if (handle.surface === 'headless' || handle.paneRef === undefined) return false
    const present = handle.surface === 'tmux-window' ? tmuxWindowPresent : itermSessionPresent
    return (await present(handle.paneRef, { ...this.surfaceOptions })) === true
  }

  /**
   * Keep listening for a visible agent past the attach window (CC-124).
   *
   * A late registration flips it to attached through the ordinary `onRow` path
   * and logs how late it was; reaching the ceiling runs the same `failSpawn` a
   * dead launch gets. A retire or exit in between removes the live entry, and
   * with it any reason to fail.
   */
  private awaitLateAttach(
    req: SpawnRequest,
    agentId: string,
    handle: LaunchHandle,
    site: LaunchSite,
    launchedAt: number,
    onAttached: () => void,
    facts: SpawnFacts,
  ): void {
    const entry = this.live.get(agentId)
    if (!entry) return
    const ceiling = span(this.attachCeilingMs)
    entry.attachCeiling = setTimeout(
      () => {
        this.attachWaiters.delete(agentId)
        if (!this.live.has(agentId) || this.hasAttached(agentId)) return
        const reason = `no registration within ${ceiling} of launching into ${handle.surface}. ${attachDiagnosis(site, handle, 'waiting')}`
        // The dispatched row went out at spawn, so the ceiling is where it ends.
        writeDispatch(() => this.seatDispatch?.abandoned(facts))
        void this.failSpawn(req, agentId, reason, 'if-pane-closed')
      },
      Math.max(0, launchedAt + this.attachCeilingMs - Date.now()),
    )
    entry.attachCeiling.unref?.()
    this.attachWaiters.set(agentId, () => {
      clearTimeout(entry.attachCeiling)
      delete entry.attachCeiling
      this.attachWaiters.delete(agentId)
      logEvent('agent_attach_late', { agentId, name: req.name, elapsedMs: Date.now() - launchedAt })
      onAttached()
    })
  }

  /**
   * A launch that came up empty: undo it, record it as an exit that FAILED, and
   * hand the reason back (CC-95, second case).
   *
   * The surface goes because leaving it is how the evidence was collected in the
   * first place — a pane created for an agent that never existed, sitting on a
   * shell prompt with no owner and no way for anyone to know it was dead. The
   * `agent_exited` row is what stops the roster reading `starting` forever; the
   * requester gets it pushed only if it subscribed to its spawns (CC-1500).
   */
  private async failSpawn(
    req: SpawnRequest,
    agentId: string,
    reason: string,
    release: FailedRelease,
  ): Promise<SpawnOutcome> {
    const full = `${req.name} was launched but never registered: ${reason}`
    await this.recordExit(agentId, { code: null, signal: null, failed: full })
    await this.releaseFailedSpawn(req, agentId, release)
    logEvent('agent_spawn_failed', { agentId, name: req.name, reason })
    return { ok: false, agentId, name: req.name, reason: full }
  }

  /** CC-158: a launch that threw started no process, so its identity ends failed and its allocation is released. */
  private async abandonLaunch(req: SpawnRequest, agentId: string, reason: string): Promise<void> {
    if (this.spawnEventOf(agentId) !== undefined)
      this.core.append({
        kind: 'agent_exited',
        actor: req.name,
        ref: agentId,
        body: `${req.name} never started: ${reason}`,
        meta: { failed: 'true' },
      })
    await this.releaseFailedSpawn(req, agentId, 'now')
  }

  /**
   * CC-158: release what a spawn that never registered allocated, under retire's
   * dirty and unmerged checks, and only once its process is known gone. The reclaim
   * grace is not applied: it anchors on an agent that ran, and a tree whose process
   * may still be alive is kept for retire, which does apply it. A refusal leaves the
   * runtime state for retire --force.
   */
  private async releaseFailedSpawn(req: SpawnRequest, agentId: string, when: FailedRelease): Promise<void> {
    // A name that never registered never reaches `core.drop`, so its spawn-time claim would outlive it.
    this.core.claims.releaseAll(req.name)
    const held = readRuntimeState(agentId)
    if (held === undefined || when === 'keep') return
    if (when === 'if-pane-closed' && (await this.paneStillOpen(held.handle))) return
    const ctx = { agentId, agentName: req.name, baseCwd: req.cwd ?? process.cwd() }
    if (!(await this.releaseHeld(ctx, held, {}))) return
    // Kept, not cleared, so retire still closes the pane; `none` so it never releases the tree twice.
    writeRuntimeState(agentId, { ...held, allocation: { cwd: held.allocation.cwd }, isolation: 'none' })
  }

  /**
   * CC-952: hold the agent's declared paths before it registers, so the next
   * burndown tick refuses an overlapping task. The repo is the spawn cwd's main
   * checkout, the key the tick filters claims by; a refused claim spawns anyway.
   */
  private claimAtSpawn(req: SpawnRequest, worktreePath: string, cwd: string): void {
    if (!req.claimPaths?.length) return
    const root = gitRootOf(cwd)
    const outcome = this.core.claims.claim({
      owner: req.name,
      worktreePath,
      ...(root === undefined ? {} : { repoPath: canonicalRootOf(root) }),
      patterns: req.claimPaths,
    })
    if (!outcome.ok) logEvent('agent_spawn_claim_refused', { name: req.name, reason: outcome.reason })
  }

  /**
   * The newest live agent already stacked beside this anchor. Insertion order is
   * spawn order, so the last match is the bottom of the column — the pane a new
   * agent should split. Nothing is persisted: a column is a fact about panes that
   * currently exist, and after a broker restart the next spawn starts a new one.
   */
  private columnFor(anchor: string): string | undefined {
    let bottom: string | undefined
    for (const entry of this.live.values()) {
      if (entry.anchor === anchor && entry.handle.paneRef) bottom = entry.handle.paneRef
    }
    return bottom
  }

  /** CC-485: the host surface a fresh spawn launches on; a seat's worker with none requested runs headless. */
  private spawnSurface(req: SpawnRequest, profile: AgentProfile): SurfaceName {
    const requested = defaultSpawnSurface({
      requested: req.surface,
      profileSurface: profile.surface,
      role: roleOf(profile),
      seatSpawn: req.surface === undefined && this.isSeatSpawn(req),
    })
    return this.resolve(requested)
  }

  /** A seat owns the name; an unreadable seats directory counts as no seat, so the profile's surface stands. */
  private isSeatSpawn(req: SpawnRequest): boolean {
    if (this.seatBudget === undefined) return false
    try {
      const spawn = {
        name: req.name,
        spawner: this.seatSpawner(req),
        configDir: defaultConfigDir(),
        now: new Date(),
      }
      return this.seatBudget.read(spawn).kind !== 'none'
    } catch {
      return false
    }
  }

  /** CC-804: the surface a requested name lands on, given this host's platform. */
  private resolve(surface: SurfaceName): SurfaceName {
    return resolveSurface(surface, this.surfaceOptions?.platform)
  }

  /** TP-4256 A3: every broker launch writes its files here, so the ledger admits each one. */
  private writeAdmitted(
    req: AdmitRequest,
    plan: LaunchPlan,
    profile: AgentProfile,
    created: CreatedWorktree | undefined,
  ): void {
    const config = buildMcpConfig(profile, cliEntry(), plan.surface)
    if (this.ledger === undefined) writeLaunchFiles(plan, config, created, OFF_BROKER)
    else
      this.ledger.admit({ ...req, parent: this.admittedParent(req) }, admission =>
        writeLaunchFiles(plan, config, created, admission),
      )
  }

  /**
   * The ledger enrols a parent once and latches any later admit naming another, while
   * `ledgerParent` can change its answer when an adopted parent is admitted; so an agent the
   * ledger knows keeps the parent it was enrolled under.
   */
  private admittedParent(req: AdmitRequest): Parent {
    return this.ledger?.parentOf(req.agentId) ?? this.ledgerParent(req.parent)
  }

  /**
   * A session the human started by hand is adopted at register and never admitted, so it has no
   * launch for the ledger to check (plan risk 6). Its children root at the human; once the ledger
   * admits it (an `agent resume` of it), the chain of a child enrolled after that counts.
   */
  private ledgerParent(parent: Parent): Parent {
    if (parent === HUMAN_ROOT || this.ledger?.knows(parent)) return parent
    if (this.spawnRow(parent)?.meta.origin === 'adopted') return HUMAN_ROOT
    this.readmit(parent)
    return parent
  }

  /** The parent an agent's spawn row recorded, so every relaunch of it admits under the same one. */
  private recordedParent(agentId: string): Parent {
    return this.rootOf(agentId).parent
  }

  /** A relaunch of `agentId` under its root, carrying any quarantine on record for a skipped ancestor. */
  private recordedAdmission(agentId: string, humanProof?: boolean): AdmitRequest {
    return rootAdmission(agentId, this.rootOf(agentId), humanProof)
  }

  /**
   * TP-4345 S3: the root `survivorRoot` resolves, which resume, spawn and teleport all share. With
   * the ledger off nothing reads it, so it stays the recorded parent and probes no process.
   */
  private rootOf(agentId: string, meta = this.spawnRow(agentId)?.meta): SurvivorRoot {
    const ledger = this.ledger
    if (ledger === undefined) return { parent: ledgerParentOf(meta) }
    const probe = batchProbe(this.processProbe)
    return survivorRoot(agentId, meta, {
      spawnMeta: id => this.spawnRow(id)?.meta,
      knows: id => ledger.knows(id),
      running: id => this.running(id, probe),
      onRecord: id => this.core.events.quarantineOnRecord(id),
    })
  }

  /**
   * TP-4345 S3 (D3): held by this supervisor, connected under its own id, or with a process the
   * probe cannot prove gone. A row that is merely not exited or retired is not enough. An agent on
   * another host cannot be probed from here, so until the reaper ends its row it counts as running.
   */
  private running(agentId: string, probe: ProcessProbe): boolean {
    if (this.live.has(agentId) || this.reattached.has(agentId)) return true
    const agent = this.core.agents.get(agentId)
    if (agent === undefined || DEPARTED.has(agent.state)) return false
    const conn = this.core.registry.connFor(agent.name)
    if (conn !== undefined && this.core.registry.entryFor(conn)?.agentId === agentId) return true
    if (remoteHostOf(agent) !== undefined) return true
    return !agentLiveness(agent, probe).dead
  }

  /** A successor never carries `humanProof`: a teleport is the agent's own act, not the human's. */
  private successorAdmission(input: RelaunchInput): AdmitRequest {
    const teleportFrom = input.inheritedFrom ?? input.meta?.teleport_from
    const meta = teleportFrom === undefined ? input.meta : { ...input.meta, teleport_from: teleportFrom }
    return rootAdmission(input.agentId, this.rootOf(input.agentId, meta))
  }

  /**
   * TP-4341: a running agent a previous broker launched, enrolled from the launch it left on disk
   * once its lineage resolves. Whatever cannot be checked stays unknown, which still denies.
   */
  private readmit(agentId: string): void {
    if (this.ledger === undefined || this.ledger.knows(agentId) || this.readmitting.has(agentId)) return
    this.readmitting.add(agentId)
    try {
      const skipped = this.tryReadmit(this.ledger, agentId)
      if (skipped !== undefined) this.readmits?.skipped(agentId, skipped)
    } catch (err) {
      logEvent('integrity_readmit_failed', { agentId, error: String(err) })
    } finally {
      this.readmitting.delete(agentId)
    }
  }

  /** TP-4345 S2: enrols the survivor and writes its row, or returns why it was skipped. */
  private tryReadmit(ledger: LaunchLedger, agentId: string): string | undefined {
    const agent = this.core.agents.get(agentId)
    if (agent === undefined) return 'unknown agent'
    if (DEPARTED.has(agent.state)) return 'departed'
    const survivor = survivingLaunch(agentId, this.core.events.integrityWiredSince())
    if (survivor === undefined) return 'no launch dir'
    const root = this.rootOf(agentId)
    if (root.unresolved !== undefined) return root.unresolved
    const parent = this.ledgerParent(root.parent)
    if (parent !== HUMAN_ROOT && !ledger.knows(parent))
      return `lineage unresolved via ${parent} (${this.core.agents.get(parent)?.state ?? 'unknown'})`
    const own = this.core.events.quarantineOnRecord(agentId)
    const recorded = own ?? root.inherited?.mismatch
    const latched = ledger.readmit({ agentId, parent }, survivor, recorded)
    if (latched !== undefined) return latchReason(latched, recorded, own ? undefined : root.inherited?.via)
    this.readmits?.admitted(agentId, parent, survivor.intact && survivor.nonce !== undefined)
    return undefined
  }

  /** TP-4345 S2: once the start's settle window closes, how many of the survivors that reattached the ledger enrolled. */
  private sweepReadmits(): void {
    this.readmitSweep = undefined
    const live = [...this.reattachedAtStart].filter(id => {
      const state = this.core.agents.get(id)?.state
      return state !== undefined && !DEPARTED.has(state)
    })
    const skipped = live.filter(id => this.ledger?.knows(id) !== true)
    this.readmits?.sweep({ live: live.length, admitted: live.length - skipped.length, skipped })
    this.reattachedAtStart.clear()
  }

  /**
   * TP-4313: a parent is unadmitted only while the ledger has no baseline for it; a quarantined one
   * stays the ledger's call, and a hand-started session the ledger roots at the human is never one.
   */
  private unadmitted(parent: Parent): parent is string {
    if (parent === HUMAN_ROOT || this.ledger === undefined) return false
    if (this.ledgerParent(parent) === HUMAN_ROOT) return false
    const verdict = this.ledger.verdict(parent)
    return !verdict.ok && verdict.reason === 'no baseline'
  }

  /** TP-4313: walks up from `child` while each parent is unadmitted, so the resumes can run parents first. */
  private unadmittedLineage(child: AgentIdentity): ResumeLineage {
    const ancestors: AgentIdentity[] = []
    const seen = new Set([child.agentId])
    for (let id = this.recordedParent(child.agentId); this.unadmitted(id);) {
      if (seen.has(id))
        return { refusal: `integrity: ${child.name} is not resumed: its lineage loops at ${id}` }
      if (ancestors.length === LINEAGE_DEPTH)
        return {
          refusal: `integrity: ${child.name} is not resumed: over ${LINEAGE_DEPTH} unadmitted ancestors`,
        }
      const parent = this.core.agents.get(id)
      if (parent === undefined)
        return {
          refusal: `integrity: ${child.name} is not resumed: its parent ${id} is not an agent this broker knows`,
        }
      const refusal = unresumableParent(child.name, parent)
      if (refusal !== undefined) return { refusal }
      ancestors.unshift(parent)
      seen.add(id)
      id = this.recordedParent(id)
    }
    return { ancestors }
  }

  /** TP-4313: after a restart, resumes the child's unadmitted ancestors first, so its admit never latches `unknown parent`. */
  private async resumeAncestors(child: AgentIdentity, req: ResumeRequest): Promise<string | undefined> {
    const lineage = this.unadmittedLineage(child)
    if ('refusal' in lineage) return this.enforced(child.agentId, lineage.refusal, 'resume')
    // TP-4347: shadow starts no launch `off` would not, so the child's own admit records the gap.
    if (this.wouldDeny !== undefined) return undefined
    for (const parent of lineage.ancestors) {
      if (this.core.agents.byName(parent.name)?.agentId !== parent.agentId)
        return `integrity: ${child.name} is not resumed: its parent ${parent.agentId} is not the agent the name ${parent.name} resumes`
      const outcome = await this.resume(parent.name, parentResume(req, child.name))
      if (!outcome.ok)
        return `integrity: ${child.name} is not resumed: its parent ${parent.name} did not resume (${outcome.reason})`
    }
    return undefined
  }

  /** TP-4256 A3: the ledger's refusal of this agent's launch; undefined to launch it. */
  private launchRefusal(agentId: string, call?: IntegrityCall): string | undefined {
    const verdict = this.ledger?.verdict(agentId)
    if (verdict === undefined || verdict.ok) return undefined
    return this.enforced(agentId, integrityRefusal(agentId, verdict), call)
  }

  /** TP-4347: the refusal to make; in shadow none, and the one at `call` is written as a would_deny row. */
  private enforced(agentId: string, refusal: string, call?: IntegrityCall): string | undefined {
    if (this.wouldDeny === undefined) return refusal
    if (call !== undefined) this.wouldDeny({ agentId, reason: refusal, call })
    return undefined
  }

  private async launchOn(
    surface: SurfaceName,
    plan: LaunchPlan,
    anchor: string | undefined,
    reuseAnchor: boolean,
    call: IntegrityCall,
  ): Promise<LaunchHandle> {
    const refusal = this.launchRefusal(plan.agentId, call)
    if (refusal !== undefined) throw new Error(refusal)
    const columnAfter = anchor === undefined ? undefined : this.columnFor(anchor)
    return surfaceFor(surface, {
      ...this.surfaceOptions,
      ...(anchor === undefined ? {} : { anchor }),
      ...(columnAfter === undefined ? {} : { columnAfter }),
      ...(reuseAnchor ? { reuseAnchor } : {}),
      onNotice: text => {
        this.core.append({ kind: 'notice', actor: 'agent-chat', target: 'human', body: text })
      },
    }).launch(plan)
  }

  private track(
    agentId: string,
    name: string,
    handle: LaunchHandle,
    allocation: Allocation,
    isolation: IsolationName,
    anchor?: string,
    reviewerTree?: TreeFingerprint,
  ): void {
    // A settle timer from a previous life closes over the OLD Live object, but
    // `recordExit` resolves the entry by id against the current map — so a timer
    // left armed here would fire against the agent that just came back, delete
    // it, free its slot, and record an exit for a running process. Replacing the
    // entry has to cancel the timer that belonged to it.
    const previous = this.live.get(agentId)
    if (previous?.settle) clearTimeout(previous.settle)
    this.forgetReattach(agentId)

    const entry: Live = {
      agentId,
      name,
      handle,
      allocation,
      isolation,
      ...(anchor ? { anchor } : {}),
      ...(reviewerTree ? { reviewerTree } : {}),
    }
    this.live.set(agentId, entry)
    // CC-78: the same facts on disk, so a retire that outlives this broker can
    // still release the worktree and close the pane. `exited` is dropped because
    // a Promise cannot be persisted, which is also what makes the persisted copy
    // safe to use only where an exit callback is irrelevant. `launchFailed` likewise.
    const { exited: _exited, launchFailed: _launchFailed, ...handleState } = handle
    writeRuntimeState(agentId, { handle: handleState, allocation, isolation, ...(anchor ? { anchor } : {}) })
    // Headless only. A visible agent has no such promise, by design, and falls
    // through to the presence-inferred path instead.
    void handle.exited?.then(outcome => void this.recordExit(agentId, outcome, entry))
  }

  /**
   * End the process, keeping the identity. Refuses on a visible surface: killing
   * a pane a human is looking at, from a bus any peer model can reach, is not a
   * thing to build.
   */
  kill(name: string): { ok: boolean; reason?: string } {
    const entry = this.find(name)
    if (!entry) return { ok: false, reason: `no live agent named "${name}"` }
    if (entry.handle.surface !== 'headless')
      return {
        ok: false,
        reason: `${name} is running in an iTerm pane; exit it there, or \`agent-chat agent attach ${name}\` to go to it.`,
      }
    const { pid } = entry.handle
    if (pid === undefined) return { ok: false, reason: `${name} has no recorded pid` }

    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      return { ok: false, reason: `${name} (pid ${pid}) was already gone` }
    }
    entry.cancelReason = 'exited after a cancellation request'
    this.shadow.requestCancellation(entry.executionId, 'kill')
    setTimeout(() => killLauncherGroup(pid), KILL_GRACE_MS).unref?.()
    return { ok: true }
  }

  /**
   * Close the identity: release isolation, close the surface, end the process,
   * free the name. Retire is the ONLY thing that frees a name, so a detached
   * agent stays addressable and its peers' remembered addressing keeps working
   * until someone decides otherwise.
   *
   * CC-77 added the reap, and the order matters: isolation can REFUSE (dirty or
   * unmerged work), so nothing is killed until that has passed. Closing a
   * broker-owned pane already ended the process in the ordinary case — the reap
   * is for the case where there is no handle to close, which a broker restart
   * makes routine, since `live` is memory only and nothing rehydrates it. That
   * gap is not theoretical: an agent retired after a restart sat finished in its
   * pane for three days, and its retire reported ok.
   *
   * CC-78 closed the other half of the same gap: what `live` held is now also on
   * disk, so a restart no longer costs the worktree and the pane either.
   */
  async retire(
    name: string,
    force = false,
    actor?: string,
    claim: OwnershipClaim = {},
  ): Promise<{ ok: boolean; reason?: string }> {
    const identity = this.core.agents.byName(name)
    if (!identity) return { ok: false, reason: `no agent named "${name}"` }
    return this.retireIdentity(identity, { force }, actor, claim)
  }

  /** CC-408: the bulk form retires the row it planned, never whichever row now holds the name. */
  async retireById(
    agentId: string,
    actor?: string,
    release: ReleaseOptions = {},
    claim: OwnershipClaim = {},
  ): Promise<{ ok: boolean; reason?: string }> {
    const identity = this.core.agents.get(agentId)
    // CC-1453: a hand-started seat's teleport successor leases the name, so the seat watchdog retires it by id.
    if (identity === undefined || !launchedByBroker(identity) || identity.state === 'retired')
      return { ok: false, reason: `no unretired spawned agent with id ${agentId}` }
    return this.retireIdentity(identity, { keepBranch: release.keepBranch === true }, actor, claim)
  }

  /** CC-959: a stale seat row by id; never whichever row holds the name now, and never a live one. */
  async retireStale(
    agentId: string,
    name: string,
    actor?: string,
    claim: OwnershipClaim = {},
  ): Promise<{ ok: boolean; reason?: string }> {
    const identity = this.core.agents.get(agentId)
    if (identity !== undefined && identity.name !== name)
      return { ok: false, reason: `agent ${agentId} no longer holds the name "${name}"` }
    const live = identity?.state === 'live' || identity?.state === 'spawning'
    if (identity !== undefined && (live || this.namePresence(identity) === 'self'))
      return { ok: false, reason: `agent ${agentId} (${name}) is still live; not retired` }
    return this.retireById(agentId, actor, {}, claim)
  }

  /** CC-1138: every retire path ends here, so the worker ownership rule is checked before anything is released. */
  private async retireIdentity(
    identity: AgentIdentity,
    release: ReleaseOptions,
    actor?: string,
    claim: OwnershipClaim = {},
  ): Promise<{ ok: boolean; reason?: string }> {
    const refused = this.checkOwnership(identity, claim, 'retire')
    if (refused) return { ok: false, reason: refused }
    const force = release.force === true
    const name = identity.name
    const held = this.live.get(identity.agentId)
    const entry = held ?? this.rehydrate(identity.agentId, name)
    const tenancy = entry ? this.worktreeTenancy(identity.agentId, name, entry, force) : undefined
    if (tenancy?.refusal) return { ok: false, reason: tenancy.refusal }

    if (entry) {
      const released = await this.releaseIsolation(identity, name, entry, release)
      if (!released)
        return {
          ok: false,
          reason: `${name}'s isolation refused release (${refusalOf(entry.allocation) ?? 'still holds work'}). Merge or discard it, or retire with --force.`,
        }
      // CC-408: a teleport successor may reuse the stale row's pane, so only the name's own process closes it.
      if (this.namePresence(identity) !== 'other') await this.closeSurface(entry)
      this.live.delete(identity.agentId)
    }

    const reaped = this.reap(identity)
    this.semaphore.release(identity.agentId)
    clearRuntimeState(identity.agentId)
    // CC-126: retire frees the name, so this row is how the conversation is found again.
    const transcript = identityTranscript(identity)
    this.core.append({
      kind: 'agent_retired',
      actor: actor ?? 'human',
      target: name,
      ref: identity.agentId,
      meta: {
        reaped,
        session_id: identity.sessionId,
        transcript: transcript.path,
        transcript_found: String(transcript.found),
      },
    })
    this.finishRetired(identity.agentId, held)
    this.seatJournal?.({ event: 'retire', agent: name })
    this.writeRetiredRow(identity, transcript.path)
    const remote = remoteHostOf(identity)
    const hadHandle = entry !== undefined || remote !== undefined
    const caveat = this.retireCaveat(name, hadHandle, reaped, tenancy?.warning, remote)
    return { ok: true, ...(caveat ?? {}) }
  }

  /** CC-331: the spend read streams the whole transcript, so the row is written after retire has answered. */
  private writeRetiredRow(identity: AgentIdentity, transcript: string): void {
    const log = this.seatDispatch
    if (log === undefined) return
    const meta = this.core.agents.spawnMeta(identity.agentId)
    const facts: SpawnFacts = {
      agent: identity.name,
      agent_id: identity.agentId,
      spawner: identity.spawnedBy || null,
      profile: meta.profile ?? identity.profile,
      model: meta.model ?? null,
      predecessor: meta.predecessor ?? null,
      ...(meta.spawned_as === undefined ? {} : { spawnedAs: meta.spawned_as }),
    }
    const sessionId = identity.sessionId || null
    const tree = allocatedWorktree(this.core.events.agentEvents(), identity.agentId)
    void readTranscriptSpend(transcript)
      .then(async read => {
        const outcome = await retireOutcomeOf(read.ok ? read.work : undefined, () => branchHead(tree))
        writeDispatch(() => log.retired(facts, sessionId, retireSpendOf(read), outcome))
        await log.ended?.(facts, outcome)
      })
      .catch(dispatchUnavailable)
  }

  /**
   * CC-282: remove an exited agent's clean, pushed worktree and keep its branch.
   *
   * Runs here rather than in the CLI so the occupancy check, the removal and the
   * `isolation_parked` row happen in the process that also serialises spawns into
   * that tree, and so the row lands in the log `agent resume` reads it back from.
   */
  async park(name: string, req: ParkRequest = {}): Promise<{ ok: boolean; reason?: string }> {
    const identity = this.core.agents.byName(name)
    if (!identity) return { ok: false, reason: `no agent named "${name}"` }
    const refused = this.checkOwnership(identity, req, 'park')
    if (refused) return { ok: false, reason: refused }
    if (this.parking.has(identity.agentId)) return { ok: false, reason: `${name} is already being parked` }
    const target = allocatedWorktree(this.core.events.agentEvents(), identity.agentId)
    const blocked = this.parkBlockerFor(identity.agentId, target)
    if (blocked !== undefined || target === undefined) return { ok: false, reason: blocked ?? 'no worktree' }
    let settle = (): void => undefined
    const done = new Promise<void>(resolve => (settle = resolve))
    this.parking.set(identity.agentId, { tree: canonicalPath(target.worktree), done })
    try {
      return await this.parkTree(name, identity, target, req)
    } finally {
      this.parking.delete(identity.agentId)
      settle()
    }
  }

  /**
   * The entry is set before the fix-round check, not after: a spawn into the tree registers as
   * its tenant only after several awaits, so the occupancy re-check before removal cannot see
   * one that got past `parkingRefusal`. CC-1468: it is dropped once the removal answers, and the
   * row is written in the same turn, so a resume woken by `done` reads it.
   */
  private async parkTree(
    name: string,
    identity: AgentIdentity,
    target: ParkTarget,
    req: ParkRequest,
  ): Promise<{ ok: boolean; reason?: string }> {
    const check = req.noFixRoundCheck === true ? undefined : this.shepherdSkip
    const fixRound = check && (await fixRoundBlocker(check, identity, target))
    if (fixRound) return { ok: false, reason: fixRound }
    const { prHead } = req
    const parked = await parkWorktree(
      target,
      () => this.parkBlockerFor(identity.agentId, target),
      identity.state === 'detached' || req.checkProcesses ? this.cwdLister : undefined,
      prHead && (() => Promise.resolve([prHead])),
    )
    this.parking.delete(identity.agentId)
    if (!parked.ok) return parked
    this.recordParked(name, identity.agentId, { ...target, branch: parked.branch }, parked.head)
    return {
      ok: true,
      reason: `Parked ${target.worktree}; branch ${parked.branch} kept at ${parked.head}.`,
    }
  }

  /**
   * CC-323: retire every finished agent in scope that holds no work, each through `retire` so its refusals apply.
   * CC-1138: the caller is each row's actor, and a worker caller plans only the agents it spawned.
   */
  async retireFinished(
    req: RetireScope & { dryRun?: boolean; caller?: string } & Omit<OwnershipClaim, 'requestedBy'>,
  ): Promise<FinishedRetireOutcome> {
    const { requesterAgentId, requesterBinding, ...scope } = req
    const claim: OwnershipClaim = {
      ...(req.caller === undefined ? {} : { requestedBy: req.caller }),
      ...(requesterAgentId === undefined ? {} : { requesterAgentId }),
      ...(requesterBinding === undefined ? {} : { requesterBinding }),
    }
    const port: FinishedRetirePort = {
      roster: () => this.core.agents.roster(),
      events: () => this.core.events.agentEvents(),
      tracked: (agentId: string) => this.live.has(agentId),
      parking: (agentId: string) => this.parking.has(agentId),
      current: (agentId: string) => this.core.agents.get(agentId),
      presence: (agent: AgentIdentity) => this.namePresence(agent),
      ownership: (agent: AgentIdentity) => this.checkOwnership(agent, claim, 'retire'),
      retire: (agentId: string) => this.retireById(agentId, req.caller, {}, claim),
      now: () => Date.now(),
      ...(this.shepherdSkip === undefined ? {} : { skip: this.shepherdSkip }),
    }
    return retireFinished(port, scope)
  }

  /** CC-921: park and retire an opted-in spawner's agent that exited on a final report; logs why when it keeps one. */
  private async retireIfReported(agentId: string): Promise<void> {
    const port = this.reportRetirePort()
    if (port === undefined) return
    const result = await retireAtReport(port, agentId)
    if (result.action === 'kept')
      logEvent('auto_retire_kept', { agentId, name: result.name, reason: result.reason })
    if (result.action === 'retired') logEvent('auto_retired', { agentId, ...result })
  }

  /** CC-976: park a reviewer's tree at its final Verdict, opt-in or not; a CC-921 park already removed it. */
  private async parkReviewerIfReported(agentId: string): Promise<void> {
    const result = await parkReviewerAtReport(this.reviewerParkPort(), agentId)
    if (result.action === 'kept')
      logEvent('reviewer_park_kept', { agentId, name: result.name, reason: result.reason })
    if (result.action === 'parked') logEvent('reviewer_parked', { agentId, ...result })
  }

  private reviewerParkPort(): ReviewerParkPort {
    return {
      current: agentId => this.core.agents.get(agentId),
      events: () => this.core.events.agentEvents(),
      lastReport: agent => this.lastReportText(agent),
      finalText: agent =>
        finalAssistantText(agent.cwd, agent.sessionId, agent.configDir === '' ? undefined : agent.configDir),
      park: agentId => this.parkById(agentId),
    }
  }

  /** CC-1039: park a non-reviewer's clean, pushed tree at a normal exit; an earlier park already removed it. */
  private async parkImplementerIfExited(agentId: string): Promise<void> {
    const port = this.implementerParkPort()
    if (port === undefined) return
    const result = await parkImplementerAtExit(port, agentId)
    if (result.action === 'kept')
      logEvent('implementer_park_kept', { agentId, name: result.name, reason: result.reason })
    if (result.action === 'parked') logEvent('implementer_parked', { agentId, ...result })
  }

  private implementerParkPort(): ImplementerParkPort | undefined {
    const enabled = this.autoParkOnExit
    if (enabled === undefined) return undefined
    const treeHold = this.burndownTreeHold
    return {
      current: agentId => this.core.agents.get(agentId),
      events: () => this.core.events.agentEvents(),
      enabled,
      treeHold: tree => treeHold?.(tree),
      park: agentId => this.parkById(agentId, { checkProcesses: true }),
    }
  }

  private lastReportText(agent: AgentIdentity): string | undefined {
    return this.core.events.lastStatusReport(
      agent.name,
      reportRecipients(agent.spawnedBy),
      this.core.runStartedAt(agent),
    )?.text
  }

  private reportRetirePort(): ReportRetirePort | undefined {
    const enabledFor = this.autoRetireOnReport
    if (enabledFor === undefined || this.shepherdSkip === undefined) return undefined
    return {
      current: agentId => this.core.agents.get(agentId),
      roster: () => this.core.agents.roster(),
      events: () => this.core.events.agentEvents(),
      enabledFor,
      lastReport: agent => this.lastReportText(agent),
      tracked: agentId => this.live.has(agentId),
      skip: this.shepherdSkip,
      park: agentId => this.parkById(agentId),
      retire: agentId => this.retireById(agentId, 'agent-chat', { keepBranch: true }),
    }
  }

  /** `park` resolves a name, so a teleport successor holding it now is refused rather than parked. */
  private parkById(agentId: string, req: ParkRequest = {}): Promise<{ ok: boolean; reason?: string }> {
    const name = this.core.agents.get(agentId)?.name
    if (name === undefined || this.core.agents.byName(name)?.agentId !== agentId)
      return Promise.resolve({ ok: false, reason: 'the name now belongs to another agent' })
    return this.park(name, req)
  }

  /** Read fresh each call, so the re-check before removal sees a spawn or resume that landed during the git checks. */
  private parkBlockerFor(agentId: string, target: ParkTarget | undefined): string | undefined {
    const identity = this.core.agents.get(agentId)
    if (!identity) return 'the agent was retired while parking'
    return parkBlocker(identity, this.live.has(agentId), target, this.core.agents.roster())
  }

  private recordParked(name: string, agentId: string, target: ParkTarget, head: string): void {
    const { gitRoot, worktree, branch } = target
    this.core.append({
      kind: 'isolation_parked',
      actor: name,
      ref: agentId,
      body: '',
      meta: { strategy: 'worktree', gitRoot, worktree, branch, head },
    })
    this.seatJournal?.({ event: 'park', agent: name })
  }

  /** CC-282: a spawn or resume into a tree mid-park would lose its cwd to the removal. */
  private parkingRefusal(dir: string | undefined): string | undefined {
    if (dir === undefined) return undefined
    const at = canonicalPath(dir)
    for (const { tree } of this.parking.values())
      if (isAtOrUnder(at, tree)) return `${tree} is being parked; try again once the park finishes`
    return undefined
  }

  /**
   * CC-141: a successor spawned with `worktree:` adopts its predecessor's tree, and
   * adoption leaves ownership with the predecessor, so retiring it would pull the
   * tree out from under the successor. "Still working" means any identity that is
   * not retired, the same test `byName` and the name lease use: an exited or
   * detached agent can still be resumed into that cwd.
   */
  private worktreeTenancy(
    agentId: string,
    name: string,
    entry: Live,
    force: boolean,
  ): { refusal?: string; warning?: string } | undefined {
    const ref = entry.allocation.ref
    if (entry.isolation !== 'worktree' || ref?.assigned === 'true' || !ref?.worktree) return undefined
    const tree = canonicalPath(ref.worktree)
    const tenants = this.core.agents
      .roster()
      .filter(a => a.agentId !== agentId && a.cwd !== '' && isAtOrUnder(canonicalPath(a.cwd), tree))
      .map(a => a.name)
    if (tenants.length === 0) return undefined
    const who = tenants.join(', ')
    if (!force)
      return {
        refusal:
          `${name} allocated the worktree ${tree}, and ${who} (not retired) is working in it. ` +
          `Retire ${who} first, or leave ${name} parked until that branch merges. ` +
          'Retire with --force to release it anyway.',
      }
    return {
      warning: `--force released the worktree ${tree} and branch ${ref.branch ?? '(unknown)'} while ${who} was still working in it`,
    }
  }

  /** A row the pre-restart broker opened has no `Live` here, so it is found by agent instead. */
  private finishRetired(agentId: string, held: Live | undefined): void {
    if (held?.executionId !== undefined)
      return this.shadow.finish(held.executionId, { outcome: 'cancelled', reason: 'retired' })
    this.shadow.finishByAgent(agentId, { outcome: 'cancelled', reason: 'retired after restart' })
  }

  /**
   * The persisted runtime state, shaped as the `Live` entry retire needs.
   *
   * RETIRE ONLY, and deliberately not put back into `live`. A general rehydrate
   * on broker start would hand every other caller an entry describing a process
   * this broker did not launch: `kill` would signal a pid that may since have
   * been recycled, and the settle timers and slot accounting in `recordExit`
   * would infer exits for agents nobody is watching. Retire needs none of that.
   * It needs the worktree to remove and the pane to close, and it is about to
   * throw the identity away regardless.
   */
  private rehydrate(agentId: string, name: string): Live | undefined {
    const state = readRuntimeState(agentId)
    if (!state) return undefined
    return { agentId, name, ...state }
  }

  /** Extracted from `retire` so the log row is written on both outcomes, once. */
  private async releaseIsolation(
    identity: AgentIdentity,
    name: string,
    entry: Live,
    release: ReleaseOptions,
  ): Promise<boolean> {
    const stopped = stoppedAt(identity)
    const ctx: IsolationContext = {
      agentId: identity.agentId,
      agentName: name,
      baseCwd: identity.cwd,
      // CC-188: not lastEventAt, which each refused retire's own isolation_released row advances.
      ...(stopped !== undefined ? { stoppedAt: stopped } : {}),
    }
    return this.releaseHeld(ctx, entry, release)
  }

  /** Shared by retire and a failed spawn, so both write the same `isolation_released` row. */
  private async releaseHeld(
    ctx: IsolationContext,
    entry: Pick<Live, 'allocation' | 'isolation'>,
    release: ReleaseOptions,
  ): Promise<boolean> {
    const released = await resolveIsolation([entry.isolation]).release(ctx, entry.allocation, release)
    // A `none` release is a no-op, so a row would claim a second release of what a failed spawn already gave back.
    if (entry.isolation === 'none') return released
    this.core.append({
      kind: 'isolation_released',
      actor: ctx.agentName,
      ref: ctx.agentId,
      body: released ? '' : 'refused: uncommitted or unmerged work, or inside the reclaim window',
      meta: { strategy: entry.isolation, released: String(released) },
    })
    return released
  }

  /**
   * End Claude Code itself for an agent being retired, on the pid its own
   * registration reported.
   *
   * `endSession` is reused rather than `kill`: `kill` refuses on a visible
   * surface, and rightly — killing a pane a human is looking at from a bus any
   * peer can reach is not a thing to build. Retire is not that. It is CLI-only,
   * so the caller is a person, and it is already the act that frees the name and
   * destroys the isolation; leaving the process alive was the odd one out.
   *
   * `not_registered` is the ordinary, quiet case: the agent already exited, or
   * its pane close above ended it, and there is nothing left to signal.
   */
  private reap(identity: AgentIdentity): Reaped {
    const name = identity.name
    const presence = this.namePresence(identity)
    if (presence === 'none') return 'not_registered'
    if (presence === 'other') return 'another_agent'
    const remote = remoteHostOf(identity)
    if (remote !== undefined) return this.requestRemoteEnd(identity, remote)
    const hostPid = this.core.registry.hostPidFor(name)
    if (hostPid === undefined) return 'no_host_pid'
    return this.endSession(name, hostPid, this.core.registry.hostFor(name)).ok ? 'true' : 'already_gone'
  }

  /**
   * CC-1059: the broker cannot signal a pid on another host, so it asks the agent's own MCP
   * process, which ends its Claude Code when the id is its own. Nothing confirms it: retired is
   * terminal, so the detach that follows changes no row.
   */
  private requestRemoteEnd(identity: AgentIdentity, host: string): Reaped {
    const conn = this.core.registry.connFor(identity.name)
    if (conn === undefined) return 'not_registered'
    const reason = `retired; ending ${identity.name} on ${host}`
    conn.write(encode({ t: 'end_self', agentId: identity.agentId, reason }))
    logEvent('remote_end_requested', { agentId: identity.agentId, name: identity.name, host })
    return 'remote_end_requested'
  }

  /** CC-408: an unbound connection counts as this agent's, so the doubt falls on not retiring. */
  private namePresence(identity: AgentIdentity): NamePresence {
    const conn = this.core.registry.connFor(identity.name)
    if (conn === undefined) return 'none'
    const bound = this.core.registry.entryFor(conn)?.agentId
    return bound === undefined || bound === identity.agentId ? 'self' : 'other'
  }

  /**
   * What retire could NOT do, said out loud. Retire still succeeded — the name
   * is freed either way — but returning a bare ok is what let a live process and
   * an unreleased worktree go unnoticed for three days.
   */
  private retireCaveat(
    name: string,
    hadHandle: boolean,
    reaped: string,
    tenancyWarning: string | undefined,
    remoteHost?: string,
  ): { reason: string } | undefined {
    const notes: string[] = tenancyWarning === undefined ? [] : [tenancyWarning]
    if (reaped === 'remote_end_requested')
      notes.push(
        `${name} runs on ${remoteHost ?? 'another host'}, so the broker asked its own process to end ` +
          'rather than signalling it. Nothing confirms that it ended, and an older agent-chat there ' +
          'ignores the request; check its terminal on that host',
      )
    if (!hadHandle)
      notes.push(
        `the broker has no record of what ${name} held, in memory or on disk (spawned before ` +
          'runtime state was persisted, or the file is unreadable), so any isolation it allocated ' +
          'was not released and any pane it owns was not closed',
      )
    if (reaped === 'no_host_pid')
      notes.push(
        `${name} is still running but its MCP server predates \`hostPid\`, so the broker cannot end ` +
          'it without severing the bus and leaving it running; exit it in its terminal',
      )
    if (reaped === 'another_agent')
      notes.push(
        `another agent now holds the name ${name}, so its process was left running and no pane was closed`,
      )
    return notes.length === 0 ? undefined : { reason: `Note: ${notes.join('. ')}.` }
  }

  /**
   * Close the pane, tab or window an agent was given.
   *
   * Reached from retire AND from `recordExit` (CC-95). It was retire-only, on the
   * argument that an agent finishing is not an instruction to throw away what it
   * printed; six months of panes said otherwise. A finished agent's pane is a
   * dead shell nobody reads, and a wall of them is what a coordinator has to scan
   * to find a live one. Retire is still the act that frees the name and destroys
   * the isolation; it is no longer the only thing that tidies the screen.
   *
   * What is closed is decided by `ownsSurface`, one layer down, and THAT is the
   * constraint that never moved. A pane the broker merely split off, or an adopted
   * session's own window, has no such mark and survives. `kill` needs nothing
   * here: it already refuses on any visible surface.
   */
  private async closeSurface(entry: Live): Promise<void> {
    if (entry.handle.ownsSurface !== true) return
    const { closed, reason } = await surfaceFor(entry.handle.surface, { ...this.surfaceOptions }).close(
      entry.handle,
    )
    logEvent('agent_surface_closed', {
      name: entry.name,
      surface: entry.handle.surface,
      closed,
      // CC-95: `closed:false` used to be a bare boolean nobody could act on, and
      // `closed:true` used to be a claim nobody had checked. Both are now sourced
      // from a second read of iTerm2's session list.
      ...(reason === undefined ? {} : { reason }),
    })
  }

  /**
   * Relaunch a listed, non-live identity on its own conversation (CC-126).
   *
   * Refused unless the transcript is on disk: `--resume` replays state Claude
   * Code owns, and an identity without it would come back knowing nothing. The
   * outcome carries the verdict either way so the caller never has to guess.
   */
  async resume(name: string, req: ResumeRequest = {}): Promise<SpawnOutcome> {
    await this.parkSettled(this.core.agents.byName(name)?.cwd)
    const drained = this.drainRefusal()
    if (drained) return { ok: false, ...drained }
    const identity = this.core.agents.byName(name)
    if (!identity) return { ok: false, reason: this.missingReason(name) }
    const crashLooping = crashLoopRefusal(identity, req)
    if (crashLooping) return { ok: false, reason: crashLooping, code: CRASH_LOOP_REFUSAL, retryable: false }
    const refused =
      this.checkResumer(identity, req) ??
      this.supersededRefusal(identity) ??
      this.parkingRefusal(identity.cwd) ??
      this.resumingRefusal(identity)
    if (refused) return { ok: false, reason: refused }
    return this.holdingLaunch(identity, () => this.resumeUnguarded(identity, req))
  }

  /**
   * CC-1468: a resume into a tree mid-park waits for that park, then runs every check afresh:
   * a park that removed the tree has written its `isolation_parked` row, so the tree is
   * re-created, and a refused one left it in place. The wait takes no launch hold, and park
   * never waits on one, so the two cannot deadlock; past `parkWaitMs`, `parkingRefusal` answers.
   */
  private async parkSettled(dir: string | undefined): Promise<void> {
    if (!dir) return
    const at = canonicalPath(dir)
    const pending = [...this.parking.values()].filter(p => isAtOrUnder(at, p.tree)).map(p => p.done)
    if (pending.length === 0) return
    let timer: NodeJS.Timeout | undefined
    const bound = new Promise<void>(resolve => (timer = setTimeout(resolve, this.parkWaitMs)))
    await Promise.race([Promise.all(pending), bound])
    clearTimeout(timer)
  }

  /**
   * CC-1456: a second resume while one is in flight would see the old state and
   * launch a second process on the same session. Refused rather than joined: the
   * second request may carry its own message, surface or requester, and handing
   * it the first launch's result would answer a request nobody made.
   */
  private resumingRefusal(identity: AgentIdentity): string | undefined {
    const since = this.resuming.get(identity.agentId)
    if (since === undefined)
      return this.remoteLaunchRefusal(identity) ?? this.sessionLaunchRefusal(identity.sessionId)
    return (
      `${identity.name} is already resuming (since ${new Date(since).toISOString()}); ` +
      'wait for that resume to answer, then check agent_list before resuming again'
    )
  }

  /**
   * CC-1472: a host resume releases its hold once the launcher accepts the launch, before the
   * agent registers; until it does, or the attach ceiling passes, a second launch would run a
   * second process on the same session.
   */
  private remoteLaunchRefusal(identity: AgentIdentity): string | undefined {
    if (!this.remoteSpawns.has(identity.agentId)) return undefined
    return (
      `${identity.name} is already resuming on ${identity.host ?? 'another machine'} and has not registered yet; ` +
      'check agent_list before resuming again'
    )
  }

  /** CC-1457: a `resume_session` spawn mints a new agent id, so only the session id shows it shares a conversation. */
  private sessionLaunchRefusal(sessionId: string | undefined): string | undefined {
    const held = sessionId ? this.launchingSessions.get(sessionId) : undefined
    if (held === undefined) return undefined
    return (
      `session ${sessionId} is already launching for ${held.name} (since ${new Date(held.since).toISOString()}); ` +
      'wait for that launch to answer, then check agent_list before launching it again'
    )
  }

  /**
   * CC-1456, CC-1457: holds the agent and its session from before the first await
   * until the launch answers, so resume, surface switch, `resume_session` spawn
   * and an account-move relaunch (CC-1462) refuse each other. Callers check the
   * refusals first.
   */
  private async holdingLaunch<T>(
    hold: { agentId?: string; name: string; sessionId?: string },
    launch: () => Promise<T>,
  ): Promise<T> {
    const since = Date.now()
    if (hold.agentId !== undefined) this.resuming.set(hold.agentId, since)
    if (hold.sessionId) this.launchingSessions.set(hold.sessionId, { name: hold.name, since })
    try {
      return await launch()
    } finally {
      if (hold.agentId !== undefined) this.resuming.delete(hold.agentId)
      if (hold.sessionId) this.launchingSessions.delete(hold.sessionId)
    }
  }

  private async resumeUnguarded(checked: AgentIdentity, req: ResumeRequest): Promise<SpawnOutcome> {
    let identity = checked
    const { name } = identity
    if (identity.state === 'live') {
      const stale = await this.staleLiveRefusal(identity)
      if (stale) return { ok: false, reason: stale }
      identity = this.core.agents.get(identity.agentId) ?? identity
    }
    if (req.host !== undefined) {
      const route = this.resumeRoute(req.host)
      if ('refusal' in route) return { ok: false, reason: route.refusal }
      if (route.site === 'launcher') return this.resumeOnHost(identity, req, route)
    }
    const transcript = identityTranscript(identity)
    const gone = this.goneCwd(identity)
    const blocked = resumeBlocker(identity, transcript, gone)
    if (blocked) return { ok: false, reason: blocked, transcript }
    const profile = this.resumeProfile(identity, req.requestedBy)
    if ('error' in profile)
      return {
        ok: false,
        reason: `cannot reload profile "${identity.profile}": ${profile.error}`,
        transcript,
      }
    if (!this.semaphore.acquire(identity.agentId))
      return { ok: false, reason: `no free agent slots (${this.semaphore.summary()})`, transcript }
    // TP-4313: after every check on the child's own record, and holding its slot, so no parent
    // starts for a child that would be refused anyway, nor takes the slot the child needs.
    const orphaned = await this.resumeAncestors(identity, req)
    if (orphaned !== undefined) {
      this.semaphore.release(identity.agentId)
      return { ok: false, reason: orphaned, transcript }
    }

    const executionId = this.shadow.resume(
      identity.agentId,
      identity.configDir ?? configDir(),
      identity.sessionId,
    )
    const warnings: string[] = []
    const relaunch = this.resumeRemoteControl(identity, req, warnings)
    try {
      const reattached = gone ? await this.reattachForResume(identity, gone, req) : undefined
      warnings.push(...(reattached?.warnings ?? []))
      await this.relaunchResumed(identity, profile, relaunch, transcript, executionId, reattached)
    } catch (err) {
      this.semaphore.release(identity.agentId)
      const reason = `resume failed: ${(err as Error).message}`
      this.shadow.finish(executionId, { outcome: 'failed', reason, retryable: false })
      const code = err instanceof SurfaceRefused ? { code: 'surface_refused' as const } : {}
      return { ok: false, reason, ...code, transcript }
    }
    if (req.message !== undefined && (req.surface ?? 'headless') !== 'headless')
      warnings.push(
        'a visible resume opens on the conversation as it was left; the message was not delivered',
      )
    return { ok: true, agentId: identity.agentId, name, transcript, ...(warnings.length ? { warnings } : {}) }
  }

  /** CC-1472: where a resume naming `host` runs; the broker's own host is today's local resume. */
  private resumeRoute(host: string): ResumeRoute {
    return resumeRouteFor({
      host,
      brokerHost: brokerHost(),
      launchers: this.hosts?.launchers() ?? [],
      aliases: knownMachineAliases(),
    })
  }

  /**
   * CC-1472: resume on another machine through its launcher, which holds the transcript. Every
   * refusal returns from here: a host request never falls through to the local resume, since that
   * would answer about a transcript the requester did not ask for.
   */
  private async resumeOnHost(
    identity: AgentIdentity,
    checked: ResumeRequest,
    route: LauncherRoute,
  ): Promise<SpawnOutcome> {
    const hosts = this.hosts
    if (hosts?.spawn === undefined) return { ok: false, reason: `no launcher connected on ${route.host}` }
    const warnings: string[] = []
    const req = this.resumeRemoteControl(identity, checked, warnings)
    const surface = req.surface ?? 'headless'
    const refused =
      identityBlocker(identity) ?? remoteResumeRefusal(identity, surface, this.resumeSite(route))
    if (refused !== undefined) return { ok: false, reason: refused }
    const profile = this.resumeProfile(identity, req.requestedBy)
    if ('error' in profile)
      return { ok: false, reason: `cannot reload profile "${identity.profile}": ${profile.error}` }
    const probed = await probeTranscript(hosts.probe.bind(hosts), identity, surface, route.host)
    if ('refusal' in probed) return { ok: false, reason: probed.refusal, ...probed.verdict }
    const { transcript } = probed
    warnings.push(...localCopyWarning(identityTranscript(identity), brokerHost(), route.host))
    const launch = resumeLaunchFor(identity, profile, { ...req, surface })
    const launched = await this.launchOnLauncher(identity, req, launch, transcript, {
      host: route.host,
      spawn: hosts.spawn.bind(hosts),
    })
    if (launched !== undefined) return { ok: false, reason: launched, transcript }
    if (req.message !== undefined && surface !== 'headless')
      warnings.push(
        'a visible resume opens on the conversation as it was left; the message was not delivered',
      )
    return {
      ok: true,
      agentId: identity.agentId,
      name: identity.name,
      host: route.host,
      transcript,
      ...(warnings.length ? { warnings } : {}),
    }
  }

  private resumeSite(route: LauncherRoute): RemoteResumeSite {
    return {
      host: route.host,
      platform: route.platform,
      brokerHost: brokerHost(),
      brokerPlatform: process.platform,
      user: os.userInfo().username,
      brokerHome: os.homedir(),
      surfaces: this.hosts?.surfacesOn(route.host) ?? [],
    }
  }

  /**
   * Records the resume and hands it to the launcher's spawn executor. No slot is taken: the process
   * runs on another machine, and an attach adopts one as for any agent this broker did not launch.
   * Lost before it registers, the resume is closed as never started and the identity is kept.
   */
  private async launchOnLauncher(
    agent: AgentIdentity,
    req: ResumeRequest,
    launch: RemoteLaunch,
    transcript: TranscriptVerdict,
    { host, spawn }: { host: string; spawn: NonNullable<LauncherSite['spawn']> },
  ): Promise<string | undefined> {
    const executionId = this.shadow.resume(agent.agentId, agent.configDir ?? configDir(), agent.sessionId)
    this.remoteSpawns.open({
      agentId: agent.agentId,
      name: agent.name,
      host,
      announce: () => undefined,
      onLost: reason => this.hostResumeLost(agent, executionId, reason),
    })
    this.core.append({
      kind: 'agent_resumed',
      actor: req.requestedBy ?? HUMAN,
      target: agent.name,
      ref: agent.agentId,
      body: 'resumed',
      meta: {
        session_id: agent.sessionId,
        surface: launch.surface,
        from_surface: agent.surface,
        transcript: transcript.path,
        host,
        ...(req.source === undefined ? {} : { source: req.source }),
        ...(req.cause === undefined ? {} : { cause: req.cause }),
        ...launchMeta(req),
        ...this.crashClearedMeta(agent, req),
      },
    })
    const answer = await spawn(host, launch, HOST_RESUME_TIMEOUT_MS)
    this.remoteSpawns.ready(
      agent.agentId,
      answer.ok ? { ok: true } : { ok: false, reason: answer.reason ?? '' },
    )
    return answer.ok ? undefined : `refused on ${host}: ${answer.reason ?? 'no reason given'}`
  }

  /** CC-1492: a host resume's execution closes as a local one's does when its launch fails. */
  private hostResumeLost(agent: AgentIdentity, executionId: string | undefined, reason: string): void {
    this.shadow.finish(executionId, { outcome: 'failed', reason, retryable: false })
    this.resumeNeverStarted(agent, new Error(reason))
  }

  /** CC-1453: a hand-started session's teleport successor runs on what it inherited, which no profile file holds. */
  private resumeProfile(identity: AgentIdentity, by: string | undefined): AgentProfile | { error: string } {
    if (identity.origin === 'adopted')
      return inheritedProfile(this.core.agents.spawnMeta(identity.agentId).model)
    return this.loadLaunchableProfile(identity.profile, by)
  }

  /** CC-883: the watchdog asks for Remote Control without knowing the role, so a worker's resume drops it rather than fails. */
  private resumeRemoteControl(
    identity: AgentIdentity,
    req: ResumeRequest,
    warnings: string[],
  ): ResumeRequest {
    if (!req.remoteControl || recordedRole(this.core.agents.spawnMeta(identity.agentId)) !== 'worker')
      return req
    warnings.push(
      `${identity.name} is a worker, so it resumed without Remote Control; only a coordinator may run with it`,
    )
    return { ...req, remoteControl: false }
  }

  /**
   * CC-216: a worker may resume only an agent it spawned itself, so it cannot
   * relaunch a coordinator or a peer's agent on a message of its own choosing.
   */
  private checkResumer(identity: AgentIdentity, req: ResumeRequest): string | undefined {
    return this.checkOwnership(identity, req, 'resume')
  }

  /** CC-408: only the newest session under a name is resumed; an older generation is stale. */
  private supersededRefusal(identity: AgentIdentity): string | undefined {
    const newer = this.core.agents.supersededBy(identity)
    if (newer === undefined) return undefined
    const kind = newer.origin === 'adopted' ? 'adopted ' : ''
    const account = newer.configDir === undefined ? '' : ` on ${newer.configDir}`
    return (
      `${identity.name}'s session ${identity.sessionId || '(none)'} is stale: a newer ${kind}${identity.name} ` +
      `(agent ${newer.agentId}, session ${newer.sessionId || '(none)'}${account}) is ${newer.state}, so resuming the older one is refused`
    )
  }

  /** CC-225: surfacing stops the running process, so it takes resume's rule; surfacing yourself is always allowed. */
  private checkSurfacer(identity: AgentIdentity, req: SwitchRequest): string | undefined {
    if (identity.agentId === req.requesterAgentId) return undefined
    return this.checkOwnership(identity, req, 'surface')
  }

  /**
   * CC-216/CC-225: a registered worker may act only on agents it spawned.
   * Coordinators, human-started sessions and the unregistered human pass.
   */
  private checkOwnership(
    identity: AgentIdentity,
    { requesterAgentId, requestedBy, requesterBinding }: OwnershipClaim,
    verb: 'resume' | 'surface' | 'park' | 'retire',
  ): string | undefined {
    const requester = this.requesterOf(requesterAgentId, { binding: requesterBinding, name: requestedBy })
    if (requester.role !== 'worker') return undefined
    if (this.spawnEventOf(identity.agentId)?.meta.parent === requesterAgentId) return undefined
    return (
      `${requestedBy ?? 'the requester'} is a worker (profile ${requester.profile || 'unknown'}) ` +
      `and can ${verb} only agents it spawned; ${identity.name} was not. Report the need to your ` +
      'spawner via chat_send'
    )
  }

  /** The refusal for a name nothing live holds, with the retired agent's removed worktree when it can come back. */
  private missingReason(name: string): string {
    const roster = this.core.agents.roster({ includeRetired: true })
    const retired = roster.find(a => a.name === name && a.state === 'retired' && a.origin === 'spawned')
    const gone = retired && retiredWorktree(roster, this.core.events.agentEvents(), retired.sessionId)
    return missingAgent(name, retired, gone)
  }

  /** CC-140: the removed worktree an identity's cwd was, when agent-chat can re-create it. */
  private goneCwd(identity: AgentIdentity): WorktreeRecord | undefined {
    const gone = goneWorktree(this.core.events.agentEvents(), identity.agentId)
    return gone !== undefined && gone.worktree === path.resolve(identity.cwd) ? gone : undefined
  }

  /** CC-1110: the self-grant anchor, the tree this allocation launches in only if agent-chat recorded creating it. */
  private createdWorktree(
    agentId: string,
    allocation: Allocation,
    isolation: IsolationName,
  ): CreatedWorktree | undefined {
    return createdWorktreeFor(this.core.events.agentEvents(), agentId, allocation, isolation)
  }

  /** Re-create the worktree and record it, so a later retire treats it like the allocation or adoption it was. */
  private async reattachForResume(
    identity: AgentIdentity,
    gone: WorktreeRecord,
    req: ResumeRequest,
  ): Promise<Allocation> {
    const allocation = await recreateWorktree(gone, { treeHolders: this.treeHolders })
    this.core.append({
      kind: 'isolation_allocated',
      actor: req.requestedBy ?? HUMAN,
      ref: identity.agentId,
      body: allocation.note ?? '',
      meta: { strategy: 'worktree', ...(allocation.ref ?? {}) },
    })
    return allocation
  }

  /** The launch half of `resume`. Isolation is reused, never reallocated, so a worktree agent lands back in its own. */
  /** CC-1671 S4: a resume by hand is the one row that clears a mark or a streak. */
  private crashClearedMeta(agent: AgentIdentity, req: ResumeRequest): Record<string, string> {
    if (agent.crashStreak === undefined || isAutomaticRelaunch(req)) return {}
    return { crash_cleared: 'true' }
  }

  /** CC-1671 S4: a seat relaunch mints a new id, so the identity it replaces is the one to read. */
  private lineageCrashRefusal(req: SpawnRequest): string | undefined {
    const replaced = req.lineageFrom === undefined ? undefined : this.core.agents.get(req.lineageFrom)
    return replaced === undefined ? undefined : crashLoopRefusal(replaced, req)
  }

  /** CC-1671 S4: an automated relaunch under a new id carries on its predecessor's count. */
  private inheritedCrashStreak(req: SpawnRequest): Record<string, string> {
    const streak =
      req.lineageFrom === undefined ? undefined : this.core.agents.get(req.lineageFrom)?.crashStreak
    return streak === undefined || !isAutomaticRelaunch(req) ? {} : { crash_streak: String(streak) }
  }

  private async relaunchResumed(
    agent: AgentIdentity,
    profile: AgentProfile,
    req: ResumeRequest,
    transcript: TranscriptVerdict,
    executionId: string | undefined,
    reattached?: Allocation,
  ): Promise<void> {
    const state = this.live.get(agent.agentId) ?? readRuntimeState(agent.agentId)
    const allocation = reattached ?? state?.allocation ?? { cwd: agent.cwd }
    const isolation = reattached ? 'worktree' : (state?.isolation ?? (agent.isolation as IsolationName))
    const surface = this.resolve(req.surface ?? 'headless')
    const plan = buildLaunchPlan({
      agentId: agent.agentId,
      sessionId: agent.sessionId,
      resume: true,
      name: agent.name,
      profile,
      adopted: agent.origin === 'adopted',
      brief: req.message ?? RESUMED_BRIEF,
      cwd: allocation.cwd,
      cwdHoldsUserSettings: cwdHoldsUserSettings(allocation.cwd, agent.configDir),
      surface,
      mcpConfigPath: mcpConfigPath(agent.agentId),
      hookSettingsPath: hookSettingsPath(agent.agentId),
      ...(allocation.addDirs ? { extraDirs: allocation.addDirs } : {}),
      agentChatHome: home(),
      gitHooksDir: gitHooksDir(),
      ...(agent.configDir ? { configDir: agent.configDir } : {}),
      ...(agent.configDirUnset ? { configDirUnset: true } : {}),
      ...(req.remoteControl ? { remoteControl: true } : {}),
    })
    const provenance = reattached === undefined ? {} : await worktreeProvenance(reattached)
    const humanProof = isHumanResume(req)
    // TP-4341: the clear and the row that records it, with no await between them for a quarantine to fall in.
    this.writeAdmitted(
      this.recordedAdmission(agent.agentId, humanProof),
      plan,
      profile,
      this.createdWorktree(agent.agentId, allocation, isolation),
    )
    this.core.append({
      kind: 'agent_resumed',
      actor: req.requestedBy ?? HUMAN,
      target: agent.name,
      ref: agent.agentId,
      body: 'resumed',
      meta: {
        session_id: agent.sessionId,
        surface,
        from_surface: agent.surface,
        transcript: transcript.path,
        ...(req.source === undefined ? {} : { source: req.source }),
        ...(req.cause === undefined ? {} : { cause: req.cause }),
        ...launchMeta(req),
        ...this.crashClearedMeta(agent, req),
        ...(humanProof ? { [INTEGRITY_CLEARED]: HUMAN } : {}),
        // CC-915: a re-created worktree may sit on a fresh branch cut from a newer base.
        ...provenance,
      },
    })
    const reviewerTree = await this.reviewerTreeBefore(profile.name, agent.name, allocation.cwd)
    const handle = await this.launchOn(surface, plan, req.anchor, false, 'resume').catch((err: unknown) => {
      this.resumeNeverStarted(agent, err)
      throw err
    })
    this.track(agent.agentId, agent.name, handle, allocation, isolation, req.anchor, reviewerTree)
    this.bindExecution(agent.agentId, executionId)
  }

  /** CC-326: closes the `agent_resumed` row of a launch that threw, so nothing reads it as a resume that started. */
  private resumeNeverStarted(agent: AgentIdentity, err: unknown): void {
    this.core.append({
      kind: 'agent_exited',
      actor: agent.name,
      ref: agent.agentId,
      body: `${agent.name} resume never started: ${err instanceof Error ? err.message : String(err)}`,
      meta: { failed: 'true', never_started: 'true' },
    })
  }

  /**
   * Move a live agent between headless and a terminal, keeping its conversation.
   * Policy — who may aim this, and where it lands — is `mode-switch.ts`; this is
   * the mechanism only.
   */
  async switchSurface(req: SwitchRequest): Promise<SwitchOutcome> {
    const identity = this.core.agents.byName(req.name)
    const blocked =
      req.to === 'headless'
        ? checkBackgroundable(identity, req.name, req.hostPid)
        : checkSurfaceable(identity, req.name)
    if (blocked) return { ok: false, reason: blocked }

    const agent = identity as AgentIdentity
    const refused = req.to === 'interactive' ? this.checkSurfacer(agent, req) : undefined
    if (refused) return { ok: false, reason: refused }
    const profile = this.loadLaunchableProfile(agent.profile, req.requestedBy)
    if ('error' in profile)
      return { ok: false, reason: `cannot reload profile "${agent.profile}": ${profile.error}` }
    if (agent.sessionId === '')
      return { ok: false, reason: `${req.name} has no recorded session id, so it cannot be resumed` }
    // CC-1457: refused before the stop, so a switch that cannot relaunch never ends the running process.
    const inFlight = this.resumingRefusal(agent)
    if (inFlight) return { ok: false, reason: inFlight }
    // CC-1505: an iTerm surface on a Linux host threw from the launch after the stop, and the broker died.
    const surface = req.to === 'headless' ? 'headless' : this.resolve(placementFor(req.anchor))
    const unlaunchable = this.surfaceBlocker(surface)
    if (unlaunchable) return { ok: false, reason: `cannot surface ${req.name}: ${unlaunchable}` }

    return this.holdingLaunch(agent, async () => {
      const stopped = this.stopFor(req, agent)
      if (!stopped.ok) return { ok: false, reason: stopped.reason as string }
      await this.waitForNameFree(req.name)
      return this.resumeOnto(req, agent, profile, surface)
    })
  }

  /**
   * End the running process, by the route that direction is allowed to use.
   *
   * Surfacing reaches `kill`, which refuses anything but a headless agent — and
   * a headless agent is the only thing surfacing applies to, so the guard that
   * protects a human's pane from a peer stays fully intact. Backgrounding reaches
   * `endSession`, on a pid the caller reported about its OWN process.
   *
   * An agent that is not live is not an error: it is already stopped, and the
   * resume below is exactly what it needed anyway.
   */
  private stopFor(req: SwitchRequest, agent: AgentIdentity): { ok: boolean; reason?: string } {
    const entry = this.live.get(agent.agentId)
    if (entry === undefined) return { ok: true }
    const stopped =
      req.to === 'headless' ? this.endSession(req.name, req.hostPid as number, req.host) : this.kill(req.name)
    if (stopped.ok) entry.cancelReason = MODE_SWITCH
    return stopped
  }

  /** Rebuild the plan against the new surface and reattach to the same conversation. */
  private async resumeOnto(
    req: SwitchRequest,
    agent: AgentIdentity,
    profile: AgentProfile,
    surface: SurfaceName,
  ): Promise<SwitchOutcome> {
    const entry = this.live.get(agent.agentId)
    const allocation = entry?.allocation ?? { cwd: agent.cwd }
    const isolation = entry?.isolation ?? (agent.isolation as IsolationName)

    const plan = buildLaunchPlan({
      agentId: agent.agentId,
      sessionId: agent.sessionId,
      resume: true,
      name: req.name,
      profile,
      adopted: agent.origin === 'adopted',
      brief: req.to === 'headless' ? BACKGROUNDED_BRIEF : agent.brief,
      cwd: allocation.cwd,
      cwdHoldsUserSettings: cwdHoldsUserSettings(allocation.cwd, agent.configDir),
      surface,
      mcpConfigPath: mcpConfigPath(agent.agentId),
      hookSettingsPath: hookSettingsPath(agent.agentId),
      ...(allocation.addDirs ? { extraDirs: allocation.addDirs } : {}),
      agentChatHome: home(),
      gitHooksDir: gitHooksDir(),
      // A mode switch is the SAME agent in a different window, so it keeps the
      // account it was spawned on. Without this the rebuilt plan would drop the
      // config dir and the agent would come back billing the broker's account,
      // with its conversation resumed from a transcript it can no longer find.
      ...(agent.configDir ? { configDir: agent.configDir } : {}),
      ...(agent.configDirUnset ? { configDirUnset: true } : {}),
    })
    this.writeAdmitted(
      this.recordedAdmission(agent.agentId),
      plan,
      profile,
      this.createdWorktree(agent.agentId, allocation, isolation),
    )

    // `surface` in meta is what stops the roster reporting the pane this agent no
    // longer has — `foldAgent` reads it, and only a switch ever writes it.
    this.core.append({
      kind: 'agent_resumed',
      actor: req.requestedBy,
      target: req.name,
      ref: agent.agentId,
      body: req.to === 'headless' ? 'backgrounded' : 'surfaced',
      meta: { session_id: agent.sessionId, surface, from_surface: agent.surface },
    })

    const executionId = this.continueExecution(agent, entry)
    let handle: LaunchHandle
    try {
      handle = await this.launchOn(surface, plan, req.anchor, false, 'mode switch')
    } catch (err) {
      this.resumeNeverStarted(agent, err)
      const said = err instanceof Error ? err.message : String(err)
      return { ok: false, reason: `${req.name} was stopped but did not relaunch: ${said}` }
    }
    this.track(agent.agentId, req.name, handle, allocation, isolation, req.anchor, entry?.reviewerTree)
    this.bindExecution(agent.agentId, executionId)
    logEvent('agent_surface_switched', { name: req.name, to: handle.surface, from: agent.surface })
    // Delivered after the relaunch so it lands in the session that came back,
    // rather than the one that was about to be signalled.
    if (req.to !== 'headless') this.tellAgent(req.name, SURFACED_NOTICE)
    return { ok: true, name: req.name, agentId: agent.agentId, surface: handle.surface }
  }

  /** The stopped process's exit may land after `track` replaced its entry, so its row is closed here too. */
  private continueExecution(agent: AgentIdentity, stopped: Live | undefined): string | undefined {
    this.finishSuperseded(agent.agentId, stopped, MODE_SWITCH)
    return this.shadow.resume(agent.agentId, agent.configDir ?? configDir(), agent.sessionId)
  }

  /** A second finish on a terminal row is a no-op, so this is safe beside `recordExit`. */
  private finishSuperseded(agentId: string, held: Live | undefined, reason: string): void {
    if (held?.executionId !== undefined)
      return this.shadow.finish(held.executionId, { outcome: 'cancelled', reason })
    this.shadow.finishByAgent(agentId, { outcome: 'cancelled', reason })
  }

  /**
   * A `message` rather than a `notice`: notices are not pushed and are not an
   * inbox kind, so one aimed at a session is simply never seen — the defect the
   * teleport live runs found, and the same trap is open here.
   */
  private tellAgent(name: string, body: string): void {
    const { msgId } = this.core.append({ kind: 'message', actor: 'agent-chat', target: name, body })
    this.core.deliverTo(name, { msgId, from: 'agent-chat', text: body, at: Date.now() })
  }

  /**
   * Registration is what holds a name, and the resumed process registers under
   * the name the stopped one still holds. Timing out is not fatal — the launch
   * proceeds and the agent's own registration reports the collision.
   */
  private async waitForNameFree(name: string): Promise<void> {
    const deadline = Date.now() + this.nameFreeMs
    while (Date.now() < deadline) {
      if (this.core.registry.connFor(name) === undefined) return
      await new Promise(resolve => setTimeout(resolve, NAME_FREE_POLL_MS))
    }
    logEvent('switch_name_held', { name, waitedMs: this.nameFreeMs })
  }

  /** Hand off to a successor and end this session. See `teleport.ts`. */
  async teleport(req: TeleportRequest): Promise<TeleportOutcome> {
    return this.teleporter.start(req)
  }

  /**
   * CC-1592: an account move's dry run. Reads what `Teleport.accountMove` reads, so it records no
   * handoff and ends nothing; the profile and surface checks a real move runs after it are not run.
   */
  checkAccountMove(subject: TeleportSubject, account: AccountMoveRequest): TeleportOutcome {
    const identity = this.core.agents.get(subject.agentId)
    if (identity === undefined) return { ok: false, reason: `no durable identity for ${subject.agentId}` }
    const reason = accountMoveRefusal(
      this.accountMoves,
      {
        name: subject.name,
        onBrokerHost: isLocalHost(subject.host),
        configDir: subject.configDir ?? this.core.agents.spawnMeta(subject.agentId).config_dir,
        cwd: this.inheritedIsolation(subject.agentId)?.allocation.cwd ?? subject.cwd,
        sessionId: identity.sessionId ?? '',
      },
      account,
    )
    return reason === undefined ? { ok: true, name: subject.name } : { ok: false, reason }
  }

  /** CC-881: what a session teleporting from another host waits on: the launch to run there. */
  teleportPlan(agentId: string): Promise<RemotePlanReply> {
    return this.teleporter.remotePlan(agentId)
  }

  teleportLaunched(agentId: string, report: RemoteLaunchReport): { ok: boolean; reason?: string } {
    return this.teleporter.remoteLaunched(agentId, report)
  }

  /** CC-913: the caller's helper could not place an armed successor after its predecessor exited. */
  teleportLandFailed(agentId: string, token: string, reason: string, from?: string): LandFailedReply {
    return this.teleporter.landFailed(agentId, token, reason, from)
  }

  /** The human's veto on a countdown. No agent-facing path reaches this. */
  abortTeleport(name: string): { ok: boolean; reason?: string } {
    return this.teleporter.abort(name)
  }

  /**
   * The predecessor's isolation, for the descendant to STAND IN rather than
   * re-allocate. Undefined for an ordinary session, which never had one.
   */
  inheritedIsolation(agentId: string): InheritedIsolation | undefined {
    const entry = this.live.get(agentId)
    if (!entry) return undefined
    return { allocation: entry.allocation, isolation: entry.isolation, slot: this.semaphore.has(agentId) }
  }

  /**
   * End Claude Code itself, on a pid the session reported about its own process.
   *
   * Deliberately NOT `kill(name)`: that refuses on a visible surface, because
   * killing a pane a human is looking at from a bus any peer can reach is not a
   * thing to build. This is the other case — the session asked to end itself, a
   * human was offered 30 seconds to say no, and nothing here can be aimed at
   * anyone else, since the pid came from the caller's own registration.
   */
  endSession(name: string, hostPid: number, host: string | undefined): { ok: boolean; reason?: string } {
    const polite = signalSessionPid(name, hostPid, 'SIGTERM', host)
    if (!polite.ok) return polite
    setTimeout(() => signalSessionPid(name, hostPid, 'SIGKILL', host), KILL_GRACE_MS).unref?.()
    return { ok: true }
  }

  /** CC-880: why a surface cannot launch here, so teleport refuses before ending anyone. */
  surfaceBlocker(surface: SurfaceName): string | undefined {
    return surfaceBlockerFor(surface, this.surfacePlatform())
  }

  /** CC-951: the OS this broker launches on, faked in tests. */
  surfacePlatform(): NodeJS.Platform {
    return this.surfaceOptions?.platform ?? process.platform
  }

  /** CC-1203: a teleport is an agent launch, so a drifted profile is flagged or refused and never re-baselined. */
  loadProfile(name: string, by: string): AgentProfile | { error: string } {
    return this.loadLaunchableProfile(name, by)
  }

  /**
   * Launch a descendant into a name and an isolation that already exist.
   *
   * Everything the ordinary spawn path decides — a fresh allocation, a slot, a
   * depth one greater than its parent — is pinned by the caller here instead,
   * because a teleport is a continuation of one agent rather than the creation
   * of another. What it does NOT skip is rebuilding the launch plan and the MCP
   * config: that is what makes the descendant exec the current `dist/cli.js` and
   * read the current instructions, which is the entire payoff of the feature.
   *
   * CC-1462: an account move resumes the predecessor's session, so it holds that session
   * as a `resume_session` spawn does, and refuses, before any side effect, a session
   * another launch already holds. A fresh-session relaunch has nothing to hold.
   */
  async relaunch(input: RelaunchInput): Promise<void> {
    const session = input.resumeSession
    if (session === undefined) return this.relaunchUnguarded(input)
    const inFlight = this.sessionLaunchRefusal(session)
    if (inFlight) throw new Error(inFlight)
    return this.holdingLaunch({ name: input.name, sessionId: session }, () => this.relaunchUnguarded(input))
  }

  private async relaunchUnguarded(input: RelaunchInput): Promise<void> {
    // The descendant occupies exactly what the predecessor did, so the budget
    // sees one agent throughout rather than two for the length of a launch.
    if (input.inheritedFrom !== undefined) this.semaphore.release(input.inheritedFrom)
    if (input.inherited?.slot) this.semaphore.acquire(input.agentId)
    // The predecessor's entry is dropped here rather than left for its own exit
    // to clear: `find(name)` scans by name, and for as long as both entries sit
    // in the map, "the live agent called scout" resolves to the dead one — so a
    // kill or an `agent attach` would be aimed at a process that is already gone.
    // CC-951: a successor-first teleport keeps it, since the predecessor is still
    // running and is kept if the successor never attaches; `standDown` drops it.
    const predecessor = input.inheritedFrom === undefined ? undefined : this.live.get(input.inheritedFrom)
    if (predecessor !== undefined && input.successorFirst === true) predecessor.teleporting = true
    else if (predecessor !== undefined) this.standDown(predecessor.agentId)

    const isolation = input.inherited?.isolation ?? 'none'
    const allocation = input.inherited?.allocation ?? { cwd: input.cwd }
    if (input.inherited !== undefined)
      this.core.append({
        kind: 'isolation_allocated',
        actor: input.name,
        ref: input.agentId,
        body: allocation.note ?? '',
        meta: {
          strategy: isolation,
          ...(allocation.ref ?? {}),
          // So a later release still finds the branch, worktree path and git root
          // it needs — without this the tree survives every retirement forever.
          ...(input.inheritedFrom === undefined ? {} : { inherited_from: input.inheritedFrom }),
        },
      })

    const { plan, sessionId } = this.successorPlan(input, allocation)
    this.writeAdmitted(
      this.successorAdmission(input),
      plan,
      input.profile,
      this.createdWorktree(input.agentId, allocation, isolation),
    )
    this.appendSuccessorSpawn(input, sessionId, allocation, isolation)

    const executionId = this.openSuccessor(input, predecessor)
    const launch: SuccessorLaunch = { input, plan, sessionId, predecessor, allocation, isolation }
    const { handle, retried } = await this.launchSuccessor(launch, executionId)
    this.trackSuccessor(launch, handle)
    this.bindExecution(input.agentId, executionId)
    this.watchSuccessor(launch, handle, retried)
    this.announceSuccessor(input, sessionId, allocation.cwd)
  }

  /** CC-951: the predecessor's entry goes once it is being ended, so its own exit records nothing over its successor. */
  standDown(agentId: string): void {
    const predecessor = this.live.get(agentId)
    if (predecessor === undefined) return
    if (predecessor.settle) clearTimeout(predecessor.settle)
    this.live.delete(agentId)
    // CC-951: a successor on another machine took no slot here, so the predecessor's goes with it.
    this.semaphore.release(agentId)
  }

  /**
   * CC-951: a successor-first teleport whose successor never attached, while its
   * predecessor still runs. The predecessor gets back what `relaunch` moved to it: its
   * slot, and prompts its stale-session guard would now block. The successor is stopped,
   * headless or in a surface the broker opened, since its row retires. CC-1450: the marker
   * is cleared by the predecessor's own id, since one reattached after a restart is not in
   * `live` and so carries no `inheritedFrom`.
   */
  keepPredecessor(predecessorId: string, input: RelaunchInput, reason: string): void {
    const successor = this.live.get(input.agentId)
    if (successor !== undefined) {
      if (successor.settle) clearTimeout(successor.settle)
      this.live.delete(input.agentId)
      this.finishFailedLaunch(successor.executionId, reason)
      this.stopSuccessor(successor)
    }
    this.semaphore.release(input.agentId)
    clearSuperseded(predecessorId)
    if (input.inheritedFrom === undefined) return
    const predecessor = this.live.get(input.inheritedFrom)
    if (predecessor !== undefined) delete predecessor.teleporting
    if (input.inherited?.slot) this.semaphore.acquire(input.inheritedFrom)
  }

  /** CC-1451: an unreadable process table reads as not running, so the land window is not extended on a guess. */
  async successorRunning(agentId: string): Promise<boolean> {
    return (await this.launcherRunning(agentId)) === true
  }

  /** CC-951: the predecessor ended and its successor did not start, so only the human can act. */
  noticeLostTeleport(input: RelaunchInput, reason: string): void {
    this.noticeDeadSuccessor(
      input,
      `${input.name} ended while its teleport successor was starting, and the successor did not start: ${reason}`,
      reason,
    )
  }

  private stopSuccessor(entry: Live): void {
    if (entry.handle.surface !== 'headless') {
      void this.closeSurface(entry).catch(err =>
        logEvent('teleport_successor_stop_failed', { name: entry.name, error: (err as Error).message }),
      )
      return
    }
    this.stopHeadless(entry)
  }

  private stopHeadless(entry: Live): void {
    const { pid, surface } = entry.handle
    if (surface !== 'headless' || pid === undefined) return
    try {
      process.kill(pid, 'SIGTERM')
    } catch (err) {
      logEvent('teleport_successor_stop_failed', { name: entry.name, pid, error: (err as Error).message })
    }
  }

  /**
   * CC-881: the successor of a session on another host. Its row is recorded here, so it
   * registers into an identity the broker already holds, but its files and surface are the
   * caller's to make: this host can neither write that host's disk nor open its terminal.
   */
  prepareRemoteRelaunch(input: RelaunchInput, launcherHost?: string): RemoteLaunch {
    const sessionId = Teleport.newSessionId()
    this.appendSuccessorSpawn(input, sessionId, { cwd: input.cwd }, 'none', launcherHost)
    this.remoteSessions.set(input.agentId, sessionId)
    const { env: _env, mcpServers: _servers, warnings: _warnings, ...profile } = input.profile
    return {
      agentId: input.agentId,
      sessionId,
      name: input.name,
      profile,
      brief: input.brief,
      preamble: input.preamble,
      ...(isAdoptedSuccessor(input) ? { adopted: true as const } : {}),
      surface: input.surface,
      ...(input.tags?.length ? { tags: input.tags } : {}),
      ...(input.subscriptions?.length ? { subscriptions: input.subscriptions } : {}),
      ...(input.remoteControl ? { remoteControl: true } : {}),
      ...(input.channels?.length ? { channels: input.channels } : {}),
      ...(input.permissionMode === undefined ? {} : { permissionMode: input.permissionMode }),
      ...(input.anchor === undefined ? {} : { anchor: input.anchor }),
    }
  }

  confirmRemoteRelaunch(input: RelaunchInput): void {
    this.bindExecution(input.agentId, this.openSuccessor(input, undefined))
    this.announceSuccessor(input, this.remoteSessions.get(input.agentId) ?? '', input.cwd)
    this.remoteSessions.delete(input.agentId)
  }

  releaseRemoteRelaunch(input: RelaunchInput, reason: string, where = "its caller's host"): void {
    this.remoteSessions.delete(input.agentId)
    this.core.append({
      kind: 'agent_retired',
      actor: 'agent-chat',
      target: input.name,
      ref: input.agentId,
      body: `teleport successor not launched on ${where}: ${reason}`,
    })
  }

  private successorPlan(
    input: RelaunchInput,
    allocation: Allocation,
    over: { sessionId?: string; surface?: SurfaceName } = {},
  ): { plan: LaunchPlan; sessionId: string } {
    // CC-892: an account move continues the same conversation, so it resumes the id rather than minting one.
    const sessionId = over.sessionId ?? input.resumeSession ?? Teleport.newSessionId()
    const plan = buildLaunchPlan({
      agentId: input.agentId,
      sessionId,
      ...(input.resumeSession === undefined ? {} : { resume: true }),
      name: input.name,
      profile: input.profile,
      brief: input.brief,
      cwd: allocation.cwd,
      cwdHoldsUserSettings: cwdHoldsUserSettings(allocation.cwd, input.configDir),
      surface: over.surface ?? input.surface,
      preamble: input.preamble,
      adopted: isAdoptedSuccessor(input),
      mcpConfigPath: mcpConfigPath(input.agentId),
      hookSettingsPath: hookSettingsPath(input.agentId),
      ...(allocation.addDirs ? { extraDirs: allocation.addDirs } : {}),
      ...(input.tags?.length ? { tags: input.tags } : {}),
      ...(input.subscriptions?.length ? { subscriptions: input.subscriptions } : {}),
      agentChatHome: home(),
      gitHooksDir: gitHooksDir(),
      ...(input.configDir ? { configDir: input.configDir } : {}),
      ...(input.configDirUnset ? { configDirUnset: true } : {}),
      ...(input.remoteControl ? { remoteControl: true } : {}),
      ...(input.channels?.length ? { channels: input.channels } : {}),
      ...(input.permissionMode === undefined ? {} : { permissionMode: input.permissionMode }),
    })
    return { plan, sessionId }
  }

  private appendSuccessorSpawn(
    input: RelaunchInput,
    sessionId: string,
    allocation: Allocation,
    isolation: IsolationName,
    host?: string,
  ): void {
    this.core.append({
      kind: 'agent_spawned',
      actor: input.name,
      target: input.name,
      msgId: input.agentId,
      body: input.brief,
      meta: {
        name: input.name,
        profile: input.profile.name,
        model: input.profile.model,
        surface: input.surface,
        isolation,
        cwd: allocation.cwd,
        session_id: sessionId,
        allowed_tools: input.profile.allowedTools.join(','),
        // CC-1612: without it toolSetOf finds no deny list and CC-40 waves the successor through.
        disallowed_tools: (input.profile.disallowedTools ?? []).join(','),
        perm_mode: permModeFor(input.surface),
        surface_lifetime: lifetimeOf(input.profile),
        // Carried across rather than re-resolved: a descendant spends the same
        // account as the session it continues (CC-100).
        ...(input.configDir ? { config_dir: input.configDir } : {}),
        ...(input.configDirUnset ? { config_dir_unset: 'true' } : {}),
        // CC-1492: where it runs, so liveness and retire never probe this host for it.
        ...(host === undefined ? {} : { host }),
        ...input.meta,
      },
    })
    this.markPredecessorSuperseded(input)
  }

  /** CC-762: from this row on the predecessor is superseded, so a transcript restored later must not take a turn. */
  private markPredecessorSuperseded(input: RelaunchInput): void {
    const from = input.meta?.teleport_from
    if (from === undefined) return
    try {
      markSuperseded(from)
    } catch (err) {
      logEvent('superseded_marker_failed', { agentId: from, error: String(err) })
    }
  }

  private announceSuccessor(input: RelaunchInput, sessionId: string, cwd: string): void {
    logEvent('agent_teleported', { agentId: input.agentId, name: input.name, from: input.inheritedFrom })
    this.fireHook('on_spawn', {
      agentId: input.agentId,
      name: input.name,
      session_id: sessionId,
      cwd,
      parent: null,
      profile: input.profile.name,
      briefing: null,
    })
  }

  /** Transfers the allocation to the descendant's id, so ITS eventual retire releases the real strategy. */
  private trackSuccessor(launch: SuccessorLaunch, launched: LaunchHandle): void {
    const { input, predecessor, allocation, isolation } = launch
    const handle = succeedsInto(launched, predecessor?.handle) ? { ...launched, ownsSurface: true } : launched
    this.track(input.agentId, input.name, handle, allocation, isolation, input.anchor)
  }

  /** Nothing awaits a successor's attach, so its launch check is what notices a relaunch that never ran (CC-191). */
  private watchSuccessor(launch: SuccessorLaunch, handle: LaunchHandle, retried: boolean): void {
    handle.launchFailed
      ?.then(reason => this.successorNotRunning(launch, reason, retried))
      .catch(err =>
        logEvent('teleport_failed_report_error', { name: launch.input.name, error: (err as Error).message }),
      )
  }

  /** CC-402: the first launch check that fails earns one relaunch; the second goes to the human. */
  private async successorNotRunning(
    launch: SuccessorLaunch,
    reason: string,
    retried: boolean,
  ): Promise<void> {
    const { input } = launch
    if (this.hasAttached(input.agentId)) return
    if (retried) return this.reportDeadSuccessor(input, reason)
    logEvent('teleport_relaunch_retry', { name: input.name, agentId: input.agentId, reason })
    await pause(RELAUNCH_RETRY_MS)
    const refusal = await this.retryRefusal(input)
    if (refusal !== undefined) return this.refuseRetry(input, reason, refusal)
    let handle: LaunchHandle
    try {
      handle = await this.launchOn(
        input.surface,
        launch.plan,
        input.anchor,
        input.reuseAnchor ?? false,
        'teleport',
      )
    } catch (err) {
      return this.reportDeadSuccessor(input, (err as Error).message)
    }
    this.trackSuccessor(launch, handle)
    this.watchSuccessor(launch, handle, true)
  }

  /** CC-402: why a retry must not launch again, since a late successor would then run twice; undefined to retry. */
  private async retryRefusal(input: RelaunchInput): Promise<RetryRefusal | undefined> {
    if (this.hasAttached(input.agentId)) return { reason: 'the successor attached', tell: false }
    const running = await this.launcherRunning(input.agentId)
    if (running === true) return { reason: 'its run-agent is already running', tell: false }
    if (running === undefined)
      return {
        reason: 'the process table could not be read, so a running run-agent cannot be ruled out',
        tell: true,
      }
    return undefined
  }

  private refuseRetry(input: RelaunchInput, failure: string, refusal: RetryRefusal): void {
    if (refusal.tell)
      return this.reportDeadSuccessor(input, `${failure}; not launched again: ${refusal.reason}`)
    logEvent('teleport_relaunch_skipped', {
      name: input.name,
      agentId: input.agentId,
      reason: refusal.reason,
    })
  }

  /** The human queue and the seat's log, since nobody is left inside the session to notice (CC-191, CC-402). */
  private reportDeadSuccessor(input: RelaunchInput, reason: string): void {
    if (this.hasAttached(input.agentId)) return
    // CC-951: the teleport it waits on decides who is told, since its predecessor may still run.
    if (input.successorFirst === true && this.teleporter.successorFailed(input.agentId, reason)) return
    this.noticeDeadSuccessor(
      input,
      `${input.name} shut down for a teleport and its successor was still not running after one retry: ${reason}`,
      reason,
    )
  }

  private noticeDeadSuccessor(input: RelaunchInput, lead: string, reason: string): void {
    const refusal = this.launchRefusal(input.agentId)
    const next =
      refusal === undefined
        ? `Run ${relaunchScriptPath(input.agentId)} in a terminal to start it.`
        : `${refusal}; do not run its relaunch script.`
    this.core.append({ kind: 'notice', actor: 'agent-chat', target: HUMAN, body: `${lead}. ${next}` })
    this.seatJournal?.({ event: 'teleport-failed', agent: input.name })
    logEvent('teleport_failed', { name: input.name, from: input.inheritedFrom, reason })
  }

  /** Two applies, not one atomic write until TP-199: a restart between them is slice 4's `teleport_half_written`. */
  private openSuccessor(input: RelaunchInput, predecessor: Live | undefined): string | undefined {
    if (input.inheritedFrom !== undefined)
      this.finishSuperseded(input.inheritedFrom, predecessor, 'superseded by teleport')
    return this.shadow.open(input.agentId, input.configDir ?? configDir())
  }

  /** The descendant takes the pane its predecessor vacated; safe only because that pane's owner is already gone. */
  private async launchSuccessor(
    launch: SuccessorLaunch,
    executionId: string | undefined,
  ): Promise<{ handle: LaunchHandle; retried: boolean }> {
    const { input, plan } = launch
    const attempt = () =>
      this.launchOn(input.surface, plan, input.anchor, input.reuseAnchor ?? false, 'teleport')
    let failure: string
    try {
      return { handle: await attempt(), retried: false }
    } catch (first) {
      failure = (first as Error).message
      logEvent('teleport_relaunch_retry', { name: input.name, agentId: input.agentId, reason: failure })
    }
    await pause(RELAUNCH_RETRY_MS)
    const refusal = await this.retryRefusal(input)
    if (refusal !== undefined) return this.skippedRetry(launch, executionId, failure, refusal)
    try {
      return { handle: await attempt(), retried: true }
    } catch (err) {
      return this.headlessFallback(launch, executionId, (err as Error).message)
    }
  }

  /**
   * CC-1372: a successor-last teleport has already ended its predecessor, so a surface that
   * failed its launch and retry runs the successor headless rather than losing it. A
   * successor-first predecessor still runs and is kept instead (CC-951), and the successor is lost
   * when the CC-406 machine guard refuses a headless agent.
   */
  private async headlessFallback(
    launch: SuccessorLaunch,
    executionId: string | undefined,
    failure: string,
  ): Promise<{ handle: LaunchHandle; retried: boolean }> {
    const { input } = launch
    if (input.successorFirst === true || input.surface === 'headless')
      return this.lostSuccessor(input, executionId, failure)
    const refusal = await this.retryRefusal(input)
    if (refusal !== undefined) return this.skippedRetry(launch, executionId, failure, refusal)
    const machine = this.machineRefusal('headless')
    if (machine !== undefined) return this.refusedHeadless(input, executionId, failure, machine)
    let handle: LaunchHandle
    try {
      handle = await this.launchOn('headless', this.headlessPlan(launch), undefined, false, 'teleport')
    } catch (err) {
      // The relaunch script the lost-teleport notice names must start the surface the human asked for.
      this.writeSuccessorFiles(launch, launch.plan)
      return this.lostSuccessor(input, executionId, (err as Error).message)
    }
    this.recordHeadlessSuccessor(launch)
    this.noticeHeadlessSuccessor(input, failure)
    logEvent('teleport_relaunch_headless', { name: input.name, agentId: input.agentId, reason: failure })
    return { handle, retried: true }
  }

  /** The successor's plan and launch files rewritten for headless, under the session id already recorded. */
  private headlessPlan(launch: SuccessorLaunch): LaunchPlan {
    const { input, sessionId, allocation } = launch
    const { plan } = this.successorPlan(input, allocation, { sessionId, surface: 'headless' })
    this.writeSuccessorFiles(launch, plan)
    return plan
  }

  private writeSuccessorFiles(launch: SuccessorLaunch, plan: LaunchPlan): void {
    const { input, allocation, isolation } = launch
    this.writeAdmitted(
      this.successorAdmission(input),
      plan,
      input.profile,
      this.createdWorktree(input.agentId, allocation, isolation),
    )
  }

  /** As a mode switch records it, so the identity, `agent surface` and the roster see the process that runs. */
  private recordHeadlessSuccessor(launch: SuccessorLaunch): void {
    const { input, sessionId } = launch
    this.core.append({
      kind: 'agent_resumed',
      actor: 'agent-chat',
      target: input.name,
      ref: input.agentId,
      body: 'teleport successor started headless',
      meta: {
        session_id: sessionId,
        surface: 'headless',
        from_surface: input.surface,
        perm_mode: permModeFor('headless'),
        cause: 'teleport-headless-fallback',
      },
    })
  }

  /** Refused before `headlessPlan` rewrites the launch files, so the relaunch script still starts the requested surface. */
  private refusedHeadless(
    input: RelaunchInput,
    executionId: string | undefined,
    failure: string,
    machine: Extract<MachineDecision, { ok: false }>,
  ): never {
    logEvent('teleport_headless_refused', {
      name: input.name,
      agentId: input.agentId,
      code: machine.code,
      reason: machine.reason,
    })
    return this.lostSuccessor(input, executionId, `${failure}; headless fallback refused: ${machine.reason}`)
  }

  private lostSuccessor(input: RelaunchInput, executionId: string | undefined, reason: string): never {
    this.finishFailedLaunch(executionId, reason)
    this.reportDeadSuccessor(input, reason)
    throw new SuccessorNotStarted(reason)
  }

  private noticeHeadlessSuccessor(input: RelaunchInput, reason: string): void {
    this.core.append({
      kind: 'notice',
      actor: 'agent-chat',
      target: HUMAN,
      body:
        `${input.name}'s teleport successor could not open in ${input.surface} (${reason}), so it was ` +
        `started headless. Run \`agent-chat agent surface ${input.name}\` to bring it into a terminal.`,
    })
  }

  /**
   * CC-602: a retry skipped because the successor is running or attached adopts it with a
   * handle, so `relaunch` tracks, binds and announces it as if its launch returned. The handle
   * names a pane only when the launch aimed at the predecessor's own, so a pane the broker owns
   * still closes on retire. Only a refusal the human is told about fails the launch.
   */
  private skippedRetry(
    launch: SuccessorLaunch,
    executionId: string | undefined,
    failure: string,
    refusal: RetryRefusal,
  ): { handle: LaunchHandle; retried: boolean } {
    const { input } = launch
    if (refusal.tell) this.finishFailedLaunch(executionId, failure)
    this.refuseRetry(input, failure, refusal)
    if (refusal.tell) throw new SuccessorNotStarted(refusal.reason)
    const paneRef = input.reuseAnchor === true ? launch.predecessor?.handle.paneRef : undefined
    return {
      handle: { surface: input.surface, ...(paneRef === undefined ? {} : { paneRef }) },
      retried: true,
    }
  }

  private finishFailedLaunch(executionId: string | undefined, reason: string): void {
    this.shadow.finish(executionId, {
      outcome: 'failed',
      reason: `teleport failed: ${reason}`,
      retryable: false,
    })
  }

  /** Live agents, for `agent ls` and the slot summary. */
  liveIds(): string[] {
    return [...this.live.keys()]
  }

  /** Slot holders, reattached agents included: CC-118's verifier compares them with the ledger. */
  slotIds(): string[] {
    return this.semaphore.ids()
  }

  slots(blocked = 0): string {
    return this.semaphore.summary(blocked)
  }

  /** Held/cap, for the roster header and `/health` — see `slots()` for the rendered form. */
  slotUsage(): SlotUsage {
    return { held: this.semaphore.inUse, cap: this.semaphore.slots }
  }

  /** CC-1179: refuse new spawns and resumes until `ttlMs` from now, or lift the drain. */
  drain(on: boolean, ttlMs = 0, now = Date.now()): { until: number } | undefined {
    if (on) this.drainState.enter(now + ttlMs)
    else this.drainState.leave()
    return this.drainState.active(now)
  }

  draining(now = Date.now()): { until: number } | undefined {
    return this.drainState.active(now)
  }

  private drainRefusal():
    { reason: string; code: 'broker_draining'; retryable: true; retryAfterMs: number } | undefined {
    const refusal = this.drainState.refusal(Date.now())
    return refusal && { ...refusal, code: 'broker_draining', retryable: true }
  }

  paneRefFor(name: string): string | undefined {
    return this.find(name)?.handle.paneRef
  }

  private find(name: string): Live | undefined {
    for (const entry of this.live.values()) if (entry.name === name) return entry
    return undefined
  }

  close(): void {
    this.unwatch()
    this.unwatchSeatFollow()
    this.teleporter.close()
    this.attachWaiters.clear()
    this.reaper.close()
    this.remoteSpawns.close()
    for (const timer of this.reattached.values()) clearTimeout(timer)
    clearTimeout(this.readmitSweep)
    clearInterval(this.idlePrintTimer)
    this.stopFootprint?.()
    this.stopMergedRetire?.()
    for (const entry of this.live.values()) {
      if (entry.settle) clearTimeout(entry.settle)
      if (entry.attachCeiling) clearTimeout(entry.attachCeiling)
    }
  }
}
