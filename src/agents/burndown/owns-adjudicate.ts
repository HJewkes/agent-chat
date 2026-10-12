import { patternsOverlap } from '../../broker/claims.js'
import type { HeldOwns } from './collision.js'
import { isProtectedPath } from './pr-adopt.js'

/**
 * CC-1150 f, owner decision 269 D1: a PR that touches files outside its slice's owns amends the owns
 * and goes on to Shepherd when no outside file is (i) under another held claim's owns, (ii) in another
 * open PR or (iii) a protected path; the reviewer judges scope. Anything else escalates, naming the first
 * holder, PR or path. An open-PR list or file list that cannot be read escalates: a miss would let two
 * PRs edit one file unseen. Checks run cheapest first, so a protected or held file reads no PR files.
 */

export interface OtherPr {
  number: number
  /** Read only when checks (i) and (iii) pass; undefined when GitHub could not tell. */
  files: () => readonly string[] | undefined
}

export interface AdjudicateCtx {
  /** The other held claims' owns in the claim's repo. */
  held: readonly HeldOwns[]
  /** The repo's other open PRs, the claim's own excluded; undefined when the list could not be read. */
  openPrs: () => readonly OtherPr[] | undefined
}

export type Adjudication = { kind: 'amend'; files: string[] } | { kind: 'escalate'; reason: string }

export const UNREADABLE_PRS = 'could not read open PRs'

export function adjudicateOutside(outside: readonly string[], ctx: AdjudicateCtx): Adjudication {
  const reason = protectedOrHeld(outside, ctx.held) ?? inOpenPr(outside, ctx.openPrs())
  return reason === undefined ? { kind: 'amend', files: [...outside] } : { kind: 'escalate', reason }
}

function protectedOrHeld(outside: readonly string[], held: readonly HeldOwns[]): string | undefined {
  const guarded = outside.find(isProtectedPath)
  if (guarded !== undefined) return `${guarded} is a protected path`
  for (const file of outside) {
    const holder = held.find(h => h.owns.some(own => patternsOverlap(file, own)))
    if (holder !== undefined) return `${file} is under ${holder.holder}'s owns`
  }
  return undefined
}

function inOpenPr(outside: readonly string[], prs: readonly OtherPr[] | undefined): string | undefined {
  if (prs === undefined) return UNREADABLE_PRS
  for (const pr of prs) {
    const files = pr.files()
    if (files === undefined) return `${UNREADABLE_PRS} (no file list for #${pr.number})`
    const hit = outside.find(file => files.includes(file))
    if (hit !== undefined) return `#${pr.number} touches ${hit}`
  }
  return undefined
}
