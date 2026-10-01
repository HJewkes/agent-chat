import { createHash } from 'node:crypto'
import { unlockTableRow } from '../broker/decisions.js'
import type { DecidedItem, ItemShape, QueueItem, ServerMessage } from '../protocol.js'
import { readShape } from './item-shape.js'

/** What the human can do with an item decides its section; the verbs differ per section. */
export type Section = 'approval' | 'question' | 'endorse' | 'decided' | 'notice'

export const SECTION_ORDER: readonly Section[] = ['approval', 'question', 'endorse', 'decided', 'notice']

export interface BatchItem {
  n: number
  msgId: string
  section: Section
  from: string
  at: number
  text: string
  shape: ItemShape
  /** Lines shown under the text: the command preview, the recipient, the decision under audit. */
  details: string[]
  /** An endorsement's recipient, which approving it restates (CC-418). */
  recipient?: string
  /** The unlock-table row this item touches; such an item is never prefilled. */
  unlock?: string
  /** The answer line's starting value, which feeding the file back unedited sends. */
  prefill?: string
}

type Unnumbered = Omit<BatchItem, 'n'>

const SECTION_OF: Partial<Record<QueueItem['kind'], Section>> = {
  approval_request: 'approval',
  question: 'question',
  endorse_request: 'endorse',
  notice: 'notice',
  message: 'notice',
}

/** Words that mean something other than free text on an answer line, so never a prefill. */
const RESERVED = new Set(['dismiss', 'allow', 'deny', 'endorse', 'decline', 'accept'])

function unlockOf(section: Section, text: string, shape: ItemShape): string | undefined {
  if (section === 'approval') return 'permission prompt'
  if (section === 'endorse') return 'endorsement'
  if (shape.kind === 'ready-to-merge') return 'merge'
  return unlockTableRow([text, shape.recommended ?? '', ...(shape.options ?? [])].join('\n'))
}

function prefillOf(item: Unnumbered): string | undefined {
  const recommended = item.shape.recommended
  if (item.section !== 'question' || item.unlock !== undefined || recommended === undefined) return undefined
  if (/[\r\n]/.test(recommended) || RESERVED.has(recommended.trim().toLowerCase())) return undefined
  return recommended
}

function detailsOf(item: QueueItem): string[] {
  const details: string[] = []
  if (item.kind === 'endorse_request') {
    details.push(`would be delivered to ${item.meta.recipient} as ${item.from}, with your authority`)
    if (item.meta.recipient_durable === 'false')
      details.push(`warning: "${item.meta.recipient}" has no durable identity; anyone could hold that name`)
  }
  if (item.meta.input_preview) details.push(item.meta.input_preview)
  return details
}

function fromQueue(item: QueueItem): Unnumbered | undefined {
  const section = SECTION_OF[item.kind]
  if (section === undefined) return undefined
  const shape = readShape(item.meta)
  const unlock = unlockOf(section, item.text, shape)
  const base = { msgId: item.msgId, section, from: item.from, at: item.at, text: item.text, shape }
  const recipient = item.kind === 'endorse_request' ? item.meta.recipient : undefined
  const withUnlock = {
    ...base,
    details: detailsOf(item),
    ...(recipient === undefined ? {} : { recipient }),
    ...(unlock === undefined ? {} : { unlock }),
  }
  const prefill = prefillOf(withUnlock)
  return prefill === undefined ? withUnlock : { ...withUnlock, prefill }
}

function fromDecided({ question, decision }: DecidedItem): Unnumbered {
  const shape = readShape(question.meta)
  const unlock = unlockTableRow(`${question.text}\n${decision.text}`)
  return {
    msgId: question.msgId,
    section: 'decided',
    from: question.from,
    at: decision.at,
    text: question.text,
    shape,
    details: [
      `decided by ${decision.by}: ${decision.text}`,
      `cites (${decision.class}, ${decision.basis}): ${decision.precedent}`,
      `to undo: ${decision.reversible}`,
    ],
    ...(unlock === undefined ? {} : { unlock }),
  }
}

const rank = (item: Unnumbered): [number, string, number] => [
  SECTION_ORDER.indexOf(item.section),
  item.shape.kind ?? '',
  item.at,
]

function compare(a: Unnumbered, b: Unnumbered): number {
  const [sa, ka, ta] = rank(a)
  const [sb, kb, tb] = rank(b)
  return sa - sb || ka.localeCompare(kb) || ta - tb
}

/** Every open item, grouped by section then kind, oldest first, numbered from 1. */
export function buildBatch(res: Extract<ServerMessage, { t: 'queue_result' }>): BatchItem[] {
  const open = res.items.map(fromQueue).filter((i): i is Unnumbered => i !== undefined)
  const decided = (res.decided ?? []).map(fromDecided)
  return [...open, ...decided].sort(compare).map((item, index) => ({ ...item, n: index + 1 }))
}

/** Same items in the same order give the same id, so printing twice does not strand a file. */
export function batchId(items: readonly Pick<BatchItem, 'n' | 'msgId' | 'section'>[]): string {
  const key = items.map(i => `${i.n}:${i.msgId}:${i.section}`).join('\n')
  return createHash('sha256').update(key).digest('hex').slice(0, 12)
}
