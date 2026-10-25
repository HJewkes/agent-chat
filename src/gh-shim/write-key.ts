import fs from 'node:fs'
import path from 'node:path'
import { readLauncherKey } from '../broker/launcher-key.js'
import { ensureToken } from '../broker/token.js'
import { AGENT_ID_ENV } from '../launch-identity.js'
import { ghWriteKeysDir } from '../paths.js'
import { GH_WRITE_TICKET_ENV, mintTicket } from './ticket.js'

/** An agent id names one file inside the keys dir, never a path out of it. */
const keyFile = (root: string, agentId: string): string | null =>
  agentId !== '' && agentId !== '.' && agentId !== '..' && path.basename(agentId) === agentId
    ? path.join(root, agentId)
    : null

/**
 * Mints a fresh key for this launch, replacing any a crashed launch left behind, and returns the
 * root the shim is baked with. run-agent calls it, not the broker, so it runs from fresh dist.
 */
export function writeGhWriteKey(agentId: string, root: string = ghWriteKeysDir()): string {
  const file = keyFile(root, agentId)
  if (file === null) throw new Error(`gh-write key: unusable agent id ${JSON.stringify(agentId)}`)
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  fs.chmodSync(root, 0o700)
  fs.rmSync(file, { force: true })
  ensureToken(file)
  return root
}

/** Null for a missing, blank, symlinked or group/other-readable key, as the launcher key is read. */
export function readGhWriteKey(root: string, agentId: string): string | null {
  const file = keyFile(root, agentId)
  return file === null ? null : readLauncherKey(file)
}

export function removeGhWriteKey(agentId: string, root: string = ghWriteKeysDir()): void {
  const file = keyFile(root, agentId)
  if (file !== null) fs.rmSync(file, { force: true })
}

/** The ticket env for one gh start, or none outside a launch that holds a usable key. */
export function ghWriteTicketEnv(
  env: NodeJS.ProcessEnv,
  argv: string[],
  now: number,
  root: string = ghWriteKeysDir(),
): Record<string, string> {
  const agentId = env[AGENT_ID_ENV]
  if (agentId === undefined) return {}
  const key = readGhWriteKey(root, agentId)
  return key === null ? {} : { [GH_WRITE_TICKET_ENV]: mintTicket(key, agentId, argv, now) }
}
