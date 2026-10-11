import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  landedSweep,
  readRecentSubjects,
  renderLandedSweep,
  type SweepTask,
} from '../agents/burndown/landed-sweep.js'

const task = (id: string, tags: string[] = []): SweepTask => ({ id, initiative: 'claude-channels', tags })

/** 41 open tasks, CC-1 to CC-41; a plan walk with `--top 13` reads at most 39 of them. */
const fortyOne = (): SweepTask[] => Array.from({ length: 41 }, (_, i) => task(`CC-${i + 1}`))

describe('landedSweep', () => {
  it('reports a task ranked 41st of 41, below any 3N cut', () => {
    const reads = [{ repo: '/r/agent-chat', subjects: ['Sweep the backlog (CC-41) (#700)'] }]

    const rows = landedSweep(fortyOne(), reads)

    expect(rows).toEqual([
      {
        kind: 'landed',
        id: 'CC-41',
        initiative: 'claude-channels',
        repo: '/r/agent-chat',
        subject: 'Sweep the backlog (CC-41) (#700)',
      },
    ])
  })

  it('leaves a task tagged reconciled out even when a subject names it', () => {
    const reads = [{ repo: '/r/agent-chat', subjects: ['CC-7: land it (#1)'] }]

    expect(landedSweep([task('CC-7', ['reconciled'])], reads)).toEqual([])
  })

  it('does not report TP-40 for a subject naming TP-400', () => {
    const reads = [{ repo: '/r/tp', subjects: ['Add scorer (TP-400)'] }]

    expect(landedSweep([task('TP-40')], reads)).toEqual([])
  })

  it('gives an unreadable repo its own row and still reports hits in another repo', () => {
    const reads = [
      { repo: '/r/gone', subjects: undefined },
      { repo: '/r/agent-chat', subjects: ['CC-3: fix it (#2)'] },
    ]

    const rows = landedSweep([task('CC-3')], reads)

    expect(rows).toEqual([
      { kind: 'unreadable', repo: '/r/gone' },
      {
        kind: 'landed',
        id: 'CC-3',
        initiative: 'claude-channels',
        repo: '/r/agent-chat',
        subject: 'CC-3: fix it (#2)',
      },
    ])
  })

  it('orders rows by task id numerically', () => {
    const reads = [{ repo: '/r/a', subjects: ['CC-10 (#2)', 'CC-9 (#1)'] }]

    const ids = landedSweep([task('CC-10'), task('CC-9')], reads).map(row => ('id' in row ? row.id : ''))

    expect(ids).toEqual(['CC-9', 'CC-10'])
  })
})

describe('renderLandedSweep', () => {
  it('prints LANDED and UNREADABLE lines, then the summary', () => {
    const lines = renderLandedSweep({
      rows: [
        { kind: 'unreadable', repo: '/r/gone' },
        {
          kind: 'landed',
          id: 'CC-3',
          initiative: 'claude-channels',
          repo: '/r/a',
          subject: 'CC-3: fix it (#2)',
        },
      ],
      swept: 41,
      repos: 2,
    })

    expect(lines).toEqual([
      'UNREADABLE /r/gone: no default-branch subjects',
      'LANDED CC-3: /r/a: CC-3: fix it (#2)',
      'swept 41 open tasks in 2 repos; 1 landed',
    ])
  })
})

describe('readRecentSubjects over a fixture repository', () => {
  let root: string
  let origin: string
  let clone: string
  const git = (cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): string =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, ...env },
    })
  const eightDaysAgo = new Date(Date.now() - 8 * 86_400_000).toISOString()

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-landed-sweep-'))
    origin = path.join(root, 'origin.git')
    const seed = path.join(root, 'seed')
    clone = path.join(root, 'clone')
    git(root, ['init', '-q', '--bare', '-b', 'main', origin])
    git(root, ['clone', '-q', origin, seed])
    git(seed, ['checkout', '-q', '-b', 'main'])
    const old = { GIT_AUTHOR_DATE: eightDaysAgo, GIT_COMMITTER_DATE: eightDaysAgo }
    git(seed, ['commit', '--allow-empty', '-q', '-m', 'Old landing (CC-2) (#1)'], old)
    git(seed, ['push', '-q', 'origin', 'main'])
    git(root, ['clone', '-q', origin, clone])
    git(seed, ['commit', '--allow-empty', '-q', '-m', 'Sweep the backlog (CC-41) (#700)'])
    git(seed, ['push', '-q', 'origin', 'main'])
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('returns a commit that exists only on the remote and skips one dated 8 days ago', () => {
    const subjects = readRecentSubjects(clone, 'main', 7)

    expect(subjects).toEqual(['Sweep the backlog (CC-41) (#700)'])
  })

  it('reports the 41st of 41 tasks from the fixture repo', () => {
    const reads = [{ repo: clone, subjects: readRecentSubjects(clone, 'main', 7) }]

    const ids = landedSweep(fortyOne(), reads).map(row => ('id' in row ? row.id : row.kind))

    expect(ids).toEqual(['CC-41'])
  })

  it('reads a failed fetch as undefined', () => {
    git(clone, ['remote', 'set-url', 'origin', path.join(root, 'gone.git')])

    expect(readRecentSubjects(clone, 'main', 7)).toBeUndefined()
  })
})
