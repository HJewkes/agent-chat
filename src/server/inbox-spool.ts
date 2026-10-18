import nodeFs from 'node:fs'
import path from 'node:path'
import { hostChannelStatus, type ArgvReader } from '../broker/host-channels.js'
import { agentDir } from '../paths.js'

/**
 * CC-1455: a `claude -p` host drops every channel push, so its MCP server also
 * writes each push into a local spool that a hook drains into the next tool
 * result. This module only WRITES; nothing reads the spool until the hook ships.
 *
 * Each record is written to a dot-prefixed temp file and renamed into place, so
 * a reader globbing `*.json` never sees a partial record. The name leads with
 * the arrival time and a per-process seq, both zero-padded, so a lexical sort of
 * the directory is arrival order even for two pushes in one millisecond.
 */

export type SpoolFs = Pick<typeof nodeFs, 'mkdirSync' | 'writeFileSync' | 'renameSync'>

export interface SpoolRecord {
  kind: 'message' | 'system'
  /** The broker's id; a lifecycle record has none, since nobody sent it. */
  msgId?: string
  /** The channel tag's attributes exactly as pushed, provenance and batch lists included. */
  meta: Record<string, string>
  /** The pushed content, context hint and all. */
  text: string
}

export interface SpoolDeps {
  fs?: SpoolFs
  now?: () => number
}

let seq = 0

const SAFE_ID = /[^A-Za-z0-9_-]/g

/** The spool of one spawned agent, beside its launch files and with their modes. */
export const inboxSpoolDir = (agentId: string): string => path.join(agentDir(agentId), 'inbox')

/**
 * The spool dir to write, or `undefined` when this server must not spool: only a
 * spawned agent whose launch opted in and whose host is in print mode. The argv
 * reader is the broker's own, so the two never disagree on what "print" means.
 */
export function resolveInboxSpool(opts: {
  agentId: string | undefined
  env: NodeJS.ProcessEnv
  hostPid: number | undefined
  read?: ArgvReader
}): string | undefined {
  if (opts.agentId === undefined || !opts.env.AGENT_CHAT_INBOX_SPOOL) return undefined
  if (hostChannelStatus(opts.hostPid, 'agent-chat', opts.read) !== 'print') return undefined
  return inboxSpoolDir(opts.agentId)
}

/** Write one record; `false` when the fs refused, which must never cost the push itself. */
export function spoolRecord(dir: string, record: SpoolRecord, deps: SpoolDeps = {}): boolean {
  const fs = deps.fs ?? nodeFs
  seq += 1
  const at = String((deps.now ?? Date.now)()).padStart(13, '0')
  const id = record.msgId?.replace(SAFE_ID, '_') ?? 'system'
  const name = `${at}-${String(seq).padStart(9, '0')}-${id}.json`
  const temp = path.join(dir, `.${name}.${process.pid}.tmp`)
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    fs.writeFileSync(temp, JSON.stringify(record), { mode: 0o600 })
    fs.renameSync(temp, path.join(dir, name))
    return true
  } catch {
    return false
  }
}
