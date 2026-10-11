import fs from 'node:fs'
import path from 'node:path'
import { home } from '../../paths.js'
import { resolveClaudeBin } from '../claude-bin.js'
import {
  claudeConfigPath,
  hasTrustEntry,
  plannedWorktreeTrustKeys,
  VERIFIED_TRUST_RULE_VERSIONS,
} from '../trust.js'

/**
 * The one place trust is a gate rather than a diagnosis (`trust.ts`): an
 * unattended spawn into an untrusted folder hangs on a dialog nobody answers,
 * so the tick refuses it up front. Anything it cannot determine refuses too.
 */

/** Where a tick-spawned agent's worktree would be cut, which does not exist yet at plan time. */
export const worktreePathFor = (repo: string, agentName: string): string =>
  path.join(repo, '.worktrees', agentName)

/** The version of the `claude` a spawn would run, read from a native install's `versions/<semver>` target. */
export function installedClaudeVersion(): string | undefined {
  const resolution = resolveClaudeBin({ env: process.env, stateDir: home() })
  if ('error' in resolution) return undefined
  try {
    const version = path.basename(fs.realpathSync(resolution.bin))
    return /^\d+\.\d+\.\d+$/.test(version) ? version : undefined
  } catch {
    return undefined
  }
}

/** Fails closed on a release nobody has read the trust rule of, and names the step that would admit it. */
const unverifiedVersionRefusal = (cliVersion: string): string =>
  `installed Claude Code ${cliVersion} is not one of ${Object.keys(VERIFIED_TRUST_RULE_VERSIONS).join(', ')}, the releases whose trust rule this gate reproduces. ` +
  `Owner step: run \`node scripts/verify-trust-rule.mjs ${cliVersion}\`, compare its output with (a) to (d) in docs/trust-rule-versions.md, ` +
  'and if all four match add the version to VERIFIED_TRUST_RULE_VERSIONS in src/agents/trust.ts with a table row'

export function trustRefusal(
  repo: string,
  cwd: string,
  configDir: string,
  cliVersion: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (env.CLAUDE_CODE_CUSTOM_OAUTH_URL)
    return 'CLAUDE_CODE_CUSTOM_OAUTH_URL is set, so Claude Code reads a differently named trust config file than this gate does'
  if (cliVersion === undefined)
    return 'cannot determine the installed Claude Code version, so its trust rule is unknown'
  if (!Object.hasOwn(VERIFIED_TRUST_RULE_VERSIONS, cliVersion)) return unverifiedVersionRefusal(cliVersion)
  const keys = plannedWorktreeTrustKeys(repo, cwd)
  if (keys === undefined) return `${repo} is not inside a git repository, so no worktree can be cut there`
  const file = claudeConfigPath(configDir)
  const trusted = hasTrustEntry(keys, file)
  if (trusted === true) return undefined
  if (trusted === undefined) return `cannot read ${file}, so trust for ${cwd} is unknown`
  return `no accepted trust entry for ${keys.join(' or ')} in ${file}`
}
