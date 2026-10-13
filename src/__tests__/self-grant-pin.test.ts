import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentEventRow } from '../broker/event-store.js'
import { createdWorktreeFor } from '../agents/resume-session.js'

const dirs: string[] = []

function tmpdir(): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'agent-chat-pin-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function allocated(meta: Record<string, string>, ref = 'ag000001'): AgentEventRow {
  return {
    kind: 'isolation_allocated',
    ts: Date.now(),
    actor: 'worker',
    target: null,
    msgId: null,
    ref,
    body: '',
    meta: { strategy: 'worktree', ...meta },
  }
}

function created(): { gitRoot: string; worktree: string; row: AgentEventRow } {
  const gitRoot = tmpdir()
  const worktree = path.join(gitRoot, '.worktrees', 'worker')
  return { gitRoot, worktree, row: allocated({ gitRoot, worktree, branch: 'agent-chat/worker' }) }
}

describe('the worktree agent-chat created for a launch (CC-1110)', () => {
  it('is the recorded tree and its repository when the allocation launches in it', () => {
    const { gitRoot, worktree, row } = created()

    expect(createdWorktreeFor([row], 'ag000001', { cwd: worktree, ref: { worktree } }, 'worktree')).toEqual({
      worktree,
      gitRoot,
    })
  })

  it('is nothing for an isolation:none launch, whatever its ref says', () => {
    const { worktree, row } = created()

    expect(
      createdWorktreeFor([row], 'ag000001', { cwd: worktree, ref: { worktree } }, 'none'),
    ).toBeUndefined()
  })

  it('is nothing for an assigned tree, even one agent-chat allocated for another agent', () => {
    const { gitRoot, worktree, row } = created()
    const assigned = allocated(
      { gitRoot, worktree, branch: 'agent-chat/worker', assigned: 'true' },
      'ag000002',
    )
    const allocation = { cwd: worktree, ref: { worktree, assigned: 'true' } }

    expect(createdWorktreeFor([row, assigned], 'ag000002', allocation, 'worktree')).toBeUndefined()
  })

  it('is nothing when the only record of the path belongs to another agent', () => {
    const { worktree, row } = created()

    expect(
      createdWorktreeFor([row], 'ag000002', { cwd: worktree, ref: { worktree } }, 'worktree'),
    ).toBeUndefined()
  })

  it("is nothing when the agent's newest allocation is for a different path", () => {
    const { worktree, row } = created()
    const moved = allocated({ gitRoot: tmpdir(), worktree: path.join(tmpdir(), 'other'), branch: 'b' })

    expect(
      createdWorktreeFor([row, moved], 'ag000001', { cwd: worktree, ref: { worktree } }, 'worktree'),
    ).toBeUndefined()
  })

  it('is nothing when the cwd is not the allocated tree', () => {
    const { worktree, row } = created()

    expect(
      createdWorktreeFor([row], 'ag000001', { cwd: tmpdir(), ref: { worktree } }, 'worktree'),
    ).toBeUndefined()
  })
})
