import path from 'node:path'
import { accountConfigPath, isTrustedUnder } from '../trust.js'

/**
 * The one place trust is a gate rather than a diagnosis (`trust.ts`): an
 * unattended spawn into an untrusted folder hangs on a dialog nobody answers,
 * so the tick refuses it up front. Unreadable config refuses too.
 */

/** Where a tick-spawned agent's worktree would be cut, which does not exist yet at plan time. */
export const worktreePathFor = (repo: string, agentName: string): string =>
  path.join(repo, '.worktrees', agentName)

export function trustRefusal(cwd: string, configDir: string): string | undefined {
  const file = accountConfigPath(configDir)
  const trusted = isTrustedUnder(cwd, file)
  if (trusted === true) return undefined
  if (trusted === undefined) return `cannot read ${file}, so trust for ${cwd} is unknown`
  return `no accepted trust entry for ${cwd} or any parent in ${file}`
}
