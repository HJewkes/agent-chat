import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { tokenPath } from '../paths.js'

/**
 * The shared secret for `/api/*`, read from disk or minted on first start.
 *
 * WHY A FILE AND NOT AN ENV VAR OR A PROCESS-LIFETIME RANDOM. The token has to
 * survive a broker restart, because the browser holding a dashboard tab was
 * handed its copy at page load and would otherwise start 403ing until someone
 * reloaded. It also has to be readable by a *different* process — that is the
 * whole mechanism: the file is `0600`, so the broker (which runs as the owning
 * user) can inject it into the served HTML and another local OS account cannot
 * read it at all. That asymmetry IS the auth.
 *
 * Persisted rather than regenerated for the same reason the socket path is
 * stable: the port is an accessory, and an accessory that invalidates every open
 * tab on restart is worse than no accessory.
 */

/** 256 bits, hex — long enough that guessing is not a threat model worth naming. */
const TOKEN_BYTES = 32

export function ensureToken(file: string = tokenPath()): string {
  const existing = readToken(file)
  if (existing !== null) return existing

  const token = crypto.randomBytes(TOKEN_BYTES).toString('hex')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  // `mode` on writeFileSync only applies when the file is CREATED, and it is
  // masked by umask besides. The explicit chmod is what actually guarantees
  // 0600, and it is the only line here that carries the security property.
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600 })
  fs.chmodSync(file, 0o600)
  return token
}

/**
 * The token as written, or null if there isn't a usable one.
 *
 * A truncated or empty file is treated as absent rather than as an empty token:
 * an empty string would compare equal to a missing header and silently disable
 * the auth it exists to provide.
 */
export function readToken(file: string = tokenPath()): string | null {
  try {
    const raw = fs.readFileSync(file, 'utf8').trim()
    return raw === '' ? null : raw
  } catch {
    return null
  }
}
