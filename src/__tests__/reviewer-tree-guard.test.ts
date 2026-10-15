import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { reviewerDirtyText, treeChange, treeFingerprint } from '../agents/reviewer-tree-guard.js'

/** CC-233: the fingerprint a reviewer's tree is compared by, against real git in a temp repo. */

const tmpDirs: string[] = []

const tmp = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-rtg-'))
  tmpDirs.push(dir)
  return dir
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'ignore' })

function repo(): string {
  const dir = tmp()
  git(dir, 'init', '-q')
  fs.writeFileSync(path.join(dir, 'constants.ts'), 'export const ATWATER = 4\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-qm', 'init')
  return dir
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('treeFingerprint and treeChange', () => {
  it('reports nothing for a tree left as it was', async () => {
    const dir = repo()
    const before = await treeFingerprint(dir)
    const after = await treeFingerprint(dir)
    expect(treeChange(before!, after!)).toEqual([])
  })

  it('names a tracked file edited in place', async () => {
    const dir = repo()
    const before = await treeFingerprint(dir)
    const file = path.join(dir, 'constants.ts')
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('4', '9'))
    expect(treeChange(before!, (await treeFingerprint(dir))!)).toEqual(['constants.ts'])
  })

  it('names a further edit to a file that was already dirty', async () => {
    const dir = repo()
    fs.writeFileSync(path.join(dir, 'constants.ts'), 'implementer wip\n')
    const before = await treeFingerprint(dir)
    fs.writeFileSync(path.join(dir, 'constants.ts'), 'reviewer mutant\n')
    expect(treeChange(before!, (await treeFingerprint(dir))!)).toEqual(['constants.ts'])
  })

  it('names a new untracked file', async () => {
    const dir = repo()
    const before = await treeFingerprint(dir)
    fs.mkdirSync(path.join(dir, 'scratch'))
    fs.writeFileSync(path.join(dir, 'scratch', 'mutant.ts'), 'x\n')
    expect(treeChange(before!, (await treeFingerprint(dir))!)).toEqual(['scratch/mutant.ts'])
  })

  it('names HEAD when the reviewer commits', async () => {
    const dir = repo()
    const before = await treeFingerprint(dir)
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'reviewer commit')
    expect(treeChange(before!, (await treeFingerprint(dir))!)).toEqual(['HEAD'])
  })

  it('is undefined outside a git tree', async () => {
    expect(await treeFingerprint(tmp())).toBeUndefined()
  })
})

describe('reviewerDirtyText', () => {
  it('lists five paths and counts the rest', () => {
    const text = reviewerDirtyText('rv-1', '/w', ['a', 'b', 'c', 'd', 'e', 'f', 'g'])
    expect(text).toContain('a, b, c, d, e +2 more')
    expect(text).toContain('rv-1')
    expect(text).toContain('/w')
  })
})
