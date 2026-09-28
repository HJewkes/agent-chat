import { QUEUE_ITEM_KINDS, type ItemShape, type QueueItemKind } from '../protocol.js'

/** Long enough for a sentence of context, short enough that one field cannot bury the queue. */
const MAX_FIELD = 500
const MAX_OPTIONS = 8

const isKind = (value: unknown): value is QueueItemKind =>
  typeof value === 'string' && (QUEUE_ITEM_KINDS as readonly string[]).includes(value)

const clean = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, MAX_FIELD) : undefined

/**
 * The item shape as `meta` entries. Frames are not schema-checked on the socket,
 * so this is the broker's only filter: a closed set of keys, strings only, and
 * an unknown kind dropped rather than stored.
 */
export function shapeMeta(frame: ItemShape): Record<string, string> {
  const meta: Record<string, string> = {}
  if (isKind(frame.kind)) meta.kind = frame.kind
  const task = clean(frame.task)
  if (task) meta.task = task
  const recommended = clean(frame.recommended)
  if (recommended) meta.recommended = recommended
  const onNoAnswer = clean(frame.onNoAnswer)
  if (onNoAnswer) meta.on_no_answer = onNoAnswer
  const options = Array.isArray(frame.options)
    ? frame.options.map(clean).filter((o): o is string => o !== undefined)
    : []
  if (options.length > 0) meta.options = JSON.stringify(options.slice(0, MAX_OPTIONS))
  return meta
}

function readOptions(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((o): o is string => typeof o === 'string') : undefined
  } catch {
    return undefined
  }
}

/** The inverse of {@link shapeMeta}, tolerant of rows written before the shape existed. */
export function readShape(meta: Record<string, string>): ItemShape {
  const options = readOptions(meta.options)
  return {
    ...(isKind(meta.kind) ? { kind: meta.kind } : {}),
    ...(meta.task ? { task: meta.task } : {}),
    ...(options && options.length > 0 ? { options } : {}),
    ...(meta.recommended ? { recommended: meta.recommended } : {}),
    ...(meta.on_no_answer ? { onNoAnswer: meta.on_no_answer } : {}),
  }
}
