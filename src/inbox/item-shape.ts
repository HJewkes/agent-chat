import {
  ASK_BLOCKING,
  ASK_DOORS,
  QUEUE_ITEM_KINDS,
  type AskBlocking,
  type AskDoor,
  type ItemShape,
  type QueueItemKind,
} from '../protocol.js'

/** Long enough for a sentence of context, short enough that one field cannot bury the queue. */
const MAX_FIELD = 500
const MAX_OPTIONS = 8
const MAX_HEADER = 80
const MAX_CATEGORY = 40

const oneOf =
  <T extends string>(values: readonly T[]) =>
  (value: unknown): value is T =>
    typeof value === 'string' && (values as readonly string[]).includes(value)

const isKind = oneOf<QueueItemKind>(QUEUE_ITEM_KINDS)
const isDoor = oneOf<AskDoor>(ASK_DOORS)
const isBlocking = oneOf<AskBlocking>(ASK_BLOCKING)

const clean = (value: unknown, max = MAX_FIELD): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, max) : undefined

/** Labels and their descriptions zipped before blank labels are dropped, so the two stay aligned. */
function optionPairs(frame: ItemShape): Array<[string, string]> {
  if (!Array.isArray(frame.options)) return []
  const descriptions = Array.isArray(frame.optionDescriptions) ? frame.optionDescriptions : []
  return frame.options
    .map((option, i): [string | undefined, string] => [clean(option), clean(descriptions[i]) ?? ''])
    .filter((pair): pair is [string, string] => pair[0] !== undefined)
    .slice(0, MAX_OPTIONS)
}

function optionMeta(frame: ItemShape): Record<string, string> {
  const pairs = optionPairs(frame)
  if (pairs.length === 0) return {}
  const labels = pairs.map(([label]) => label)
  const descriptions = pairs.map(([, description]) => description)
  const fallback = clean(frame.default)
  return {
    options: JSON.stringify(labels),
    ...(descriptions.some(d => d !== '') ? { option_descriptions: JSON.stringify(descriptions) } : {}),
    ...(fallback && labels.includes(fallback) ? { default: fallback } : {}),
  }
}

/** The free-text fields, each written under its meta key when non-blank. */
function textMeta(frame: ItemShape): Record<string, string> {
  const fields: Array<[string, string | undefined]> = [
    ['task', clean(frame.task)],
    ['recommended', clean(frame.recommended)],
    ['on_no_answer', clean(frame.onNoAnswer)],
    ['header', clean(frame.header, MAX_HEADER)],
    ['category', clean(frame.category, MAX_CATEGORY)],
    ['initiative', clean(frame.initiative)],
    ['reversible', clean(frame.reversible)],
  ]
  return Object.fromEntries(fields.filter((f): f is [string, string] => f[1] !== undefined))
}

/**
 * The item shape as `meta` entries. Frames are not schema-checked on the socket,
 * so this is the broker's only filter: a closed set of keys, strings only, and
 * an unknown kind, door or blocking value dropped rather than stored.
 */
export function shapeMeta(frame: ItemShape): Record<string, string> {
  return {
    ...(isKind(frame.kind) ? { kind: frame.kind } : {}),
    ...textMeta(frame),
    ...optionMeta(frame),
    ...(isDoor(frame.door) ? { door: frame.door } : {}),
    ...(isBlocking(frame.blocking) ? { blocking: frame.blocking } : {}),
  }
}

function readStrings(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((o): o is string => typeof o === 'string') : undefined
  } catch {
    return undefined
  }
}

function readOptions(meta: Record<string, string>): Pick<ItemShape, 'options' | 'optionDescriptions'> {
  const options = readStrings(meta.options)
  if (!options || options.length === 0) return {}
  const descriptions = readStrings(meta.option_descriptions)
  return {
    options,
    ...(descriptions?.length === options.length ? { optionDescriptions: descriptions } : {}),
  }
}

/** The inverse of {@link shapeMeta}, tolerant of rows written before the shape existed. */
export function readShape(meta: Record<string, string>): ItemShape {
  return {
    ...(isKind(meta.kind) ? { kind: meta.kind } : {}),
    ...(meta.task ? { task: meta.task } : {}),
    ...readOptions(meta),
    ...(meta.recommended ? { recommended: meta.recommended } : {}),
    ...(meta.on_no_answer ? { onNoAnswer: meta.on_no_answer } : {}),
    ...(meta.header ? { header: meta.header } : {}),
    ...(isDoor(meta.door) ? { door: meta.door } : {}),
    ...(meta.default ? { default: meta.default } : {}),
    ...(meta.category ? { category: meta.category } : {}),
    ...(meta.initiative ? { initiative: meta.initiative } : {}),
    ...(isBlocking(meta.blocking) ? { blocking: meta.blocking } : {}),
    ...(meta.reversible ? { reversible: meta.reversible } : {}),
  }
}
