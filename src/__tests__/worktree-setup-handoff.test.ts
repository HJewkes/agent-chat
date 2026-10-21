import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type {
  SetupRunner,
  SetupTarget,
  WorktreeAllocation,
  WorktreeOptions,
  WorktreeRequest,
} from '@titan-design/worktree'

const control = vi.hoisted(() => ({
  mode: 'normal',
  targets: new Map<string, SetupTarget | undefined>(),
  calls: [] as SetupTarget[],
}))
vi.mock('@titan-design/worktree', async importOriginal => {
  const actual = await importOriginal<typeof import('@titan-design/worktree')>()
  const handoff = (allocation: WorktreeAllocation): WorktreeAllocation => {
    if (control.mode === 'missing') {
      const { setupTarget: _target, ...rest } = allocation
      return rest
    }
    control.targets.set(allocation.cwd, allocation.setupTarget)
    return control.mode === 'early' ? { ...allocation, ref: { ...allocation.ref, base: '' } } : allocation
  }
  return {
    ...actual,
    createWorktreeAllocator: (options: WorktreeOptions) => {
      const allocator = actual.createWorktreeAllocator(options)
      return {
        ...allocator,
        allocate: async (request: WorktreeRequest) => handoff(await allocator.allocate(request)),
      }
    },
    reattachWorktree: async (...args: Parameters<typeof actual.reattachWorktree>) =>
      handoff(await actual.reattachWorktree(...args)),
    setupWorktree: async (...args: Parameters<typeof actual.setupWorktree>) => {
      const [target] = args
      expect(target).toBe(control.targets.get(target.worktree))
      control.calls.push(target)
      return actual.setupWorktree(...args)
    },
  }
})
import { createWorktreeStrategy, reattachWorktree } from '../agents/isolation/worktree.js'

const dirs: string[] = []
afterEach(() => {
  control.mode = 'normal'
  control.targets.clear()
  control.calls.length = 0
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})
const git = (args: string[], cwd: string): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()
function temp(): string {
  const p = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'setup-handoff-')))
  dirs.push(p)
  return p
}
function repo(): string {
  const p = temp(),
    origin = temp()
  git(['init', '-b', 'main'], p)
  git(['config', 'user.email', 'test@example.com'], p)
  git(['config', 'user.name', 'Test'], p)
  git(['config', 'commit.gpgsign', 'false'], p)
  git(['config', 'maintenance.auto', 'false'], p)
  fs.mkdirSync(path.join(p, '.agent-chat'))
  fs.writeFileSync(
    path.join(p, '.agent-chat', 'worktree.json'),
    JSON.stringify({ setup: { command: ['synthetic-setup'] } }),
  )
  git(['add', '.'], p)
  git(['commit', '-qm', 'seed'], p)
  git(['init', '--bare', '-b', 'main'], origin)
  git(['remote', 'add', 'origin', origin], p)
  git(['push', '-q', 'origin', 'main'], p)
  return p
}
const request = (p: string) => ({ agentId: 'synthetic-id', agentName: 'synthetic', baseCwd: p })
const runner = () => vi.fn<SetupRunner>(async () => ({ exitCode: 0, timedOut: false, output: '' }))

it('passes the returned target object unchanged and removes it from the product response', async () => {
  const root = repo(),
    run = runner()
  const allocation = await createWorktreeStrategy({ runSetup: run, budget: 2 }).allocate(request(root))
  expect(control.calls).toHaveLength(1)
  expect(control.calls[0]).toBe(control.targets.get(allocation.cwd))
  expect(Object.hasOwn(allocation, 'setupTarget')).toBe(false)
  expect(run).toHaveBeenCalledTimes(1)
})
it('strips target data even when product composition takes its early return', async () => {
  const root = repo(),
    run = runner()
  control.mode = 'early'
  const allocation = await createWorktreeStrategy({ runSetup: run, budget: 2 }).allocate(request(root))
  expect(control.targets.get(allocation.cwd)).toBeDefined()
  expect(Object.hasOwn(allocation, 'setupTarget')).toBe(false)
  expect(control.calls).toEqual([])
  expect(run).not.toHaveBeenCalled()
})
it('keeps missing recreation targets conservative without fabricating an outcome', async () => {
  const root = repo(),
    run = runner()
  const first = await createWorktreeStrategy({ runSetup: run, budget: 2 }).allocate(request(root))
  git(['worktree', 'remove', first.cwd], root)
  control.mode = 'missing'
  run.mockClear()
  control.calls.length = 0
  const allocation = await reattachWorktree(
    { gitRoot: root, worktree: first.cwd, branch: first.ref?.branch ?? '' },
    { runSetup: run, budget: 2 },
  )
  expect(allocation.ref?.setup).toBeUndefined()
  expect(Object.hasOwn(allocation.ref ?? {}, 'setup')).toBe(false)
  expect(allocation.note).toContain('install dependencies and build')
  expect(Object.hasOwn(allocation, 'setupTarget')).toBe(false)
  expect(control.calls).toEqual([])
  expect(run).not.toHaveBeenCalled()
})
