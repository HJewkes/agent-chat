import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/**
 * CC-694: whether `agent-chat permission-hook` may answer `allow` itself for a file write
 * into the spawn's own repo skills.
 *
 * Claude Code guards `<project>/.claude/skills` with a safety check that runs after the
 * allow rules, so the owner-approved rule below does not clear it on its own (observed on
 * 2.1.296, `docs/permission-relay.md` "Repo skill writes"). The rule is kept as the opt-in
 * switch: a spawn whose `--allowed-tools` carries it gets this decision instead of an owner
 * prompt, and only for `<root>/.claude/skills/<name>/…` inside a linked worktree.
 *
 * Skills are a prompt-injection persistence surface, which is why Claude Code guards them,
 * so every check here refuses on doubt: an unreadable root, a dangling symlink, a path that
 * resolves anywhere but the subtree, a file with a second hard link.
 *
 * Every call rechecks the launch pin: the root is still its own real path and git still
 * resolves the common dir recorded at launch, so a root swapped after launch for a symlink
 * to another worktree refuses (CC-1200). The check still runs before Claude Code writes,
 * so a process in the worktree could swap a checked directory for a symlink in between
 * (TOCTOU). Only the spawn itself works in its worktree, so this guards against mistakes
 * and planted links, not a racing writer.
 *
 * git runs with every inherited `GIT_*` variable removed, so it answers for the root
 * passed to `-C` and not for a repository the hook or launch process was pointed at.
 */

export const REPO_SKILLS_RULE = 'Edit(./.claude/skills/**)'

const WRITE_TOOLS: ReadonlySet<string> = new Set(['Write', 'Edit', 'MultiEdit'])

/** Claude Code's own skill-name rule, so a name it would not load is not granted either. */
const SKILL_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/

/** The worktree root and git common dir pinned when the hook was armed at launch. */
export interface SelfGrantPin {
  root: string
  commonDir: string
}

export function selfGrant(pin: SelfGrantPin, toolName: string, toolInput: unknown): boolean {
  if (!WRITE_TOOLS.has(toolName)) return false
  const filePath = fileArg(toolInput)
  if (filePath === undefined || !pinHolds(pin)) return false
  const resolved = resolveThroughLinks(filePath)
  return resolved !== undefined && isUnderSkillDir(pin.root, resolved) && !isHardLinked(resolved)
}

function pinHolds(pin: SelfGrantPin): boolean {
  if (realpathOrUndefined(pin.root) !== pin.root) return false
  if (linkedWorktreeRoot(pin.root) !== pin.root) return false
  return gitCommonDir(pin.root) === pin.commonDir
}

function realpathOrUndefined(p: string): string | undefined {
  try {
    return fs.realpathSync(p)
  } catch {
    return undefined
  }
}

/** A write through a second hard link edits a file that also lives outside the subtree. */
function isHardLinked(resolved: string): boolean {
  try {
    return fs.lstatSync(resolved).nlink > 1
  } catch {
    return false
  }
}

function fileArg(toolInput: unknown): string | undefined {
  if (typeof toolInput !== 'object' || toolInput === null) return undefined
  const filePath = (toolInput as { file_path?: unknown }).file_path
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) return undefined
  if (filePath.split(/[\\/]/).includes('..')) return undefined
  return filePath
}

/**
 * The real root when `root` is a linked worktree its repository has registered, else
 * undefined. A main checkout has a `.git` directory. A submodule also has a `.git` file,
 * but only a registered worktree's admin dir carries a `gitdir` file pointing back at it.
 */
export function linkedWorktreeRoot(root: string): string | undefined {
  try {
    const realRoot = fs.realpathSync(root)
    const dotGit = path.join(realRoot, '.git')
    if (!fs.lstatSync(dotGit).isFile()) return undefined
    const pointer = /^gitdir: (.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'))?.[1]?.trim()
    if (pointer === undefined) return undefined
    const adminDir = path.resolve(realRoot, pointer)
    const backPointer = fs.readFileSync(path.join(adminDir, 'gitdir'), 'utf8').trim()
    if (fs.realpathSync(path.resolve(adminDir, backPointer)) !== dotGit) return undefined
    return isRegisteredByGit(realRoot) ? realRoot : undefined
  } catch {
    return undefined
  }
}

/** The real common dir git resolves for `root`, the repository's `.git` for a linked worktree. */
export function gitCommonDir(root: string): string | undefined {
  try {
    const commonDir = execFileSync(
      'git',
      ['-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: gitEnv() },
    ).trim()
    return fs.realpathSync(commonDir)
  } catch {
    return undefined
  }
}

/** An inherited GIT_DIR or GIT_COMMON_DIR makes git answer for another repository than `-C` (CC-1205). */
function gitEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
}

/** Hand-written `.git` and admin files can mimic the pointers, so ask git where the admin dir sits. */
function isRegisteredByGit(realRoot: string): boolean {
  const [gitDir, commonDir] = execFileSync(
    'git',
    ['-C', realRoot, 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: gitEnv() },
  )
    .trim()
    .split('\n')
  if (gitDir === undefined || commonDir === undefined) return false
  const realAdmin = fs.realpathSync(gitDir)
  return realAdmin === path.join(fs.realpathSync(commonDir), 'worktrees', path.basename(realAdmin))
}

/**
 * The real path the write would land on: the nearest existing ancestor through `realpath`,
 * plus the part that does not exist yet. A dangling symlink exists for `lstat` but not for
 * `realpath`, and a write through it would create its target, so it refuses.
 */
function resolveThroughLinks(filePath: string): string | undefined {
  let existing = path.resolve(filePath)
  const tail: string[] = []
  while (!lstatExists(existing)) {
    const parent = path.dirname(existing)
    if (parent === existing) return undefined
    tail.unshift(path.basename(existing))
    existing = parent
  }
  try {
    return path.join(fs.realpathSync(existing), ...tail)
  } catch {
    return undefined
  }
}

function lstatExists(p: string): boolean {
  try {
    fs.lstatSync(p)
    return true
  } catch {
    return false
  }
}

function isUnderSkillDir(realRoot: string, resolved: string): boolean {
  const rel = path.relative(realRoot, resolved)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false
  const [dotClaude, skills, name, ...rest] = rel.split(path.sep)
  if (dotClaude !== '.claude' || skills !== 'skills') return false
  if (name === undefined || !SKILL_NAME.test(name) || rest.length === 0) return false
  return !rest.some(segment => segment.toLowerCase() === '.claude')
}
