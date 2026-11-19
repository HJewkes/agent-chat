import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readDirtyPaths } from '../server/human-wait.js'
import { unsavedWork } from '../agents/isolation/unsaved-work.js'
import { workBlocker } from '../agents/isolation/retire-finished.js'
import { parkWorktree } from '../agents/isolation/park.js'
import { inspectForRelease } from '../agents/isolation/worktree.js'

// Worker threads read the real HOME from libuv, so the home directory is faked at the module.
const fake = vi.hoisted(() => ({ home: undefined as string | undefined }))
vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>()
  const homedir = (): string => fake.home ?? actual.homedir()
  return { ...actual, homedir, default: { ...actual, homedir } }
})

const dirs: string[] = []
const fakeHome = (): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'home-repo-')))
  dirs.push(dir)
  execFileSync('git', ['init', '-q', dir])
  fs.writeFileSync(path.join(dir, 'untracked.txt'), 'x')
  fake.home = dir
  return dir
}

afterEach(() => {
  fake.home = undefined
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('a git repository rooted at HOME', () => {
  it('readDirtyPaths reports unknown instead of walking untracked files', async () => {
    const home = fakeHome()
    expect(await readDirtyPaths(home)).toBeUndefined()
  })

  it('unsavedWork refuses without running status', async () => {
    const home = fakeHome()
    const result = await unsavedWork(home, 'release')
    expect(result?.kind).toBe('other')
  })

  it('workBlocker runs no status walk', async () => {
    const home = fakeHome()
    const git = vi.fn(async (args: readonly string[]) => (args[0] === 'rev-parse' ? `${home}\n` : ''))
    const blocker = await workBlocker({ worktree: home, gitRoot: home, branch: 'b', assigned: false }, git)
    expect(blocker).toContain('home directory')
    expect(git.mock.calls.some(([args]) => args[0] === 'status')).toBe(false)
  })

  it('park refuses', async () => {
    const home = fakeHome()
    const result = await parkWorktree(
      { worktree: home, gitRoot: home, branch: 'b', assigned: false },
      () => undefined,
    )
    expect(result.ok).toBe(false)
  })

  it('release inspection reports the tree as not safe', async () => {
    const home = fakeHome()
    const safety = await inspectForRelease(home, home, 'b', 'main')
    expect(safety.dirty).toBe(true)
  })
})
