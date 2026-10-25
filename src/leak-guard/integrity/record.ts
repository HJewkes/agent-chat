/**
 * Run-time record of the files a later shell sources (TP-4256, TP-4232 option R1). Pure and inert: it
 * stats and hashes files and compares two records. It never reads shell line text, and it restores
 * nothing. Numbers are strings so a record survives JSON.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

type Env = Readonly<Record<string, string | undefined>>

/** `startup` files may not vanish; `session` files are pruned by Claude Code, so deleting one is allowed. */
export type FileKind = 'startup' | 'session'

export interface StatRecord {
  dev: string
  ino: string
  size: string
  ctimeNs: string
}

export type FileRecord =
  | { kind: FileKind; state: 'absent' }
  | {
      kind: FileKind
      state: 'present'
      lstat: StatRecord
      stat?: StatRecord
      link?: string
      sha256?: string
    }

export type Records = Record<string, FileRecord>

export interface Mismatch {
  file: string
  field: string
}

export interface RecordFs {
  lstat(file: string): fs.BigIntStats | undefined
  stat(file: string): fs.BigIntStats | undefined
  readlink(file: string): string | undefined
  /** The sha256 of the content, or undefined when the file is not regular or unreadable. */
  hash(file: string): string | undefined
  list(dir: string): string[]
}

const attempt = <T>(fn: () => T): T | undefined => {
  try {
    return fn()
  } catch {
    return undefined
  }
}

/** Opened without blocking and hashed only when regular, so a FIFO or a device cannot hang the hook. */
function hashRegular(file: string): string | undefined {
  let fd: number | undefined
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)
    if (!fs.fstatSync(fd).isFile()) return undefined
    return createHash('sha256').update(fs.readFileSync(fd)).digest('hex')
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

export const nodeFs: RecordFs = {
  lstat: file => attempt(() => fs.lstatSync(file, { bigint: true })),
  stat: file => attempt(() => fs.statSync(file, { bigint: true })),
  readlink: file => attempt(() => fs.readlinkSync(file)),
  hash: hashRegular,
  list: dir => attempt(() => fs.readdirSync(dir)) ?? [],
}

const statRecord = (s: fs.BigIntStats): StatRecord => ({
  dev: String(s.dev),
  ino: String(s.ino),
  size: String(s.size),
  ctimeNs: String(s.ctimeNs),
})

export function recordOf(file: string, kind: FileKind, io: RecordFs = nodeFs): FileRecord {
  const lstat = io.lstat(file)
  if (lstat === undefined) return { kind, state: 'absent' }
  const record: FileRecord = { kind, state: 'present', lstat: statRecord(lstat) }
  const stat = io.stat(file)
  if (stat !== undefined) record.stat = statRecord(stat)
  if (lstat.isSymbolicLink()) record.link = io.readlink(file)
  const sha256 = io.hash(file)
  if (sha256 !== undefined) record.sha256 = sha256
  return record
}

// The shell startup files of zsh, bash and the ksh family that a later shell may source.
const STARTUP_NAMES = [
  '.zshenv',
  '.zprofile',
  '.zshrc',
  '.zlogin',
  '.zlogout',
  '.bashrc',
  '.bash_profile',
  '.bash_login',
  '.bash_logout',
  '.profile',
  '.kshrc',
  '.mkshrc',
  '.shrc',
]

const absolute = (value: string | undefined): string | undefined =>
  value !== undefined && path.isAbsolute(value) ? value : undefined

/**
 * The startup files in HOME and ZDOTDIR (absent ones recorded as absent), plus the absolute values of
 * BASH_ENV and ENV.
 */
export function startupSet(home: string, zdotdir: string | undefined, env: Env, io: RecordFs = nodeFs): Records {
  const dirs = new Set([home])
  const zdir = absolute(zdotdir)
  if (zdir !== undefined) dirs.add(zdir)
  const files = [...dirs].flatMap(dir => STARTUP_NAMES.map(name => path.join(dir, name)))
  for (const value of [absolute(env.BASH_ENV), absolute(env.ENV)]) {
    if (value !== undefined) files.push(value)
  }
  return recordAll(files, 'startup', io)
}

/**
 * Every file in `shell-snapshots` and in `session-env/<session>`, taken at the first check. The hook's
 * CLAUDE_ENV_FILE is a startup-kind entry: nothing prunes it, so its deletion is a change.
 */
export function sessionSet(configDir: string, sessionId: string, env: Env, io: RecordFs = nodeFs): Records {
  const dirs = [path.join(configDir, 'shell-snapshots'), path.join(configDir, 'session-env', sessionId)]
  const files = dirs.flatMap(dir => io.list(dir).map(name => path.join(dir, name)))
  const records = recordAll(files, 'session', io)
  const envFile = absolute(env.CLAUDE_ENV_FILE)
  if (envFile !== undefined) records[envFile] = recordOf(envFile, 'startup', io)
  return records
}

function recordAll(files: readonly string[], kind: FileKind, io: RecordFs): Records {
  const records: Records = {}
  for (const file of files) records[file] = recordOf(file, kind, io)
  return records
}

const STAT_FIELDS = ['dev', 'ino', 'size', 'ctimeNs'] as const

function changedStat(base: StatRecord, now: StatRecord, prefix: string): string | undefined {
  const field = STAT_FIELDS.find(name => base[name] !== now[name])
  return field === undefined ? undefined : prefix + field
}

function changedField(base: FileRecord, now: FileRecord): string | undefined {
  if (base.state === 'absent') return now.state === 'absent' ? undefined : 'state'
  if (now.state === 'absent') return base.kind === 'session' ? undefined : 'state'
  const lstat = changedStat(base.lstat, now.lstat, '')
  if (lstat !== undefined) return lstat
  if (base.link !== now.link) return 'link'
  if (base.stat === undefined || now.stat === undefined) {
    if (base.stat !== now.stat) return 'stat'
  } else {
    const stat = changedStat(base.stat, now.stat, 'stat.')
    if (stat !== undefined) return stat
  }
  return base.sha256 === now.sha256 ? undefined : 'sha256'
}

/**
 * The first file of the baseline whose record changed, and the field that shows it. A file the
 * baseline never held is ignored, so another session's new snapshot passes. A baselined session
 * file that is gone passes; every other disappearance, and every appearance, does not.
 */
export function compare(base: Records, now: Records): Mismatch | undefined {
  for (const [file, before] of Object.entries(base)) {
    const field = changedField(before, now[file] ?? { kind: before.kind, state: 'absent' })
    if (field !== undefined) return { file, field }
  }
  return undefined
}
