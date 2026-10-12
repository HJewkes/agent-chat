import { createHash } from 'node:crypto'
import { HARD_STOPS, type HardStopClass } from '@titan-design/coordinator'

/**
 * CC-974: the human ops a task or slice may declare, and the patterns that spot them in prose. Each
 * hard-stop pattern comes from coordinator HARD_STOPS (TP-1974 b). They run as a brief-time lint,
 * never as the dispatch decision.
 */

export const OPS = [
  'deploy',
  'restart',
  'config-edit',
  'publish',
  'spend',
  'force-push',
  'ruleset-write',
  'dotfiles-merge',
  'message',
  'personal-data',
] as const
export type Op = (typeof OPS)[number]

/** Ops a person does. `publish` is left out: the `release-through-ci` grant unlocks it. */
export const HUMAN_OPS: readonly Op[] = OPS.filter(op => op !== 'publish')

/** Every charter hard-stop class, each mapped to the op that declares it. */
export const HARD_STOP_OPS: Record<HardStopClass, Op> = {
  'broker-restart': 'restart',
  deploy: 'deploy',
  'launchd-install': 'deploy',
  'force-push': 'force-push',
  'config-edit': 'config-edit',
  'spend-money': 'spend',
  'npm-publish': 'publish',
  'ruleset-write': 'ruleset-write',
  'tag-move': 'publish',
  'dotfiles-merge': 'dotfiles-merge',
  'third-party-message': 'message',
  'personal-data': 'personal-data',
}

/** Patterns no hard-stop class carries, by the op they serve. */
const EXTRA_PATTERNS: Partial<Record<Op, RegExp[]>> = {
  // The release GRANTABLE lint: any publish, tag push or release cut, not only to npm.
  publish: [/\b(publish(es|ed|ing)?|tag push|cut a release)\b/i],
}

const classPatterns = (op: Op): RegExp[] =>
  HARD_STOPS.filter(stop => HARD_STOP_OPS[stop.name] === op).map(stop => stop.pattern)

export const OP_PATTERNS: Record<Op, RegExp[]> = Object.fromEntries(
  OPS.map(op => [op, [...classPatterns(op), ...(EXTRA_PATTERNS[op] ?? [])]]),
) as Record<Op, RegExp[]>

export interface OpsHit {
  op: Op
  text: string
}

const isOp = (value: string): value is Op => (OPS as readonly string[]).includes(value)

/** The 8 hex digits an `ops:none=<h>` tag carries; reflowing the text keeps it, editing a word does not. */
export function doneWhenHash(doneWhen: string): string {
  const collapsed = doneWhen.trim().replace(/\s+/g, ' ')
  return createHash('sha256').update(collapsed).digest('hex').slice(0, 8)
}

/** The tag that marks every hit in `doneWhen` as subject matter. */
export const opsNoneTag = (doneWhen: string): string => `ops:none=${doneWhenHash(doneWhen)}`

/** The ops a task declares through `ops:<op>` tags; unknown ops and `ops:none=` are not ops. */
export const declaredOps = (tags: readonly string[]): Op[] =>
  tags.flatMap(tag => {
    const op = tag.startsWith('ops:') ? tag.slice('ops:'.length) : ''
    return isOp(op) ? [op] : []
  })

/** Every distinct pattern match in `text`, by op in OPS order. */
export function opsHits(text: string): OpsHit[] {
  return OPS.flatMap(op => {
    const matches = OP_PATTERNS[op].flatMap(pattern =>
      [...text.matchAll(new RegExp(pattern.source, 'gi'))].map(m => m[0]),
    )
    return [...new Set(matches)].map(match => ({ op, text: match }))
  })
}

/** The hits in `doneWhen` that neither a declared op nor an `ops:none` tag for the current text resolves. */
export function opsLint(doneWhen: string, tags: readonly string[]): OpsHit[] {
  if (tags.includes(opsNoneTag(doneWhen))) return []
  const declared = new Set(declaredOps(tags))
  return opsHits(doneWhen).filter(hit => !declared.has(hit.op))
}

/** A task a person does: burndown routes it and never dispatches it. */
export const isHumanStep = (tags: readonly string[]): boolean =>
  tags.includes('kind:operator') || tags.includes('kind:owner')
