import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startSupervisor, type RestartHarness, type SurfaceSpawn } from './helpers/restart-harness.js'

/**
 * CC-952 slice c: a spawn carrying `claimPaths` leaves a `files` claim under the
 * agent's name, keyed by the spawn cwd's repo, so the burndown tick sees it
 * before the agent registers; a spawn that never registers drops it.
 */

const harnesses: RestartHarness[] = []
const dirs: string[] = []

afterEach(() => {
  for (const h of harnesses.splice(0)) h.close()
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const tmp = (prefix: string): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  dirs.push(dir)
  return dir
}

const git = (args: string[], cwd: string): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()

function makeRepo(): string {
  const dir = tmp('claim-paths-repo-')
  git(['init', '-b', 'main'], dir)
  git(['config', 'user.email', 'test@example.com'], dir)
  git(['config', 'user.name', 'Test'], dir)
  git(['config', 'commit.gpgsign', 'false'], dir)
  fs.writeFileSync(path.join(dir, 'README.md'), 'seed\n')
  git(['add', '.'], dir)
  git(['commit', '-m', 'seed'], dir)
  return dir
}

/** A headless child whose exit the test decides. */
function exitingChild() {
  let onExit: ((code: number | null, signal: string | null) => void) | undefined
  const spawn = () => ({
    pid: 4243,
    unref: () => undefined,
    once: (event: string, listener: (code: number | null, signal: string | null) => void) => {
      if (event === 'exit') onExit = listener
    },
  })
  return {
    spawn: spawn as unknown as SurfaceSpawn,
    started: () => onExit !== undefined,
    exit: (code: number) => onExit?.(code, null),
  }
}

function start(options: Parameters<typeof startSupervisor>[0] = {}): RestartHarness {
  const h = startSupervisor(options)
  harnesses.push(h)
  return h
}

const inRepo = (repo: string) => ({
  cwd: repo,
  isolation: 'worktree' as const,
  spawnerConfigDir: tmp('claim-paths-account-'),
  claimPaths: ['src/a/**'],
})

describe('spawn with claimPaths', () => {
  it("installs a files claim owned by the agent in its worktree, keyed by the spawn cwd's repo", async () => {
    const repo = makeRepo()
    const h = start()

    const outcome = await h.spawnAgent('worker-a', inRepo(repo))

    expect(outcome.ok).toBe(true)
    const worktree = h.core.agents.byName('worker-a')?.cwd
    expect(worktree).not.toBe(repo)
    expect(h.core.claims.list()).toEqual([
      expect.objectContaining({
        owner: 'worker-a',
        kind: 'files',
        patterns: ['src/a/**'],
        worktreePath: worktree,
        repoPath: repo,
      }),
    ])
  })

  it('takes no claim when the spawn declares no paths', async () => {
    const h = start()

    await h.spawnAgent('worker-a', { ...inRepo(makeRepo()), claimPaths: [] })

    expect(h.core.claims.list()).toEqual([])
  })

  it('releases the claim when the agent never registers', async () => {
    const child = exitingChild()
    const h = start({ spawn: child.spawn, attach: false })

    const pending = h.spawnAgent('worker-a', inRepo(makeRepo()))
    await vi.waitFor(() => expect(child.started()).toBe(true))
    expect(h.core.claims.list().map(c => c.owner)).toEqual(['worker-a'])
    child.exit(1)
    const outcome = await pending

    expect(outcome.ok).toBe(false)
    expect(h.core.claims.list()).toEqual([])
  })
})
