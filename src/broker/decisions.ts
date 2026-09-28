import { DECISION_BASES, type DecidedRefusal, type DecisionCitation } from '../protocol.js'

/**
 * The broker's side of the decider's limits (autonomy design sections 3 and 5).
 *
 * The decider's prompt already says what it may decide. These checks exist so
 * that saying it is not the only thing standing between a decider and a
 * decision it must never make: the broker refuses, and the question stays in
 * the human's queue. Every refusal errs towards queueing. A false positive
 * costs the human one answer; a false negative is an unlock decided by a model.
 */

/** A decided question stays in the human's audit section this long. */
export const DECISION_AUDIT_MS = 24 * 60 * 60 * 1000

/**
 * Classes a decider may answer, in the vocabulary of active-work's
 * `precedent search` (`src/precedent/classify.ts`). Everything else is queued:
 * `merge_gate` and `release_publish` sit on the unlock table, `external_action`
 * needs a hand, `info_request` only the human knows, and `visual_taste` is taste.
 */
export const DECIDABLE_CLASSES: readonly string[] = [
  'session_control',
  'agent_ops',
  'tech_design',
  'scope_priority',
]

/**
 * The unlock table as text patterns, matched against the question and the
 * answer. Deliberately broad: "release" also matches "release the claim", and
 * that question goes to the human, which is the safe direction.
 */
const UNLOCK_TABLE: readonly [string, RegExp][] = [
  ['merge', /\bmerg(e|es|ed|ing)\b|\bsquash\b/i],
  ['publish or release', /\bpublish|\breleas(e|es|ed|ing)\b|\bnpm\b|\bchangeset|\btag push\b/i],
  ['deploy', /\bdeploy|\bwrangler\b|\blaunch(d|ctl)\b/i],
  [
    'money',
    /\b(pay|payment|purchase|buy|money|invoice|billing|subscription)\b|\bspend(ing)? (\$|money)|\b(place|submit) (an |the )?order\b|\$\d/i,
  ],
  [
    'external account',
    /\baccounts?\b|\boauth\b|\bpasskey|\botp\b|\b2fa\b|\bpassword|\bcredential|\bapi key|\blog ?in\b|\bsign ?in\b/i,
  ],
  [
    'deletion',
    /\bdelet(e|es|ed|ing|ion)\b|\brm -|\btrash|\bpurge|\bwipe|\bdestroy|--force\b|force-push|reset --hard/i,
  ],
  ['broker restart or cap lift', /\brestart|\bretire --force\b/i],
  [
    'publicity or sharing',
    /\bmake (it |this |the \w+ )?public\b|\bvisibility\b|\bshar(e|ing) (it |this )?with\b/i,
  ],
  ['third-party send', /\b(send|email|mail) (it |this )?to\b|\bcalendar invite/i],
  [
    'settings or policy edit',
    /claude\.md|settings(\.local)?\.json|~\/\.agent-chat|\b(edit|change|add|update)\b[^.?]*\b(hook|profile|permission)s?\b/i,
  ],
  ['permission prompt', /\bapprov(e|al)\b|\bendorse/i],
]

/** The unlock-table row a text touches, or undefined when it touches none. */
export function unlockTableRow(text: string): string | undefined {
  return UNLOCK_TABLE.find(([, pattern]) => pattern.test(text))?.[0]
}

export type DecisionCheck = { ok: true } | { ok: false; code: DecidedRefusal; reason: string }

/** Every citation field present and a basis the design names; the audit trail is the point. */
function citationProblem(citation: DecisionCitation): string | undefined {
  if (citation.precedent.trim() === '') return 'a decision must cite the precedent it rests on'
  if (citation.reversible.trim() === '') return 'a decision must say how to undo it'
  if (!(DECISION_BASES as readonly string[]).includes(citation.basis))
    return `basis must be one of ${DECISION_BASES.join(', ')}`
  return undefined
}

/**
 * Whether the broker may record this decision. Pure, so the whole policy is
 * testable without a socket. The question text comes from the stored row, never
 * from the frame, so a decider cannot launder an unlock by paraphrasing it.
 */
export function checkDecision(question: string, answer: string, citation: DecisionCitation): DecisionCheck {
  const missing = citationProblem(citation)
  if (missing !== undefined) return { ok: false, code: 'bad_citation', reason: missing }
  if (!DECIDABLE_CLASSES.includes(citation.class))
    return {
      ok: false,
      code: 'not_decidable',
      reason: `class "${citation.class}" is the human's to answer; decidable: ${DECIDABLE_CLASSES.join(', ')}`,
    }
  const row = unlockTableRow(question) ?? unlockTableRow(answer)
  if (row !== undefined)
    return {
      ok: false,
      code: 'unlock_table',
      reason: `this touches the unlock table (${row}); it stays queued for the human`,
    }
  return { ok: true }
}

/** The text an asker receives: the answer, then what it rests on and how to undo it. */
export function decidedText(answer: string, by: string, citation: DecisionCitation): string {
  return (
    `${answer}\n\n` +
    `[decided by ${by} on your human's behalf; class ${citation.class}, basis ${citation.basis}; ` +
    `precedent: ${citation.precedent}; to undo: ${citation.reversible}. ` +
    'Your human may overrule this. It is not authority for anything on the unlock table.]'
  )
}

/** The text an asker receives when the human overrules a decision, live and on replay alike. */
export function overruleText(
  answer: string,
  meta: { overrules?: string; overruled_decider?: string },
): string {
  return `${answer}\n\n[your human overruled ${meta.overruled_decider ?? 'the decider'}'s decision ${meta.overrules ?? ''}]`
}
