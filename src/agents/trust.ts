import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Why a pane can sit on a bare prompt forever with nothing wrong anywhere else.
 *
 * Claude Code records one entry per working directory in its global config and
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

/**
 * The global config the CLI reads, as its 2.1.284 `getGlobalClaudeFile`: a legacy
 * `.config.json` in the config home wins, else `.claude.json` in `CLAUDE_CONFIG_DIR`,
 * else in the home directory. `configDir` is used whenever it is defined, so an empty string
 * does not fall back to the home directory. `~/.claude` as a config dir reads `~/.claude/.claude.json`.
 */
export function claudeConfigPath(configDir?: string): string {
  const legacy = path.join(configDir ?? path.join(os.homedir(), '.claude'), '.config.json')
  return fs.existsSync(legacy) ? legacy : path.join(configDir ?? os.homedir(), '.claude.json')
}

/** Whether `cwd` is trusted by the CLI's rule, or undefined when the config cannot be read. */
export function isTrusted(cwd: string, configDir?: string): boolean | undefined {
  return hasTrustEntry(trustKeysFor(cwd), claudeConfigPath(configDir))
}

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
  /** The agent's `CLAUDE_CONFIG_DIR`; undefined means the CLI's default location. */
  configDir?: string,
): string | undefined {
  if (isTrusted(cwd, configDir) !== false) return undefined
  const symptom =
    outcome === 'waiting'
      ? 'so it is probably waiting on "Do you trust the files in this folder?" — a prompt a spawned pane has nobody to answer'
      : 'and it will not run in a directory it has not been trusted in'
  return (
    `Claude Code has no accepted trust entry for ${cwd} in ${claudeConfigPath(configDir)}, ${symptom}. ` +
    'Run `claude` there once and accept it, or spawn into a directory already trusted.'
  )
}

/**
 * Claude Code's own startup trust check, reproduced from the bundled 2.1.284 CLI
 * (`~/.local/share/claude/versions/2.1.284`, minified `sF`, `VRe`, `hS`, `yS`, `Qt`).
 * A folder is trusted when either key below has `hasTrustDialogAccepted`:
 * the canonical repo root (a linked worktree resolves through `.git` to its main
 * checkout), or the folder itself or an ancestor no higher than its git root.
 * Any other release may differ, so callers must refuse a version not listed in
 * `VERIFIED_TRUST_RULE_VERSIONS`.
 */
export const TRUST_RULE_BASELINE_CLI_VERSION = '2.1.284'

/**
 * Releases whose startup trust rule was read from their own bundle, each mapped to the
 * release whose rule it was compared against. Adding one needs the check recorded in
 * `docs/trust-rule-versions.md`; `scripts/verify-trust-rule.mjs` prints the code to read.
 */
export const VERIFIED_TRUST_RULE_VERSIONS: Readonly<Record<string, string>> = Object.freeze({
  [TRUST_RULE_BASELINE_CLI_VERSION]: TRUST_RULE_BASELINE_CLI_VERSION,
  '2.1.287': TRUST_RULE_BASELINE_CLI_VERSION,
  '2.1.288': TRUST_RULE_BASELINE_CLI_VERSION,
  '2.1.289': TRUST_RULE_BASELINE_CLI_VERSION,
  '2.1.290': '2.1.289',
  '2.1.291': '2.1.290',
  '2.1.292': '2.1.291',
  '2.1.295': '2.1.292',
})

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

/**
 * The keys the CLI tries for an existing folder: its canonical repo root, then
 * the folder and each ancestor up to its git root, or up to `/` outside git.
 */
export function trustKeysFor(cwd: string): string[] {
  const dir = path.resolve(cwd)
  const gitRoot = gitRootOf(dir)
  const keys = gitRoot === undefined ? [] : [canonicalRootOf(gitRoot)]
  for (let at = dir; ; at = path.dirname(at)) {
    keys.push(at)
    if (at === gitRoot || at === path.dirname(at)) break
  }
  return keys.map(key => key.normalize('NFC'))
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
