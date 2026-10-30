import nodeFs from 'node:fs'
import path from 'node:path'
import type { SpoolRecord } from '../server/inbox-spool.js'
import { isAlive } from '../suite-slots.js'

/**
 * CC-1455 S3: the read side of the spool `server/inbox-spool.ts` writes. A hook
 * drains it into the model's next tool result, prompt or turn end.
 *
 * A file is claimed by renaming it into `.claimed/<pid>-<name>`. rename is
 * atomic, so when parallel tool calls fire concurrent hooks each record has one
 * winner. A record is only claimed once it fits the budget, so whatever is left
 * stays in the spool for the next drain and the cap never loses a message.
 */

export type DrainFs = Pick<
  typeof nodeFs,
  'readdirSync' | 'readFileSync' | 'renameSync' | 'mkdirSync' | 'statSync' | 'rmSync'
>

export interface DrainDeps {
  fs?: DrainFs
  now?: () => number
  pid?: number
  isAlive?: (pid: number) => boolean
  /** Characters of rendered blocks one drain may print. */
  budget?: number
}

export interface Drained {
  blocks: string[]
  msgIds: string[]
  /** CC-1680: delivery time by msgId, for the records that carry one. */
  sentAt: Record<string, number>
  /** The claimed files, deleted by `releaseClaims` once the output was written. */
  claimed: string[]
}

/** Below Claude Code's ~10 KB whole-delivery limit (S0), leaving room for the header. */
export const DRAIN_BUDGET = 8000
const TEXT_CAP = 2000
const STALE_CLAIM_MS = 30_000
const CLAIMED = '.claimed'

interface Candidate {
  name: string
  record: SpoolRecord
}

/** Human and provenance first, so a broadcast storm cannot push a STAND DOWN past the cap. */
function tier(record: SpoolRecord): number {
  if (record.kind === 'system') return 4
  if (record.meta.from === 'human' || record.meta.provenance !== undefined) return 0
  if (record.meta.broadcast === 'true') return 3
  return record.meta.audience !== undefined ? 2 : 1
}

const escapeAttr = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

/** A peer's text cannot close the tag and open a forged one. */
const neutralizeTags = (text: string): string => text.replace(/<(\/?channel)/gi, '&lt;$1')

export function renderBlock(record: SpoolRecord): string {
  const attrs = Object.entries({ source: 'agent-chat', ...record.meta })
    .map(([key, value]) => `${key}="${escapeAttr(value)}"`)
    .join(' ')
  const text =
    record.text.length > TEXT_CAP
      ? `${record.text.slice(0, TEXT_CAP)}… (truncated; full text: chat_inbox)`
      : record.text
  return `<channel ${attrs}>\n${neutralizeTags(text)}\n</channel>`
}

function readCandidates(dir: string, fs: DrainFs): Candidate[] {
  const names = fs
    .readdirSync(dir)
    .filter(name => name.endsWith('.json') && !name.startsWith('.'))
    .sort()
  const candidates: Candidate[] = []
  for (const name of names) {
    try {
      candidates.push({
        name,
        record: JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as SpoolRecord,
      })
    } catch {
      // Claimed by a concurrent drain, or not a record; either way not ours to show.
    }
  }
  return candidates.sort((a, b) => tier(a.record) - tier(b.record))
}

/** A claim left by a hook that died before its unlink goes back to the spool. */
function recoverStaleClaims(dir: string, fs: DrainFs, deps: DrainDeps): void {
  const claimedDir = path.join(dir, CLAIMED)
  const alive = deps.isAlive ?? isAlive
  const now = (deps.now ?? Date.now)()
  let names: string[]
  try {
    names = fs.readdirSync(claimedDir)
  } catch {
    return
  }
  for (const claim of names) {
    const [, pid, name] = /^(\d+)-(.+)$/.exec(claim) ?? []
    if (pid === undefined || name === undefined || alive(Number(pid))) continue
    const from = path.join(claimedDir, claim)
    try {
      if (now - fs.statSync(from).mtimeMs <= STALE_CLAIM_MS) continue
      fs.renameSync(from, path.join(dir, name))
    } catch {
      // Another drain recovered it first.
    }
  }
}

function claim(dir: string, name: string, fs: DrainFs, pid: number): string | undefined {
  const to = path.join(dir, CLAIMED, `${pid}-${name}`)
  try {
    fs.mkdirSync(path.join(dir, CLAIMED), { recursive: true, mode: 0o700 })
    fs.renameSync(path.join(dir, name), to)
    return to
  } catch {
    return undefined
  }
}

/** Claim and render what fits the budget, most urgent first. Never throws. */
export function drainInbox(dir: string, deps: DrainDeps = {}): Drained {
  const fs = deps.fs ?? nodeFs
  const budget = deps.budget ?? DRAIN_BUDGET
  const drained: Drained = { blocks: [], msgIds: [], sentAt: {}, claimed: [] }
  let used = 0
  try {
    recoverStaleClaims(dir, fs, deps)
    for (const { name, record } of readCandidates(dir, fs)) {
      const block = renderBlock(record)
      if (used + block.length > budget) break
      const claimed = claim(dir, name, fs, deps.pid ?? process.pid)
      if (claimed === undefined) continue
      used += block.length
      drained.blocks.push(block)
      drained.claimed.push(claimed)
      if (record.msgId === undefined) continue
      drained.msgIds.push(record.msgId)
      if (record.at !== undefined) drained.sentAt[record.msgId] = record.at
    }
  } catch {
    // No spool yet, or an unreadable one: nothing to show.
  }
  return drained
}

/** Delete what was shown. A hook that dies before this shows it once more, after the stale window. */
export function releaseClaims(claimed: string[], fs: DrainFs = nodeFs): void {
  for (const file of claimed) fs.rmSync(file, { force: true })
}

export interface Peeked {
  /** The sender of each record in the spool now, never its text. */
  senders: string[]
  /** How many of them this call claimed the notice for. */
  fresh: number
}

export type PeekFs = DrainFs & Pick<typeof nodeFs, 'writeFileSync'>

const NOTICED = '.noticed'

/** One `wx` create per record: of concurrent hooks, exactly one wins the notice. */
function claimNotice(dir: string, name: string, fs: PeekFs): boolean {
  try {
    fs.mkdirSync(path.join(dir, NOTICED), { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(dir, NOTICED, name), '', { flag: 'wx', mode: 0o600 })
    return true
  } catch {
    return false
  }
}

/** A marker whose record chat_inbox cleared or a drain claimed has nothing left to guard. */
function pruneNotices(dir: string, names: Set<string>, fs: PeekFs): void {
  try {
    for (const marker of fs.readdirSync(path.join(dir, NOTICED))) {
      if (!names.has(marker)) fs.rmSync(path.join(dir, NOTICED, marker), { force: true })
    }
  } catch {
    // No marker yet.
  }
}

/**
 * CC-1510: a count-only look at the spool for a host whose hook context outranks
 * the user (Codex puts it in the developer role). Nothing is claimed or deleted,
 * so chat_inbox still returns every body; only a per-record notice marker is taken.
 */
export function peekInbox(dir: string, fs: PeekFs = nodeFs): Peeked {
  const peeked: Peeked = { senders: [], fresh: 0 }
  try {
    const candidates = readCandidates(dir, fs)
    pruneNotices(dir, new Set(candidates.map(candidate => candidate.name)), fs)
    for (const { name, record } of candidates) {
      peeked.senders.push(record.meta.from ?? 'agent-chat')
      if (claimNotice(dir, name, fs)) peeked.fresh += 1
    }
  } catch {
    // No spool yet: nothing waits.
  }
  return peeked
}
