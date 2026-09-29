import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveSpawnCwd } from '../broker/spawn-default-cwd.js'

const tmpDirs: string[] = []

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('resolveSpawnCwd', () => {
  it('runs in the worktree when the spawner sits in a non-repo dir and no cwd is given', () => {
    const spawnerCwd = tmpDir('agent-chat-nonrepo-')
    const worktree = tmpDir('agent-chat-wt-')

    expect(resolveSpawnCwd({ worktree }, spawnerCwd)).toBe(worktree)
  })

  it('lets an explicit cwd win over the worktree', () => {
    const cwd = tmpDir('agent-chat-explicit-')
    const worktree = tmpDir('agent-chat-wt-')

    expect(resolveSpawnCwd({ cwd, worktree }, tmpDir('agent-chat-nonrepo-'))).toBe(cwd)
  })

  it('falls back to the spawner cwd when neither is given', () => {
    const spawnerCwd = tmpDir('agent-chat-nonrepo-')

    expect(resolveSpawnCwd({}, spawnerCwd)).toBe(spawnerCwd)
  })
})
