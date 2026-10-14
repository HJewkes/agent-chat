import { z } from 'zod'

/**
 * TP-1600 b: the seat's authored handoff block, an adapter in agent-chat because
 * `@titan-design/coordinator` 0.4.2 stores `authored` as a plain string. Shapes mirror
 * titan-platform#1511 (TP-2896 a) so the swap is a drop-in. Delete this file when TP-2897
 * swaps it for the published coordinator export.
 */

export const AUTHORED_MAX_CHARS = 1500
const NEXT_WHY_MAX_LINES = 5

export const authoredContinuationSchema = z.strictObject({
  on: z.enum(['agent', 'pr', 'msg', 'time']),
  ref: z.string().min(1),
  do: z.string().min(1),
})

export const standingRuleSchema = z.strictObject({
  text: z.string().min(1),
  source: z.string().min(1),
  expires: z.iso.date(),
})

export const openQuestionSchema = z.strictObject({
  to: z.string().min(1),
  msg_id: z.string().min(1),
  text: z.string().min(1),
})

type BlockShape = {
  continuations: unknown[]
  standing_rules: unknown[]
  open_questions: unknown[]
  next_why: string
}

// Empty sections are left out so the measured size never exceeds the text the author wrote.
function compactJson(block: BlockShape): string {
  const kept = Object.entries(block).filter(([, value]) => value.length > 0)
  return JSON.stringify(Object.fromEntries(kept))
}

export const authoredBlockSchema = z
  .strictObject({
    continuations: z.array(authoredContinuationSchema).default([]),
    standing_rules: z.array(standingRuleSchema).default([]),
    open_questions: z.array(openQuestionSchema).default([]),
    next_why: z
      .string()
      .default('')
      .refine(text => text.split('\n').length <= NEXT_WHY_MAX_LINES, {
        message: `next_why must be at most ${NEXT_WHY_MAX_LINES} lines`,
      }),
  })
  .superRefine((block, ctx) => {
    const size = compactJson(block).length
    if (size <= AUTHORED_MAX_CHARS) return
    ctx.addIssue({
      code: 'custom',
      message: `authored block is ${size} chars of JSON; the cap is ${AUTHORED_MAX_CHARS}`,
      params: { tooLong: true },
    })
  })

export type AuthoredContinuation = z.infer<typeof authoredContinuationSchema>
export type StandingRule = z.infer<typeof standingRuleSchema>
export type OpenQuestion = z.infer<typeof openQuestionSchema>
export type AuthoredBlock = z.infer<typeof authoredBlockSchema>
export type AuthoredError = {
  code: 'too-long' | 'invalid-json' | 'missing' | 'invalid'
  path: string
  message: string
}
export type AuthoredResult = { ok: true; block: AuthoredBlock } | { ok: false; errors: AuthoredError[] }

function valueAt(raw: unknown, path: readonly PropertyKey[]): unknown {
  let node = raw
  for (const key of path) {
    if (node === null || typeof node !== 'object') return undefined
    node = (node as Record<PropertyKey, unknown>)[key]
  }
  return node
}

function toError(raw: unknown, issue: z.core.$ZodIssue): AuthoredError {
  const path = issue.path.map(String).join('.')
  if (issue.code === 'custom' && issue.params?.tooLong) {
    return { code: 'too-long', path, message: issue.message }
  }
  const missing = issue.path.length > 0 && valueAt(raw, issue.path) === undefined
  return { code: missing ? 'missing' : 'invalid', path, message: issue.message }
}

function readJson(text: string): { ok: true; raw: unknown } | { ok: false; message: string } {
  try {
    return { ok: true, raw: JSON.parse(text) }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Validates the seat's authored block from its stored JSON text; never throws.
 * `""` is the cleared block and reads as empty.
 */
export function parseAuthored(text: string): AuthoredResult {
  if (text.length > AUTHORED_MAX_CHARS) {
    const message = `authored block is ${text.length} chars; the cap is ${AUTHORED_MAX_CHARS}`
    return { ok: false, errors: [{ code: 'too-long', path: '', message }] }
  }
  const json = text.trim() === '' ? { ok: true as const, raw: {} } : readJson(text)
  if (!json.ok) {
    return { ok: false, errors: [{ code: 'invalid-json', path: '', message: json.message }] }
  }
  const parsed = authoredBlockSchema.safeParse(json.raw)
  if (parsed.success) return { ok: true, block: parsed.data }
  return { ok: false, errors: parsed.error.issues.map(issue => toError(json.raw, issue)) }
}

function section(title: string, lines: string[]): string | null {
  return lines.length === 0 ? null : [title, ...lines].join('\n')
}

/**
 * Renders the block as plain-text sections, leaving out empty ones. A standing rule is in
 * force through its `expires` day and is dropped once `now`'s UTC day is past it.
 */
export function renderAuthored(block: AuthoredBlock, now: Date): string {
  const today = now.toISOString().slice(0, 10)
  const sections = [
    section(
      'Continuations:',
      block.continuations.map(c => `- on ${c.on} ${c.ref}: ${c.do}`),
    ),
    section(
      'Standing rules:',
      block.standing_rules
        .filter(rule => rule.expires >= today)
        .map(rule => `- ${rule.text} (source ${rule.source}, until ${rule.expires})`),
    ),
    section(
      'Open questions:',
      block.open_questions.map(q => `- to ${q.to} [${q.msg_id}]: ${q.text}`),
    ),
    section('Next/why:', block.next_why === '' ? [] : [block.next_why]),
  ]
  return sections.filter((s): s is string => s !== null).join('\n\n')
}
