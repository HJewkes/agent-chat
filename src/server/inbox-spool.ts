import nodeFs from 'node:fs'
import path from 'node:path'
import { hostChannelStatus, type ArgvReader } from '../broker/host-channels.js'
import { agentDir, codexHostDir } from '../paths.js'
import type { Harness } from './host.js'

/**
 * CC-1455: a `claude -p` host drops every channel push, so its MCP server also
 * writes each push into a local spool that a hook drains into the next tool
 * result. This module WRITES the spool; the hook drains it (`inbox-spool/drain.ts`),
 * and chat_inbox clears what it already returned.
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
  /** CC-1680: when the broker delivered the message, so a reader can tell how long it waited. */
  at?: number
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

const spoolId = (msgId: string): string => msgId.replace(SAFE_ID, '_')

/** The spool of one spawned agent, beside its launch files and with their modes. */
export const inboxSpoolDir = (agentId: string): string => path.join(agentDir(agentId), 'inbox')

/** The spool of one Codex process, which renders no channel push at all (CC-1509). */
export const codexInboxSpoolDir = (hostPid: number): string => path.join(codexHostDir(hostPid), 'inbox')

/**
 * CC-1669: set by the launcher on a host it starts with `-p`. Reading the host's argv
 * is the fallback, since a prompt holding a bare `--` hides `-p` from a `ps` line.
 */
export const HOST_MODE_ENV = 'AGENT_CHAT_HOST_MODE'

export const launchedInPrintMode = (env: NodeJS.ProcessEnv): boolean => env[HOST_MODE_ENV] === 'print'

/**
 * The spool dir to write, or `undefined` when this server must not spool: a Codex
 * host always spools, since it drops every push; otherwise only a spawned agent
 * whose launch opted in and whose host is in print mode. Print mode is the
 * launcher's word when it gave one, else the broker's own argv read, so an older
 * launch and the broker never disagree on what "print" means.
 */
export function resolveInboxSpool(opts: {
  agentId: string | undefined
  env: NodeJS.ProcessEnv
  hostPid: number | undefined
  harness?: Harness
  read?: ArgvReader
}): string | undefined {
  if (opts.harness === 'codex')
    return opts.hostPid === undefined ? undefined : codexInboxSpoolDir(opts.hostPid)
  if (opts.agentId === undefined || !opts.env.AGENT_CHAT_INBOX_SPOOL) return undefined
  const print =
    launchedInPrintMode(opts.env) || hostChannelStatus(opts.hostPid, 'agent-chat', opts.read) === 'print'
  if (!print) return undefined
  return inboxSpoolDir(opts.agentId)
}

/**
 * Remove a Codex host's state when this server exits, since the pid key outlives
 * the process and a later Codex reusing it must not inherit stale records. `exit`
 * covers every path out, the superseded and stdin-closed ones included.
 */
export function retireCodexHostOnExit(
  hostPid: number,
  proc: Pick<NodeJS.EventEmitter, 'once'> = process,
  fs: Pick<typeof nodeFs, 'rmSync'> = nodeFs,
): void {
  proc.once('exit', () => fs.rmSync(codexHostDir(hostPid), { recursive: true, force: true }))
}

/** Write one record;`false` when the fs refused, which must never cost the push itself. */
export function spoolRecord(dir: string, record: SpoolRecord, deps: SpoolDeps = {}): boolean {
  const fs = deps.fs ?? nodeFs
  seq += 1
  const at = String((deps.now ?? Date.now)()).padStart(13, '0')
  const id = record.msgId === undefined ? 'system' : spoolId(record.msgId)
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

/**
 * Delete the spooled records of messages chat_inbox just returned, so the hook does
 * not show them a second time. A record a hook already claimed is left to that hook.
 */
export function clearSpooled(
  dir: string,
  msgIds: string[],
  fs: Pick<typeof nodeFs, 'readdirSync' | 'rmSync'> = nodeFs,
): void {
  const suffixes = msgIds.map(id => `-${spoolId(id)}.json`)
  try {
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith('.') || !suffixes.some(suffix => name.endsWith(suffix))) continue
      fs.rmSync(path.join(dir, name), { force: true })
    }
  } catch {
    // No spool yet: nothing was waiting.
  }
}
