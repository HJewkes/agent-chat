import { createHmac, timingSafeEqual } from 'node:crypto'
import { launcherKeyPath, ownLauncherKeyPath } from '../paths.js'
import { readToken } from './token.js'

/**
 * CC-1063: a launcher proves it holds its host's secret by an HMAC over a
 * single-use broker nonce, so the name cannot be claimed by whoever connects in
 * the gap after the real launcher drops, and a captured hello cannot be replayed.
 * The secret lives only in 0600 files, never in env, so a successor's launch
 * environment cannot carry it.
 */

const PROOF_LABEL = 'agent-chat host_hello v1'

export const helloProof = (key: string, host: string, nonce: string): string =>
  createHmac('sha256', key).update(`${PROOF_LABEL}\n${host.toLowerCase()}\n${nonce}`).digest('hex')

export const proofMatches = (key: string, host: string, nonce: string, proof: unknown): boolean => {
  if (typeof proof !== 'string') return false
  const expected = helloProof(key, host, nonce)
  return proof.length === expected.length && timingSafeEqual(Buffer.from(proof), Buffer.from(expected))
}

/** Null for a missing or blank key file; a path-like host has no key rather than throwing. */
export const brokerKeyFor = (host: string): string | null => {
  try {
    return readToken(launcherKeyPath(host))
  } catch {
    return null
  }
}

export const ownKey = (): string | null => readToken(ownLauncherKeyPath())
