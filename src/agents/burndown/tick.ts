import os from 'node:os'
import { burndownLedgerPath } from '../../paths.js'
import { activeWorkRoot } from '../active-work.js'
import { gateAccount, RUN_CAP_MS, type AccountReading } from './budget-gate.js'
import { routeOf, type RouteConfig } from './exception.js'
import { backoffHeld } from './backoff.js'
import { taskRefusal, type Initiative } from './eligibility.js'
import { heldClaims, isStalled, readLedger, type Claim, type DeciderState, type Ledger } from './ledger.js'
import type { Runner } from './exec.js'
import type { Roster } from './observe.js'
import { plan, type Plan, type PlanInputs } from './plan.js'
import { lineStopFrom, readServiceCheck, serviceCheckLine } from './service-check.js'
import { defaultAutonomyRoot, loadCharterPools, seatScope, type CharterPool } from './policy.js'
import { expandHome } from './seat-dispatch.js'
import { projectMix, shareOrder, type ProjectShares, type ShareRow } from './project-shares.js'
import { scoredSeatFromDisk } from './score-render.js'
import { priorPicksOf } from './seat-plan.js'
import {
  briefDepsOf,
  diskSeatDeps,
  loadSeats,
  localDate,
  planSeats,
  type LoadedSeats,
  type SeatPlanDeps,
} from './seat-tick.js'
import { loadResolvedConfig } from './settings-store.js'
import { accountDir, readInitiatives, readReadings, readTasks } from './source.js'
import { currentTriage, exceptionOf } from './triage.js'
import { installedClaudeVersion, trustRefusal } from './trust-gate.js'

/** The dry-run tick over the live files, and its two renderings: `burndown plan` and `burndown status`. */

const accountsOf = (initiatives: Initiative[]): string[] => [
  ...new Set(
    initiatives.flatMap(i =>
      i.autonomy === undefined
        ? []
        : i.autonomy.accounts.length > 0
          ? i.autonomy.accounts
          : i.profile === undefined
            ? []
            : [i.profile],
    ),
  ),
]

export interface CharterRules {
  rules: Record<string, CharterPool>
  /** Why the charter could not be read; every pool's gate is then closed. */
  error?: string
}

/** CC-801: the charter's pools, the one source `burndown status`, the tick and `seats status` judge a pool by. */
export function charterRules(autonomyRoot: string): CharterRules {
  try {
    return { rules: loadCharterPools(autonomyRoot) }
  } catch (err) {
    return { rules: {}, error: err instanceof Error ? err.message : String(err) }
  }
}

/** The pool's charter `config_dir`, as `seats status` reads it; an account the charter lacks keeps its profile dir. */
export const poolDir =
  (rules: CharterRules['rules'], home = os.homedir()) =>
  (account: string): string => {
    const dir = rules[account]?.config_dir
    return dir === undefined ? accountDir(account) : expandHome(dir, home)
  }

/** Everything `plan` reads off disk, which the tick also needs for briefs and the account gate. */
export type World = Omit<PlanInputs, 'ledger' | 'capacity' | 'orphan'>

export function loadWorld(now: Date, root: string): World {
  const initiatives = readInitiatives(root)
  const { rules } = charterRules(defaultAutonomyRoot(root))
  const cliVersion = installedClaudeVersion()
  const accounts = [...new Set([...accountsOf(initiatives), ...Object.keys(rules)])]
  return {
    initiatives,
    tasks: new Map(initiatives.map(i => [i.slug, i.autonomy === undefined ? [] : readTasks(root, i.slug)])),
    rules,
    readings: readReadings(accounts, now.getTime(), poolDir(rules)),
    // No human-presence signal exists yet, so the gate assumes the human is here: a pool they use gets the capped ceiling.
    gate: { now },
    trust: (repo, cwd, account) => trustRefusal(repo, cwd, accountDir(account), cliVersion),
  }
}

/** `collision` is the CC-202 check; without one, `plan` refuses nothing for collisions. */
export function planFromDisk(
  now = new Date(),
  root = activeWorkRoot(),
  collision?: (ledger: Ledger) => PlanInputs['collision'],
): Plan {
  const ledger = readLedger(burndownLedgerPath())
  const check = collision?.(ledger)
  return plan({ ...loadWorld(now, root), ledger, ...(check === undefined ? {} : { collision: check }) })
}

export interface SeatPlanOptions {
  seat: string
  now: Date
  root: string
  autonomyRoot: string
  collision?: (ledger: Ledger) => PlanInputs['collision']
  /** The broker's roster; with it only active trees count against the seat's cap, as the tick counts them. */
  roster?: Roster
  /** Runs `titan-factory` and `git` for the service-check read; defaults to the real runner. */
  exec?: Runner
  /** CC-1107: forecast the next picks by project under these shares, beside the plan. */
  whatIf?: ShareWhatIfRequest
}

export interface ShareWhatIfRequest {
  shares: ProjectShares
  picks: number
}

/** The ledger, the seat as the tick loads it, and the planning deps the tick passes; shared by `plan --seat` and `seats compare`. */
export function seatPlanSetup(opts: SeatPlanOptions): {
  ledger: Ledger
  seats: LoadedSeats
  deps: SeatPlanDeps
  serviceCheck: string
} {
  const ledger = readLedger(burndownLedgerPath())
  const seats = loadSeats([opts.seat], ledger, diskSeatDeps(opts.autonomyRoot, opts.root, opts.now))
  const check = opts.collision?.(ledger)
  const cliVersion = installedClaudeVersion()
  // A dry run judges this read against the persisted one and writes neither.
  const read = readServiceCheck(opts.exec)
  const lineStop = lineStopFrom(read, ledger.serviceCheck, opts.now)
  const config = loadResolvedConfig().tick
  const deps: SeatPlanDeps = {
    ledger,
    scopeTagAliases: config.scopeTagAliases,
    brief: briefDepsOf(config),
    initiatives: readInitiatives(opts.root),
    trust: (repo, cwd, configDir) => trustRefusal(repo, cwd, configDir, cliVersion),
    ...(check === undefined ? {} : { collision: check }),
    ...(lineStop === undefined ? {} : { lineStop }),
    ...(opts.roster === undefined ? {} : { roster: opts.roster }),
  }
  return { ledger, seats, deps, serviceCheck: serviceCheckLine(read, ledger.serviceCheck, opts.now) }
}

/** `burndown plan --seat <name>`: one seat's dispatches as the tick would plan them, without the tick's live ceilings; with no roster it counts every held tree. */
export function seatPlanFromDisk(opts: SeatPlanOptions): Plan & { shareMix?: string } {
  const { ledger, seats, deps, serviceCheck } = seatPlanSetup(opts)
  const planned = planSeats(seats.loaded, deps, opts.root)
  const [skipped] = [...seats.skipped, ...planned.skipped]
  if (skipped !== undefined) throw new Error(skipped.reason)
  const [seat] = seats.loaded
  const shareMix =
    opts.whatIf === undefined || seat === undefined
      ? undefined
      : renderShareMix(
          shareWhatIfFromDisk(opts, opts.whatIf, {
            priorPicks: priorPicksOf(ledger, opts.seat, runStartOf(seat.budget)),
            readySet: deps.brief?.briefGate[opts.seat] === 'on',
          }),
        )
  return {
    dispatch: planned.dispatch,
    refusals: planned.refusals,
    notOptedIn: [],
    skippedTasks: planned.skippedTasks.flatMap(s => s.files),
    serviceCheck,
    ...(shareMix !== undefined && { shareMix }),
  }
}

/** The start of the seat's run as `planSeat` bounds its prior picks: the meter's start, at most 12 h back. */
const runStartOf = ({ runStartAt, ctx }: { runStartAt: number; ctx: { now: Date } }): number =>
  Math.max(runStartAt, ctx.now.getTime() - RUN_CAP_MS)

/** Each initiative's count of the next `picks` whole-task picks, before and after the shares. */
export interface ShareWhatIf {
  picks: number
  /** Initiatives in report order: the shares' own, then any other the forecast picks from. */
  slugs: string[]
  before: Record<string, number>
  after: Record<string, number>
}

/**
 * CC-1107: the next picks by project. `before` is the seat's order as it stands; `after` is the order
 * scored under the shares' defaults and interleaved by `shareOrder` from the run's prior picks.
 */
export function shareWhatIf(
  before: readonly ShareRow[],
  after: readonly ShareRow[],
  { shares, picks }: ShareWhatIfRequest,
  priorPicks: Readonly<Record<string, number>> = {},
): ShareWhatIf {
  const mix = {
    before: projectMix(before, picks),
    after: projectMix(shareOrder(after, shares, priorPicks), picks),
  }
  const slugs = [
    ...new Set([...Object.keys(shares.initiatives), ...Object.keys(mix.before), ...Object.keys(mix.after)]),
  ]
  return { picks, slugs, ...mix }
}

export function renderShareMix({ picks, slugs, before, after }: ShareWhatIf): string {
  const counts = slugs.map(slug => `${slug} ${before[slug] ?? 0} -> ${after[slug] ?? 0}`)
  return `next ${picks} picks by project: ${counts.join(', ')}`
}

/**
 * The what-if over the seat's scored order (`burndown plan --seat --scored`), every open row in scope;
 * throws on a share naming an initiative outside the seat's scope.
 */
export function shareWhatIfFromDisk(
  opts: Pick<SeatPlanOptions, 'seat' | 'now' | 'root' | 'autonomyRoot'>,
  whatIf: ShareWhatIfRequest,
  live: { priorPicks: Readonly<Record<string, number>>; readySet: boolean },
): ShareWhatIf {
  const disk = {
    seat: opts.seat,
    top: Number.MAX_SAFE_INTEGER,
    today: localDate(opts.now),
    autonomyRoot: opts.autonomyRoot,
    activeWorkRoot: opts.root,
  }
  const before = scoredSeatFromDisk({ ...disk, readySet: live.readySet })
  checkShareScope(before.policy, opts, whatIf.shares)
  const after = scoredSeatFromDisk({ ...disk, shares: whatIf.shares }).plan.order
  return shareWhatIf(before.plan.order, after, whatIf, live.priorPicks)
}

function checkShareScope(
  policy: ReturnType<typeof scoredSeatFromDisk>['policy'],
  opts: Pick<SeatPlanOptions, 'seat' | 'root'>,
  shares: ProjectShares,
): void {
  const scope = seatScope(policy.charter, policy.seats, opts.seat, readInitiatives(opts.root))
  const unknown = Object.keys(shares.initiatives).filter(slug => !(slug in scope))
  if (unknown.length > 0)
    throw new Error(`--shares names ${unknown.join(', ')}, not in seat ${opts.seat}'s scope`)
}

export function renderPlan(result: Plan, now: Date): string[] {
  const lines = [`burndown plan at ${now.toISOString()} (dry run: nothing spawned, nothing claimed)`]
  if (result.serviceCheck !== undefined) lines.push(result.serviceCheck)
  if (result.dispatch.length === 0) lines.push('would dispatch: nothing')
  for (const d of result.dispatch)
    lines.push(
      `would dispatch ${d.initiative} ${d.task} as ${d.profile} on ${d.account} in ${d.cwd}: ${d.reason}`,
    )
  for (const r of result.refusals)
    lines.push(`refused ${r.initiative}${r.task === undefined ? '' : ` ${r.task}`} [${r.kind}]: ${r.reason}`)
  if (result.notOptedIn.length > 0)
    lines.push(
      `not opted in (${result.notOptedIn.length} focused, no autonomy.mode: burndown): ${result.notOptedIn.join(', ')}`,
    )
  if (result.skippedTasks !== undefined)
    lines.push(
      `scorer skipped: ${result.skippedTasks.length}${result.skippedTasks.length === 0 ? '' : ` (${result.skippedTasks.join(', ')})`}`,
    )
  return lines
}

const findingSuffix = (c: Claim): string =>
  c.finding === undefined ? '' : ` FINDING ${c.finding.kind} (${c.finding.reason}, since ${c.finding.since})`

/** A stall's or open finding's class, the dial's route for it, and its triage job's outcome once one exists (CC-649). */
function stallSuffix(c: Claim, route: RouteConfig): string {
  const exception = exceptionOf(c)
  if (exception === undefined) return ''
  const { cls } = exception
  const triage = currentTriage(c)
  const job = triage === undefined ? '' : `, triage ${triage.name ?? '-'} ${triage.outcome}`
  return ` (class ${cls ?? 'none'}, route ${routeOf(cls, route, true).route}${job})`
}

/** One line per charter pool, judged by `gateAccount` on the same line and ceiling `seats status` prints. */
export function poolStatusLines(
  { rules, error }: CharterRules,
  readings: ReadonlyMap<string, AccountReading>,
  now: Date,
): string[] {
  const lines = error === undefined ? [] : [`pools: closed, no charter pools: ${error}`]
  for (const [account, rule] of Object.entries(rules)) {
    const gate = gateAccount(account, rule, readings.get(account), { now })
    lines.push(`account ${account}: ${gate.open ? 'open' : 'closed'}, ${gate.reason}`)
  }
  return lines
}

export function renderStatus(ledger: Ledger, now: Date, autonomyRoot = defaultAutonomyRoot()): string[] {
  const pools = charterRules(autonomyRoot)
  const readings = readReadings(Object.keys(pools.rules), now.getTime(), poolDir(pools.rules))
  const held = heldClaims(ledger)
  const { route } = loadResolvedConfig().tick.exceptions
  const lines = [
    `ledger ${burndownLedgerPath()}: ${held.length} held, last tick ${ledger.lastTickAt ?? 'never'}`,
  ]
  for (const c of held)
    lines.push(
      `${c.taskId} (${c.initiative}) ${c.agentId ?? c.agentName ?? 'unspawned'} ${c.phase} since ${c.phaseAt}${isStalled(c, now) ? ' STALLED' : ''}${stallSuffix(c, route)}${findingSuffix(c)}`,
    )
  for (const c of ledger.claims.filter(c => c.phase === 'done' || c.respawn !== undefined))
    for (const u of c.unretired ?? [])
      lines.push(
        `${c.taskId} (${c.initiative}) ${c.phase === 'done' ? 'done' : 'respawning'}, UNRETIRED ${u.name}: ${u.reason}`,
      )
  if (ledger.decider !== undefined) lines.push(deciderStatus(ledger.decider, now))
  return [...lines, ...poolStatusLines(pools, readings, now)]
}

function deciderStatus(state: DeciderState, now: Date): string {
  const lastDay = state.wakes.filter(w => now.getTime() - Date.parse(w) < 24 * 60 * 60_000).length
  const refused =
    state.refused === undefined ? '' : `; REFUSED at ${state.refused.at}: ${state.refused.reason}`
  return `decider: ${lastDay} wakes in the last day, last ${state.wakes.at(-1) ?? 'never'}${refused}`
}

/** Tasks that pass eligibility across opted-in initiatives, before budget and trust; the doctor line's `n`. */
export function eligibleCount(root = activeWorkRoot(), now = new Date()): number {
  const ledger = readLedger(burndownLedgerPath())
  const claimed = new Set(heldClaims(ledger).map(c => c.taskId))
  const held = backoffHeld(ledger, now)
  return readInitiatives(root)
    .filter(i => i.state === 'focused' && i.autonomy !== undefined)
    .flatMap(i => readTasks(root, i.slug).map(t => taskRefusal(t, i.autonomy?.grants ?? [], claimed, held)))
    .filter(refusal => refusal === undefined).length
}
