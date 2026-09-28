import type { PermissionBehavior } from '../protocol.js'
import type { BatchItem, Section } from './batch.js'
import type { Snapshot } from './snapshot.js'

/** One answer, already bound to a msgId, in the vocabulary of the single-item verbs. */
export type Action =
  | { n: number; msgId: string; verb: 'answer'; text: string }
  | { n: number; msgId: string; verb: 'approve'; behavior: PermissionBehavior }
  | { n: number; msgId: string; verb: 'endorse' }
  | { n: number; msgId: string; verb: 'dismiss' }

export interface Parsed {
  actions: Action[]
  /** Non-empty means the caller must send nothing, not even the valid actions. */
  errors: string[]
}

type Verdict = Omit<Action, 'n' | 'msgId'>
type Interpret = (answer: string) => Verdict | string

const word = (answer: string): string => answer.trim().toLowerCase()

const INTERPRET: Record<Section, Interpret> = {
  question: a => (word(a) === 'dismiss' ? { verb: 'dismiss' } : { verb: 'answer', text: a }),
  approval: a => {
    const w = word(a)
    if (w === 'allow' || w === 'deny') return { verb: 'approve', behavior: w }
    return w === 'dismiss' ? { verb: 'dismiss' } : 'a permission prompt takes allow, deny or dismiss'
  },
  endorse: a => {
    const w = word(a)
    if (w === 'endorse') return { verb: 'endorse' }
    return w === 'decline' || w === 'dismiss'
      ? { verb: 'dismiss' }
      : 'an endorsement takes endorse or decline'
  },
  decided: a => {
    const w = word(a)
    if (w === 'accept' || w === 'dismiss') return { verb: 'dismiss' }
    const overrule = /^overrule\s+(\S[\s\S]*)$/i.exec(a.trim())
    return overrule
      ? { verb: 'answer', text: overrule[1]! }
      : 'a decided item takes accept or overrule <answer>'
  },
  notice: a => (word(a) === 'dismiss' ? { verb: 'dismiss' } : 'a notice takes no answer, only dismiss'),
}

const ANSWER_LINE = /^(\d+)\s*:\s?(.*)$/
const BATCH_LINE = /^#\s*batch:\s*(\S+)\s*$/

/** Lines the renderer writes that carry no answer: comments, item headers, indented bodies, blanks. */
const ignorable = (line: string): boolean => line.trim() === '' || /^[#[\s]/.test(line)

function stale(item: Snapshot['items'][number], current: ReadonlyMap<string, BatchItem>): string | undefined {
  const now = current.get(item.msgId)
  if (now === undefined) return `item ${item.n} (${item.msgId}) is no longer open`
  if (now.section !== item.section)
    return `item ${item.n} (${item.msgId}) moved from ${item.section} to ${now.section} since you read it`
  return undefined
}

function checkBatchId(input: string[], snapshot: Snapshot): string[] {
  const ids = input.map(line => BATCH_LINE.exec(line)?.[1]).filter((id): id is string => id !== undefined)
  return ids
    .filter(id => id !== snapshot.batch)
    .map(id => `this file is batch ${id}; the latest is ${snapshot.batch}`)
}

/**
 * Bind every `N: answer` line to the item N meant when the batch was printed.
 * Validation is all or nothing, so a typo can never shift an answer onto a
 * neighbouring item or leave half a batch applied.
 */
export function parseAnswers(input: string, snapshot: Snapshot, current: readonly BatchItem[]): Parsed {
  const lines = input.split(/\r?\n/)
  const errors = checkBatchId(lines, snapshot)
  const byNumber = new Map(snapshot.items.map(i => [i.n, i]))
  const byMsgId = new Map(current.map(i => [i.msgId, i]))
  const seen = new Set<number>()
  const actions: Action[] = []
  lines.forEach((line, index) => {
    if (ignorable(line)) return
    const at = `line ${index + 1}`
    const match = ANSWER_LINE.exec(line)
    if (!match) return void errors.push(`${at}: not an "N: answer" line: ${line}`)
    const n = Number(match[1])
    const answer = match[2]!.trim()
    const item = byNumber.get(n)
    if (item === undefined) return void errors.push(`${at}: there is no item ${n} in batch ${snapshot.batch}`)
    if (seen.has(n)) return void errors.push(`${at}: item ${n} is answered twice`)
    seen.add(n)
    if (answer === '') return
    const moved = stale(item, byMsgId)
    if (moved) return void errors.push(`${at}: ${moved}`)
    const verdict = INTERPRET[item.section](answer)
    if (typeof verdict === 'string') return void errors.push(`${at}: ${verdict}`)
    actions.push({ ...verdict, n, msgId: item.msgId } as Action)
  })
  return { actions, errors }
}
