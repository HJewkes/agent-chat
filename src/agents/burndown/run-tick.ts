import fs from 'node:fs'
import path from 'node:path'
import { logEvent } from '../../broker/log.js'
import { resolveDeciderAgentId, resolveWorktreeBudget } from '../../config.js'
import {
  burndownConfigPath,
  burndownLedgerPath,
  burndownPausePath,
  burndownTickStatusPath,
} from '../../paths.js'
import type { QueueItem } from '../../protocol.js'
import { activeWorkRoot } from '../active-work.js'
import { seatMergedLog } from '../seats/dispatch-log.js'
import { seatJournal } from '../seats/journal.js'
import { DEFAULT_WORKTREE_BUDGET } from '../isolation/worktree.js'
import { advance, applyActions, claimKey, type ClaimKey, type InboxMessage } from './advance.js'
import { withFindings } from './finding.js'
import { ladderActions, releasesSince } from './ladder.js'
import { verifySection } from './brief.js'
import { gatePool, pickAccount } from './budget-gate.js'
import { collisionCheck, type BrokerView, type CollisionReader } from './collision.js'
import { deciderVerdict, recordRefusal, wakeDecider, type DeciderVerdict } from './decider.js'
import type { Initiative, Refusal, Task } from './eligibility.js'
import { leakCheck } from './leak-check.js'
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
import { DEFAULT_NAME_PREFIX, plan, type Capacity, type Dispatch, type PlanInputs } from './plan.js'
import { branchOf, diffSummary } from './progress.js'
import { defaultAutonomyRoot } from './policy.js'
import { describeSeatEvents, deliverSeatEvents, type OpenSender } from './seat-deliver.js'
import type { SpawnResult } from './seat-events.js'
import {
  diskSeatDeps,
  loadSeats,
  planSeats,
  type LoadedSeats,
  type SeatPlanDeps,
  type SeatsPlan,
  type SkippedSeat,
} from './seat-tick.js'
import {
  accountDir,
  loadTickConfig,
  readInitiatives,
  readTaskText,
  readTasks,
  type TickConfig,
} from './source.js'
import {
  downstreamReader,
  prHeadOf,
  registerWithShepherd,
  shepherdLanded,
  shepherdRows,
  targetRef,
} from './shepherd.js'
import { retrySteps, stepsForActions, stepsForDispatch, type StepContext } from './steps.js'
import { recordTick, type StopCode, type TickResult } from './tick-status.js'
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
  root?: string
  log?: (event: string, detail: Record<string, unknown>) => void
  /** Runs the collision check's `git` and `gh` readers and the `titan-factory` calls; a test injects one that reaches neither. */
  exec?: Runner
}

interface ReaderFailure {
  reader: CollisionReader
  repo: string
  detail?: string
}

/** Shown in dry-run briefs when no `reportTo` is configured; a real tick refuses instead. */
const UNSET_REPORT_TO = '<reportTo unset>'

/** Why the tick may not act at all, or undefined when it may. */
export function stopReason(config: TickConfig, paused: boolean): string | undefined {
  if (!config.enabled) return `burndown is disabled (enabled is not true in ${burndownConfigPath()})`
  if (paused)
    return `burndown is paused (${burndownPausePath()} exists; \`agent-chat burndown resume\` clears it)`
  if (config.reportTo === undefined)
    return `no reportTo in ${burndownConfigPath()}: name the registered session that receives agents' reports`
  return undefined
}

/** CC-205 D2: seats mode and a brief's `autonomy:` block could dispatch one initiative twice, so both is a config error. */
export function modeConflict(config: TickConfig, initiatives: readonly Initiative[]): string | undefined {
  if (config.seats.length === 0) return undefined
  const optedIn = initiatives.filter(i => i.autonomy !== undefined).map(i => i.slug)
  if (optedIn.length === 0) return undefined
  return `config error: ${burndownConfigPath()} lists seats, and brief.md of ${optedIn.join(', ')} has an autonomy: block; remove one, since both modes would dispatch the same work`
}

/** Never rejects for a real tick: a throw is recorded in the status file (CC-756). A dry run records nothing and throws as before. */
export async function tickFromDisk(opts: TickOptions): Promise<string[]> {
  if (opts.dryRun) return (await tickOnce(opts)).lines
  const now = opts.now ?? new Date()
  return recordTick(burndownTickStatusPath(), () => tickOnce({ ...opts, now }), now, opts.log)
}

const stopCode = (config: TickConfig, paused: boolean): StopCode =>
  !config.enabled ? 'disabled' : paused ? 'paused' : 'no-report-to'

async function tickOnce(opts: TickOptions): Promise<TickResult> {
  const config = loadTickConfig(burndownConfigPath())
  const paused = fs.existsSync(burndownPausePath())
  const stop = stopReason(config, paused)
  if (stop !== undefined && !opts.dryRun)
    return { lines: [stop], outcome: { kind: 'stopped', reason: stopCode(config, paused) } }
  const head = stop === undefined ? [] : [`${stop}; dry run proceeds anyway`]
  const conflict = modeConflict(config, readInitiatives(opts.root ?? activeWorkRoot()))
  if (conflict !== undefined)
    return { lines: [...head, conflict], outcome: { kind: 'failed', errorClass: 'ModeConflict' } }
  const locked = await withLedgerLock(burndownLedgerPath(), () => runTick(config, opts))
  if (!locked.ran)
    return {
      lines: [...head, `another tick holds the ledger lock (pid ${locked.holder}); did nothing`],
      outcome: { kind: 'skipped' },
    }
  return { lines: [...head, ...locked.value], outcome: { kind: 'ok' } }
}

async function runTick(config: TickConfig, opts: TickOptions): Promise<string[]> {
  const now = opts.now ?? new Date()
  const ledger = readLedger(burndownLedgerPath())
  const decided = await decide(config, opts, ledger, now)
  const { steps, notes, decider } = decided
  if (opts.dryRun) {
    const planned = applyActions(
      ledger,
      steps.flatMap(s => (s.kind === 'ledger' ? s.actions : [])),
      now,
    )
    const diff = { seats: config.seats, before: ledger, after: planned, spawns: [] }
    return [
      `burndown tick at ${now.toISOString()} (dry run)`,
      ...steps.map(describe),
      ...describeDecider(config, decider),
      ...describeTriage(decided.triage),
      ...describeSeatEvents(diff, now),
      ...notes,
    ]
  }
  const lines = await actOn(config, opts, ledger, decided, now)
  return [`burndown tick at ${now.toISOString()}`, ...lines, ...notes]
}

/** Executes the steps, wakes the decider, scans claimed PRs for leaks, then tells each seat what changed, writing the ledger last. */
async function actOn(
  config: TickConfig,
  opts: TickOptions,
  ledger: Ledger,
  { steps, decider, triage, failures, unchecked, seatStates, skippedSeats }: Decided,
  now: Date,
): Promise<string[]> {
  const log = opts.log ?? logEvent
  for (const failure of failures) log('burndown_collision_reader_failed', { ...failure })
  for (const initiative of unchecked) log('burndown_collision_skipped', { initiative, reason: 'no repo' })
  for (const skipped of skippedSeats) log('burndown_seat_skipped', { ...skipped })
  const sampled = seatStates === undefined ? ledger : { ...ledger, seats: seatStates }
  const spawns: SpawnResult[] = []
  const executed = await execute(steps, sampled, {
    ledgerFile: burndownLedgerPath(),
    spawn: recordingSpawn(steps, opts.broker.spawn, spawns),
    retire: opts.broker.retire,
    register: registration => registerWithShepherd(registration, opts.exec ?? run),
    prHead: target => prHeadOf(target, opts.exec ?? run),
    log,
    now,
  })
  for (const r of releasesSince(ledger, executed.ledger))
    log('burndown_release', { task: r.taskId, slice: r.slice, code: r.code, branch: r.branch, n: r.n })
  const woken = await actOnTriage(
    config,
    triage,
    await actOnDecider(config, decider, executed.ledger, { broker: opts.broker, log, now }),
    triageDeps(opts, log, now),
  )
  const leaks = await leakCheck(woken.ledger, { exec: opts.exec ?? run, log, seats: config.seats })
  const diff = { seats: config.seats, before: ledger, after: leaks.ledger, spawns, human: leaks.human }
  const journal = seatJournal(defaultAutonomyRoot(opts.root), { log, now: () => now })
  const dispatch = seatMergedLog(defaultAutonomyRoot(opts.root), { log, now: () => now })
  const told = await deliverSeatEvents(diff, { open: opts.broker.seatSender, log, now, journal, dispatch })
  writeLedger(burndownLedgerPath(), { ...told.ledger, lastTickAt: now.toISOString() })
  return [...executed.lines, ...woken.lines, ...leaks.lines, ...told.lines]
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
  skippedSeats: SkippedSeat[]
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
async function decide(config: TickConfig, opts: TickOptions, ledger: Ledger, now: Date): Promise<Decided> {
  const root = opts.root ?? activeWorkRoot()
  const roster = await opts.broker.roster()
  const world = loadWorld(now, root)
  const seats =
    config.seats.length === 0
      ? undefined
      : loadSeats(config.seats, ledger, diskSeatDeps(defaultAutonomyRoot(root), root, now))
  const held = heldClaims(ledger)
  const shepherd = memo(() => shepherdRows(opts.exec ?? run, opts.log))
  const { observations, unread } = await observe(held, roster, {
    inboxSince: opts.broker.inboxSince,
    root,
    shepherdRows: shepherd,
    landed: target => shepherdLanded(target, opts.exec ?? run),
  })
  const ctx = {
    ...stepContext(world, config, now, root),
    ...(seats === undefined ? {} : { seat: seatLookup(seats) }),
    running: (name: string) => isRunning(roster, name),
    priorBranch: (key: ClaimKey) => ledger.ladder?.[claimKey(key)]?.branch,
    tasks: new Map([...world.tasks, ...seatClaimTasks(held, world, root)]),
  }
  const capacity = agentCapacity(config, ledger.claims, roster)
  const decider = await deciderFor(config, opts, ledger, roster, capacity, now)
  const agents = decider?.wake === true ? { ...capacity, agents: capacity.agents - 1 } : capacity
  const laddered = ladderActions(
    withFindings(advance(held, observations, now), held, observations, now, seat => {
      const lookup = ctx.seat?.(seat)
      return lookup !== undefined && 'gate' in lookup && !lookup.gate(0).open
    }),
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
  const advanced = stepsForActions(laddered.actions, ledger, ctx, agents.agents)
  const kept = advanced.steps.flatMap(s => (s.kind === 'ledger' ? s.actions : []))
  const planLedger = applyActions(ledger, kept, now)
  const triage = triageFor(
    config,
    planLedger,
    roster,
    { ...agents, agents: agents.agents - advanced.spawns },
    now,
  )
  const { check, failures } = await tickCollision(planLedger, opts)
  const prefixes = [DEFAULT_NAME_PREFIX, ...(seats?.loaded.map(s => s.dispatch.prefix) ?? [])]
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
    },
    downstreamReader(shepherd, opts.exec ?? run),
  )
  const dispatchCtx = { ...ctx, tasks: new Map([...ctx.tasks, ...planned.tasks]) }
  const dispatched = planned.dispatch.map(d => stepsForDispatch(d, dispatchCtx))
  const notes = [
    ...(roster.partial === undefined ? [] : [`roster partial: ${roster.partial}`]),
    ...unread.map(u => `unread ${u}`),
    ...laddered.notes,
    ...advanced.deferred.map(d => `deferred ${d}`),
    ...dispatched.flatMap(d => (typeof d === 'string' ? [`not dispatched: ${d}`] : [])),
    ...refusalLines(planned.refusals),
    ...triageNotes(triage.plan.verdicts),
    ...planned.skipped.map(s => `seat ${s.seat} skipped: ${s.reason}`),
    ...planned.skippedTasks.map(
      s => `seat ${s.seat} scorer skipped: ${s.files.length} (${s.files.join(', ')})`,
    ),
  ]
  const steps = [
    ...retrySteps(ledger, roster),
    ...advanced.steps,
    ...dispatched.flatMap(d => (typeof d === 'string' ? [] : d)),
  ]
  const unchecked = world.initiatives
    .filter(i => i.state === 'focused' && i.autonomy !== undefined && i.autonomy.repo === undefined)
    .map(i => i.slug)
  const seatStates = seats === undefined ? undefined : samplesAfter(ledger, seats)
  return {
    steps,
    notes,
    failures,
    unchecked,
    skippedSeats: planned.skipped,
    triage: triage.plan,
    ...(decider === undefined ? {} : { decider }),
    ...(seatStates === undefined ? {} : { seatStates }),
  }
}

type NewWork = Required<Pick<PlanInputs, 'ledger' | 'capacity' | 'orphan' | 'collision'>> & {
  charged: readonly string[]
}

interface Planned {
  dispatch: Dispatch[]
  refusals: Refusal[]
  skipped: SkippedSeat[]
  /** Task files seats mode read beyond the world's, for the dispatch briefs. */
  tasks: Map<string, Task[]>
  skippedTasks: SeatsPlan['skippedTasks']
}

/** Without seats, `plan()` over the briefs' autonomy blocks; with seats, `planSeat` for each loaded seat. */
function planNew(
  world: World,
  seats: LoadedSeats | undefined,
  root: string,
  roster: Roster,
  work: NewWork,
  downstream: NonNullable<SeatPlanDeps['downstream']>,
): Planned {
  if (seats === undefined)
    return { ...plan({ ...world, ...work }), skipped: [], tasks: new Map(), skippedTasks: [] }
  const cliVersion = installedClaudeVersion()
  const planned = planSeats(
    seats.loaded,
    {
      ...work,
      initiatives: world.initiatives,
      trust: (repo, cwd, configDir) => trustRefusal(repo, cwd, configDir, cliVersion),
      downstream,
      roster,
    },
    root,
  )
  return { ...planned, skipped: [...seats.skipped, ...planned.skipped] }
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
  capacity: Pick<Capacity, 'agents' | 'agentsReason'>,
  now: Date,
): { plan: TriagePlan; left: Pick<Capacity, 'agents' | 'agentsReason'> } {
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
): Pick<Capacity, 'agents' | 'agentsReason'> {
  const live = liveBurndownAgents(claims, roster, config.decider === undefined ? [] : [config.decider.name])
  const slots = roster.slots
  const free = slots === undefined ? 0 : slots.cap - slots.held - config.reserveSlots
  const broker =
    slots === undefined
      ? 'broker reported no slot reading, so none are assumed free'
      : `broker slots ${slots.held}/${slots.cap} held, ${config.reserveSlots} kept free`
  return {
    agents: Math.max(0, Math.min(config.maxAgents - live, free)),
    agentsReason: `${live} of maxAgents ${config.maxAgents} burndown agents alive; ${broker}`,
  }
}

function worktreeCapacity(
  config: TickConfig,
  agents: Pick<Capacity, 'agents' | 'agentsReason'>,
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

function describe(step: Step): string {
  if (step.kind === 'retire')
    return step.names.length === 0
      ? `would clear ${claimKey(step.key)}'s unretired agents, all since retired by hand`
      : `would retire ${step.names.join(', ')}`
  if (step.kind === 'register')
    return `would register ${targetRef(step.registration.target)} with Shepherd for ${claimKey(step.key)}`
  if (step.kind === 'ledger')
    return `would record ${step.actions.map(a => (a.kind === 'add' ? `add ${a.claims.map(c => c.taskId).join(',')}` : `${a.kind} ${a.key.taskId}${a.key.slice ?? ''}`)).join('; ')}`
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
