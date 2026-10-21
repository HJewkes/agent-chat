import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { reclaim, sweepWorktrees } from '../agents/isolation/sweep.js'
import { RECLAIM_GRACE_MS } from '../agents/isolation/worktree.js'
import { runtimeStatePath, writeRuntimeState } from '../agents/launch-files.js'

/**
 * TP-640 P2. `sweepWorktrees` classifies a tree, and `reclaim` acts on that
 * report later. Work written in between must not be destroyed on the strength
 * of a stale "reclaimable".
 */

const branch = 'agent-chat/worker'
const agentId = 'synthetic-reclaim-adapter'
const tmpDirs: string[] = []

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()

beforeEach(() => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reclaim-adapter-home-')))
  tmpDirs.push(home)
  process.env.AGENT_CHAT_HOME = home
})

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function makeRepo(): string {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reclaim-adapter-')))
  tmpDirs.push(repo)
  git(repo, ['init', '-q', '-b', 'main'])
  for (const [key, value] of [
    ['user.email', 'test@example.com'],
    ['user.name', 'Test'],
    ['commit.gpgsign', 'false'],
  ] as const)
    git(repo, ['config', key, value])
  fs.writeFileSync(path.join(repo, 'README.md'), 'owned seed\n')
  git(repo, ['add', '.'])
  git(repo, ['commit', '-qm', 'seed'])
  return repo
}

async function sweptReclaimable() {
  const repo = makeRepo()
  const base = git(repo, ['rev-parse', 'HEAD'])
  const tree = path.join(repo, '.worktrees', 'worker')
  git(repo, ['worktree', 'add', '-qb', branch, tree])
  writeRuntimeState(agentId, {
    handle: { surface: 'headless' },
    isolation: 'worktree',
    allocation: { cwd: tree, ref: { branch, worktree: tree, gitRoot: repo, base } },
  })
  const report = await sweepWorktrees([], {
    roots: [repo],
    list: async cwd => git(cwd, ['worktree', 'list', '--porcelain']),
    now: () => RECLAIM_GRACE_MS + 1,
  })
  expect(report).toHaveLength(1)
  const entry = report[0]!
  expect(entry).toMatchObject({ gitRoot: repo, worktree: tree, branch, status: 'reclaimable' })
  return { repo, tree, entry }
}

function writeLateWork(kind: 'untracked' | 'commit', repo: string, tree: string): string {
  const note = path.join(tree, 'late-owned-note.txt')
  fs.writeFileSync(note, 'harmless owned note\n')
  if (kind === 'commit') {
    git(tree, ['add', 'late-owned-note.txt'])
    git(tree, ['commit', '-qm', 'owned late commit'])
    expect(git(repo, ['rev-list', '--count', `main..${branch}`])).toBe('1')
  }
  return note
}

it.each(['untracked', 'commit'] as const)(
  'refuses to reclaim a tree that gained %s work after the sweep, and keeps it',
  async kind => {
    const { repo, tree, entry } = await sweptReclaimable()
    const note = writeLateWork(kind, repo, tree)
    const tip = git(repo, ['rev-parse', branch])

    const result = await reclaim(entry)

    expect(result.ok).toBe(false)
    expect(result.reason).toContain(branch)
    expect(fs.readFileSync(note, 'utf8')).toBe('harmless owned note\n')
    expect(git(repo, ['rev-parse', branch])).toBe(tip)
    expect(fs.existsSync(runtimeStatePath(agentId))).toBe(true)
  },
)

it('reclaims a tree that is still clean when reclaim runs', async () => {
  const { repo, tree, entry } = await sweptReclaimable()

  const result = await reclaim(entry)

  expect(result).toEqual({ ok: true })
  expect(fs.existsSync(tree)).toBe(false)
  expect(git(repo, ['branch', '--list', branch])).toBe('')
  expect(fs.existsSync(runtimeStatePath(agentId))).toBe(false)
})

it('still discards late work when a human forces the reclaim', async () => {
  const { repo, tree, entry } = await sweptReclaimable()
  writeLateWork('untracked', repo, tree)

  expect(await reclaim(entry, { force: true })).toEqual({ ok: true })
  expect(fs.existsSync(tree)).toBe(false)
})
