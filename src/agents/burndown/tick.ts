import { burndownConfigPath, burndownLedgerPath } from '../../paths.js'
import { activeWorkRoot } from '../active-work.js'
import { gateAccount } from './budget-gate.js'
import { classOf, routeOf, type RouteConfig } from './exception.js'
import { backoffHeld } from './backoff.js'
import { taskRefusal, type Initiative } from './eligibility.js'
import { heldClaims, isStalled, readLedger, type Claim, type DeciderState, type Ledger } from './ledger.js'
import type { Runner } from './exec.js'
import { memo, type Roster } from './observe.js'
import { downstreamReader, shepherdRows } from './shepherd.js'
import { plan, type Plan, type PlanInputs } from './plan.js'
import { diskSeatDeps, loadSeats, planSeats, type LoadedSeats, type SeatPlanDeps } from './seat-tick.js'
import { accountDir, loadRules, loadTickConfig, readInitiatives, readReadings, readTasks } from './source.js'
import { currentTriage } from './triage.js'
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

/** Everything `plan` reads off disk, which the tick also needs for briefs and the account gate. */
export type World = Omit<PlanInputs, 'ledger' | 'capacity' | 'orphan'>

export function loadWorld(now: Date, root: string): World {
  const initiatives = readInitiatives(root)
  const rules = loadRules(burndownConfigPath())
  const cliVersion = installedClaudeVersion()
  return {
    initiatives,
    tasks: new Map(initiatives.map(i => [i.slug, i.autonomy === undefined ? [] : readTasks(root, i.slug)])),
    rules,
    readings: readReadings([...new Set([...accountsOf(initiatives), ...Object.keys(rules)])], now.getTime()),
    // No human-presence signal exists yet, so the gate assumes the human is here: day rules, capped ceiling.
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
  /** Runs `titan-factory` and `git` for the downstream WIP read; defaults to the real runner. */
  exec?: Runner
}

/** The ledger, the seat as the tick loads it, and the planning deps the tick passes; shared by `plan --seat` and `seats compare`. */
export function seatPlanSetup(opts: SeatPlanOptions): {
  ledger: Ledger
  seats: LoadedSeats
  deps: SeatPlanDeps
} {
  const ledger = readLedger(burndownLedgerPath())
  const seats = loadSeats([opts.seat], ledger, diskSeatDeps(opts.autonomyRoot, opts.root, opts.now))
  const check = opts.collision?.(ledger)
  const cliVersion = installedClaudeVersion()
  const deps: SeatPlanDeps = {
    ledger,
    initiatives: readInitiatives(opts.root),
    trust: (repo, cwd, configDir) => trustRefusal(repo, cwd, configDir, cliVersion),
    downstream: downstreamReader(
      memo(() => shepherdRows(opts.exec)),
      opts.exec,
    ),
    ...(check === undefined ? {} : { collision: check }),
    ...(opts.roster === undefined ? {} : { roster: opts.roster }),
  }
  return { ledger, seats, deps }
}

/** `burndown plan --seat <name>`: one seat's dispatches as the tick would plan them, without the tick's live ceilings; with no roster it counts every held tree. */
export function seatPlanFromDisk(opts: SeatPlanOptions): Plan {
  const { seats, deps } = seatPlanSetup(opts)
  const planned = planSeats(seats.loaded, deps, opts.root)
  const [skipped] = [...seats.skipped, ...planned.skipped]
  if (skipped !== undefined) throw new Error(skipped.reason)
  return {
    dispatch: planned.dispatch,
    refusals: planned.refusals,
    notOptedIn: [],
    skippedTasks: planned.skippedTasks.flatMap(s => s.files),
  }
}

export function renderPlan(result: Plan, now: Date): string[] {
  const lines = [`burndown plan at ${now.toISOString()} (dry run: nothing spawned, nothing claimed)`]
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

/** A stall's class, the dial's route for it, and its triage job's outcome once one exists (CC-649). */
function stallSuffix(c: Claim, route: RouteConfig): string {
  if (c.stalledReason === undefined) return ''
  const cls = classOf(c)
  const triage = currentTriage(c)
  const job = triage === undefined ? '' : `, triage ${triage.name ?? '-'} ${triage.outcome}`
  return ` (class ${cls ?? 'none'}, route ${routeOf(cls, route, true).route}${job})`
}

export function renderStatus(ledger: Ledger, now: Date): string[] {
  const rules = loadRules(burndownConfigPath())
  const readings = readReadings(Object.keys(rules), now.getTime())
  const held = heldClaims(ledger)
  const { route } = loadTickConfig(burndownConfigPath()).exceptions
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
  for (const account of Object.keys(rules)) {
    const gate = gateAccount(account, rules[account], readings.get(account), { now })
    lines.push(`account ${account}: ${gate.open ? 'open' : 'closed'}, ${gate.reason}`)
  }
  return lines
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
