import { createHmac, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import { launcherAliasesPath, launcherKeyPath, launcherKeysDir, ownLauncherKeyPath } from '../paths.js'
import { ensureToken } from './token.js'

/**
 * CC-1063: a launcher proves it holds its host's secret by an HMAC over a
 * single-use broker nonce, so the name cannot be claimed by whoever connects in
 * the gap after the real launcher drops, and a captured hello cannot be replayed.
 * The secret lives only in 0600 files, never in env, so a successor's launch
 * environment cannot carry it.
 */

const PROOF_LABEL = 'agent-chat host_hello v1'

/** Hex SHA-256. Checked before comparing because the proof is pre-auth input and must never throw. */
const PROOF_SHAPE = /^[0-9a-f]{64}$/

export const helloProof = (key: string, host: string, nonce: string): string =>
  createHmac('sha256', key).update(`${PROOF_LABEL}\n${host.toLowerCase()}\n${nonce}`).digest('hex')

export const proofMatches = (key: string, host: string, nonce: string, proof: unknown): boolean => {
  if (typeof proof !== 'string' || !PROOF_SHAPE.test(proof)) return false
  return timingSafeEqual(Buffer.from(proof), Buffer.from(helloProof(key, host, nonce)))
}

/**
 * The key as written, or null when it is missing, blank, a symlink, or readable
 * by group or other. A loose or redirected key file fails closed rather than
 * being trusted. O_NOFOLLOW and fstat on the open descriptor keep the checks and
 * the read on the same file.
 */
export const readLauncherKey = (file: string): string | null => {
  let fd: number
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  } catch {
    return null
  }
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) return null
    const raw = fs.readFileSync(fd, 'utf8').trim()
    return raw === '' ? null : raw
  } finally {
    fs.closeSync(fd)
  }
}

/** Mints the broker's key for a host if absent, inside a 0700 keys directory. */
export const ensureBrokerKey = (host: string): string => {
  const file = launcherKeyPath(host)
  fs.mkdirSync(launcherKeysDir(), { recursive: true, mode: 0o700 })
  fs.chmodSync(launcherKeysDir(), 0o700)
  return ensureToken(file)
}

/** Null for a missing or unusable key file; a path-like host has no key rather than throwing. */
export const brokerKeyFor = (host: string): string | null => {
  try {
    return readLauncherKey(launcherKeyPath(host))
  } catch {
    return null
  }
}

const ALIAS_SHAPE = /^[a-z0-9][a-z0-9-]*$/i

export const assertMachineAlias = (alias: string): void => {
  if (!ALIAS_SHAPE.test(alias)) throw new Error(`not a machine alias: ${alias}`)
}

/** Alias -> host as recorded, read with the same no-symlink, owner-only discipline as a key. Empty when unusable. */
export const readMachineAliases = (): Record<string, string> => {
  const raw = readLauncherKey(launcherAliasesPath())
  if (raw === null) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    return Object.fromEntries(Object.entries(parsed).filter(([, host]) => typeof host === 'string'))
  } catch {
    return {}
  }
}

/** Records `alias -> host` beside the keys; rewriting the same pair is a no-op. */
export const registerMachineAlias = (alias: string, host: string): void => {
  assertMachineAlias(alias)
  launcherKeyPath(host)
  const next = { ...readMachineAliases(), [alias.toLowerCase()]: host.toLowerCase() }
  const file = launcherAliasesPath()
  fs.mkdirSync(launcherKeysDir(), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  fs.chmodSync(tmp, 0o600)
  fs.renameSync(tmp, file)
}

export const ownKey = (): string | null => readLauncherKey(ownLauncherKeyPath())
