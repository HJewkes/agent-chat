import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentIdentity } from '../protocol.js'
import { observe } from '../agents/burndown/observe.js'
import { readProgress, type Progress } from '../agents/burndown/progress.js'
import type { Claim } from '../agents/burndown/ledger.js'

let repo: string

const git = (...args: string[]): void => {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
}

const writeFile = (file: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true })
  fs.writeFileSync(path.join(repo, file), text)
}

const read = (): Progress => {
  const progress = readProgress(repo)
  if (progress === 'unreadable') throw new Error('expected a readable worktree')
  return progress
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-progress-'))
  git('init', '-q')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  writeFile('src/a.ts', 'one\n')
  git('add', '.')
  git('commit', '-q', '-m', 'first')
})

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true })
})

describe('reading a worktree for progress', () => {
  it('returns a new head after a commit', () => {
    const before = read()
    writeFile('src/a.ts', 'two\n')
    git('commit', '-q', '-am', 'second')

    expect(read().head).not.toBe(before.head)
  })

  it('returns a new dirty hash after a tracked file is edited', () => {
    const before = read()
    writeFile('src/a.ts', 'edited\n')

    const after = read()

    expect(after.dirty).not.toBe(before.dirty)
    expect(after.dirtyCount).toBe(1)
  })

  it('returns a new content signal after a second edit to a file already dirty', () => {
    writeFile('src/a.ts', 'edited\n')
    const first = read()
    writeFile('src/a.ts', 'edited again\n')

    const second = read()

    expect(second.dirty).toBe(first.dirty)
    expect(second.content).not.toBe(first.content)
  })

  it('ignores edits under .claude/ and node_modules/', () => {
    writeFile('.claude/settings.local.json', '{}\n')
    git('add', '-f', '.claude')
    git('commit', '-q', '-m', 'tracked settings')
    const before = read()
    writeFile('.claude/settings.local.json', '{"edited":true}\n')
    writeFile('node_modules/pkg/index.js', 'x\n')

    expect(read()).toEqual(before)
  })

  it('reads a missing worktree as unreadable, not as no progress', () => {
    expect(readProgress(path.join(repo, 'gone'))).toBe('unreadable')
  })

  it('reads a failing git as unreadable', () => {
    expect(readProgress(repo, () => ({ status: 128, stdout: '' }))).toBe('unreadable')
  })
})

describe('observing progress', () => {
  const claim = (over: Partial<Claim>): Claim =>
    ({
      taskId: 'CC-1',
      initiative: 'demo',
      phase: 'implementing',
      phaseAt: '2026-07-30T11:00:00.000Z',
      agentName: 'bd-cc-1',
      worktree: '/repo/.worktrees/bd-cc-1',
      ...over,
    }) as Claim
  const row = { name: 'bd-cc-1', agentId: 'a1', state: 'live', spawnedAt: 1 } as AgentIdentity
  const deps = (seen: string[]) => ({
    inboxSince: async () => [],
    root: '/root',
    activity: () => 'unknown' as const,
    progress: (worktree: string) => {
      seen.push(worktree)
      return 'unreadable' as const
    },
  })

  it('reads the worktree of a live implementer', async () => {
    const seen: string[] = []
    const { observations } = await observe([claim({})], { agents: [row] }, deps(seen))

    expect(seen).toEqual(['/repo/.worktrees/bd-cc-1'])
    expect(observations.get('CC-1#')?.progress).toBe('unreadable')
  })

  it('does not read a reviewer or a finished implementer', async () => {
    const seen: string[] = []
    const exited = { ...row, state: 'exited' } as AgentIdentity
    await observe([claim({ phase: 'reviewing' })], { agents: [row] }, deps(seen))
    const finished = {
      ...deps(seen),
      finalText: () => undefined,
      diff: () => ({ reviewable: false, reason: 'x' }),
    }
    await observe([claim({})], { agents: [exited] }, finished)

    expect(seen).toEqual([])
  })
})
