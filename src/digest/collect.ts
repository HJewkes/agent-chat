import path from 'node:path'
import { burndownConfigPath, burndownLedgerPath, home } from '../paths.js'
import { activeWorkRoot } from '../agents/active-work.js'
import { DEFAULT_RULES } from '../agents/burndown/budget-gate.js'
import { EMPTY_LEDGER, heldClaims, isStalled, readLedger, type Ledger } from '../agents/burndown/ledger.js'
import type { Plan } from '../agents/burndown/plan.js'
import { accountDir, loadRules } from '../agents/burndown/source.js'
import { planFromDisk } from '../agents/burndown/tick.js'
import { EMPTY_FACTS, readLedgerFacts } from './ledger.js'
import { lookupPrs, type Search } from './prs.js'
import { accountSpend } from './spend.js'
import { doneTasks } from './tasks.js'
import type { Digest, NamedItem } from './types.js'

/** Gathers every digest section from its read-only source; a source that fails becomes a gap line. */

export interface CollectOptions {
  now: number
  sinceMs: number
  /** Query GitHub for approved and merged PRs; off by default because the API is rate-limited. */
  prs: boolean
  search?: Search
  plan?: (now: Date) => Plan
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

function attempt<T>(gaps: string[], source: string, fallback: T, read: () => T): T {
  try {
    return read()
  } catch (err) {
    gaps.push(`${source}: ${message(err)}`)
    return fallback
  }
}

const eventsDbPath = (): string => path.join(home(), 'events.db')

const awaitingMerge = (ledger: Ledger): NamedItem[] =>
  heldClaims(ledger)
    .filter(c => c.phase === 'awaiting-merge')
    .map(c => ({
      label: c.taskId,
      detail: `${c.initiative}, ${c.agentId} awaiting merge since ${c.phaseAt}`,
    }))

export function collectDigest(options: CollectOptions): Digest {
  const { now, sinceMs } = options
  const gaps: string[] = []
  const ledger = attempt(gaps, 'events.db', EMPTY_FACTS, () => readLedgerFacts(eventsDbPath(), sinceMs, now))
  if (!ledger.available) gaps.push(`events.db: not found at ${eventsDbPath()}`)
  const claims = attempt(gaps, 'burndown ledger', EMPTY_LEDGER, () => readLedger(burndownLedgerPath()))
  const rules = attempt(gaps, 'burndown config', DEFAULT_RULES, () => loadRules(burndownConfigPath()))
  const planned = attempt<Plan | undefined>(gaps, 'burndown plan', undefined, () =>
    (options.plan ?? planFromDisk)(new Date(now)),
  )
  const prs = options.prs ? lookupPrs(sinceMs, options.search) : { readyToMerge: [], merged: [], gaps: [] }
  return {
    generatedAt: now,
    sinceMs,
    ledger,
    readyToMerge: [...awaitingMerge(claims), ...prs.readyToMerge],
    needsGrant: (planned?.refusals ?? [])
      .filter(r => r.kind === 'needs-grant')
      .map(r => ({ label: `${r.initiative} ${r.task ?? ''}`.trim(), detail: r.reason })),
    done: attempt(gaps, 'active-work tasks', [], () => doneTasks(activeWorkRoot(), sinceMs)),
    mergedPrs: prs.merged,
    stalled: heldClaims(claims).filter(c => isStalled(c, new Date(now))),
    spend: Object.keys(rules).map(account => accountSpend(account, accountDir(account), sinceMs, now)),
    next: {
      picks: planned?.dispatch ?? [],
      refused: planned?.refusals.length ?? 0,
      notOptedIn: planned?.notOptedIn.length ?? 0,
      ...(planned === undefined ? { error: 'the burndown planner did not run; see gaps' } : {}),
    },
    gaps: [...gaps, ...prs.gaps],
  }
}
