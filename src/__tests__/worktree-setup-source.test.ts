import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWorktreeStrategy } from '../agents/isolation/worktree.js'
import { SETUP_FILE, type SetupRunner } from '@titan-design/worktree'

const dirs: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})
const git = (args: string[], cwd: string): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()
function temp(): string {
  const p = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'setup-source-')))
  dirs.push(p)
  return p
}
function declaration(repo: string, text: string): void {
  fs.mkdirSync(path.join(repo, '.agent-chat'), { recursive: true })
  fs.writeFileSync(path.join(repo, SETUP_FILE), text)
}
const step = (command: string): string => JSON.stringify({ setup: { command: [command] } })
function repo(defaultDeclaration?: string): string {
  const p = temp()
  git(['init', '-b', 'main'], p)
  git(['config', 'user.email', 'test@example.com'], p)
  git(['config', 'user.name', 'Test'], p)
  git(['config', 'commit.gpgsign', 'false'], p)
  git(['config', 'maintenance.auto', 'false'], p)
  git(['config', 'gc.auto', '0'], p)
  fs.writeFileSync(path.join(p, 'README.md'), 'seed')
  if (defaultDeclaration !== undefined) declaration(p, defaultDeclaration)
  git(['add', '.'], p)
  git(['commit', '-qm', 'seed'], p)
  const origin = temp()
  git(['init', '--bare', '-b', 'main'], origin)
  git(['remote', 'add', 'origin', origin], p)
  git(['push', '-q', 'origin', 'main'], p)
  git(['switch', '-qc', 'parent'], p)
  declaration(p, step('requested-branch-command'))
  git(['add', '.'], p)
  git(['commit', '-qm', 'requested setup'], p)
  git(['push', '-q', 'origin', 'parent'], p)
  git(['switch', '-q', 'main'], p)
  return p
}
function recorder() {
  const run = vi.fn<SetupRunner>(async () => ({ exitCode: 0, timedOut: false, output: '' }))
  return run
}
const request = (p: string) => ({
  agentId: 'synthetic-id',
  agentName: 'synthetic',
  baseCwd: p,
  baseRef: 'origin/parent',
})
describe('setup authority is independent of requested checkout', () => {
  it('runs only fetched DEFAULT while preserving requested checkout metadata', async () => {
    const p = repo(step('default-command'))
    const run = recorder()
    const alloc = await createWorktreeStrategy({ runSetup: run }).allocate(request(p))
    expect(alloc.ref?.base_ref).toBe('origin/parent')
    expect(git(['config', 'branch.agent-chat/synthetic.agent-chat-base'], p)).toBe('parent')
    expect(run).toHaveBeenCalledExactlyOnceWith(['default-command'], alloc.cwd, 300_000)
  })
  it('does not grant setup authority when only the requested branch declares a step', async () => {
    const p = repo()
    const run = recorder()
    const alloc = await createWorktreeStrategy({ runSetup: run }).allocate(request(p))
    expect(run).not.toHaveBeenCalled()
    expect(alloc.warnings?.filter(w => w.includes('setup')) ?? []).toEqual([])
  })
  it.each([step('local-untrusted-command'), '{}', 'not json'])(
    'preserves failed DEFAULT fetch with present fallback declaration %s',
    async text => {
      const p = repo(text)
      git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/missing-default'], p)
      const run = recorder()
      const alloc = await createWorktreeStrategy({ runSetup: run }).allocate(request(p))
      expect(run).not.toHaveBeenCalled()
      expect(alloc.warnings?.filter(w => w.includes('setup'))).toEqual([
        "worktree setup skipped: .agent-chat/worktree.json is trusted only from origin's fetched default branch",
      ])
      expect(alloc.warnings?.some(w => w.includes('worktree branched from')) ?? false).toBe(false)
    },
  )
  it('preserves a failed fallback declaration read as no setup without granting authority', async () => {
    const p = repo(step('unreadable-local-command'))
    const blob = git(['rev-parse', `HEAD:${SETUP_FILE}`], p)
    fs.unlinkSync(path.join(p, '.git', 'objects', blob.slice(0, 2), blob.slice(2)))
    git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/missing-default'], p)
    const run = recorder()
    const alloc = await createWorktreeStrategy({ runSetup: run }).allocate(request(p))
    expect(run).not.toHaveBeenCalled()
    expect(alloc.warnings?.filter(w => w.includes('setup')) ?? []).toEqual([])
  })
  it('preserves failed DEFAULT fetch with absent fallback declaration as no setup', async () => {
    const p = repo()
    git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/missing-default'], p)
    const run = recorder()
    const alloc = await createWorktreeStrategy({ runSetup: run }).allocate(request(p))
    expect(run).not.toHaveBeenCalled()
    expect(alloc.warnings?.filter(w => w.includes('setup')) ?? []).toEqual([])
    expect(alloc.warnings?.some(w => w.includes('worktree branched from')) ?? false).toBe(false)
  })
  it('records the requested stack metadata before the setup runner observes it', async () => {
    const p = repo(step('default-command'))
    const observed: string[] = []
    const run = vi.fn<SetupRunner>(async () => {
      observed.push(git(['config', 'branch.agent-chat/synthetic.agent-chat-base'], p))
      return { exitCode: 0, timedOut: false, output: '' }
    })
    const alloc = await createWorktreeStrategy({ runSetup: run }).allocate(request(p))
    expect(observed).toEqual(['parent'])
    expect(run).toHaveBeenCalledExactlyOnceWith(['default-command'], alloc.cwd, 300_000)
    expect(Object.hasOwn(alloc, 'setupTarget')).toBe(false)
  })
  it('keeps a metadata warning before the setup failure warning without duplication', async () => {
    const p = repo(step('default-command'))
    const bin = temp()
    fs.writeFileSync(
      path.join(bin, 'git'),
      [
        '#!/bin/sh',
        'if [ "$1" = config ] && [ "$2" = branch.agent-chat/synthetic.agent-chat-base ] && [ "$3" = parent ]; then exit 1; fi',
        'exec /usr/bin/git "$@"',
        '',
      ].join('\n'),
      { mode: 0o755 },
    )
    vi.stubEnv('PATH', bin + path.delimiter + (process.env.PATH ?? ''))
    const run = vi.fn<SetupRunner>(async () => ({
      exitCode: 2,
      timedOut: false,
      output: 'synthetic failure',
    }))
    const alloc = await createWorktreeStrategy({ runSetup: run }).allocate(request(p))
    expect(alloc.warnings).toHaveLength(2)
    expect(alloc.warnings?.[0]).toBe(
      "warning: could not record branch.agent-chat/synthetic.agent-chat-base=parent; pr-ready may not find this branch's stack base",
    )
    expect(alloc.warnings?.[1]).toContain('worktree setup step `default-command` exited with code 2')
    expect(run).toHaveBeenCalledTimes(1)
    expect(Object.hasOwn(alloc, 'setupTarget')).toBe(false)
  })
})
