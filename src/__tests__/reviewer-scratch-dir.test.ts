import { describe, expect, it } from 'vitest'
import type { LaunchPlan } from '@titan-design/agent-surface'
import type { TmpStat } from '../agents/agent-tmpdir.js'
import { reviewerScratchDir, withScratchAddDir, type ScratchFs } from '../agents/reviewer-tree.js'

/**
 * CC-311: a reviewer's own `$TMPDIR/<name>` is a working directory, so the mutants it runs
 * there do not raise a permission prompt a headless session cannot answer.
 */

const dirStat: TmpStat = { isDirectory: () => true, isSymbolicLink: () => false, uid: 501 }
const linkStat: TmpStat = { isDirectory: () => false, isSymbolicLink: () => true, uid: 501 }
const fileStat: TmpStat = { isDirectory: () => false, isSymbolicLink: () => false, uid: 501 }

function fakeFs(existing: Record<string, TmpStat> = {}) {
  const made: Array<{ path: string; mode: number }> = []
  const chmods: Array<{ path: string; mode: number }> = []
  const fs: ScratchFs = {
    realpath: p => (p.startsWith('/var/') ? `/private${p}` : p),
    lstat: p => existing[p],
    mkdir: (path, mode) => void made.push({ path, mode }),
    chmod: (path, mode) => void chmods.push({ path, mode }),
  }
  return { fs, made, chmods }
}

const plan = (args: string[]): LaunchPlan => ({ agentId: 'a1', bin: 'claude', args, cwd: '/repo', env: {} })

const env = (profile: string, name = 'x', TMPDIR = '/tmp/ac-x-1') => ({
  TMPDIR,
  AGENT_CHAT_PROFILE: profile,
  AGENT_CHAT_NAME: name,
})

describe('a reviewer spawn gets its own scratch dir as --add-dir', () => {
  it('creates $TMPDIR/<name> 0700 and puts the flag ahead of the brief separator', () => {
    const { fs, made } = fakeFs()

    const dir = reviewerScratchDir(env('reviewer'), fs)
    const widened = withScratchAddDir(plan(['--model', 'opus', '--add-dir', '/extra', '--', 'brief']), dir)

    expect(dir).toBe('/tmp/ac-x-1/x')
    expect(made).toEqual([{ path: '/tmp/ac-x-1/x', mode: 0o700 }])
    expect(widened.args.slice(0, 2)).toEqual(['--add-dir', '/tmp/ac-x-1/x'])
    expect(widened.args.slice(-2)).toEqual(['--', 'brief'])
  })

  it('resolves an aliased TMPDIR to its real path', () => {
    const { fs } = fakeFs()

    expect(reviewerScratchDir(env('reviewer', 'x', '/var/folders/ab/T'), fs)).toBe(
      '/private/var/folders/ab/T/x',
    )
  })

  it('leaves an implementer and a previewer profile unchanged', () => {
    const { fs, made } = fakeFs()

    expect(reviewerScratchDir(env('bd-implementer', 'tc-cc-1-a'), fs)).toBeUndefined()
    expect(reviewerScratchDir(env('previewer', 'tc-cc-1-a'), fs)).toBeUndefined()
    expect(made).toEqual([])
    expect(withScratchAddDir(plan(['--', 'b']), undefined).args).toEqual(['--', 'b'])
  })

  it('refuses a symlink at the scratch path without creating anything', () => {
    const { fs, made, chmods } = fakeFs({ '/tmp/ac-x-1/x': linkStat })

    expect(reviewerScratchDir(env('reviewer'), fs)).toBeUndefined()
    expect(made).toEqual([])
    expect(chmods).toEqual([])
  })

  it('refuses a plain file at the scratch path', () => {
    const { fs } = fakeFs({ '/tmp/ac-x-1/x': fileStat })

    expect(reviewerScratchDir(env('reviewer'), fs)).toBeUndefined()
  })

  it('reuses an existing directory and tightens it to 0700', () => {
    const { fs, made, chmods } = fakeFs({ '/tmp/ac-x-1/x': dirStat })

    expect(reviewerScratchDir(env('reviewer'), fs)).toBe('/tmp/ac-x-1/x')
    expect(made).toEqual([])
    expect(chmods).toEqual([{ path: '/tmp/ac-x-1/x', mode: 0o700 }])
  })

  it('uses the plan env TMPDIR over the base env one', () => {
    const { fs } = fakeFs()
    const base = env('reviewer', 'x', '/tmp/base')

    expect(reviewerScratchDir({ ...base, TMPDIR: '/tmp/plan' }, fs)).toBe('/tmp/plan/x')
  })

  it('refuses a name that could leave TMPDIR', () => {
    const { fs, made } = fakeFs()

    expect(reviewerScratchDir(env('reviewer', '../rv'), fs)).toBeUndefined()
    expect(made).toEqual([])
  })
})
