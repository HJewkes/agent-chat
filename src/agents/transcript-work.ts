import { isReport } from '../broker/event-log.js'

/**
 * What a session did besides spend, gathered in the spend read's one pass over the transcript (CC-645).
 *
 * The retire row says what an agent produced and why it stopped; this collects the transcript's half of
 * that: the last return-contract report it sent, its tool errors, and how Claude Code ended it.
 */

/** Claude Code's own reply when the API refused a request, written as a synthetic assistant row. */
export type ApiStop = 'rate-limited' | 'context-exhausted' | 'api-error'

export interface TranscriptWork {
  /** `tool_result` blocks with `is_error: true`, permission denials included. */
  tool_errors: number
  /** A tool call the permission layer refused: a row carrying `toolDenialKind` (see `denials.ts`). */
  denied: boolean
  /** The last API refusal in the session, or null when there was none. */
  api_stop: ApiStop | null
  /** The text of the last `chat_send` that opens as a return-contract report. */
  report: string | null
}

export interface WorkObserver {
  observe: (line: string) => void
  work: () => TranscriptWork
}

/** Most lines are tool output; only these markers make a line worth parsing for work. */
const MARKERS = ['"is_error":true', 'toolDenialKind', 'isApiErrorMessage', 'chat_send']

export function workObserver(): WorkObserver {
  const work: TranscriptWork = { tool_errors: 0, denied: false, api_stop: null, report: null }
  return {
    observe: line => {
      if (!MARKERS.some(marker => line.includes(marker))) return
      const row = parseRow(line)
      if (row !== undefined) observeRow(work, row)
    },
    work: () => ({ ...work }),
  }
}

function observeRow(work: TranscriptWork, row: Record<string, unknown>): void {
  if (typeof row.toolDenialKind === 'string') work.denied = true
  if (row.isApiErrorMessage === true) work.api_stop = apiStopOf(row)
  for (const block of contentOf(row)) {
    if (block.type === 'tool_result' && block.is_error === true) work.tool_errors++
    const report = reportOf(block)
    if (report !== undefined) work.report = report
  }
}

function apiStopOf(row: Record<string, unknown>): ApiStop {
  if (row.error === 'rate_limit') return 'rate-limited'
  const said = contentOf(row).map(block => (typeof block.text === 'string' ? block.text : ''))
  return said.some(text => /prompt is too long/i.test(text)) ? 'context-exhausted' : 'api-error'
}

/** The tool is named `mcp__<server>__chat_send`, its server prefix depending on how the plugin is installed. */
function reportOf(block: Record<string, unknown>): string | undefined {
  if (block.type !== 'tool_use' || typeof block.name !== 'string' || !block.name.endsWith('chat_send')) {
    return undefined
  }
  const text = isRecord(block.input) ? block.input.text : undefined
  return typeof text === 'string' && isReport(text) ? text : undefined
}

function contentOf(row: Record<string, unknown>): Record<string, unknown>[] {
  const content = isRecord(row.message) ? row.message.content : undefined
  return Array.isArray(content) ? content.filter(isRecord) : []
}

function parseRow(line: string): Record<string, unknown> | undefined {
  try {
    const doc: unknown = JSON.parse(line)
    return isRecord(doc) ? doc : undefined
  } catch {
    return undefined
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
