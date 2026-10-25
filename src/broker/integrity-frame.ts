/**
 * The shape checks on an `integrity_check` frame (TP-4256). It comes from an unregistered hook the
 * broker cannot vouch for, and its records become a session's baseline, so a record `compare` could
 * not read is refused here rather than stored.
 */

export const MAX_RECORDS = 4096
const MAX_ID = 256
const STAT_KEYS = ['dev', 'ino', 'size', 'ctimeNs'] as const

type Loose = Record<string, unknown>

const isObject = (value: unknown): value is Loose =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const optionalString = (value: unknown): boolean => value === undefined || typeof value === 'string'

const isStat = (value: unknown): boolean =>
  isObject(value) && STAT_KEYS.every(key => typeof value[key] === 'string')

function isFileRecord(value: Loose): boolean {
  if (value.kind !== 'startup' && value.kind !== 'session') return false
  if (value.state === 'absent') return true
  return (
    value.state === 'present' &&
    isStat(value.lstat) &&
    (value.stat === undefined || isStat(value.stat)) &&
    optionalString(value.link) &&
    optionalString(value.sha256)
  )
}

const isDirRecord = (value: Loose): boolean =>
  value.kind === 'dir' && Array.isArray(value.names) && value.names.every(name => typeof name === 'string')

function recordsRefusal(records: unknown): string | undefined {
  if (!isObject(records)) return 'records must be an object'
  const entries = Object.values(records)
  if (entries.length > MAX_RECORDS) return `records holds more than ${MAX_RECORDS} files`
  const valid = entries.every(entry => isObject(entry) && (isDirRecord(entry) || isFileRecord(entry)))
  return valid ? undefined : 'records holds an entry that is not a file or directory record'
}

const idRefusal = (name: string, value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' && value.length <= MAX_ID
    ? undefined
    : `${name} must be a string of 1-${MAX_ID} characters`

/** Why the frame cannot be checked, or undefined when it holds what its `Records` type claims. */
export function integrityFrameRefusal(frame: Loose): string | undefined {
  return (
    idRefusal('nonce', frame.nonce) ?? idRefusal('session', frame.session) ?? recordsRefusal(frame.records)
  )
}
