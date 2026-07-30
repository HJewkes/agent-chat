import fs from 'node:fs'
import { findTranscript } from './transcript.js'

/**
 * Surface a settings-level tool denial from a headless agent's own transcript —
 * CC-29's case (B). NOT case (A): a toolset-confined agent (a tool absent from
 * its `--allowed-tools`/`--disallowed-tools` schema) never emits a `tool_use` for
 * the missing tool at all, so there is nothing here to find. That case is
 * unobservable after the fact by construction; the mitigation for it lives at
 * spawn time (`spawn_result.disallowedTools`), not here.
 *
 * THE STABLE SIGNAL, verified live 2026-07-28: a `tool_result` content block with
 * `is_error === true`, matched back to the `tool_use` block that shares its
 * `tool_use_id`. `toolDenialKind`, a top-level field on the same row, is a
 * refinement of WHY when present — undocumented internal Claude Code state that
 * may change without notice, so it is never the primary signal.
 */
export interface Denial {
  tool: string
  detail: string
  kind?: string
}

type ToolUseBlock = Record<string, unknown> & { type: 'tool_use'; id?: unknown; name?: unknown }

type ToolResultBlock = Record<string, unknown> & {
  type: 'tool_result'
  tool_use_id?: unknown
  is_error?: unknown
  content?: unknown
}

const isToolUse = (block: Record<string, unknown>): block is ToolUseBlock => block.type === 'tool_use'
const isToolResult = (block: Record<string, unknown>): block is ToolResultBlock =>
  block.type === 'tool_result'

const detailOf = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (Array.isArray(content))
    return content
      .map(part => (part && typeof part === 'object' && 'text' in part ? String(part.text) : ''))
      .filter(Boolean)
      .join(' ')
  return ''
}

/**
 * One pass, streamed line by line rather than buffered whole — a live
 * transcript can run to megabytes and this may be asked for at any point in it.
 */
export function findDenials(cwd: string, sessionId: string, limit: number): Denial[] {
  const found = findTranscript(cwd, sessionId)
  if (!found.exists) return []

  const toolNames = new Map<string, string>()
  const denials: Denial[] = []

  for (const line of fs.readFileSync(found.path, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    let row: { message?: { content?: unknown }; toolDenialKind?: unknown }
    try {
      row = JSON.parse(line)
    } catch {
      continue // a partially flushed final line is normal on a live tail
    }
    const content = row.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      if (isToolUse(block) && typeof block.id === 'string' && typeof block.name === 'string')
        toolNames.set(block.id, block.name)
      if (isToolResult(block) && block.is_error === true) {
        const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : ''
        denials.push({
          tool: toolNames.get(id) ?? 'unknown tool',
          detail: detailOf(block.content),
          ...(typeof row.toolDenialKind === 'string' ? { kind: row.toolDenialKind } : {}),
        })
      }
    }
  }
  return denials.slice(-limit)
}
