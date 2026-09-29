import fs from 'node:fs'
import { z } from 'zod'

/** `home-path` is derived at scan time from the running user's home and is never stored. */
export type Category = 'home-path' | 'owner-email' | 'private-name' | 'private-path'

export interface Denylist {
  ownerEmails: readonly string[]
  privateNames: readonly string[]
  privatePaths: readonly string[]
}

export const EMPTY_DENYLIST: Denylist = { ownerEmails: [], privateNames: [], privatePaths: [] }

/**
 * `missing`, `empty` and `unreadable` all leave only `home-path` enforced. A reason is a fixed
 * phrase and never quotes the file, since parse errors echo the text they choke on.
 */
export type DenylistLoad =
  | { kind: 'ok'; list: Denylist }
  | { kind: 'missing' }
  | { kind: 'empty' }
  | { kind: 'unreadable'; reason: string }

const Entries = z.array(z.string().trim().min(1)).default([])

const DenylistFile = z
  .object({ 'owner-email': Entries, 'private-name': Entries, 'private-path': Entries })
  .strict()

function readRaw(file: string): { text: string } | { missing: true } | { reason: string } {
  try {
    return { text: fs.readFileSync(file, 'utf8') }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { missing: true }
    return { reason: code === 'EACCES' ? 'permission denied' : `cannot be read (${code ?? 'unknown error'})` }
  }
}

function parse(text: string): DenylistLoad {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return { kind: 'unreadable', reason: 'is not valid JSON' }
  }
  const parsed = DenylistFile.safeParse(json)
  if (!parsed.success)
    return {
      kind: 'unreadable',
      reason:
        'must be an object whose only keys are owner-email, private-name and private-path, each a list of non-empty strings',
    }
  const data = parsed.data
  if (Object.values(data).every(entries => entries.length === 0)) return { kind: 'empty' }
  return {
    kind: 'ok',
    list: {
      ownerEmails: data['owner-email'],
      privateNames: data['private-name'],
      privatePaths: data['private-path'],
    },
  }
}

export function loadDenylist(file: string): DenylistLoad {
  const raw = readRaw(file)
  if ('missing' in raw) return { kind: 'missing' }
  if ('reason' in raw) return { kind: 'unreadable', reason: raw.reason }
  return parse(raw.text)
}
