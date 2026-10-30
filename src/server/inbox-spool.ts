import nodeFs from 'node:fs'
import path from 'node:path'
import { hostChannelStatus, type ArgvReader } from '../broker/host-channels.js'
import { AGENT_NAME_PATTERN } from '../launch-identity.js'
import { agentDir, codexHostDir, codexPendingDir } from '../paths.js'
import { isAlive } from '../suite-slots.js'
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
 * CC-1683: set by `codex run --name`, and only there, since a Codex that merely inherited
 * AGENT_CHAT_NAME has no supervisor coming back for what it keeps.
 */
export const CODEX_KEEP_ENV = 'AGENT_CHAT_CODEX_KEEP_AS'

const KEEP_NAME = new RegExp(`^${AGENT_NAME_PATTERN}$`)

export function codexKeepName(env: NodeJS.ProcessEnv): string | undefined {
  const name = env[CODEX_KEEP_ENV]
  return name !== undefined && KEEP_NAME.test(name) ? name : undefined
}

/** Who owns a host dir. It tells a live owner from a dead one that left its dir behind. */
export interface CodexHostStamp {
  mcpPid: number
  keepAs?: string
}

export interface ParkDeps {
  fs?: typeof nodeFs
  isAlive?: (pid: number) => boolean
  pid?: number
}

const hostStampPath = (hostPid: number): string => path.join(codexHostDir(hostPid), 'owner.json')

export function readCodexHostStamp(hostPid: number): CodexHostStamp | undefined {
  try {
    return JSON.parse(nodeFs.readFileSync(hostStampPath(hostPid), 'utf8')) as CodexHostStamp
  } catch {
    return undefined
  }
}

function listing(dir: string, fs: typeof nodeFs): string[] {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}

/** `false` only when the record is still at `from`; a racer that took it left nothing to keep. */
function moveRecord(from: string, pending: string, name: string, fs: typeof nodeFs): boolean {
  try {
    fs.mkdirSync(pending, { recursive: true, mode: 0o700 })
    fs.renameSync(from, path.join(pending, name))
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
  }
}

/**
 * Empty a Codex host dir, so a later Codex reusing the pid inherits nothing. Under a
 * `keepAs` name the records move to that name's pending dir; with none, no later session
 * can claim them and they go with the dir. The dir stays only while it holds what could
 * not move, or a claim whose live holder settles it and then parks again. Waiting records
 * go first: a drain racing this pass can only leave a claim the second loop then sees.
 */
export function parkCodexHost(hostPid: number, keepAs: string | undefined, deps: ParkDeps = {}): void {
  const fs = deps.fs ?? nodeFs
  const hostDir = codexHostDir(hostPid)
  if (keepAs === undefined) {
    fs.rmSync(hostDir, { recursive: true, force: true })
    return
  }
  const inbox = codexInboxSpoolDir(hostPid)
  const claimedDir = path.join(inbox, '.claimed')
  const pending = codexPendingDir(keepAs)
  let clear = true
  for (const name of listing(inbox, fs).filter(n => n.endsWith('.json') && !n.startsWith('.'))) {
    clear = moveRecord(path.join(inbox, name), pending, name, fs) && clear
  }
  for (const claim of listing(claimedDir, fs)) {
    const [, pid, name] = /^(\d+)-(.+)$/.exec(claim) ?? []
    if (pid === undefined || name === undefined) continue
    if ((deps.isAlive ?? isAlive)(Number(pid))) clear = false
    else clear = moveRecord(path.join(claimedDir, claim), pending, name, fs) && clear
  }
  if (clear) fs.rmSync(hostDir, { recursive: true, force: true })
}

/**
 * Take over a Codex host dir at server start. One still here belongs to an earlier owner
 * that never ran its exit handler: its records go under that owner's name, never this
 * process's, which may be a stranger on a reused pid. A live stamp is a sibling server of
 * a multi-thread host, and stays.
 */
function stampCodexHost(hostPid: number, keepAs: string | undefined, deps: ParkDeps): void {
  const prior = readCodexHostStamp(hostPid)
  const pid = deps.pid ?? process.pid
  if (prior !== undefined && prior.mcpPid !== pid && (deps.isAlive ?? isAlive)(prior.mcpPid)) return
  parkCodexHost(hostPid, prior?.keepAs, deps)
  const fs = deps.fs ?? nodeFs
  const stamp: CodexHostStamp = { mcpPid: pid, ...(keepAs === undefined ? {} : { keepAs }) }
  try {
    fs.mkdirSync(codexHostDir(hostPid), { recursive: true, mode: 0o700 })
    fs.writeFileSync(hostStampPath(hostPid), JSON.stringify(stamp), { mode: 0o600 })
  } catch {
    // Unstamped, the supervisor does not drain this spool; `chat_inbox` still reads the broker.
  }
}

/**
 * Stamp the host dir now and park it when this server exits, since the pid key outlives
 * the process. `exit` covers every path out, the superseded and stdin-closed ones included.
 */
export function adoptCodexHost(
  hostPid: number,
  keepAs: string | undefined,
  proc: Pick<NodeJS.EventEmitter, 'once'> = process,
  deps: ParkDeps = {},
): void {
  stampCodexHost(hostPid, keepAs, deps)
  proc.once('exit', () => parkCodexHost(hostPid, keepAs, deps))
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
