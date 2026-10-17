import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, expect, it } from 'vitest'

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reclaim-adapter-home-')))
process.env.AGENT_CHAT_HOME = home
const initialPath = process.env.PATH ?? ''
const roots: string[] = []
const branch = 'agent-chat/worker'
const agentId = 'synthetic-reclaim-adapter'
const records: unknown[] = []
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
const git = (cwd: string, args: string[]) =>
  execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()
afterEach(() => {
  process.env.PATH = initialPath
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(home, { recursive: true, force: true })
  fs.mkdirSync(home)
})
afterAll(() => {
  fs.writeFileSync(
    '/tmp/codex-reclaim-adapter-case-results.json',
    JSON.stringify({ utc: new Date().toISOString(), records }, null, 2) + '\n',
  )
  fs.rmSync(home, { recursive: true, force: true })
})

async function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reclaim-adapter-')))
  roots.push(root)
  const repo = path.join(root, 'repo')
  const bin = path.join(root, 'bin')
  fs.mkdirSync(repo)
  fs.mkdirSync(bin)
  const marker = path.join(root, 'fault')
  const calls = path.join(root, 'calls')
  fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\nexit 127\n', { mode: 0o755 })
  fs.writeFileSync(
    path.join(bin, 'git'),
    [
      '#!/bin/sh',
      'printf "%s\\n" "$*" >> ' + quote(calls),
      'if [ -f ' + quote(marker) + ' ]; then',
      '  fault=$(cat ' + quote(marker) + ')',
      '  if [ "$fault" = status ] && [ "$1" = status ]; then exit 1; fi',
      '  if [ "$fault" = ignored ] && [ "$1" = ls-files ]; then exit 1; fi',
      '  if [ "$fault" = remove ] && [ "$1" = worktree ] && [ "$2" = remove ]; then',
      '    printf "%s\\n" "synthetic removal refusal" >&2; exit 1',
      '  fi',
      'fi',
      'exec /usr/bin/git "$@"',
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
  process.env.PATH = bin + path.delimiter + initialPath
  // Fake provider and private runtime exist BEFORE business imports.
  const product = await import('../agents/isolation/sweep.js')
  const runtime = await import('../agents/launch-files.js')
  git(repo, ['init', '-q', '-b', 'main'])
  for (const [key, value] of [
    ['user.email', 'test@example.com'],
    ['user.name', 'Test'],
    ['commit.gpgsign', 'false'],
    ['maintenance.auto', 'false'],
    ['gc.auto', '0'],
  ] as const)
    git(repo, ['config', key, value])
  fs.writeFileSync(path.join(repo, 'README.md'), 'owned seed\n')
  git(repo, ['add', '.'])
  git(repo, ['commit', '-qm', 'seed'])
  const base = git(repo, ['rev-parse', 'HEAD'])
  const tree = path.join(repo, '.worktrees', 'worker')
  git(repo, ['worktree', 'add', '-qb', branch, tree])
  runtime.writeRuntimeState(agentId, {
    handle: { surface: 'headless' },
    isolation: 'worktree',
    allocation: { cwd: tree, ref: { branch, worktree: tree, gitRoot: repo, base, assigned: 'false' } },
  })
  const report = await product.sweepWorktrees([], {
    roots: [repo],
    list: async cwd => git(cwd, ['worktree', 'list', '--porcelain']),
    now: () => 120_001,
  })
  expect(report).toHaveLength(1)
  const entry = report[0]!
  expect(entry).toMatchObject({ gitRoot: repo, worktree: tree, branch, status: 'reclaimable' })
  return { root, repo, tree, base, marker, calls, product, runtime, entry }
}
it.each(['untracked', 'ignored', 'commit', 'status-error', 'ignored-error', 'clean', 'remove-error'])(
  'ordinary product reclaim preserves current allocation safety for %s',
  async kind => {
    const f = await fixture()
    const note = path.join(f.tree, 'late-owned-note.txt')
    if (kind === 'ignored')
      fs.appendFileSync(path.join(f.repo, '.git', 'info', 'exclude'), '\nlate-owned-note.txt\n')
    if (['untracked', 'ignored', 'commit'].includes(kind)) fs.writeFileSync(note, 'harmless owned note\n')
    if (kind === 'commit') {
      git(f.tree, ['add', 'late-owned-note.txt'])
      git(f.tree, ['commit', '-qm', 'owned late commit'])
      expect(git(f.tree, ['status', '--porcelain', '-uall'])).toBe('')
      expect(git(f.repo, ['rev-list', '--count', 'main..' + branch])).toBe('1')
    }
    if (kind === 'ignored') {
      expect(git(f.tree, ['status', '--porcelain', '-uall'])).toBe('')
      expect(git(f.tree, ['ls-files', '--others', '--ignored', '--exclude-standard'])).toBe(
        'late-owned-note.txt',
      )
    }
    const tip = git(f.repo, ['rev-parse', branch])
    if (kind === 'status-error') fs.writeFileSync(f.marker, 'status')
    if (kind === 'ignored-error') fs.writeFileSync(f.marker, 'ignored')
    if (kind === 'remove-error') fs.writeFileSync(f.marker, 'remove')
    const result = await f.product.reclaim(f.entry)
    const after = {
      tree: fs.existsSync(f.tree),
      note: fs.existsSync(note) ? fs.readFileSync(note, 'utf8') : null,
      branch: git(f.repo, ['branch', '--list', branch]).trim(),
      runtime: fs.existsSync(f.runtime.runtimeStatePath(agentId)),
    }
    records.push({ kind, result, tip, after })
    if (kind === 'clean') {
      expect(result).toEqual({ ok: true })
      expect(after).toEqual({ tree: false, note: null, branch: '', runtime: false })
    } else {
      expect(result).toEqual({ ok: false, reason: 'git would not release ' + f.tree })
      expect(after.tree).toBe(true)
      expect(after.runtime).toBe(true)
      expect(git(f.repo, ['rev-parse', branch])).toBe(tip)
      if (['untracked', 'ignored', 'commit'].includes(kind)) expect(after.note).toBe('harmless owned note\n')
    }
  },
)
