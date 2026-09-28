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
/** Whether `cwd` has an accepted trust entry, or undefined when the config cannot be read. */
export function isTrusted(cwd: string, configFile = claudeConfigPath()): boolean | undefined {
  try {
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8')) as ClaudeConfig
    return config.projects?.[cwd]?.[TRUST_FIELD] === true
  } catch {
    return undefined
  }
}

export function trustGap(
  cwd: string,
  /** `exited` drops the "it is probably waiting" claim: a process that is gone is not waiting. */
  outcome: 'waiting' | 'exited' = 'waiting',
  configFile = claudeConfigPath(),
): string | undefined {
  if (isTrusted(cwd, configFile) !== false) return undefined
  const symptom =
    outcome === 'waiting'
      ? 'so it is probably waiting on "Do you trust the files in this folder?" — a prompt a spawned pane has nobody to answer'
      : 'and it will not run in a directory it has not been trusted in'
  return (
    `Claude Code has no accepted trust entry for ${cwd} in ${configFile}, ${symptom}. ` +
    'Run `claude` there once and accept it, or spawn into a directory already trusted.'
  )
}

/**
 * Claude Code's own startup trust check, reproduced from the bundled 2.1.284 CLI
 * (`~/.local/share/claude/versions/2.1.284`, minified `sF`, `VRe`, `hS`, `yS`, `Qt`).
 * A folder is trusted when either key below has `hasTrustDialogAccepted`:
 * the canonical repo root (a linked worktree resolves through `.git` to its main
 * checkout), or the folder itself or an ancestor no higher than its git root.
 * Any other release may differ, so callers must refuse on a version mismatch.
 */
export const TRUST_RULE_CLI_VERSION = '2.1.284'

/** The global config the CLI reads under `CLAUDE_CONFIG_DIR`: a legacy `.config.json` there wins over `.claude.json`. */
export function accountConfigPath(configDir: string): string {
  const legacy = path.join(configDir, '.config.json')
  return fs.existsSync(legacy) ? legacy : path.join(configDir, '.claude.json')
}

/** The nearest directory at or above `dir` holding a `.git` file or directory, as the CLI's `findGitRoot`. */
export function gitRootOf(dir: string): string | undefined {
  for (let at = path.resolve(dir); ; at = path.dirname(at)) {
    if (fs.existsSync(path.join(at, '.git'))) return at
    if (at === path.dirname(at)) return undefined
  }
}

const readTrimmed = (file: string): string => fs.readFileSync(file, 'utf8').trim()

/** The main checkout behind a linked worktree's git root, or the git root itself when any link fails to check out. */
export function canonicalRootOf(gitRoot: string): string {
  try {
    const pointer = readTrimmed(path.join(gitRoot, '.git'))
    if (!pointer.startsWith('gitdir:')) return gitRoot
    const gitDir = path.resolve(gitRoot, pointer.slice('gitdir:'.length).trim())
    const common = path.resolve(gitDir, readTrimmed(path.join(gitDir, 'commondir')))
    if (path.dirname(gitDir) !== path.join(common, 'worktrees')) return gitRoot
    if (path.resolve(gitDir, readTrimmed(path.join(gitDir, 'gitdir'))) !== path.join(gitRoot, '.git'))
      return gitRoot
    if (path.basename(common) !== '.git') return fs.existsSync(path.join(common, '.git')) ? gitRoot : common
    return path.dirname(common)
  } catch {
    return gitRoot
  }
}

/**
 * The keys the CLI would try for a worktree not yet cut from `repo`: the new
 * worktree is its own git root, so the ancestor walk ends at the worktree and
 * the repo counts only as the canonical root.
 */
export function plannedWorktreeTrustKeys(repo: string, worktree: string): string[] | undefined {
  const repoRoot = gitRootOf(repo)
  if (repoRoot === undefined) return undefined
  return [canonicalRootOf(repoRoot), path.resolve(worktree)].map(key => key.normalize('NFC'))
}

/** Whether any key has an accepted trust entry in `configFile`, or undefined when the config cannot be read. */
export function hasTrustEntry(keys: string[], configFile: string): boolean | undefined {
  let projects: ClaudeConfig['projects']
  try {
    projects = (JSON.parse(fs.readFileSync(configFile, 'utf8')) as ClaudeConfig).projects
  } catch {
    return undefined
  }
  return keys.some(key => projects?.[key]?.[TRUST_FIELD] === true)
}
