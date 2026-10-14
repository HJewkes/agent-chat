import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { logEvent } from '../../broker/log.js'
import { resolveDeciderAgentId, resolveWorktreeBudget } from '../../config.js'
import {
  burndownConfigPath,
  burndownLedgerPath,
  burndownOverridePath,
  burndownOwedHoldsPath,
  burndownPausePath,
  burndownShadowDir,
  burndownTickStatusPath,
  burndownTicksPath,
} from '../../paths.js'
import type { QueueItem } from '../../protocol.js'
import { activeWorkRoot } from '../active-work.js'
import { appendSeatLog } from '../seats/io.js'
import { seatMergedLog } from '../seats/dispatch-log.js'
import { seatJournal } from '../seats/journal.js'
import { ownerQueueSpoolDir, spoolOwnerQueue } from './owner-queue-spool.js'
import { describeCandidates, parkCandidates, parkSweep } from './park-sweep.js'
import { adoptSeatPrs, type AdoptSeat } from './pr-adopt.js'
import { adoptSeatOf, changedFiles as prChangedFiles, diskAdoptPorts } from './pr-adopt-ports.js'
import { claimPrReader } from './pr-state.js'
import { DEFAULT_WORKTREE_BUDGET } from '../isolation/worktree.js'
import { advance, applyActions, claimKey, type Action, type ClaimKey, type InboxMessage } from './advance.js'
import { withFindings } from './finding.js'
import { BRAKE_WINDOW_MS, brakeSince, ladderActions, releasesSince } from './ladder.js'
import { briefFacts } from './brief.js'
import {
  autoApprovePortsOn,
  briefAnswered,
  finishBriefRoutes,
  recordBriefRoutes,
  settleProposedBriefs,
  type ApprovePorts,
  type AutoApprovePorts,
  type BriefRoute,
  type SettledBriefs,
} from './brief-approve.js'
import { gatePool, pickAccount } from './budget-gate.js'
import { collisionCheck, type BrokerView, type CollisionReader } from './collision.js'
import {
  deciderVerdict,
  recordRefusal,
  wakeDecider,
  type DeciderVerdict,
  withRecordedBriefs,
  type WakeDelivery,
} from './decider.js'
import type { Initiative, Refusal, Task } from './eligibility.js'
import type { EgressRunner } from './egress-runner.js'
import { dailyRetire, dailyRetireDue, type RetireFinishedReply } from './daily-retire.js'
import { doneIdsOnDisk, fileHumanSteps, humanStepSources } from './human-steps.js'
import { leakCheck } from './leak-check.js'
import { readExitedWork } from './exited-adopt.js'
import { run, type Runner } from './exec.js'
import { execute, type SpawnFrame, type SpawnReply, type Step } from './execute.js'
import {
  heldClaims,
  readLedger,
  withLedgerLock,
  writeLedger,
  type Claim,
  type Ledger,
  type SeatState,
} from './ledger.js'
import {
  defaultBranch,
  liveBurndownAgents,
  memo,
  observe,
  orphanAt,
  rowNamed,
  worktreesUnder,
  worktreeUse,
  type Roster,
} from './observe.js'
import { dueReasons, type NoDispatchReason, type SeatOutcome } from './no-dispatch.js'
import { binaryGate, capGate, type GateReading } from './gate-reading.js'
import {
  BURNDOWN_CONFIG,
  DEFAULT_NAME_PREFIX,
  plan,
  stackInputs,
  type Capacity,
  type Dispatch,
  type PlanInputs,
} from './plan.js'
import { backoffHeld } from './backoff.js'
import { branchOf, diffSummary } from './progress.js'
import { defaultAutonomyRoot } from './policy.js'
import { describeSeatEvents, deliverSeatEvents, type OpenSender } from './seat-deliver.js'
import { mergedEvents, mergedFlagKey, slicesMerged, slicesReleasedComplete } from './slices-complete.js'
import { readOpenPrs } from './collision.js'
import { readRecentSubjects, releasedSlicesLanded } from './landed-sweep.js'
import type { SeatEvents, SpawnResult } from './seat-events.js'
import {
  briefDepsOf,
  diskSeatDeps,
  loadSeats,
  localDate,
  watchdogUnusable,
  planSeats,
  scopeExhausted,
  type LoadedSeat,
  type LoadedSeats,
  type SeatPlanDeps,
  type SeatsPlan,
  type SkippedSeat,
} from './seat-tick.js'
import { burndownRefusalsPath, refusalSnapshot, writeRefusalSnapshot } from './refusal-snapshot.js'
import {
  diskPlanReader,
  pendingOffLedger,
  resyncQueuedSlices,
  resyncSteps,
  seedSteps,
} from './seed-slices.js'
import { seatPrReader } from './off-ledger-adopt.js'
import { shadowDecisions, writeShadowRecord, type ShadowCapture } from './shadow-record.js'
import { healSteps } from './slice-repo.js'
import { stepTimer, type StepTimer } from './step-timer.js'
import type { Resolved } from './settings-resolve.js'
import { loadResolvedConfig } from './settings-store.js'
import { accountDir, readInitiatives, readTaskText, readTasks, type TickConfig } from './source.js'
import {
  prHeadOf,
  registerWithShepherd,
  shepherdLanded,
  shepherdRows,
  shepherdTarget,
  targetRef,
  type Registration,
} from './shepherd.js'
import {
  lineStopFrom,
  persisted,
  readServiceCheck,
  serviceCheckNote,
  type PersistedRead,
} from './service-check.js'
import { retrySteps, stepsForActions, stepsForDispatch, type StepContext } from './steps.js'
import { recordTick, type StopCode, type TickResult } from './tick-status.js'
import {
  adoptSeatOfRegistration,
  claimSeatOf,
  recordingRegister,
  tickSummary,
  tickSummaryWriter,
  type RegisterRecord,
  type SummaryInputs,
  type SummaryPlan,
} from './tick-summary.js'
import { loadWorld, type World } from './tick.js'
import { installedClaudeVersion, trustRefusal } from './trust-gate.js'
import {
  actOnTriage,
  describeTriage,
  triageNotes,
  triageReadiness,
  triageVerdicts,
  type TriageDeps,
  type TriagePlan,
} from './triage.js'

/**
 * `agent-chat burndown tick --once`: one pass under the ledger lock. Observe
 * every held claim, advance it one phase, then dispatch new work inside the
 * tick's own ceilings. The broker treats this unregistered connection as the
 * human, so it applies no spawn-rate or cwd check: these ceilings are the bound.
 * Seat events go out through `seatSender`, a separate connection registered as `burndown`.
 */

export interface TickBroker {
  roster: () => Promise<Roster>
  inboxSince: (name: string, afterId: number) => Promise<InboxMessage[]>
  spawn: (frame: SpawnFrame) => Promise<SpawnReply>
  retire: (name: string) => Promise<SpawnReply>
  /** TP-1974 c: retires the finished agents `spawner` started, once a day per enrolled seat. */
  retireFinished: (spawner: string) => Promise<RetireFinishedReply>
  /** The human queue's open items; read only when a decider is configured. */
  queue: () => Promise<QueueItem[]>
  resume: (name: string, message: string) => Promise<SpawnReply>
  /** CC-1257: `agent park` by name; absent, the tick sweeps no exited trees. */
  park?: (name: string) => Promise<SpawnReply>
  /** Live agent and session names and every `files` claim, for the CC-202 collision check. */
  collisionView: () => Promise<BrokerView>
  /** Opens a connection registered as `burndown` for peer `send`s, never the spawn connection (CC-250). */
  seatSender: OpenSender
}

export interface TickOptions {
  dryRun: boolean
  broker: TickBroker
  now?: Date
  /** CC-220: read at each seat-log append; defaults to the wall clock, or to `now` when a test pins it. */
  clock?: () => Date
  root?: string
  log?: (event: string, detail: Record<string, unknown>) => void
  /** Runs the collision check's `git` and `gh` readers and the `titan-factory` calls; a test injects one that reaches neither. */
  exec?: Runner
  /** The leak check's scanner; a test injects one so no run reads the owner's term list. */
  egress?: EgressRunner
  /** The owner-queue spool the scope-exhausted item is filed into; defaults to the console's inbox spool. */
  ownerQueueDir?: string
  /** CC-1192: the monotonic ms clock the step timings read; defaults to `performance.now`. */
  monotonic?: () => number
  /** CC-1234: the `active-work task edit` that settles proposed briefs; a test injects one that edits its fixture. */
  briefEdit?: ApprovePorts['edit']
  /** CC-1238: the `active-work task done` that closes a landed all-released parent; a test injects one that edits its fixture. */
  taskDone?: (slug: string, id: string) => void
}

interface ReaderFailure {
  reader: CollisionReader
  repo: string
  detail?: string
}

/** Shown in dry-run briefs when no `reportTo` is configured; a real tick refuses instead. */
const UNSET_REPORT_TO = '<reportTo unset>'

/** One writer per process, so a summary file that cannot be written is logged once, not once per tick. */
const appendTickSummary = tickSummaryWriter(burndownTicksPath)

/** CC-955: what pauses the tick, naming the layer, or undefined when nothing does. The pause file wins. */
function pauseOf(resolved: Resolved): string | undefined {
  if (fs.existsSync(burndownPausePath()))
    return `${burndownPausePath()} exists; \`agent-chat burndown resume\` clears it`
  if (!resolved.paused) return undefined
  if (resolved.sources.paused === 'override') return `the override in ${burndownOverridePath()} sets paused`
  return `preset ${resolved.preset} sets paused`
}

/** Why the tick may not act at all, or undefined when it may. `paused` names what pauses it. */
export function stopReason(config: TickConfig, paused: string | undefined): string | undefined {
  if (!config.enabled) return `burndown is disabled (enabled is not true in ${burndownConfigPath()})`
  if (paused !== undefined) return `burndown is paused (${paused})`
  if (config.reportTo === undefined)
    return `no reportTo in ${burndownConfigPath()}: name the registered session that receives agents' reports`
  return undefined
}

/** CC-205 D2: seats mode and a brief's `autonomy:` block could dispatch one initiative twice, so both is a config error. */
export function modeConflict(config: TickConfig, initiatives: readonly Initiative[]): string | undefined {
  if (config.seats.length === 0) return undefined
  const optedIn = initiatives.filter(i => i.autonomy !== undefined).map(i => i.slug)
  if (optedIn.length === 0) return undefined
  return `config error: the resolved burndown config (\`agent-chat burndown config show\`) lists seats, and brief.md of ${optedIn.join(', ')} has an autonomy: block; remove one, since both modes would dispatch the same work`
}

/** Never rejects for a real tick: a throw is recorded in the status file (CC-756). A dry run records nothing and throws as before. */
export async function tickFromDisk(opts: TickOptions): Promise<string[]> {
  if (opts.dryRun) return (await tickOnce(opts)).lines
  const now = opts.now ?? new Date()
  const clock = clockOf(opts)
  return recordTick(burndownTickStatusPath(), () => tickOnce({ ...opts, now, clock }), now, opts.log)
}

/** A tick runs for minutes, so seat-log lines stamp the time they are appended, not the tick's `now`. */
function clockOf({ clock, now }: TickOptions): () => Date {
  if (clock !== undefined) return clock
  return now === undefined ? () => new Date() : () => now
}

const stopCode = (config: TickConfig, paused: string | undefined): StopCode =>
  !config.enabled ? 'disabled' : paused !== undefined ? 'paused' : 'no-report-to'

type Gate = { done: TickResult } | { config: TickConfig; head: string[] }

/** The config, pause and mode checks that run before the lock is taken. */
function gateTick(opts: TickOptions): Gate {
  const resolved = loadResolvedConfig()
  const config = resolved.tick
  const paused = pauseOf(resolved)
  const stop = stopReason(config, paused)
  if (stop !== undefined && !opts.dryRun)
    return { done: { lines: [stop], outcome: { kind: 'stopped', reason: stopCode(config, paused) } } }
  const head = stop === undefined ? [] : [`${stop}; dry run proceeds anyway`]
  const conflict = modeConflict(config, readInitiatives(opts.root ?? activeWorkRoot()))
  if (conflict !== undefined)
    return { done: { lines: [...head, conflict], outcome: { kind: 'failed', errorClass: 'ModeConflict' } } }
  return { config, head }
}

/** CC-1192: the summary row is appended after the lock is released, so its write never counts as lock-held time. */
async function tickOnce(opts: TickOptions): Promise<TickResult> {
  const monotonic = opts.monotonic ?? (() => performance.now())
  const started = monotonic()
  const timer = stepTimer(monotonic)
  const gate = await timer.time('config', () => gateTick(opts))
  if ('done' in gate) return gate.done
  const locked = await withLedgerLock(burndownLedgerPath(), async () => {
    const lockedAt = monotonic()
    const ran = await runTick(gate.config, opts, timer)
    return { ...ran, lockHeldMs: Math.round(monotonic() - lockedAt) }
  })
  if (!locked.ran)
    return {
      lines: [...gate.head, `another tick holds the ledger lock (pid ${locked.holder}); did nothing`],
      outcome: { kind: 'skipped' },
    }
  const { lines, summary, lockHeldMs, shadow } = locked.value
  if (summary !== undefined) {
    const timings = { durationMs: Math.round(monotonic() - started), lockHeldMs, steps: timer.steps() }
    appendTickSummary(tickSummary(summary, timings), opts.log ?? logEvent)
  }
  if (shadow !== undefined && summary !== undefined && gate.config.shadowOut)
    recordShadow(shadow, summary.now, opts.log ?? logEvent)
  return { lines: [...gate.head, ...lines], outcome: { kind: 'ok' } }
}

interface Ran {
  lines: string[]
  /** A real tick's summary row inputs; a dry run has none. */
  summary?: SummaryInputs
  /** CC-1193: a real tick's ledger as read and its decisions, for the shadow record. */
  shadow?: ShadowCapture
}

/** Best effort: a record that cannot be written is an event, never a failed tick. */
function recordShadow(shadow: ShadowCapture, now: Date, log: NonNullable<TickOptions['log']>): void {
  try {
    writeShadowRecord(burndownShadowDir(), shadow, now)
  } catch (err) {
    log('burndown_shadow_record_failed', { reason: err instanceof Error ? err.message : String(err) })
  }
}

async function runTick(config: TickConfig, opts: TickOptions, timer: StepTimer): Promise<Ran> {
  const now = opts.now ?? new Date()
  const ledger = await timer.time('read-ledger', () => readLedger(burndownLedgerPath()))
  const ledgerText = JSON.stringify(ledger)
  const briefs = await timer.time('brief-approve', () => settleBriefs(config, opts, now))
  const decided = await decide(config, opts, ledger, now, timer, briefs.routes)
  const { steps, decider } = decided
  const notes = [...briefs.lines, ...decided.notes]
  if (opts.dryRun) {
    const planned = applyActions(
      ledger,
      steps.flatMap(s => (s.kind === 'ledger' ? s.actions : [])),
      now,
    )
    const diff = { seats: config.seats, before: ledger, after: planned, spawns: [], merged: decided.merged }
    return {
      lines: [
        `burndown tick at ${now.toISOString()} (dry run)`,
        ...steps.map(describe),
        ...describeDecider(config, decider),
        ...describeTriage(decided.triage),
        ...describeSeatEvents(diff, now),
        ...decided.closing.map(
          p => `would close ${p.initiative} ${p.id}: every slice landed or was released`,
        ),
        ...decided.reasons.map(r => `would log for seat ${r.seat}: ${r.text}`),
        ...dailyRetireDue(config.seats, ledger.dailyRetire, now).map(s => `would retire finished (${s})`),
        ...describeCandidates(sweepCandidates(decided.sweep, planned)),
        ...notes,
      ],
    }
  }
  const acted = await actOn(config, opts, ledger, decided, now, timer)
  const decisions = shadowDecisions({ steps: steps.map(describe), briefs, decided })
  return {
    lines: [`burndown tick at ${now.toISOString()}`, ...acted.lines, ...notes],
    summary: acted.summary,
    shadow: { ledgerText, config, decisions },
  }
}

/** Executes the steps, wakes the decider, scans claimed PRs for leaks, then tells each seat what changed, writing the ledger last. */
async function actOn(
  config: TickConfig,
  opts: TickOptions,
  ledger: Ledger,
  {
    steps,
    decider,
    briefRoutes,
    triage,
    failures,
    unchecked,
    seatStates,
    outcomes,
    skippedSeats,
    serviceCheck,
    reasons,
    adopt,
    summary,
    humanStepSeats,
    merged,
    closing,
    sweep,
  }: Decided,
  now: Date,
  timer: StepTimer,
): Promise<Ran & { summary: SummaryInputs }> {
  const log = opts.log ?? logEvent
  const clock = clockOf(opts)
  logReasons(defaultAutonomyRoot(opts.root), reasons, clock, log)
  for (const failure of failures) log('burndown_collision_reader_failed', { ...failure })
  for (const initiative of unchecked) log('burndown_collision_skipped', { initiative, reason: 'no repo' })
  for (const skipped of skippedSeats) log('burndown_seat_skipped', { ...skipped })
  const exhausted = await timer.time('scope-exhausted', () =>
    fileScopeExhausted(outcomes, seatStates, opts, now),
  )
  const sampled = exhausted === undefined ? ledger : { ...ledger, seats: exhausted }
  const routed = await fileSeatHumanSteps(humanStepSeats, config, opts)
  const retired = await timer.time('daily-retire', () =>
    dailyRetire(config.seats, ledger.dailyRetire, {
      retireFinished: opts.broker.retireFinished,
      seatLog: (seat, text) => appendSeatLog(defaultAutonomyRoot(opts.root), seat, clock(), text),
      log,
      now,
    }),
  )
  const spawns: SpawnResult[] = []
  const registrations: RegisterRecord[] = []
  const register = (registration: Registration) => registerWithShepherd(registration, opts.exec ?? run)
  const executed = await timer.time('execute', () =>
    execute(steps, sampled, {
      ledgerFile: burndownLedgerPath(),
      spawn: recordingSpawn(steps, opts.broker.spawn, spawns),
      retire: opts.broker.retire,
      register: recordingRegister(register, claimSeatOf(steps, sampled), registrations),
      prHead: target => prHeadOf(target, opts.exec ?? run),
      log,
      now,
    }),
  )
  logLadder(ledger, executed.ledger, log)
  const swept = await sweepTrees(sweepCandidates(sweep, executed.ledger), opts.broker.park, log)
  const adopted = await timer.time('adopt', () => adoptPrs(adopt, executed.ledger, opts, now, registrations))
  const woken = await timer.time('decider-triage', async () =>
    actOnTriage(
      config,
      triage,
      await actOnDeciderAndBriefs(
        config,
        { decider, briefRoutes },
        executed.ledger,
        { broker: opts.broker, log, now },
        opts,
      ),
      triageDeps(opts, log, now),
    ),
  )
  const leaks = await timer.time('leak-check', () =>
    leakCheck(woken.ledger, {
      exec: opts.exec ?? run,
      log,
      seats: config.seats,
      ...(opts.egress === undefined ? {} : { egress: opts.egress }),
    }),
  )
  const closed = closeParents(closing, opts, log)
  const diff = {
    seats: config.seats,
    before: ledger,
    after: leaks.ledger,
    spawns,
    human: leaks.human,
    merged,
  }
  const journal = seatJournal(defaultAutonomyRoot(opts.root), { log, now: clock })
  const dispatch = seatMergedLog(defaultAutonomyRoot(opts.root), { log, now: clock })
  const told = await timer.time('deliver', () =>
    deliverSeatEvents(diff, { open: opts.broker.seatSender, log, now, journal, dispatch }),
  )
  await timer.time('write-ledger', () => {
    writeLedger(burndownLedgerPath(), {
      ...told.ledger,
      lastTickAt: now.toISOString(),
      ...dailyRetireStamps(told.ledger.dailyRetire, retired.stamps),
      ...(serviceCheck === undefined ? {} : { serviceCheck }),
    })
    writeRefusalSnapshot(burndownRefusalsPath(), refusalSnapshot(outcomes, now))
  })
  return {
    lines: [
      ...routed,
      ...retired.lines,
      ...executed.lines,
      ...swept,
      ...adopted,
      ...woken.lines,
      ...leaks.lines,
      ...closed,
      ...told.lines,
    ],
    summary: { ...summary, now, registrations },
  }
}

const dailyRetireStamps = (
  before: Ledger['dailyRetire'],
  stamps: Record<string, string>,
): Pick<Ledger, 'dailyRetire'> =>
  Object.keys(stamps).length === 0 ? {} : { dailyRetire: { ...before, ...stamps } }

/** CC-974: files each seat's due kind:owner and kind:operator task into the owner queue, beside `fileScopeExhausted`. */
async function fileSeatHumanSteps(
  seats: readonly LoadedSeat[],
  config: TickConfig,
  opts: TickOptions,
): Promise<string[]> {
  if (seats.length === 0) return []
  const root = opts.root ?? activeWorkRoot()
  const done = memo(() => doneIdsOnDisk(root))
  const log = opts.log ?? logEvent
  return fileHumanSteps(
    () => humanStepSources(seats, readInitiatives(root), root, config.scopeTagAliases, log),
    id => done().has(id),
    spoolOwnerQueue(opts.ownerQueueDir ?? ownerQueueSpoolDir()),
    log,
  )
}

/**
 * CC-864: after the dispatch decision, once per seat, files the scope-exhausted owner item and carries the streak in
 * the seat states. A spool that cannot be written is an event, never a failed tick; the streak then stays as it was.
 */
async function fileScopeExhausted(
  outcomes: readonly SeatOutcome[],
  states: Record<string, SeatState> | undefined,
  opts: TickOptions,
  now: Date,
): Promise<Record<string, SeatState> | undefined> {
  if (states === undefined) return undefined
  try {
    const port = spoolOwnerQueue(opts.ownerQueueDir ?? ownerQueueSpoolDir())
    return await scopeExhausted(outcomes, states, now, port)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    ;(opts.log ?? logEvent)('burndown_scope_exhausted_failed', { detail })
    return states
  }
}

/** CC-861: after the claims' own registrations, so a claimed PR is never adopted; a throw is an event, and the tick carries on. */
function adoptPrs(
  seats: readonly AdoptSeat[],
  ledger: Ledger,
  opts: TickOptions,
  now: Date,
  registrations: RegisterRecord[],
): string[] {
  const log = opts.log ?? logEvent
  const claimed = new Set(
    heldClaims(ledger).flatMap(c => {
      const target = shepherdTarget(c.pr)
      return target === undefined ? [] : [targetRef(target).toLowerCase()]
    }),
  )
  const root = opts.root ?? activeWorkRoot()
  const ports = diskAdoptPorts({
    exec: opts.exec ?? run,
    root,
    autonomyRoot: defaultAutonomyRoot(root),
    clock: clockOf(opts),
    log,
    owedHoldsFile: burndownOwedHoldsPath(),
  })
  const register = recordingRegister(ports.register, adoptSeatOfRegistration(seats), registrations)
  try {
    return adoptSeatPrs(seats, claimed, { ...ports, register }, now)
  } catch (err) {
    log('burndown_pr_adopt_failed', { reason: err instanceof Error ? err.message : String(err) })
    return []
  }
}

/** CC-1023: an adopted PR's files from GitHub; a renamed file counts by both paths, as the local `--no-renames` read does. */
export const prFilesReader =
  (exec: Runner) =>
  (pr: string): string[] | undefined => {
    const target = shepherdTarget(pr)
    const files = target === undefined ? undefined : prChangedFiles(target, exec)
    return files?.flatMap(f => (f.previousPath === undefined ? [f.path] : [f.path, f.previousPath]))
  }

/** Each seat's "dispatched nothing" line; a write that fails is an event, and the tick carries on. */
function logReasons(
  autonomyRoot: string,
  reasons: readonly NoDispatchReason[],
  clock: () => Date,
  log: NonNullable<TickOptions['log']>,
): void {
  for (const { seat, text } of reasons) {
    try {
      appendSeatLog(autonomyRoot, seat, clock(), text)
    } catch (err) {
      log('burndown_seat_log_failed', { seat, reason: err instanceof Error ? err.message : String(err) })
    }
  }
}

/** The tick's releases and its brake notice, each logged once. */
function logLadder(before: Ledger, after: Ledger, log: NonNullable<TickOptions['log']>): void {
  for (const r of releasesSince(before, after))
    log('burndown_release', {
      task: r.taskId,
      slice: r.slice,
      code: r.code,
      reason: r.reason,
      branch: r.branch,
      n: r.n,
    })
  const brake = brakeSince(before, after)
  if (brake === undefined) return
  const claims = brake.claims.map(c => c.key)
  log('burndown_brake', { count: brake.count, window_ms: BRAKE_WINDOW_MS, cause: brake.cause, claims })
}

/** Spawns through the broker and records which claim each answered spawn was for. */
function recordingSpawn(
  steps: readonly Step[],
  spawn: TickBroker['spawn'],
  into: SpawnResult[],
): TickBroker['spawn'] {
  const keys = new Map(steps.flatMap(s => (s.kind === 'spawn' ? [[s.frame.name, s.key] as const] : [])))
  return async frame => {
    const reply = await spawn(frame)
    const key = keys.get(frame.name)
    if (key !== undefined) into.push({ key, ok: reply.ok })
    return reply
  }
}

const briefPorts = (opts: Pick<TickOptions, 'root' | 'briefEdit'>): AutoApprovePorts => {
  const ports = autoApprovePortsOn(opts.root ?? activeWorkRoot())
  return opts.briefEdit === undefined ? ports : { ...ports, edit: opts.briefEdit }
}

/**
 * CC-1234: approves each proposed brief whose plan lints before the world is read, so it can dispatch this tick.
 * The failing ones become routes that ride the tick's one decider wake; a dry run only says so.
 */
function settleBriefs(config: TickConfig, opts: TickOptions, now: Date): SettledBriefs {
  return settleProposedBriefs(briefPorts(opts), {
    today: localDate(now),
    dryRun: opts.dryRun,
    decider: config.decider !== undefined,
  })
}

type LandingRead = { subjects: string[] | undefined; titles: string[] }

/**
 * Each repo's open PR titles, read once, and its default-branch subjects over a window of days, read once per window.
 * A failed read of either marks the repo unreadable, which keeps the parent open.
 */
function landingReader(exec: Runner): (repo: string, days: number) => LandingRead {
  const prs = new Map<string, ReturnType<typeof readOpenPrs>>()
  const seen = new Map<string, LandingRead>()
  return (repo, days) => {
    const key = `${repo}\0${days}`
    const known = seen.get(key)
    if (known !== undefined) return known
    if (!prs.has(repo)) prs.set(repo, readOpenPrs(repo, exec))
    const open = prs.get(repo)
    const subjects =
      open === undefined ? undefined : readRecentSubjects(repo, defaultBranch(repo, exec), days, exec)
    const read = { subjects, titles: (open ?? []).map(pr => pr.title) }
    seen.set(key, read)
    return read
  }
}

/**
 * CC-1238: open parents whose slices were all released or done, with a default-branch commit for every slice and no open
 * PR naming them. Slice commits are counted from git, so a parent the seat merely abandoned stays open and is flagged.
 */
function landedReleasedParents(
  ledger: Ledger,
  tasks: ReadonlyMap<string, readonly Task[]>,
  seats: LoadedSeats,
  opts: TickOptions,
): ClosingParent[] {
  const read = landingReader(opts.exec ?? run)
  const now = opts.now ?? new Date()
  const home = (initiative: string): string[] => seats.loaded.flatMap(s => s.dispatch.repos[initiative] ?? [])
  return [...tasks].flatMap(([initiative, list]) =>
    list
      .filter(t => (t.status === undefined || t.status === 'open') && slicesReleasedOnly(ledger, t.id))
      .filter(t => slicesLanded(ledger, { initiative, id: t.id }, home(initiative), read, now))
      .map(t => ({ initiative, id: t.id })),
  )
}

const slicesReleasedOnly = (ledger: Ledger, id: string): boolean =>
  !slicesMerged(ledger, id) && slicesReleasedComplete(ledger, id)

function slicesLanded(
  ledger: Ledger,
  { initiative, id }: ClosingParent,
  fallback: readonly string[],
  read: ReturnType<typeof landingReader>,
  now: Date,
): boolean {
  const claims = ledger.claims.filter(
    c => c.taskId === id && c.initiative === initiative && c.slice !== undefined,
  )
  const named = claims.flatMap(c => (c.repo === undefined ? [] : [c.repo]))
  // The log starts at the oldest slice claim, so a commit from before the parent was worked never counts.
  const began = Math.min(...claims.map(c => Date.parse(c.spawnedAt)))
  const days = Number.isFinite(began) ? Math.ceil((now.getTime() - began) / 86_400_000) + 1 : undefined
  const reads = [...new Set(named.length > 0 ? named : fallback)].map(repo =>
    days === undefined ? { repo, subjects: undefined, titles: [] } : { repo, ...read(repo, days) },
  )
  const slices = { done: claims.flatMap(c => c.slice ?? []), released: ledger.slicesReleased?.[id] ?? [] }
  return (
    reads.length > 0 &&
    releasedSlicesLanded(
      id,
      slices,
      reads,
      reads.flatMap(r => r.titles),
    )
  )
}

/** `active-work task done`, pinned to the root this tick read so the close never lands in another tree. */
function taskDoneOn(root: string): (slug: string, id: string) => void {
  return (slug, id) => {
    execFileSync('active-work', ['task', 'done', slug, id], {
      stdio: 'pipe',
      timeout: 30_000,
      env: { ...process.env, ACTIVE_ROOT: root },
    })
  }
}

/** Closes each landed parent; a failed close is logged and left for the next tick, which sees the task still open. */
function closeParents(
  closing: readonly ClosingParent[],
  opts: TickOptions,
  log: (event: string, detail: Record<string, unknown>) => void,
): string[] {
  const done = opts.taskDone ?? taskDoneOn(opts.root ?? activeWorkRoot())
  return closing.map(({ initiative, id }) => {
    try {
      done(initiative, id)
      return `closed ${initiative} ${id}: every slice landed or was released`
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      log('burndown_parent_close_failed', { initiative, id, reason })
      return `could not close ${initiative} ${id}: ${reason}`
    }
  })
}

interface DeciderDeps {
  broker: TickBroker
  log: (event: string, detail: Record<string, unknown>) => void
  now: Date
  /** Persists the ledger; defaults to the burndown ledger file, and a test injects one that throws. */
  write?: (ledger: Ledger) => void
}

/** Wakes the decider, or records why not when the human has something to fix. */
async function actOnDecider(
  config: TickConfig,
  verdict: DeciderVerdict | undefined,
  ledger: Ledger,
  deps: DeciderDeps,
  compose?: () => string | undefined,
): Promise<{ ledger: Ledger; lines: string[]; delivery: WakeDelivery }> {
  const name = config.decider?.name
  if (verdict === undefined || name === undefined)
    return { ledger, lines: [], delivery: { sent: false, reason: 'no decider configured' } }
  if (verdict.wake) {
    const woken = await wakeDecider(name, verdict.message, ledger, {
      resume: deps.broker.resume,
      log: deps.log,
      now: deps.now,
      write: deps.write ?? ((l: Ledger): void => writeLedger(burndownLedgerPath(), l)),
      ...(compose === undefined ? {} : { compose }),
    })
    return { ledger: woken.ledger, lines: [woken.line], delivery: woken.delivery }
  }
  const line = `decider ${name} not woken: ${verdict.reason}`
  const delivery = { sent: false as const, reason: verdict.reason }
  if (!verdict.record) return { ledger, lines: [line], delivery }
  deps.log('burndown_decider_refused', { name, reason: verdict.reason })
  return { ledger: recordRefusal(ledger, verdict.reason, deps.now), lines: [line], delivery }
}

/**
 * CC-1234: the tick's one decider wake; its briefs' sends are kept or dropped by how it ended. CC-1239: they are
 * recorded inside the wake, after its counting ledger write, so a write that throws leaves no record behind.
 */
export async function actOnDeciderAndBriefs(
  config: TickConfig,
  { decider, briefRoutes }: { decider: DeciderVerdict | undefined; briefRoutes: readonly BriefRoute[] },
  ledger: Ledger,
  deps: DeciderDeps,
  opts: Pick<TickOptions, 'root' | 'briefEdit'>,
): Promise<{ ledger: Ledger; lines: string[] }> {
  const ports = briefPorts(opts)
  if (decider?.wake !== true) {
    const acted = await actOnDecider(config, decider, ledger, deps)
    const reason = decider?.wake === false ? decider.reason : 'no decider configured'
    return { ledger: acted.ledger, lines: [...acted.lines, ...unsentBriefLines(briefRoutes, reason)] }
  }
  let recorded: BriefRoute[] = []
  let lines: string[] = []
  const compose = (): string | undefined => {
    ;({ recorded, lines } = recordBriefRoutes(briefRoutes, ports))
    const verdict = withRecordedBriefs(
      decider,
      recorded.map(route => route.section),
      deps.now,
    )
    return verdict?.wake === true ? verdict.message : undefined
  }
  const acted = await actOnDecider(config, decider, ledger, deps, compose)
  const finished = finishBriefRoutes(recorded, acted.delivery, ports)
  return { ledger: acted.ledger, lines: [...lines, ...acted.lines, ...finished] }
}

const unsentBriefLines = (routes: readonly BriefRoute[], reason: string): string[] =>
  routes.map(route => `brief ${route.taskId} not sent to the decider: ${reason}; retried next tick`)

function describeDecider(config: TickConfig, verdict: DeciderVerdict | undefined): string[] {
  const name = config.decider?.name
  if (verdict === undefined || name === undefined) return []
  if (verdict.wake)
    return [
      `would wake decider ${name} (headless) for ${verdict.waiting} waiting question(s) and ${verdict.briefs} proposed brief(s)`,
    ]
  return [`decider ${name} not woken: ${verdict.reason}`]
}

interface Decided {
  steps: Step[]
  notes: string[]
  decider?: DeciderVerdict
  /** CC-1234: failing briefs that ride the decider wake, released when the decider is not woken. */
  briefRoutes: readonly BriefRoute[]
  triage: TriagePlan
  failures: ReaderFailure[]
  unchecked: string[]
  /** Seats mode only: every seat's pool samples, this tick's included. */
  seatStates?: Record<string, SeatState>
  /** Seats mode only: each seat's dispatch outcome this tick, for the scope-exhausted streak (CC-864). */
  outcomes: SeatOutcome[]
  skippedSeats: SkippedSeat[]
  /** Seats mode only: this tick's service-check read, persisted for the next tick's two-read rule. */
  serviceCheck?: PersistedRead
  /** Seats mode only: the "dispatched nothing" lines due this tick (CC-859). */
  reasons: NoDispatchReason[]
  /** Seats mode only: the seats whose unregistered PRs the tick registers or flags (CC-861). */
  adopt: AdoptSeat[]
  /** What this tick's summary row reads from the plan (CC-929). */
  summary: SummaryPlan
  /** Seats mode only: the loaded seats whose due human steps the tick routes (CC-974). */
  humanStepSeats: LoadedSeat[]
  /** CC-1049: open tasks whose slices all merged, told once to the seat that holds them. */
  merged: SeatEvents
  /** CC-1238: all-released parents whose slices landed on the default branch, closed by the tick. */
  closing: ClosingParent[]
  /** CC-1257: what the park sweep reads, judged against the ledger the tick ends on. */
  sweep: SweepInputs
}

interface SweepInputs {
  roster: Roster
  prefixes: readonly string[]
}

const sweepCandidates = ({ roster, prefixes }: SweepInputs, ledger: Ledger) =>
  parkCandidates(roster, ledger, prefixes, dir => fs.existsSync(dir))

/** CC-1257: re-tries the park that park-at-exit refused, once its claim has moved on or gone. */
async function sweepTrees(
  candidates: ReturnType<typeof sweepCandidates>,
  park: TickBroker['park'],
  log: NonNullable<TickOptions['log']>,
): Promise<string[]> {
  if (park === undefined || candidates.length === 0) return []
  const { lines, parked, kept, left } = await parkSweep(candidates, park)
  log('burndown_park_sweep', { parked, kept, left })
  return lines
}

interface ClosingParent {
  initiative: string
  id: string
}

/** Any row not retired may still run, and so may a name missing from a partial roster. */
function mayRun(roster: Roster, name: string): boolean {
  const row = rowNamed(roster, name)
  return row === undefined ? roster.partial !== undefined : row.state !== 'retired'
}

/** A row still spawning, live or detached; a missing row has exited, been retired, or never landed. */
function isRunning(roster: Roster, name: string): boolean {
  const state = rowNamed(roster, name)?.state
  return state !== undefined && state !== 'exited' && state !== 'retired'
}

/** Observe, advance and plan: every step the tick would take, in order, and a note for everything it would not. */
async function decide(
  config: TickConfig,
  opts: TickOptions,
  ledger: Ledger,
  now: Date,
  timer: StepTimer,
  briefRoutes: readonly BriefRoute[],
): Promise<Decided> {
  const root = opts.root ?? activeWorkRoot()
  const roster = await timer.time('roster', () => opts.broker.roster())
  const world = await timer.time('world', () => loadWorld(now, root))
  const seating = timer.start('seats')
  const unusable = config.seats.length === 0 ? undefined : watchdogUnusable()
  if (unusable !== undefined) (opts.log ?? logEvent)('burndown_seat_paths_skipped', { reason: unusable })
  const seats =
    config.seats.length === 0
      ? undefined
      : unusable !== undefined
        ? { loaded: [], skipped: config.seats.map(seat => ({ seat, reason: unusable })) }
        : loadSeats(config.seats, ledger, diskSeatDeps(defaultAutonomyRoot(root), root, now))
  seating.stop()
  const held = heldClaims(ledger)
  const shepherd = memo(() => shepherdRows(opts.exec ?? run, opts.log))
  const tasks = new Map([...world.tasks, ...seatClaimTasks(held, world, root)])
  const { observations, unread } = await timer.time('observe', () =>
    observe(held, roster, {
      proposed: (initiative, taskId) =>
        briefAnswered(tasks.get(initiative)?.find(t => t.id === taskId)?.tags ?? []),
      inboxSince: opts.broker.inboxSince,
      root,
      shepherdRows: shepherd,
      landed: target => shepherdLanded(target, opts.exec ?? run),
      exitedWork: worktree => readExitedWork(worktree, opts.exec ?? run),
      prFiles: prFilesReader(opts.exec ?? run),
      prState: claimPrReader(opts.exec ?? run),
    }),
  )
  const ctx = {
    ...stepContext(world, config, now, root),
    ...(seats === undefined ? {} : { seat: seatLookup(seats) }),
    running: (name: string) => isRunning(roster, name),
    priorBranch: (key: ClaimKey) => ledger.ladder?.[claimKey(key)]?.branch,
    tasks,
  }
  const capacity = agentCapacity(config, ledger.claims, roster)
  const briefs = briefRoutes.map(route => route.section)
  const decider = await timer.time('decider', () =>
    deciderFor(config, opts, ledger, roster, capacity, now, briefs),
  )
  const agents = decider?.wake === true ? { ...capacity, agents: capacity.agents - 1 } : capacity
  const planning = timer.start('plan')
  const laddered = ladderActions(
    withFindings(
      advance(held, observations, now, name => mayRun(roster, name)),
      held,
      observations,
      now,
      seat => {
        const lookup = ctx.seat?.(seat)
        return lookup !== undefined && 'gate' in lookup && !lookup.gate(0).open
      },
    ),
    held,
    ledger,
    {
      enabled: config.ladder.enabled,
      diffSummary: w => diffSummary(w, opts.exec ?? run),
      branch: w => branchOf(w, opts.exec ?? run),
      live: name => mayRun(roster, name),
      now,
    },
  )
  const advanced = stepsForActions([...laddered.actions, ...laddered.brake], ledger, ctx, agents.agents)
  const kept = advanced.steps.flatMap(s => (s.kind === 'ledger' ? s.actions : []))
  const resynced = resyncQueuedSlices(
    applyActions(ledger, kept, now),
    diskPlanReader(root),
    now,
    seatPrReader(seats?.loaded.map(s => s.dispatch) ?? [], opts.exec ?? run),
  )
  const planLedger = applyActions(ledger, [...kept, ...resynced.actions], now)
  const triage = triageFor(
    config,
    planLedger,
    roster,
    { ...agents, agents: agents.agents - advanced.spawns },
    now,
  )
  planning.stop()
  const { check, failures } = await timer.time('collision', () => tickCollision(planLedger, opts))
  const building = timer.start('plan')
  const prefixes = [DEFAULT_NAME_PREFIX, ...(seats?.loaded.map(s => s.dispatch.prefix) ?? [])]
  const service = seats === undefined ? undefined : serviceGate(ledger, opts, now)
  const stacking = stackInputs(config.stack.mode, planLedger, backoffHeld(planLedger, now), shepherd)
  const planned = planNew(
    world,
    seats,
    root,
    roster,
    {
      ledger: planLedger,
      capacity: worktreeCapacity(config, triage.left, prefixes),
      orphan: (repo, name) => orphanAt(repo, name),
      collision: check,
      charged: advanced.charged,
      ...(stacking.stack === undefined ? {} : { stack: stacking.stack }),
    },
    {
      ...(service?.lineStop === undefined ? {} : { lineStop: service.lineStop }),
      brief: briefDepsOf(config),
      scopeTagAliases: config.scopeTagAliases,
    },
  )
  const dispatchCtx = { ...ctx, tasks: new Map([...ctx.tasks, ...planned.tasks]) }
  const dispatched = planned.dispatch.map(d => stepsForDispatch(d, dispatchCtx))
  const pending = pendingOffLedger(ledger, diskPlanReader(root))
  const closingParents = (
    seats === undefined ? [] : landedReleasedParents(ledger, dispatchCtx.tasks, seats, opts)
  ).filter(p => pending(p.initiative, p.id).length === 0)
  const closing = new Set(closingParents.map(p => mergedFlagKey(p.initiative, p.id)))
  const notes = [
    ...(roster.partial === undefined ? [] : [`roster partial: ${roster.partial}`]),
    ...unread.map(u => `unread ${u}`),
    ...laddered.notes,
    ...resynced.notes,
    ...(service?.note === undefined ? [] : [service.note]),
    ...advanced.deferred.map(d => `deferred ${d}`),
    ...dispatched.flatMap(d => (typeof d === 'string' ? [`not dispatched: ${d}`] : [])),
    ...refusalLines(planned.refusals),
    ...planned.notes,
    ...stacking.notes,
    ...triageNotes(triage.plan.verdicts),
    ...planned.skipped.map(s => `seat ${s.seat} skipped: ${s.reason}`),
    ...planned.skippedTasks.map(
      s => `seat ${s.seat} scorer skipped: ${s.files.length} (${s.files.join(', ')})`,
    ),
  ]
  const steps = [
    ...retrySteps(ledger, roster),
    ...advanced.steps,
    ...resyncSteps(resynced),
    ...seedSteps(planned.seeds),
    ...healSteps(planned.heals),
    ...dispatched.flatMap(d => (typeof d === 'string' ? [] : d)),
  ]
  const unchecked = world.initiatives
    .filter(i => i.state === 'focused' && i.autonomy !== undefined && i.autonomy.repo === undefined)
    .map(i => i.slug)
  const marked =
    seats === undefined ? undefined : dueReasons(planned.outcomes, samplesAfter(ledger, seats), now)
  building.stop()
  return {
    steps,
    reasons: marked?.due ?? [],
    outcomes: planned.outcomes,
    adopt: seats?.loaded.map(s => adoptSeatOf(s)) ?? [],
    humanStepSeats: seats?.loaded ?? [],
    merged:
      seats === undefined
        ? {}
        : mergedEvents(ledger, dispatchCtx.tasks, (i, id) => closing.has(mergedFlagKey(i, id)), pending),
    closing: closingParents,
    sweep: { roster, prefixes },
    summary: {
      maxAgeDays: config.briefMaxAgeDays,
      caps: Object.fromEntries(seats?.loaded.map(s => [s.dispatch.seat, s.dispatch.caps]) ?? []),
      outcomes: planned.outcomes,
      dispatch: planned.dispatch,
      tasks: dispatchCtx.tasks,
    },
    notes,
    failures,
    unchecked,
    skippedSeats: planned.skipped,
    triage: triage.plan,
    ...(decider === undefined ? {} : { decider }),
    briefRoutes,
    ...(marked === undefined ? {} : { seatStates: marked.states }),
    ...(service === undefined ? {} : { serviceCheck: service.read }),
  }
}

/** Seats mode's one service-check read per tick, judged against the read the last tick persisted. */
function serviceGate(
  ledger: Ledger,
  opts: TickOptions,
  now: Date,
): { read: PersistedRead; lineStop?: SeatPlanDeps['lineStop']; note?: string } {
  const current = readServiceCheck(opts.exec ?? run)
  const lineStop = lineStopFrom(current, ledger.serviceCheck, now)
  const note = serviceCheckNote(current)
  return {
    read: persisted(current, now),
    ...(lineStop === undefined ? {} : { lineStop }),
    ...(note === undefined ? {} : { note }),
  }
}

type NewWork = Required<Pick<PlanInputs, 'ledger' | 'capacity' | 'orphan' | 'collision'>> &
  Pick<PlanInputs, 'stack'> & {
    charged: readonly string[]
  }

interface Planned {
  dispatch: Dispatch[]
  refusals: Refusal[]
  skipped: SkippedSeat[]
  /** Task files seats mode read beyond the world's, for the dispatch briefs. */
  tasks: Map<string, Task[]>
  skippedTasks: SeatsPlan['skippedTasks']
  outcomes: SeatOutcome[]
  notes: string[]
  /** Seats mode only: slice claims seeded from seat-written plans (CC-927). */
  seeds?: Claim[]
  /** CC-1228: ledger updates that rehome or park queued slices their seat cannot place. */
  heals?: Action[]
}

/** Without seats, `plan()` over the briefs' autonomy blocks; with seats, `planSeat` for each loaded seat. */
function planNew(
  world: World,
  seats: LoadedSeats | undefined,
  root: string,
  roster: Roster,
  work: NewWork,
  flow: Pick<SeatPlanDeps, 'lineStop' | 'brief' | 'scopeTagAliases'>,
): Planned {
  if (seats === undefined) {
    const planned = plan({ ...world, ...work })
    return { ...planned, skipped: [], tasks: new Map(), skippedTasks: [], outcomes: [], notes: [] }
  }
  const cliVersion = installedClaudeVersion()
  const planned = planSeats(
    seats.loaded,
    {
      ...work,
      initiatives: world.initiatives,
      trust: (repo, cwd, configDir) => trustRefusal(repo, cwd, configDir, cliVersion),
      ...flow,
      roster,
    },
    root,
  )
  const unloaded = seats.skipped.map(s => ({ seat: s.seat, dispatched: 0, refusals: [], skipped: s.reason }))
  return {
    ...planned,
    skipped: [...seats.skipped, ...planned.skipped],
    outcomes: [...unloaded, ...planned.outcomes],
  }
}

const samplesAfter = (ledger: Ledger, seats: LoadedSeats): Record<string, SeatState> => ({
  ...ledger.seats,
  ...Object.fromEntries(seats.loaded.map(s => [s.dispatch.seat, s.state])),
})

/** The CC-202 check over this tick's ledger, collecting each failed reader for the event log. */
async function tickCollision(
  ledger: Ledger,
  opts: TickOptions,
): Promise<{ check: NonNullable<PlanInputs['collision']>; failures: ReaderFailure[] }> {
  const failures: ReaderFailure[] = []
  const record = (reader: CollisionReader, repo: string, detail?: string): void => {
    // The broker is shared by every repo, so its failure is one event per tick.
    if (reader === 'broker-view' && failures.some(f => f.reader === reader)) return
    failures.push({ reader, repo, ...(detail === undefined ? {} : { detail }) })
  }
  const check = collisionCheck(ledger, await readView(opts.broker), opts.exec ?? run, record)
  return { check, failures }
}

/** Undefined when the broker cannot answer, which the check turns into a `claimed` refusal per repo. */
async function readView(broker: TickBroker): Promise<BrokerView | undefined> {
  try {
    return await broker.collisionView()
  } catch {
    return undefined
  }
}

/** The decider goes first: answering is what lets parked agents finish, so it takes capacity before new work. */
async function deciderFor(
  config: TickConfig,
  opts: TickOptions,
  ledger: Ledger,
  roster: Roster,
  capacity: Pick<Capacity, 'agents' | 'agentsReason'>,
  now: Date,
  briefs: readonly string[],
): Promise<DeciderVerdict | undefined> {
  if (config.decider === undefined) return undefined
  return deciderVerdict({
    config: config.decider,
    agentId: resolveDeciderAgentId(),
    roster,
    queue: await opts.broker.queue(),
    state: ledger.decider,
    capacity: capacity.agents,
    capacityReason: capacity.agentsReason,
    now,
    briefs,
  })
}

/** Triage takes its capacity after the decider and the advance spawns, before new work; `left` is what new work may use. */
function triageFor(
  config: TickConfig,
  ledger: Ledger,
  roster: Roster,
  capacity: Pick<Capacity, 'agents' | 'agentsReason' | 'agentsGate'>,
  now: Date,
): { plan: TriagePlan; left: Pick<Capacity, 'agents' | 'agentsReason' | 'agentsGate'> } {
  const readiness = triageReadiness(config)
  const { agents: free, agentsReason } = capacity
  const verdicts = triageVerdicts({
    config,
    readiness,
    ledger,
    capacity: free,
    capacityReason: agentsReason,
    now,
  })
  const starts = verdicts.filter(v => v.kind === 'start').length
  return { plan: { verdicts, readiness, roster }, left: { ...capacity, agents: free - starts } }
}

function triageDeps(opts: TickOptions, log: TriageDeps['log'], now: Date): TriageDeps {
  const write = (l: Ledger): void => writeLedger(burndownLedgerPath(), l)
  return { spawn: opts.broker.spawn, write, log, root: opts.root ?? activeWorkRoot(), now }
}

/** New agents this tick may start: under `maxAgents`, and under the broker's free slots less a reserve. */
export function agentCapacity(
  config: TickConfig,
  claims: Claim[],
  roster: Roster,
): Pick<Capacity, 'agents' | 'agentsReason' | 'agentsGate'> {
  const live = liveBurndownAgents(claims, roster, config.decider === undefined ? [] : [config.decider.name])
  const slots = roster.slots
  const free = slots === undefined ? 0 : slots.cap - slots.held - config.reserveSlots
  const broker =
    slots === undefined
      ? 'broker reported no slot reading, so none are assumed free'
      : `broker slots ${slots.held}/${slots.cap} held, ${config.reserveSlots} kept free`
  const agents = Math.max(0, Math.min(config.maxAgents - live, free))
  return {
    agents,
    agentsReason: `${live} of maxAgents ${config.maxAgents} burndown agents alive; ${broker}`,
    agentsGate: room => agentsGate(config, live, slots, agents - room),
  }
}

/**
 * CC-1097: the smaller of the two agent ceilings binds; broker slots bind when unread, as none are assumed free.
 * `started` is what the tick took from `agents` before the refusal: decider, advance, triage and plan spawns.
 */
function agentsGate(config: TickConfig, live: number, slots: Roster['slots'], started: number): GateReading {
  if (slots === undefined) return binaryGate('agentSlots', AGENT_SLOTS_SOURCE)
  const used = slots.held + config.reserveSlots
  return config.maxAgents - live <= slots.cap - used
    ? capGate('burndown.maxAgents', config.maxAgents, live + started, BURNDOWN_CONFIG)
    : capGate('agentSlots', slots.cap, used + started, AGENT_SLOTS_SOURCE)
}

const AGENT_SLOTS_SOURCE = '~/.agent-chat/config.json'

function worktreeCapacity(
  config: TickConfig,
  agents: Pick<Capacity, 'agents' | 'agentsReason' | 'agentsGate'>,
  prefixes: readonly string[],
): Capacity {
  const budget = resolveWorktreeBudget(DEFAULT_WORKTREE_BUDGET)
  const cache = new Map<string, ReturnType<Capacity['worktrees']>>()
  return {
    ...agents,
    agents: Math.max(0, agents.agents),
    worktrees: repo => {
      const known = cache.get(repo) ?? worktreeUse(worktreesUnder(repo), budget, config, prefixes)
      cache.set(repo, known)
      return known
    },
  }
}

/** A seat's initiative has no autonomy block, so the world has not read its task files; a seat claim's spawn needs them. */
function seatClaimTasks(held: readonly Claim[], world: World, root: string): Map<string, Task[]> {
  const slugs = new Set(held.filter(c => c.seat !== undefined).map(c => c.initiative))
  return new Map(
    [...slugs]
      .filter(slug => (world.tasks.get(slug) ?? []).length === 0)
      .map(slug => [slug, readTasks(root, slug)]),
  )
}

/** The seats mode inputs for a claim's spawn: the pool gate is read from this tick's sample. */
function seatLookup(seats: LoadedSeats): NonNullable<StepContext['seat']> {
  const cliVersion = installedClaudeVersion()
  return name => {
    const loaded = seats.loaded.find(s => s.dispatch.seat === name)
    if (loaded !== undefined)
      return {
        dispatch: loaded.dispatch,
        gate: dispatched => gatePool({ ...loaded.budget, dispatched }),
        trust: (repo, cwd, configDir) => trustRefusal(repo, cwd, configDir, cliVersion),
      }
    const skipped = seats.skipped.find(s => s.seat === name)
    return skipped === undefined ? undefined : { skipped: skipped.reason }
  }
}

function stepContext(
  world: World,
  config: TickConfig,
  now: Date,
  root: string,
): Omit<StepContext, 'running'> {
  const facts = new Map<string, RepoFacts>()
  return {
    now,
    root,
    initiatives: new Map(world.initiatives.map(i => [i.slug, i])),
    tasks: world.tasks,
    reportTo: config.reportTo ?? UNSET_REPORT_TO,
    repoFacts: repo => {
      const known = facts.get(repo) ?? repoFacts(repo)
      facts.set(repo, known)
      return known
    },
    account: initiative => openAccount(initiative, world),
    configDir: account => accountDir(account),
    trust: world.trust,
    taskText: (slug, id) => readTaskText(root, slug, id),
    readFile: file => readOrUndefined(file),
  }
}

type RepoFacts = ReturnType<StepContext['repoFacts']>

function repoFacts(repo: string): RepoFacts {
  return { defaultBranch: defaultBranch(repo), ...briefFacts(readOrUndefined(path.join(repo, 'CLAUDE.md'))) }
}

/** The gate for a successor or reviewer, which run on opus: a sonnet-only account is closed to them. */
function openAccount(initiative: Initiative, world: World): { account: string } | { closed: string } {
  const named = initiative.autonomy?.accounts.length ? initiative.autonomy.accounts : [initiative.profile]
  const allowed = named.filter((a): a is string => a !== undefined)
  const { chosen, closed } = pickAccount(allowed, world.rules, world.readings, world.gate)
  if (chosen === undefined)
    return { closed: closed.map(c => `${c.account}: ${c.reason}`).join('; ') || 'no account' }
  if (chosen.sonnetOnly) return { closed: `${chosen.account} is above 85% seven_day, sonnet only` }
  return { account: chosen.account }
}

const readOrUndefined = (file: string): string | undefined => {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

const recorded = (a: Action): string => {
  if (a.kind === 'add') return `add ${a.claims.map(c => c.taskId).join(',')}`
  if (a.kind === 'brake') return `brake ${a.brake?.at.length ?? 0} in window`
  return `${a.kind} ${a.key.taskId}${a.key.slice ?? ''}`
}

function describe(step: Step): string {
  if (step.kind === 'retire')
    return step.names.length === 0
      ? `would clear ${claimKey(step.key)}'s unretired agents, all since retired by hand`
      : `would retire ${step.names.join(', ')}${step.then === undefined ? '' : `, then ${step.then.map(a => a.kind).join(', ')}`}`
  if (step.kind === 'register')
    return `would register ${targetRef(step.registration.target)} with Shepherd for ${claimKey(step.key)}`
  if (step.kind === 'ledger') return `would record ${step.actions.map(recorded).join('; ')}`
  const f = step.frame
  const extra = [f.worktree && `adopting ${f.worktree}`, f.predecessor && `after ${f.predecessor}`].filter(
    Boolean,
  )
  return `would spawn ${f.name} as ${f.profile} (${f.surface}) on ${f.configDir} in ${f.cwd}${extra.length > 0 ? `, ${extra.join(', ')}` : ''}; brief ${f.brief.length} chars`
}

function refusalLines(refusals: readonly Refusal[]): string[] {
  return refusals.map(
    r => `refused ${r.initiative}${r.task === undefined ? '' : ` ${r.task}`} [${r.kind}]: ${r.reason}`,
  )
}
