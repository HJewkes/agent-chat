import { runGit, type GitRunner } from '../../git.js'
import type { TranscriptWork } from '../transcript-work.js'

/**
 * CC-645: what a retired run produced and why it stopped, for the broker's retire row.
 *
 * The idea of a closed failure class and a git head captured beside the receipt follows
 * vnx-orchestration's receipt schema (MIT, Copyright (c) Vincent van Deth); nothing is copied.
 * Pure but for `branchHead`, which reads a local ref and never the network.
 */

/** Why a run ended, as far as its report and transcript tell apart. Closed: anything else is `unknown`. */
export const FAILURE_CLASSES = [
  /** Reported DONE or DONE_WITH_CONCERNS, or a reviewer's Verdict of any kind. */
  'none',
  /** Reported BLOCKED, with no permission denial in the transcript. */
  'blocked',
  /** Reported NEEDS_CONTEXT. */
  'needs-context',
  /** Reported BLOCKED, or sent no report, after the permission layer refused a tool call. */
  'tool-denied',
  /** Sent no report, and the session's last API refusal was a usage limit. */
  'rate-limited',
  /** Sent no report, and the API refused the prompt as too long. */
  'context-exhausted',
  /** Sent no report, and the API refused a request for another reason. */
  'api-error',
  /** Sent no report, with nothing in the transcript to say why. */
  'no-report',
  /** The transcript was not read, or the report's Status is not one the return contract names. */
  'unknown',
] as const
export type FailureClass = (typeof FAILURE_CLASSES)[number]

/** Each field is null only when nothing the broker holds says what it was. */
export interface RetireOutcome {
  /** `owner/repo#n` from the report's `PR:` line: the PR the agent reported on, which for a reviewer is the PR it reviewed. */
  pr: string | null
  /** From the report's `Head:` line, else the run's worktree branch. */
  head: string | null
  failure_class: FailureClass
  tool_errors: number | null
}

/** A retire with nothing read: what a caller that holds no transcript or worktree passes. */
export const UNREAD_OUTCOME: RetireOutcome = {
  pr: null,
  head: null,
  failure_class: 'unknown',
  tool_errors: null,
}

const LEAD = String.raw`^[\s*_\x60>#-]*`
const KEY_END = String.raw`[*_\x60]*\s*:[\s*_\x60]*`
const lineOf = (key: string, value: string, flags = 'im'): RegExp =>
  new RegExp(`${LEAD}${key}${KEY_END}${value}`, flags)

/** Matched on the opening line only, so a later `Verdict:` or `Status:` line never overrides it. */
const STATUS = lineOf('status', '([A-Za-z_]+)', 'i')
const VERDICT = lineOf('verdict', '', 'i')
const PR_LINE = lineOf('pr', String.raw`(\S+)`)
const HEAD_LINE = lineOf('head', String.raw`([0-9a-f]{40})\b`)
const PR_REF = /^([\w.-]+\/[\w.-]+)#(\d+)$/
const PR_URL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\b/
const SHA = /^[0-9a-f]{40}$/

/** `PR:` as `owner/repo#n`; a GitHub pull URL is rewritten to that form, and anything else is not a PR. */
export function reportPr(report: string): string | null {
  const value = PR_LINE.exec(report)?.[1]?.replace(/[*_`.,;)]+$/, '')
  if (value === undefined) return null
  const ref = PR_REF.exec(value) ?? PR_URL.exec(value)
  return ref === null ? null : `${ref[1]}#${ref[2]}`
}

export const reportHead = (report: string): string | null => HEAD_LINE.exec(report)?.[1] ?? null

export function failureClassOf(work: TranscriptWork | undefined): FailureClass {
  if (work === undefined) return 'unknown'
  if (work.report === null) return work.api_stop ?? (work.denied ? 'tool-denied' : 'no-report')
  const opening = work.report.trimStart().split('\n')[0] ?? ''
  if (VERDICT.test(opening)) return 'none'
  switch (STATUS.exec(opening)?.[1]?.toUpperCase()) {
    case 'DONE':
    case 'DONE_WITH_CONCERNS':
      return 'none'
    case 'BLOCKED':
      return work.denied ? 'tool-denied' : 'blocked'
    case 'NEEDS_CONTEXT':
      return 'needs-context'
    default:
      return 'unknown'
  }
}

/** `work` is undefined when the transcript read missed; `fallbackHead` runs only when the report names no head. */
export async function retireOutcomeOf(
  work: TranscriptWork | undefined,
  fallbackHead: () => Promise<string | null>,
): Promise<RetireOutcome> {
  const report = work?.report ?? null
  const reported = report === null ? null : reportHead(report)
  return {
    pr: report === null ? null : reportPr(report),
    head: reported ?? (await fallbackHead()),
    failure_class: failureClassOf(work),
    tool_errors: work?.tool_errors ?? null,
  }
}

/** The local head of a run's worktree branch, or null when it has none or the ref is gone. */
export async function branchHead(
  tree: { gitRoot: string; branch: string } | undefined,
  git: GitRunner = runGit,
): Promise<string | null> {
  if (tree === undefined) return null
  const sha = await git(
    ['rev-parse', '--verify', '--quiet', `refs/heads/${tree.branch}^{commit}`],
    tree.gitRoot,
  )
  return sha !== null && SHA.test(sha) ? sha : null
}
