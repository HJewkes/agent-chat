import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assessDiff } from '../agents/burndown/review-diff.js'

let dir: string

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' })

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-diff-')))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('assessDiff', () => {
  it('finds nothing to review when the worktree is gone', () => {
    const verdict = assessDiff(path.join(dir, 'missing'))

    expect(verdict).toEqual({ reviewable: false, reason: expect.stringContaining('no longer exists') })
  })

  it('reviews when no base ref resolves, rather than assuming there is no diff', () => {
    git(dir, 'init', '-q', '-b', 'work')
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'one')

    const verdict = assessDiff(dir)

    expect(verdict).toEqual({ reviewable: true, reason: expect.stringContaining('no base ref') })
  })

  it('skips review for a clean worktree level with main', () => {
    git(dir, 'init', '-q', '-b', 'main')
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'one')

    expect(assessDiff(dir).reviewable).toBe(false)
  })

  it('reviews commits ahead of main and uncommitted changes', () => {
    git(dir, 'init', '-q', '-b', 'main')
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'one')
    git(dir, 'checkout', '-q', '-b', 'agent-chat/bd-x')
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'two')

    expect(assessDiff(dir)).toEqual({ reviewable: true, reason: '1 commit(s) ahead of main' })
    fs.writeFileSync(path.join(dir, 'new.txt'), 'x')
    expect(assessDiff(dir).reason).toBe('worktree has uncommitted changes')
  })
})
