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

function allocated(meta: Record<string, string>): AgentEventRow {
  return {
    kind: 'isolation_allocated',
    ts: Date.now(),
    actor: 'worker',
    target: null,
    msgId: null,
    ref: 'ag000001',
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
  it('is the recorded tree when the allocation launches in it', () => {
    const { worktree, row } = created()

    expect(createdWorktreeFor([row], { cwd: worktree, ref: { worktree } }, 'worktree')).toBe(worktree)
  })

  it('is nothing for an isolation:none launch, whatever its ref says', () => {
    const { worktree, row } = created()

    expect(createdWorktreeFor([row], { cwd: worktree, ref: { worktree } }, 'none')).toBeUndefined()
  })

  it('is nothing for an assigned tree agent-chat never allocated', () => {
    const { gitRoot, worktree } = created()
    const assigned = allocated({ gitRoot, worktree, branch: 'task/x', assigned: 'true' })

    expect(createdWorktreeFor([assigned], { cwd: worktree, ref: { worktree } }, 'worktree')).toBeUndefined()
  })

  it('is the original record for an assigned tree agent-chat did allocate', () => {
    const { gitRoot, worktree, row } = created()
    const assigned = allocated({ gitRoot, worktree, branch: 'agent-chat/worker', assigned: 'true' })

    expect(createdWorktreeFor([row, assigned], { cwd: worktree, ref: { worktree } }, 'worktree')).toBe(
      worktree,
    )
  })

  it('is nothing when the record is for a different path', () => {
    const { row } = created()
    const elsewhere = path.join(tmpdir(), 'elsewhere')

    expect(
      createdWorktreeFor([row], { cwd: elsewhere, ref: { worktree: elsewhere } }, 'worktree'),
    ).toBeUndefined()
  })

  it('is nothing when the cwd is not the allocated tree', () => {
    const { worktree, row } = created()

    expect(createdWorktreeFor([row], { cwd: tmpdir(), ref: { worktree } }, 'worktree')).toBeUndefined()
  })
})
