import fs from 'node:fs'
import path from 'node:path'
import { logEvent } from '../broker/log.js'
import { home } from '../paths.js'

/**
 * The owner's seat spawn policy (CC-1580): which seats get root authority and which profiles they
 * may spawn by name. Only the owner writes this file, so anything that might let an agent have
 * written it (a symlink, another owner, a group- or world-writable mode, bad JSON) fails closed to
 * no seats. Read fresh per call, cached on the file's stat so a revoke needs no restart.
 */

export interface SeatPolicyEntry {
  root: true
  launchProfiles: string[]
  ceiling: string[]
}

export interface SeatPolicy {
  seats: Record<string, SeatPolicyEntry>
}

export type SeatPolicyState =
  | { status: 'absent' }
  | { status: 'invalid'; reason: string }
  | { status: 'ok'; policy: SeatPolicy; ignored: string[] }

const TOP_KEYS = new Set(['version', 'seats'])
const SEAT_KEYS = new Set(['root', 'launchProfiles', 'ceiling'])
const WRITABLE_BY_OTHERS = 0o022

export const seatPolicyPath = (): string => path.join(home(), 'seat-policy.json')

let cached: { path: string; key: string; state: SeatPolicyState } | undefined
const logged = new Set<string>()

function logOnce(event: string, detail: Record<string, unknown>): void {
  const key = JSON.stringify([event, detail])
  if (logged.has(key)) return
  logged.add(key)
  logEvent(event, detail)
}

/** The file's state, for `doctor` and for {@link loadSeatPolicy}. */
export function readSeatPolicy(): SeatPolicyState {
  const file = seatPolicyPath()
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(file)
  } catch {
    return { status: 'absent' }
  }
  const key = [stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.mode, stat.uid].join(':')
  if (cached?.path === file && cached.key === key) return cached.state
  const state = readChecked(file, stat)
  cached = { path: file, key, state }
  return state
}

/** The seats the policy grants: none unless the file is present, owner-only and valid. */
export function loadSeatPolicy(): SeatPolicy {
  const state = readSeatPolicy()
  if (state.status === 'invalid')
    logOnce('seat_policy_invalid', { path: seatPolicyPath(), reason: state.reason })
  if (state.status !== 'ok') return { seats: {} }
  for (const key of state.ignored) logOnce('seat_policy_ignored', { path: seatPolicyPath(), key })
  return state.policy
}

function readChecked(file: string, stat: fs.Stats): SeatPolicyState {
  const unsafe = unsafeReason(stat)
  if (unsafe !== undefined) return { status: 'invalid', reason: unsafe }
  let raw: string
  try {
    raw = readNoFollow(file)
  } catch (err) {
    return { status: 'invalid', reason: (err as Error).message }
  }
  try {
    return parseSeatPolicy(JSON.parse(raw) as unknown)
  } catch (err) {
    return { status: 'invalid', reason: `malformed JSON: ${(err as Error).message}` }
  }
}

function unsafeReason(stat: fs.Stats): string | undefined {
  if (stat.isSymbolicLink()) return 'is a symlink'
  if (!stat.isFile()) return 'is not a regular file'
  const uid = process.getuid?.()
  if (uid === undefined) return 'cannot check the owner on this platform'
  if (stat.uid !== uid) return `owned by uid ${stat.uid}, not the broker's uid ${uid}`
  if ((stat.mode & WRITABLE_BY_OTHERS) !== 0)
    return `mode ${(stat.mode & 0o777).toString(8)} is group- or world-writable`
  return undefined
}

/** Re-checks through the open descriptor, so a swap between the lstat and the read is caught. */
function readNoFollow(file: string): string {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const unsafe = unsafeReason(fs.fstatSync(fd))
    if (unsafe !== undefined) throw new Error(unsafe)
    return fs.readFileSync(fd, 'utf8')
  } finally {
    fs.closeSync(fd)
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isNameList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(item => typeof item === 'string' && item !== '')

/** Validates schema v1. A seat without `root: true` grants nothing and is dropped. */
export function parseSeatPolicy(parsed: unknown): SeatPolicyState {
  if (!isRecord(parsed)) return { status: 'invalid', reason: 'not a JSON object' }
  if (parsed.version !== 1)
    return { status: 'invalid', reason: `unsupported version ${String(parsed.version)}` }
  if (!isRecord(parsed.seats)) return { status: 'invalid', reason: '"seats" is not an object' }
  const ignored = Object.keys(parsed).filter(key => !TOP_KEYS.has(key))
  const seats: Record<string, SeatPolicyEntry> = {}
  for (const [name, entry] of Object.entries(parsed.seats)) {
    if (!isRecord(entry)) return { status: 'invalid', reason: `seat "${name}" is not an object` }
    ignored.push(
      ...Object.keys(entry)
        .filter(key => !SEAT_KEYS.has(key))
        .map(key => `seats.${name}.${key}`),
    )
    if (entry.root !== true) continue
    if (!isNameList(entry.launchProfiles) || !isNameList(entry.ceiling)) {
      return {
        status: 'invalid',
        reason: `seat "${name}" needs launchProfiles and ceiling as lists of profile names`,
      }
    }
    seats[name] = { root: true, launchProfiles: [...entry.launchProfiles], ceiling: [...entry.ceiling] }
  }
  return { status: 'ok', policy: { seats }, ignored }
}
