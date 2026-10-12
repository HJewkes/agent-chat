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
 * resolves anywhere but the subtree.
 */

export const REPO_SKILLS_RULE = 'Edit(./.claude/skills/**)'

const WRITE_TOOLS: ReadonlySet<string> = new Set(['Write', 'Edit', 'MultiEdit'])

/** Claude Code's own skill-name rule, so a name it would not load is not granted either. */
const SKILL_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/

export function selfGrant(root: string, toolName: string, toolInput: unknown): boolean {
  if (!WRITE_TOOLS.has(toolName)) return false
  const filePath = fileArg(toolInput)
  if (filePath === undefined) return false
  const realRoot = linkedWorktreeRoot(root)
  if (realRoot === undefined) return false
  const resolved = resolveThroughLinks(filePath)
  return resolved !== undefined && isUnderSkillDir(realRoot, resolved)
}

function fileArg(toolInput: unknown): string | undefined {
  if (typeof toolInput !== 'object' || toolInput === null) return undefined
  const filePath = (toolInput as { file_path?: unknown }).file_path
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) return undefined
  if (filePath.split(/[\\/]/).includes('..')) return undefined
  return filePath
}

/** A main checkout has a `.git` directory; only a linked worktree's is a file. */
function linkedWorktreeRoot(root: string): string | undefined {
  try {
    const realRoot = fs.realpathSync(root)
    return fs.lstatSync(path.join(realRoot, '.git')).isFile() ? realRoot : undefined
  } catch {
    return undefined
  }
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
