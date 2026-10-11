import { createHash } from 'node:crypto'

/**
 * CC-974: the human ops a task or slice may declare, and the one copy of the patterns that spot
 * them in prose. The patterns are the union of eligibility's HUMAN_ONLY and score's
 * HARD_STOP_PATTERNS, moved verbatim. They run as a brief-time lint, never as the dispatch decision.
 */

export const OPS = [
  'deploy',
  'restart',
  'config-edit',
  'publish',
  'spend',
  'force-push',
  'ruleset-write',
] as const
export type Op = (typeof OPS)[number]

/** Ops a person does. `publish` is left out: the `release-through-ci` grant unlocks it. */
export const HUMAN_OPS: readonly Op[] = OPS.filter(op => op !== 'publish')

export const OP_PATTERNS: Record<Op, RegExp[]> = {
  deploy: [
    /\bdeploy(s|ed|ing)?\b|\bwrangler\b|launchd install/i,
    /\bdeploy(s|ed|ing)?\b|\bwrangler\b/i,
    /launchd install|burndown install/i,
  ],
  restart: [/\brestart(s|ed|ing)? (the )?broker\b|\bbroker restart\b|restart window/i],
  'config-edit': [/CLAUDE\.md|settings\.json|~\/\.agent-chat\//i],
  publish: [
    /\bnpm publish|first publish|publish(es|ed)? to npm|version packages/i,
    /\bmove (the )?v1\b|cut a (release )?tag|tag push/i,
  ],
  spend: [/\b(purchase|pay for|spend money)\b/i, /\b(purchase|pay for|spend money|submit (the )?order)\b/i],
  'force-push': [/force-push|reset --hard/i],
  'ruleset-write': [/ruleset|branch protection/i],
}

/** The charter's hard-stop names, each mapped to the op that declares it. */
export const HARD_STOP_OPS: Record<string, Op> = {
  'broker-restart': 'restart',
  deploy: 'deploy',
  'launchd-install': 'deploy',
  'force-push': 'force-push',
  'config-edit': 'config-edit',
  'spend-money': 'spend',
  'npm-publish': 'publish',
  'ruleset-write': 'ruleset-write',
  'tag-move': 'publish',
}

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
