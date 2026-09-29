import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { trustGap } from '../agents/trust.js'

/** CC-157: nine agents died on the trust dialog while the warning read the wrong file. */

let home: string

const git = (cwd: string, ...args: string[]): void => {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'ignore' })
}

const trusting = (file: string, ...dirs: string[]): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const projects = Object.fromEntries(dirs.map(dir => [dir, { hasTrustDialogAccepted: true }]))
  fs.writeFileSync(file, JSON.stringify({ projects }))
}

/** A real repo with a linked worktree under `.worktrees/`, the layout `worktree` isolation cuts. */
function repoWithWorktree(): { repo: string; worktree: string } {
  const repo = path.join(home, 'projects', 'repo')
  fs.mkdirSync(repo, { recursive: true })
  git(repo, 'init', '-q')
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'root')
  const worktree = path.join(repo, '.worktrees', 'agent')
  git(repo, 'worktree', 'add', '-q', '-b', 'agent', worktree)
  return { repo, worktree }
}

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-trust-')))
  vi.spyOn(os, 'homedir').mockReturnValue(home)
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(home, { recursive: true, force: true })
})

describe('the spawn trust warning', () => {
  it('stays quiet for a worktree cut under a trusted repo', () => {
    const { repo, worktree } = repoWithWorktree()
    const configDir = path.join(home, '.claude')
    trusting(path.join(configDir, '.claude.json'), repo)

    expect(trustGap(worktree, 'waiting', configDir)).toBeUndefined()
  })

  it('stays quiet for a subfolder of a trusted folder outside git', () => {
    const parent = path.join(home, 'notes')
    const child = path.join(parent, 'deep', 'er')
    fs.mkdirSync(child, { recursive: true })
    trusting(path.join(home, '.claude.json'), parent)

    expect(trustGap(child)).toBeUndefined()
  })

  it("reads the config dir's own .claude.json, not the home one", () => {
    const dir = path.join(home, 'work')
    fs.mkdirSync(dir)
    const configDir = path.join(home, '.claude-profiles', 'agents')
    trusting(path.join(home, '.claude.json'), dir)
    trusting(path.join(configDir, '.claude.json'))

    const warning = trustGap(dir, 'waiting', configDir)

    expect(warning).toContain(`no accepted trust entry for ${dir} in ${path.join(configDir, '.claude.json')}`)
  })

  it('reads the home .claude.json when no config dir is set', () => {
    const dir = path.join(home, 'work')
    fs.mkdirSync(dir)
    trusting(path.join(home, '.claude', '.claude.json'), dir)
    trusting(path.join(home, '.claude.json'))

    expect(trustGap(dir)).toContain(`in ${path.join(home, '.claude.json')}`)
  })

  it('still warns for a folder nothing trusts', () => {
    const { repo } = repoWithWorktree()
    const stranger = path.join(home, 'elsewhere')
    fs.mkdirSync(stranger)
    const configDir = path.join(home, '.claude')
    trusting(path.join(configDir, '.claude.json'), repo)

    const warning = trustGap(stranger, 'waiting', configDir)

    expect(warning).toMatch(/no accepted trust entry/)
    expect(warning).toMatch(/Do you trust the files in this folder\?/)
  })

  it('does not honour trust granted above the git root', () => {
    const { repo } = repoWithWorktree()
    const configDir = path.join(home, '.claude')
    trusting(path.join(configDir, '.claude.json'), path.join(home, 'projects'), home)

    expect(trustGap(repo, 'waiting', configDir)).toMatch(/no accepted trust entry/)
  })

  it('reads a legacy .config.json in the config dir ahead of .claude.json', () => {
    const dir = path.join(home, 'work')
    fs.mkdirSync(dir)
    const configDir = path.join(home, '.claude-profiles', 'agents')
    trusting(path.join(configDir, '.claude.json'), dir)
    trusting(path.join(configDir, '.config.json'))

    expect(trustGap(dir, 'waiting', configDir)).toContain(`in ${path.join(configDir, '.config.json')}`)
  })
})
