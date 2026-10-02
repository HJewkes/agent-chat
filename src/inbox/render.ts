import { ago } from '../cli/client.js'
import { CONTROL_MARK, visible } from '../endorse-command.js'
import type { BatchItem, Section } from './batch.js'

const LABEL: Record<Section, string> = {
  approval: 'APPR',
  question: 'ASK ',
  endorse: 'ENDR',
  decided: 'DCD ',
  notice: 'note',
}

const HEADING: Record<Section, string> = {
  approval: 'Permission prompts',
  question: 'Questions',
  endorse: 'Endorsements',
  decided: 'Decided for you, awaiting audit',
  notice: 'Notices',
}

export const USAGE = [
  '# Fill in the "N:" lines, then: agent-chat inbox --batch --answers <file>   (or --answers - for stdin)',
  '# A blank answer leaves the item open. Any malformed line and nothing is sent.',
  '#   question  N: <your answer>                 N: dismiss',
  '#   approval  N: allow | deny                  N: dismiss',
  '#   endorse   N: endorse | decline',
  '#   decided   N: accept | overrule <your answer>',
  '#   notice    N: dismiss',
  '# Unlock-table items are never prefilled: type the answer yourself.',
]

/**
 * Every line of agent-written text is indented, and the parser ignores indented
 * lines, so a question body cannot smuggle in an answer line for another item.
 */
const BREAKS = /\r\n|[\r\n\v\f\u2028\u2029]/
const indent = (text: string): string[] => text.split(BREAKS).map(line => `    ${line}`)
const oneLine = (text: string): string => text.split(BREAKS).join(' ')

function header(item: BatchItem): string {
  const kind = item.shape.kind ? `  (${item.shape.kind})` : ''
  const unlock = item.unlock ? `  unlock table: ${item.unlock}` : ''
  return `[${item.n}] ${LABEL[item.section]} ${oneLine(item.msgId)}  from ${oneLine(item.from)}  ${ago(item.at)}${kind}${unlock}`
}

/** An endorsement's text and recipient reach the terminal with every control character escaped (CC-419). */
function escapedEndorse(item: BatchItem): { text: string; details: string[] } {
  const text = visible(item.text)
  const details = item.details.map(detail => visible(detail))
  const escaped = text.escaped || details.some(d => d.escaped)
  return { text: text.text, details: [...(escaped ? [CONTROL_MARK] : []), ...details.map(d => d.text)] }
}

function body(item: BatchItem): string[] {
  const { task, options, recommended, onNoAnswer } = item.shape
  const lines = task ? indent(`doing: ${task}`) : []
  const { text, details } = item.section === 'endorse' ? escapedEndorse(item) : item
  lines.push(...indent(text))
  for (const detail of details) lines.push(...indent(detail))
  if (options) lines.push(...indent(`options: ${options.join(' | ')}`))
  if (recommended) {
    const own = item.unlock ? ' (unlock table, so not prefilled)' : ''
    lines.push(...indent(`recommended${own}: ${recommended}`))
  }
  if (onNoAnswer) lines.push(...indent(`on no answer: ${onNoAnswer}`))
  return lines
}

export function renderBatch(items: readonly BatchItem[], id: string): string[] {
  if (items.length === 0) return ['Nothing waiting.']
  const lines = [`# agent-chat inbox --batch: ${items.length} open`, `# batch: ${id}`, ...USAGE, '']
  let section: Section | undefined
  for (const item of items) {
    if (item.section !== section) {
      section = item.section
      const count = items.filter(i => i.section === section).length
      lines.push(`## ${HEADING[section]} (${count})`)
    }
    lines.push(header(item), ...body(item), `${item.n}: ${item.prefill ?? ''}`.trimEnd(), '')
  }
  return lines
}
