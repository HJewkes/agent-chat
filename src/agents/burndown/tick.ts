import { burndownConfigPath, burndownLedgerPath } from '../../paths.js'
import { activeWorkRoot } from '../active-work.js'
import { gateAccount } from './budget-gate.js'
import { taskRefusal, type Initiative } from './eligibility.js'
import { heldClaims, isStalled, readLedger, type Ledger } from './ledger.js'
import { plan, type Plan } from './plan.js'
import { accountDir, loadRules, readInitiatives, readReadings, readTasks } from './source.js'
import { trustRefusal } from './trust-gate.js'

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

export function planFromDisk(now = new Date(), root = activeWorkRoot()): Plan {
  const initiatives = readInitiatives(root)
  const rules = loadRules(burndownConfigPath())
  return plan({
    initiatives,
    tasks: new Map(initiatives.map(i => [i.slug, i.autonomy === undefined ? [] : readTasks(root, i.slug)])),
    ledger: readLedger(burndownLedgerPath()),
    rules,
    readings: readReadings([...new Set([...accountsOf(initiatives), ...Object.keys(rules)])], now.getTime()),
    // No human-presence signal exists yet, so the gate assumes the human is here: day rules, capped ceiling.
    gate: { now },
    trust: (cwd, account) => trustRefusal(cwd, accountDir(account)),
  })
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
  return lines
}

export function renderStatus(ledger: Ledger, now: Date): string[] {
  const rules = loadRules(burndownConfigPath())
  const readings = readReadings(Object.keys(rules), now.getTime())
  const held = heldClaims(ledger)
  const lines = [
    `ledger ${burndownLedgerPath()}: ${held.length} held, last tick ${ledger.lastTickAt ?? 'never'}`,
  ]
  for (const c of held)
    lines.push(
      `${c.taskId} (${c.initiative}) ${c.agentId} ${c.phase} since ${c.phaseAt}${isStalled(c, now) ? ' STALLED' : ''}`,
    )
  for (const account of Object.keys(rules)) {
    const gate = gateAccount(account, rules[account], readings.get(account), { now })
    lines.push(`account ${account}: ${gate.open ? 'open' : 'closed'}, ${gate.reason}`)
  }
  return lines
}

/** Tasks that pass eligibility across opted-in initiatives, before budget and trust; the doctor line's `n`. */
export function eligibleCount(root = activeWorkRoot()): number {
  const claimed = new Set(heldClaims(readLedger(burndownLedgerPath())).map(c => c.taskId))
  return readInitiatives(root)
    .filter(i => i.state === 'focused' && i.autonomy !== undefined)
    .flatMap(i => readTasks(root, i.slug).map(t => taskRefusal(t, i.autonomy?.grants ?? [], claimed)))
    .filter(refusal => refusal === undefined).length
}
