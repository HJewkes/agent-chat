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
  burndownTickStatusPath,
  burndownTicksPath,
} from '../../paths.js'
import type { QueueItem } from '../../protocol.js'
import { activeWorkRoot } from '../active-work.js'
import { appendSeatLog } from '../seats/io.js'
import { seatMergedLog } from '../seats/dispatch-log.js'
import { seatJournal } from '../seats/journal.js'
import { ownerQueueSpoolDir, spoolOwnerQueue } from './owner-queue-spool.js'
import { adoptSeatPrs, type AdoptSeat } from './pr-adopt.js'
import { adoptSeatOf, changedFiles as prChangedFiles, diskAdoptPorts } from './pr-adopt-ports.js'
import { claimPrReader } from './pr-state.js'
import { DEFAULT_WORKTREE_BUDGET } from '../isolation/worktree.js'
import { advance, applyActions, claimKey, type Action, type ClaimKey, type InboxMessage } from './advance.js'
import { withFindings } from './finding.js'
import { BRAKE_WINDOW_MS, brakeSince, ladderActions, releasesSince } from './ladder.js'
import { verifySection } from './brief.js'
import { briefAnswered } from './brief-approve.js'
import { gatePool, pickAccount } from './budget-gate.js'
import { collisionCheck, type BrokerView, type CollisionReader } from './collision.js'
import { deciderVerdict, recordRefusal, wakeDecider, type DeciderVerdict } from './decider.js'
import type { Initiative, Refusal, Task } from './eligibility.js'
import type { EgressRunner } from './egress-runner.js'
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
import type { SpawnResult } from './seat-events.js'
import {
  briefDepsOf,
  diskSeatDeps,
  loadSeats,
  watchdogUnusable,
  planSeats,
  scopeExhausted,
  type LoadedSeat,
  type LoadedSeats,
  type SeatPlanDeps,
  type SeatsPlan,
  type SkippedSeat,
} from './seat-tick.js'
import { diskPlanReader, resyncQueuedSlices, resyncSteps, seedSteps } from './seed-slices.js'
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
  /** The human queue's open items; read only when a decider is configured. */
  queue: () => Promise<QueueItem[]>
  resume: (name: string, message: string) => Promise<SpawnReply>
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
  const { lines, summary, lockHeldMs } = locked.value
  if (summary !== undefined) {
    const timings = { durationMs: Math.round(monotonic() - started), lockHeldMs, steps: timer.steps() }
    appendTickSummary(tickSummary(summary, timings), opts.log ?? logEvent)
  }
  return { lines: [...gate.head, ...lines], outcome: { kind: 'ok' } }
}

interface Ran {
  lines: string[]
  /** A real tick's summary row inputs; a dry run has none. */
  summary?: SummaryInputs
}

async function runTick(config: TickConfig, opts: TickOptions, timer: StepTimer): Promise<Ran> {
  const now = opts.now ?? new Date()
  const ledger = await timer.time('read-ledger', () => readLedger(burndownLedgerPath()))
  const decided = await decide(config, opts, ledger, now, timer)
  const { steps, notes, decider } = decided
  if (opts.dryRun) {
    const planned = applyActions(
      ledger,
      steps.flatMap(s => (s.kind === 'ledger' ? s.actions : [])),
      now,
    )
    const diff = { seats: config.seats, before: ledger, after: planned, spawns: [] }
    return {
      lines: [
        `burndown tick at ${now.toISOString()} (dry run)`,
        ...steps.map(describe),
        ...describeDecider(config, decider),
        ...describeTriage(decided.triage),
        ...describeSeatEvents(diff, now),
        ...decided.reasons.map(r => `would log for seat ${r.seat}: ${r.text}`),
        ...notes,
      ],
    }
  }
  const acted = await actOn(config, opts, ledger, decided, now, timer)
  return {
    lines: [`burndown tick at ${now.toISOString()}`, ...acted.lines, ...notes],
    summary: acted.summary,
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
  const adopted = await timer.time('adopt', () => adoptPrs(adopt, executed.ledger, opts, now, registrations))
  const woken = await timer.time('decider-triage', async () =>
    actOnTriage(
      config,
      triage,
      await actOnDecider(config, decider, executed.ledger, { broker: opts.broker, log, now }),
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
  const diff = { seats: config.seats, before: ledger, after: leaks.ledger, spawns, human: leaks.human }
  const journal = seatJournal(defaultAutonomyRoot(opts.root), { log, now: clock })
  const dispatch = seatMergedLog(defaultAutonomyRoot(opts.root), { log, now: clock })
  const told = await timer.time('deliver', () =>
    deliverSeatEvents(diff, { open: opts.broker.seatSender, log, now, journal, dispatch }),
  )
  await timer.time('write-ledger', () =>
    writeLedger(burndownLedgerPath(), {
      ...told.ledger,
      lastTickAt: now.toISOString(),
      ...(serviceCheck === undefined ? {} : { serviceCheck }),
    }),
  )
  return {
    lines: [...routed, ...executed.lines, ...adopted, ...woken.lines, ...leaks.lines, ...told.lines],
    summary: { ...summary, now, registrations },
  }
}

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
const prFilesReader =
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

/** Wakes the decider, or records why not when the human has something to fix. */
async function actOnDecider(
  config: TickConfig,
  verdict: DeciderVerdict | undefined,
  ledger: Ledger,
  deps: { broker: TickBroker; log: (event: string, detail: Record<string, unknown>) => void; now: Date },
): Promise<{ ledger: Ledger; lines: string[] }> {
  const name = config.decider?.name
  if (verdict === undefined || name === undefined) return { ledger, lines: [] }
  if (verdict.wake) {
    const write = (l: Ledger): void => writeLedger(burndownLedgerPath(), l)
    const woken = await wakeDecider(name, verdict.message, ledger, {
      resume: deps.broker.resume,
      write,
      ...deps,
    })
    return { ledger: woken.ledger, lines: [woken.line] }
  }
  if (!verdict.record) return { ledger, lines: [`decider ${name} not woken: ${verdict.reason}`] }
  deps.log('burndown_decider_refused', { name, reason: verdict.reason })
  return {
    ledger: recordRefusal(ledger, verdict.reason, deps.now),
    lines: [`decider ${name} not woken: ${verdict.reason}`],
  }
}

function describeDecider(config: TickConfig, verdict: DeciderVerdict | undefined): string[] {
  const name = config.decider?.name
  if (verdict === undefined || name === undefined) return []
  if (verdict.wake)
    return [`would wake decider ${name} (headless) for ${verdict.waiting} waiting question(s)`]
  return [`decider ${name} not woken: ${verdict.reason}`]
}

interface Decided {
  steps: Step[]
  notes: string[]
  decider?: DeciderVerdict
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
  const decider = await timer.time('decider', () => deciderFor(config, opts, ledger, roster, capacity, now))
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
  const resynced = resyncQueuedSlices(applyActions(ledger, kept, now), diskPlanReader(root))
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
  const facts = new Map<string, { defaultBranch: string; verifySteps?: string }>()
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

function repoFacts(repo: string): { defaultBranch: string; verifySteps?: string } {
  const claudeMd = readOrUndefined(path.join(repo, 'CLAUDE.md'))
  const verifySteps = claudeMd === undefined ? undefined : verifySection(claudeMd)
  return { defaultBranch: defaultBranch(repo), ...(verifySteps === undefined ? {} : { verifySteps }) }
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
