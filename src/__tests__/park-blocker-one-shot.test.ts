import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parkBlocker, type ParkTarget } from '../agents/isolation/park.js'
import type { AgentIdentity } from '../protocol.js'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

const tree = (): string => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'park-one-shot-')))
  dirs.push(d)
  return d
}

const identity = (over: Partial<AgentIdentity>): AgentIdentity =>
  ({
    agentId: 'id',
    name: 'name',
    profile: 'explorer',
    state: 'exited',
    origin: 'spawned',
    spawnedBy: 'human',
    spawnedAt: 1,
    brief: '',
    cwd: '',
    isolation: '',
    surface: '',
    sessionId: 's',
    ...over,
  }) as AgentIdentity

const scenario = (worktree: string, other: Partial<AgentIdentity>) => {
  const owner = identity({ agentId: 'owner', name: 'owner', cwd: worktree })
  const target: ParkTarget = { gitRoot: worktree, worktree, branch: 'b', assigned: false }
  return parkBlocker(owner, false, target, [owner, identity({ agentId: 'other', cwd: worktree, ...other })])
}

describe('parkBlocker with one-shot sessions in the tree', () => {
  it('parks past an exited profile-less human-spawned adopted session', () => {
    const wt = tree()
    expect(
      scenario(wt, { name: 'folder-name', profile: '', origin: 'adopted', state: 'exited' }),
    ).toBeUndefined()
  })

  it('still refuses for a live tenant', () => {
    const wt = tree()
    expect(scenario(wt, { name: 'live-one', profile: '', origin: 'adopted', state: 'live' })).toMatch(
      /^live-one is live in /,
    )
  })

  it('still refuses for an exited tenant with a profile', () => {
    const wt = tree()
    expect(scenario(wt, { name: 'worker-b', origin: 'adopted', state: 'exited' })).toMatch(
      /^worker-b \(not retired\)/,
    )
  })
})
