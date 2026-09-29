import fs from 'node:fs'

/**
 * CC-266 and CC-255: what a headless agent was doing when it exited without the
 * return-contract report, read from the tail of its transcript.
 *
 * The broker decides WHETHER it reported from its own log; this module only
 * names the last action, for the spawner's notice and the digest. Its output
 * leaves the machine's private context, so a command becomes a short pattern
 * (`Bash(gh pr create)`) and never the command line, which can hold paths.
 */

/** The final turn fits well inside this; a megabyte transcript is never read whole. */
export const EXIT_TAIL_BYTES = 256 * 1024

export const UNKNOWN_ACTION = 'unknown'
export const NO_TOOL_CALL = 'no tool call'

/** The `meta.event` on the notice row, and what the digest groups by. */
export const UNREPORTED_EXIT = 'unreported-exit'

export interface ExitTail {
  lastAction: string
  pendingBackground: boolean
}

const UNREAD: ExitTail = { lastAction: UNKNOWN_ACTION, pendingBackground: false }

const BACKGROUND_STARTED = /Command running in background with ID:?\s*([A-Za-z0-9_-]+)/
const BACKGROUND_ENDED = /<task-notification>|\b(completed|exited|killed|failed)\b/i
/** A plain CLI word: a command, subcommand or verb, never a path, flag or value. */
const WORD = /^[a-z][a-z0-9_-]*$/i
const MAX_WORDS = 3
const MAX_PATTERN = 60

type Block = Record<string, unknown>

const isRecord = (value: unknown): value is Block => typeof value === 'object' && value !== null

/** Never throws: a missing, unreadable or garbled transcript reads as `unknown`. */
export function readExitTail(file: string | undefined, maxBytes = EXIT_TAIL_BYTES): ExitTail {
  if (file === undefined) return UNREAD
  try {
    return exitTailOf(readTail(file, maxBytes))
  } catch {
    return UNREAD
  }
}

function readTail(file: string, maxBytes: number): string {
  const fd = fs.openSync(file, 'r')
  try {
    const size = fs.fstatSync(fd).size
    const length = Math.min(size, maxBytes)
    const buffer = Buffer.alloc(length)
    fs.readSync(fd, buffer, 0, length, size - length)
    const text = buffer.toString('utf8')
    // A cut read starts mid-record; the first line is a fragment.
    return length < size ? text.slice(text.indexOf('\n') + 1) : text
  } finally {
    fs.closeSync(fd)
  }
}

interface Scan {
  lastTool?: Block
  /** Background task ids started and not yet seen to end. */
  started: Set<string>
}

/** Pure: the last main-thread tool call and whether background work was still pending. */
export function exitTailOf(text: string): ExitTail {
  const scan: Scan = { started: new Set() }
  for (const line of text.split('\n')) scanLine(scan, line)
  if (scan.lastTool === undefined) return { lastAction: NO_TOOL_CALL, pendingBackground: scan.started.size > 0 }
  const lastAction = actionPattern(scan.lastTool)
  return { lastAction, pendingBackground: scan.started.size > 0 || lastAction === 'ScheduleWakeup' }
}

function scanLine(scan: Scan, line: string): void {
  if (line.trim() === '') return
  for (const id of scan.started) if (line.includes(id) && BACKGROUND_ENDED.test(line)) scan.started.delete(id)
  let record: unknown
  try {
    record = JSON.parse(line)
  } catch {
    return
  }
  if (!isRecord(record) || record.isSidechain === true) return
  const content = isRecord(record.message) ? record.message.content : undefined
  if (!Array.isArray(content)) return
  for (const block of content) scanBlock(scan, block)
}

function scanBlock(scan: Scan, block: unknown): void {
  if (!isRecord(block)) return
  if (block.type === 'tool_use') scan.lastTool = block
  if (block.type !== 'tool_result') return
  const started = BACKGROUND_STARTED.exec(textOf(block.content))
  if (started?.[1] !== undefined) scan.started.add(started[1])
}

const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(part => (isRecord(part) && typeof part.text === 'string' ? part.text : '')).join(' ')
}

/** `mcp__plugin_x__chat_send` reads as `chat_send`; Bash keeps only its leading plain words. */
export function actionPattern(toolUse: Block): string {
  const pattern = rawPattern(toolUse)
  return pattern.length > MAX_PATTERN ? `${pattern.slice(0, MAX_PATTERN - 3)}...` : pattern
}

function rawPattern(toolUse: Block): string {
  const name = typeof toolUse.name === 'string' ? toolUse.name : UNKNOWN_ACTION
  if (name !== 'Bash') return name.split('__').at(-1) || UNKNOWN_ACTION
  const input = isRecord(toolUse.input) ? toolUse.input : {}
  if (input.run_in_background === true) return 'Bash(run_in_background)'
  const words = commandWords(typeof input.command === 'string' ? input.command : '')
  return words.length === 0 ? 'Bash' : `Bash(${words.join(' ')})`
}

/** The first segment that is not a `cd`, cut at the first token that is not a plain word. */
function commandWords(command: string): string[] {
  const segments = command.split(/&&|\|\||;|\|/).map(s => s.trim().split(/\s+/).filter(Boolean))
  const tokens = segments.find(s => s.length > 0 && s[0] !== 'cd') ?? []
  const words: string[] = []
  for (const [i, token] of tokens.entries()) {
    const word = i === 0 ? (token.split('/').at(-1) ?? '') : token
    if (!WORD.test(word) || words.length === MAX_WORDS) break
    words.push(word)
  }
  return words
}

const MAX_NAME = 64

/** The spawner's notice: a clipped name and a bounded pattern, so it stays under 300 characters. */
export function unreportedExitText(name: string, tail: ExitTail): string {
  const who = name.length > MAX_NAME ? `${name.slice(0, MAX_NAME - 3)}...` : name
  const what = tail.pendingBackground
    ? 'exited with a pending background task, no final report (no Status report)'
    : 'exited with no Status report'
  return `${who} ${what}; last action: ${tail.lastAction}`
}
