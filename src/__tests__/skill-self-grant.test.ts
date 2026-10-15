import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  gitCommonDir,
  linkedWorktreeRoot,
  REPO_SKILLS_RULE,
  type SelfGrantPin,
  selfGrant,
} from '../agents/skill-self-grant.js'

/**
 * CC-694 b. The hook may answer `allow` for a repo skill write without the owner, so what
 * these prove is the boundary: only Write/Edit/MultiEdit, only under the linked worktree's
 * own `.claude/skills/<name>/`, and never through a symlink that leaves it.
 */

const tmpDirs: string[] = []

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return fs.realpathSync(dir)
}

function initRepo(): string {
  const repo = tmpDir('agent-chat-skill-repo-')
  gitIn(repo, 'init', '-q')
  gitIn(repo, 'commit', '-q', '--allow-empty', '-m', 'init')
  return repo
}

function gitIn(repo: string, ...args: string[]): void {
  execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
    stdio: 'ignore',
  })
}

/** A linked worktree made by `git worktree add`, so git itself registers it. */
function linkedWorktree(repo = initRepo()): string {
  const root = path.join(tmpDir('agent-chat-skill-wt-'), 'wt')
  gitIn(repo, 'worktree', 'add', '-q', '-b', path.basename(path.dirname(root)), root)
  return fs.realpathSync(root)
}

/** The pin launch records: the root and the common dir git resolves for it then. */
function pinOf(root: string): SelfGrantPin {
  return { root, commonDir: gitCommonDir(root) ?? path.join(root, '.git') }
}

/** Swap `root` for a symlink to `target` after the pin was taken, as a planted link would. */
function swapForLink(root: string, target: string): void {
  fs.renameSync(root, `${root}.aside`)
  fs.symlinkSync(target, root)
}

/** Hand-written pointers that mimic a registered worktree without git knowing it. */
function forgedWorktree(): string {
  const root = tmpDir('agent-chat-skill-forged-')
  const adminDir = path.join(tmpDir('agent-chat-skill-fake-'), '.git', 'worktrees', 'wt')
  fs.mkdirSync(adminDir, { recursive: true })
  fs.writeFileSync(path.join(adminDir, 'gitdir'), `${path.join(root, '.git')}\n`)
  fs.writeFileSync(path.join(root, '.git'), `gitdir: ${adminDir}\n`)
  return root
}

/** A submodule: `.git` is a file too, but its module dir has no `gitdir` back-pointer. */
function submodule(): string {
  const root = tmpDir('agent-chat-skill-sub-')
  const moduleDir = path.join(tmpDir('agent-chat-skill-super-'), '.git', 'modules', 'sub')
  fs.mkdirSync(moduleDir, { recursive: true })
  fs.writeFileSync(path.join(root, '.git'), `gitdir: ${moduleDir}\n`)
  return root
}

function mainCheckout(): string {
  const root = tmpDir('agent-chat-skill-main-')
  fs.mkdirSync(path.join(root, '.git'))
  return root
}

function write(filePath: string): { file_path: string; content: string } {
  return { file_path: filePath, content: '---\nname: probe\n---\n' }
}

afterEach(() => {
  vi.unstubAllEnvs()
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('self-granting a repo skill write in the own worktree', () => {
  it('allows Write, Edit and MultiEdit of a new skill file', () => {
    const root = linkedWorktree()
    const skillFile = path.join(root, '.claude', 'skills', 'titan-floor', 'SKILL.md')

    expect(selfGrant(pinOf(root), 'Write', write(skillFile))).toBe(true)
    expect(selfGrant(pinOf(root), 'Edit', { file_path: skillFile, old_string: 'a', new_string: 'b' })).toBe(
      true,
    )
    expect(selfGrant(pinOf(root), 'MultiEdit', { file_path: skillFile, edits: [] })).toBe(true)
  })

  it('allows a nested file in an existing skill directory', () => {
    const root = linkedWorktree()
    const refs = path.join(root, '.claude', 'skills', 'probe', 'references')
    fs.mkdirSync(refs, { recursive: true })

    expect(selfGrant(pinOf(root), 'Write', write(path.join(refs, 'notes.md')))).toBe(true)
  })

  it('refuses a root given through a symlink, even to its own worktree', () => {
    const root = linkedWorktree()
    const alias = path.join(tmpDir('agent-chat-skill-alias-'), 'wt')
    fs.symlinkSync(root, alias)
    const pin = { root: alias, commonDir: pinOf(root).commonDir }

    expect(selfGrant(pin, 'Write', write(path.join(root, '.claude/skills/probe/SKILL.md')))).toBe(false)
  })

  it('refuses a tree whose hand-written pointers git does not know', () => {
    const root = forgedWorktree()
    const skillFile = path.join(root, '.claude', 'skills', 'probe', 'SKILL.md')

    expect(selfGrant(pinOf(root), 'Write', write(skillFile))).toBe(false)
  })

  it('exports the owner-approved rule string as the opt-in switch', () => {
    expect(REPO_SKILLS_RULE).toBe('Edit(./.claude/skills/**)')
  })
})

describe('writes the self-grant still sends to the owner', () => {
  it('refuses a skill write after the worktree is swapped for a symlink to another real worktree', () => {
    const root = linkedWorktree()
    const pin = pinOf(root)
    const other = linkedWorktree()
    swapForLink(root, other)

    expect(selfGrant(pin, 'Write', write(path.join(root, '.claude/skills/probe/SKILL.md')))).toBe(false)
  })

  it('refuses after the swap even when the other worktree shares the pinned repository', () => {
    const repo = initRepo()
    const root = linkedWorktree(repo)
    const pin = pinOf(root)
    const sibling = linkedWorktree(repo)
    expect(gitCommonDir(sibling)).toBe(pin.commonDir)
    swapForLink(root, sibling)

    expect(selfGrant(pin, 'Write', write(path.join(root, '.claude/skills/probe/SKILL.md')))).toBe(false)
  })

  it("refuses when git's common dir for the root differs from the pinned one", () => {
    const root = linkedWorktree()
    const pin = { root, commonDir: pinOf(linkedWorktree()).commonDir }

    expect(selfGrant(pin, 'Write', write(path.join(root, '.claude/skills/probe/SKILL.md')))).toBe(false)
  })

  it('refuses other .claude files and subtrees', () => {
    const root = linkedWorktree()

    for (const rel of ['.claude/settings.json', '.claude/agents/x.md', '.claude/commands/x.md']) {
      expect(selfGrant(pinOf(root), 'Write', write(path.join(root, rel))), rel).toBe(false)
    }
  })

  it('refuses the skills directory itself and a file directly in it', () => {
    const root = linkedWorktree()

    expect(selfGrant(pinOf(root), 'Write', write(path.join(root, '.claude/skills/probe')))).toBe(false)
    expect(selfGrant(pinOf(root), 'Write', write(path.join(root, '.claude/skills/SKILL.md')))).toBe(false)
  })

  it('refuses a skill name Claude Code would not load', () => {
    const root = linkedWorktree()

    expect(selfGrant(pinOf(root), 'Write', write(path.join(root, '.claude/skills/.hidden/SKILL.md')))).toBe(
      false,
    )
  })

  it('refuses a path with a .. segment even when it would land in the subtree', () => {
    const root = linkedWorktree()
    const sneaky = `${root}/.claude/skills/probe/../probe/SKILL.md`

    expect(selfGrant(pinOf(root), 'Write', write(sneaky))).toBe(false)
  })

  it('refuses a relative file path', () => {
    const root = linkedWorktree()

    expect(selfGrant(pinOf(root), 'Write', write('.claude/skills/probe/SKILL.md'))).toBe(false)
  })

  it('refuses a second .claude segment below the skill directory', () => {
    const root = linkedWorktree()

    expect(
      selfGrant(pinOf(root), 'Write', write(path.join(root, '.claude/skills/x/.claude/settings.json'))),
    ).toBe(false)
    expect(
      selfGrant(pinOf(root), 'Write', write(path.join(root, '.claude/skills/x/.Claude/settings.json'))),
    ).toBe(false)
  })

  it('refuses a skill directory symlinked outside the worktree', () => {
    const root = linkedWorktree()
    const outside = tmpDir('agent-chat-skill-outside-')
    fs.mkdirSync(path.join(root, '.claude', 'skills'), { recursive: true })
    fs.symlinkSync(outside, path.join(root, '.claude', 'skills', 'escape'))

    expect(selfGrant(pinOf(root), 'Write', write(path.join(root, '.claude/skills/escape/SKILL.md')))).toBe(
      false,
    )
  })

  it('refuses a skill file that is a symlink outside the worktree', () => {
    const root = linkedWorktree()
    const outside = path.join(tmpDir('agent-chat-skill-outside-'), 'target.md')
    fs.writeFileSync(outside, 'x')
    const skillDir = path.join(root, '.claude', 'skills', 'probe')
    fs.mkdirSync(skillDir, { recursive: true })
    fs.symlinkSync(outside, path.join(skillDir, 'SKILL.md'))

    expect(selfGrant(pinOf(root), 'Write', write(path.join(skillDir, 'SKILL.md')))).toBe(false)
  })

  it('refuses a dangling symlink, whose write would create its target', () => {
    const root = linkedWorktree()
    const skillDir = path.join(root, '.claude', 'skills', 'probe')
    fs.mkdirSync(skillDir, { recursive: true })
    fs.symlinkSync(path.join(tmpDir('agent-chat-skill-outside-'), 'new.md'), path.join(skillDir, 'SKILL.md'))

    expect(selfGrant(pinOf(root), 'Write', write(path.join(skillDir, 'SKILL.md')))).toBe(false)
  })

  it('refuses a skill write into another worktree', () => {
    const root = linkedWorktree()
    const other = linkedWorktree()

    expect(selfGrant(pinOf(root), 'Write', write(path.join(other, '.claude/skills/probe/SKILL.md')))).toBe(
      false,
    )
  })

  it('refuses when the root is a main checkout', () => {
    const root = mainCheckout()

    expect(selfGrant(pinOf(root), 'Write', write(path.join(root, '.claude/skills/probe/SKILL.md')))).toBe(
      false,
    )
  })

  it('refuses when the root is a submodule rather than a registered worktree', () => {
    const root = submodule()

    expect(selfGrant(pinOf(root), 'Write', write(path.join(root, '.claude/skills/probe/SKILL.md')))).toBe(
      false,
    )
  })

  it('refuses a worktree whose admin dir points back at a different checkout', () => {
    const root = linkedWorktree()
    const adminDir = fs.readFileSync(path.join(root, '.git'), 'utf8').slice('gitdir: '.length).trim()
    fs.writeFileSync(path.join(adminDir, 'gitdir'), `${path.join(linkedWorktree(), '.git')}\n`)

    expect(selfGrant(pinOf(root), 'Write', write(path.join(root, '.claude/skills/probe/SKILL.md')))).toBe(
      false,
    )
  })

  it('refuses a skill file hard-linked to a file outside the worktree', () => {
    const root = linkedWorktree()
    const outside = path.join(tmpDir('agent-chat-skill-outside-'), 'target.md')
    fs.writeFileSync(outside, 'x')
    const skillDir = path.join(root, '.claude', 'skills', 'probe')
    fs.mkdirSync(skillDir, { recursive: true })
    fs.linkSync(outside, path.join(skillDir, 'SKILL.md'))

    expect(selfGrant(pinOf(root), 'Edit', write(path.join(skillDir, 'SKILL.md')))).toBe(false)
  })

  it('allows editing an existing skill file with a single link', () => {
    const root = linkedWorktree()
    const skillFile = path.join(root, '.claude', 'skills', 'probe', 'SKILL.md')
    fs.mkdirSync(path.dirname(skillFile), { recursive: true })
    fs.writeFileSync(skillFile, 'x')

    expect(selfGrant(pinOf(root), 'Edit', write(skillFile))).toBe(true)
  })

  it('refuses when the root does not exist', () => {
    const root = path.join(tmpDir('agent-chat-skill-gone-'), 'missing')

    expect(selfGrant(pinOf(root), 'Write', write(path.join(root, '.claude/skills/probe/SKILL.md')))).toBe(
      false,
    )
  })

  it('refuses tools other than Write, Edit and MultiEdit', () => {
    const root = linkedWorktree()
    const skillFile = path.join(root, '.claude/skills/probe/SKILL.md')

    expect(selfGrant(pinOf(root), 'Bash', { command: `echo x > ${skillFile}`, file_path: skillFile })).toBe(
      false,
    )
    expect(selfGrant(pinOf(root), 'NotebookEdit', { file_path: skillFile })).toBe(false)
  })

  it('refuses tool input without a string file_path', () => {
    const root = linkedWorktree()

    expect(selfGrant(pinOf(root), 'Write', undefined)).toBe(false)
    expect(selfGrant(pinOf(root), 'Write', { file_path: 42 })).toBe(false)
  })
})

/** The admin dir git keeps for a linked worktree, under the repository's `.git/worktrees`. */
function adminDirOf(root: string): string {
  return fs.readFileSync(path.join(root, '.git'), 'utf8').slice('gitdir: '.length).trim()
}

describe('git variables inherited by the hook or launch process (CC-1205)', () => {
  it("refuses a forged worktree even when GIT_DIR names a registered sibling's admin dir", () => {
    const sibling = linkedWorktree()
    const forged = forgedWorktree()
    vi.stubEnv('GIT_DIR', adminDirOf(sibling))
    const pin = pinOf(forged)

    expect(linkedWorktreeRoot(forged)).toBeUndefined()
    expect(selfGrant(pin, 'Write', write(path.join(forged, '.claude/skills/probe/SKILL.md')))).toBe(false)
  })

  it("resolves the worktree's own common dir when GIT_DIR names another repository", () => {
    const repo = initRepo()
    const root = linkedWorktree(repo)
    const other = initRepo()
    vi.stubEnv('GIT_DIR', path.join(other, '.git'))

    expect(gitCommonDir(root)).toBe(path.join(repo, '.git'))
  })

  it('still self-grants in the pinned worktree when GIT_COMMON_DIR names another repository', () => {
    const root = linkedWorktree()
    const pin = pinOf(root)
    vi.stubEnv('GIT_COMMON_DIR', path.join(initRepo(), '.git'))

    expect(selfGrant(pin, 'Write', write(path.join(root, '.claude/skills/probe/SKILL.md')))).toBe(true)
  })

  it('scrubs every GIT_ prefixed variable, not only GIT_DIR and GIT_COMMON_DIR', () => {
    const root = linkedWorktree()
    const pin = pinOf(root)
    vi.stubEnv('GIT_CONFIG_COUNT', '1')

    expect(selfGrant(pin, 'Write', write(path.join(root, '.claude/skills/probe/SKILL.md')))).toBe(true)
  })
})
