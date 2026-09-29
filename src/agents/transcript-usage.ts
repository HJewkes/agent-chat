import fs from 'node:fs'
import { findTranscript } from './transcript.js'

/**
 * The context fill of a session that never draws a status line (CC-179).
 *
 * A headless print-mode agent writes no status-line cache, so the only record of
 * its context is the `message.usage` Claude Code stamps on each assistant turn in
 * its transcript. The latest one is the context as of that API response. Rate
 * limits are account-wide and never appear there.
 */

/** The last usage record sits within the final turn; this bounds a megabyte transcript. */
export const USAGE_TAIL_BYTES = 256 * 1024

export interface TranscriptUsage {
  ok: true
  path: string
  model?: string
  /** Unix seconds, from the record's own timestamp. */
  recorded_at: number
  input_tokens: number
  cache_read_tokens: number
  cache_creation_tokens: number
  output_tokens: number
}

export type TranscriptUsageRead = TranscriptUsage | { ok: false; path: string; reason: string }

/**
 * Never throws: the transcript belongs to another program and may be anything.
 * A known `cwd` hits the derived path first; without one every project dir is scanned.
 */
export function readTranscriptUsage(sessionId: string, dir?: string, cwd = ''): TranscriptUsageRead {
  let file = '(transcript)'
  try {
    const found = findTranscript(cwd, sessionId, dir)
    file = found.path
    if (!found.exists) return { ok: false, path: file, reason: 'no transcript written' }
    const usage = lastUsage(readTail(file))
    return usage === undefined
      ? { ok: false, path: file, reason: 'no assistant usage record in the transcript tail' }
      : { ok: true, path: file, ...usage }
  } catch (error) {
    return { ok: false, path: file, reason: `unreadable transcript (${(error as Error).message})` }
  }
}

function readTail(file: string): string {
  const fd = fs.openSync(file, 'r')
  try {
    const size = fs.fstatSync(fd).size
    const length = Math.min(size, USAGE_TAIL_BYTES)
    const buffer = Buffer.alloc(length)
    fs.readSync(fd, buffer, 0, length, size - length)
    return buffer.toString('utf8')
  } finally {
    fs.closeSync(fd)
  }
}

function lastUsage(tail: string): Omit<TranscriptUsage, 'ok' | 'path'> | undefined {
  const lines = tail.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const usage = usageOf(lines[i] ?? '')
    if (usage !== undefined) return usage
  }
  return undefined
}

/** A sidechain record is a subagent's turn, whose usage is its own context, not the agent's. */
function usageOf(line: string): Omit<TranscriptUsage, 'ok' | 'path'> | undefined {
  const record = parseLine(line)
  const message = isRecord(record?.message) ? record.message : undefined
  if (record?.type !== 'assistant' || record.isSidechain === true) return undefined
  if (message === undefined || message.model === '<synthetic>') return undefined
  const usage = isRecord(message.usage) ? message.usage : undefined
  const recordedMs = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN
  const input = count(usage?.input_tokens)
  if (usage === undefined || input === undefined || Number.isNaN(recordedMs)) return undefined
  return {
    ...(typeof message.model === 'string' ? { model: message.model } : {}),
    recorded_at: Math.floor(recordedMs / 1000),
    input_tokens: input,
    cache_read_tokens: count(usage.cache_read_input_tokens) ?? 0,
    cache_creation_tokens: count(usage.cache_creation_input_tokens) ?? 0,
    output_tokens: count(usage.output_tokens) ?? 0,
  }
}

/** The first line of a tail is usually cut mid-record; it fails to parse and is skipped. */
function parseLine(line: string): Record<string, unknown> | undefined {
  try {
    const doc: unknown = JSON.parse(line)
    return isRecord(doc) ? doc : undefined
  } catch {
    return undefined
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

const count = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined
