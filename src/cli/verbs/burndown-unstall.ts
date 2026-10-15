import { burndownLedgerPath } from '../../paths.js'
import { readLedger, withLedgerLock, writeLedger, type Claim } from '../../agents/burndown/ledger.js'
import { outsideOwns } from '../../agents/burndown/owns-fence.js'
import { readSlices } from '../../agents/burndown/report.js'
import type { PlanReader } from '../../agents/burndown/seed-slices.js'
import type { Report } from '../command.js'

/**
 * CC-1141: a claim parked `outside-owns` holds the owns its plan had at seeding. Once the plan's owns are fixed,
 * unstall reloads them and clears the stall in place, so the claim keeps its PR, phase and agents and the next
 * tick hands the PR to Shepherd with the implementer as fixer. Unlike `release`, it retires nobody.
 */

export interface UnstallPorts {
  plan: PlanReader
  /** The files the worktree's branch changed against its base; undefined when git could not tell. */
  changedFiles: (cwd: string) => string[] | undefined
  /** CC-1232: the claim's PR files, read when the worktree is parked; undefined when GitHub could not tell. */
  prFiles?: (pr: string) => string[] | undefined
}

type Verdict = { refused: string } | { claim: Claim; owns: string[] }

const refusedReport = (message: string): Report => ({ ok: false, lines: [], errors: [message] })

export async function unstallSlice(task: string, slice: string, ports: UnstallPorts): Promise<Report> {
  const verdict = await rewriteHeld(
    task,
    slice,
    held => unstallVerdict(held, `${task} slice ${slice}`, ports),
    unstalled,
  )
  if ('refused' in verdict) return refusedReport(verdict.refused)
  return {
    ok: true,
    lines: [
      `unstalled ${task} slice ${slice} (${verdict.claim.phase}); owns now ${verdict.owns.join(', ')}`,
      'the next tick moves it on; nothing was retired',
    ],
  }
}

/**
 * CC-1276: reload a live slice's owns from its plan, when its branch fits them, without touching its phase, PR,
 * agents or stall. The agent's spawn-time broker file claim keeps the old patterns; the tick reads the ledger's.
 */
export async function reloadSliceOwns(task: string, slice: string, ports: UnstallPorts): Promise<Report> {
  const verdict = await rewriteHeld(
    task,
    slice,
    held => reloadVerdict(held, `${task} slice ${slice}`, ports),
    (claim, owns) => ({ ...claim, owns }),
  )
  if ('refused' in verdict) return refusedReport(verdict.refused)
  return {
    ok: true,
    lines: [
      `reloaded ${task} slice ${slice} (${verdict.claim.phase}); owns now ${verdict.owns.join(', ')}`,
      "the agent's broker file claim still shows its spawn-time owns; the tick reads the ledger's",
    ],
  }
}

/** Under the ledger lock, find the held claim, decide, and write the rewrite when the verdict allows it. */
async function rewriteHeld(
  task: string,
  slice: string,
  decide: (held: Claim | undefined) => Verdict,
  rewrite: (claim: Claim, owns: string[]) => Claim,
): Promise<Verdict> {
  const file = burndownLedgerPath()
  const locked = await withLedgerLock(file, (): Verdict => {
    const ledger = readLedger(file)
    const held = ledger.claims.find(c => c.taskId === task && c.slice === slice && c.phase !== 'done')
    const verdict = decide(held)
    if ('refused' in verdict) return verdict
    const next = rewrite(verdict.claim, verdict.owns)
    writeLedger(file, { ...ledger, claims: ledger.claims.map(c => (c === verdict.claim ? next : c)) })
    return verdict
  })
  return locked.ran
    ? locked.value
    : { refused: `a tick holds the ledger lock (pid ${locked.holder}); try again` }
}

function unstallVerdict(claim: Claim | undefined, what: string, ports: UnstallPorts): Verdict {
  if (claim === undefined) return { refused: `no held claim on ${what}` }
  if (claim.stallCode !== 'outside-owns')
    return { refused: `${what} is not stalled outside-owns (${claim.stallCode ?? 'not stalled'})` }
  return fitsPlan(claim, what, ports, 'unstall needs one of them, release instead')
}

function reloadVerdict(claim: Claim | undefined, what: string, ports: UnstallPorts): Verdict {
  if (claim === undefined) return { refused: `no held claim on ${what}` }
  if (claim.stallCode === 'outside-owns')
    return { refused: `${what} is stalled outside-owns; use unstall, which also clears the stall` }
  if (claim.phase === 'queued')
    return { refused: `${what} is queued; the tick already reloads a queued slice's owns from its plan` }
  return fitsPlan(claim, what, ports, 'reload-owns needs one of them')
}

/** The plan's owns for the claim, when every file its branch changed lies inside them. */
function fitsPlan(claim: Claim, what: string, ports: UnstallPorts, unreadable: string): Verdict {
  const owns = planOwns(claim, ports.plan)
  if (typeof owns === 'string') return { refused: `${what}: ${owns}` }
  const files = changedFilesOf(claim, ports)
  if (files === undefined)
    return { refused: `${what}: cannot read its worktree's or its PR's changes; ${unreadable}` }
  const outside = outsideOwns(files, owns)
  if (outside.length > 0)
    return { refused: `${what} still touches ${outside.join(', ')} outside the plan's owns` }
  return { claim, owns }
}

/** The worktree's changes, else the PR's when the worktree is parked; undefined when neither can be read. */
function changedFilesOf(claim: Claim, ports: UnstallPorts): string[] | undefined {
  const files = claim.worktree === undefined ? undefined : ports.changedFiles(claim.worktree)
  return files ?? (claim.pr === undefined ? undefined : ports.prFiles?.(claim.pr))
}

/** The slice's owns as its plan now has them, or why they cannot be read. */
function planOwns(claim: Claim, plan: PlanReader): string[] | string {
  const { path, text } = plan(claim.initiative, claim.taskId)
  if (text === undefined) return `no plan at ${path}`
  const read = readSlices(text)
  if (read.slices === undefined) return `plan unreadable: ${read.problems.join('; ')}`
  const planned = read.slices.find(s => s.n === claim.slice)
  return planned === undefined ? `slice ${claim.slice ?? '?'} is not in ${path}` : planned.owns
}

function unstalled(claim: Claim, owns: string[]): Claim {
  const {
    stalledReason: _reason,
    stalledClass: _class,
    stallCode: _code,
    stalledAt: _at,
    stale: _stale,
    ...kept
  } = claim
  return { ...kept, owns }
}
