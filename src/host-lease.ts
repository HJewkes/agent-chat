import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { home } from './paths.js'

/**
 * The factory host lease (CC-806): `$AGENT_CHAT_HOME/factory-host` holds one
 * hostname, surrounding whitespace ignored. A broker or seats watchdog on any
 * other host refuses to start. No file means no lease. The same file is read by
 * `titan-factory serve` and the active-work daemon, so keep the format trivial.
 */
export const leasePath = (): string => path.join(home(), 'factory-host')

/** What a missing lease file reads as; any other read failure is `{ error }`. */
export type LeaseRead = { text: string } | { absent: true } | { error: string }

export type LeaseVerdict = { ok: true } | { ok: false; message: string }

export interface LeaseSeams {
  read: () => LeaseRead
  hostname: () => string
}

/**
 * Case-insensitive, and only the first label counts, so `Mac`, `mac.local` and
 * `mac.example.com` are one host.
 */
export function normaliseHost(name: string): string {
  return name.trim().toLowerCase().split('.')[0] ?? ''
}

export function checkHostLease(lease: LeaseRead, hostname: string, file = leasePath()): LeaseVerdict {
  if ('absent' in lease) return { ok: true }
  if ('error' in lease)
    return refuse(`factory host lease ${file} is unreadable (${lease.error}); refusing to start`)
  const leased = lease.text.trim()
  if (leased === '') return refuse(`factory host lease ${file} is empty; refusing to start`)
  if (normaliseHost(leased) === normaliseHost(hostname)) return { ok: true }
  return refuse(
    `factory host lease ${file} names host "${leased}", but this host is "${hostname}"; refusing to start`,
  )
}

const refuse = (message: string): LeaseVerdict => ({ ok: false, message })

function readLeaseFile(): LeaseRead {
  try {
    return { text: fs.readFileSync(leasePath(), 'utf8') }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { absent: true }
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

const defaultSeams: LeaseSeams = { read: readLeaseFile, hostname: () => os.hostname() }

/** The refusal message when this host is off the lease, else undefined. */
export function hostLeaseRefusal(seams: LeaseSeams = defaultSeams): string | undefined {
  const verdict = checkHostLease(seams.read(), seams.hostname())
  return verdict.ok ? undefined : verdict.message
}
