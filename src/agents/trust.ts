import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Why a pane can sit on a bare prompt forever with nothing wrong anywhere else.
 *
 * Claude Code records one entry per working directory in `~/.claude.json` and
 * asks "Do you trust the files in this folder?" the first time it runs in a
 * directory that has none. In a spawned pane there is nobody to answer, so the
 * process blocks before it loads a single MCP server — no registration, no
 * transcript, no exit code, and a spawn that reported success six hours ago.
 *
 * `worktree` isolation walks into this every time: a freshly created worktree is
 * by definition a path Claude Code has never been run in. Checked live on this
 * machine — 70 project entries, not one of them a `.worktrees/` path.
 *
 * A DIAGNOSIS, never a gate. Nothing here is consulted before a launch: the file
 * is Claude Code's private state, its shape is not a contract, and refusing a
 * spawn on a field that may be renamed tomorrow trades a slow failure for a
 * total one. It is read only once a spawn has already failed, to turn "did not
 * register in time" into a sentence naming the likely cause.
 */

const TRUST_FIELD = 'hasTrustDialogAccepted'

interface ClaudeConfig {
  projects?: Record<string, { [TRUST_FIELD]?: boolean } | undefined>
}

export const claudeConfigPath = (): string => path.join(os.homedir(), '.claude.json')

/**
 * The sentence to add when `cwd` has no accepted trust entry, or undefined when
 * it has one — and also when the config cannot be read at all, which is the
 * important half. An unreadable or reshaped config means this check knows
 * nothing, and reporting a cause it cannot support would send a reader after the
 * wrong thing.
 */
export function trustGap(
  cwd: string,
  /** `exited` drops the "it is probably waiting" claim: a process that is gone is not waiting. */
  outcome: 'waiting' | 'exited' = 'waiting',
  configFile = claudeConfigPath(),
): string | undefined {
  let config: ClaudeConfig
  try {
    config = JSON.parse(fs.readFileSync(configFile, 'utf8')) as ClaudeConfig
  } catch {
    return undefined
  }
  if (config.projects?.[cwd]?.[TRUST_FIELD] === true) return undefined
  const symptom =
    outcome === 'waiting'
      ? 'so it is probably waiting on "Do you trust the files in this folder?" — a prompt a spawned pane has nobody to answer'
      : 'and it will not run in a directory it has not been trusted in'
  return (
    `Claude Code has no accepted trust entry for ${cwd} in ${configFile}, ${symptom}. ` +
    'Run `claude` there once and accept it, or spawn into a directory already trusted.'
  )
}
