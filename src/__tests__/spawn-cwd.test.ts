import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkSpawnCwd } from '../agents/spawn-cwd.js'

/**
 * CC-62. The old rule refused any `cwd` no registered session was already
 * sitting in, which made `isolation: worktree` unusable for a repo nobody had
 * open. What these prove is that the widening kept the property §11.2 actually
 * argues for — a peer cannot spawn in `~/.ssh` — while dropping the accidental
 * "somebody must already be there" precondition.
 */

const tmpDirs: string[] = []

/** A disposable home, so the tests never depend on the developer's real one. */
function fakeHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-home-'))
  tmpDirs.push(dir)
  return fs.realpathSync(dir)
}

function dirUnder(root: string, ...parts: string[]): string {
  const dir = path.join(root, ...parts)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('the cwd policy a peer spawn has to pass', () => {
  it('allows a directory no session is working in, as long as it is in the workspace', () => {
    const home = fakeHome()
    const worktree = dirUnder(home, 'projects', '_worktrees', 'fresh-repo')

    expect(checkSpawnCwd(worktree, { sessionRoots: [], homeDir: home })).toBeUndefined()
  })

  it('still allows a directory under a registered session, wherever it lives', () => {
    const home = fakeHome()
    const elsewhere = fakeHome() // stands in for a checkout outside home
    const nested = dirUnder(elsewhere, 'src')

    expect(checkSpawnCwd(nested, { sessionRoots: [elsewhere], homeDir: home })).toBeUndefined()
  })

  it('refuses a credential directory even when a session is registered inside it', () => {
    const home = fakeHome()
    const keys = dirUnder(home, '.ssh')

    const reason = checkSpawnCwd(keys, { sessionRoots: [keys], homeDir: home })

    expect(reason).toMatch(/protected directory \(".ssh"\)/)
  })

  it('refuses the home directory itself, and paths outside the workspace roots', () => {
    const home = fakeHome()
    const outside = fakeHome()

    expect(checkSpawnCwd(home, { sessionRoots: [], homeDir: home, tmpDir: home })).toMatch(
      /must be under your home directory/,
    )
    expect(checkSpawnCwd(outside, { sessionRoots: [], homeDir: home, tmpDir: home })).toMatch(
      /must be under your home directory/,
    )
  })

  it('resolves through realpath, so .. and a symlink out of the workspace are caught', () => {
    const home = fakeHome()
    const outside = fakeHome()
    const link = path.join(home, 'escape-hatch')
    fs.symlinkSync(outside, link)

    expect(checkSpawnCwd(link, { sessionRoots: [], homeDir: home, tmpDir: home })).toMatch(
      /must be under your home directory/,
    )
    expect(checkSpawnCwd(path.join(home, '..'), { sessionRoots: [], homeDir: home, tmpDir: home })).toMatch(
      /must be under your home directory/,
    )
  })

  it('refuses a path that does not exist, or is a file', () => {
    const home = fakeHome()
    const file = path.join(home, 'a-file')
    fs.writeFileSync(file, 'x')

    expect(checkSpawnCwd(path.join(home, 'nope'), { sessionRoots: [], homeDir: home })).toMatch(
      /does not exist/,
    )
    expect(checkSpawnCwd(file, { sessionRoots: [], homeDir: home })).toMatch(/not a directory/)
  })
})
