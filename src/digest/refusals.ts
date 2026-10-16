import type { Refusal, RefusalKind } from '../agents/burndown/eligibility.js'
import type { NamedItem } from './types.js'

/** CC-1007: the CC-974 refusals only the owner or a brief fix can clear, listed beside needs-grant. */

const OWNER_KINDS: readonly RefusalKind[] = ['needs-human', 'human-step', 'ops-unresolved']

const OPS_NONE_TAG = /ops:none=\S+/

/** A prose ops-unresolved reason ends with its tag; leading with it keeps it inside the digest's line cut. */
const detailOf = (r: Refusal): string => {
  const tag = r.kind === 'ops-unresolved' ? OPS_NONE_TAG.exec(r.reason)?.[0] : undefined
  return tag === undefined ? `[${r.kind}] ${r.reason}` : `[${r.kind}] tag ${tag} or split: ${r.reason}`
}

export const ownerRefusals = (refusals: readonly Refusal[]): NamedItem[] =>
  refusals
    .filter(r => OWNER_KINDS.includes(r.kind))
    .map(r => ({ label: `${r.initiative} ${r.task ?? ''}`.trim(), detail: detailOf(r) }))
