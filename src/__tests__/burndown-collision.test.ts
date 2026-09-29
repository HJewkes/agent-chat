import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  collision,
  collisionCheck,
  namesId,
  readOpenPrs,
  readSubjects,
  sameTickCollision,
  type CollisionFacts,
  type CollisionWork,
} from '../agents/burndown/collision.js'
import type { Runner } from '../agents/burndown/exec.js'

/** The CC-202 collision check: a table per kind over plain facts, and the readers over a real git repo or a stub `gh`. */

const facts = (over: Partial<CollisionFacts> = {}): CollisionFacts => ({
  repo: '/repo',
  subjects: [],
  prs: [],
  prFiles: () => [],
  names: [],
  claims: [],
  ours: new Set(),
  ...over,
})

const work = (taskId: string, over: Partial<CollisionWork> = {}): CollisionWork => ({
  taskId,
  tags: [],
  owns: [],
  ...over,
})

const pr = (number: number, over: Partial<{ title: string; branch: string; body: string }> = {}) => ({
  number,
  title: 'Unrelated change',
  branch: 'feat/unrelated',
  body: '',
  ...over,
})

describe('namesId', () => {
  it.each([
    ['Add scorer (TP-400) (#12)', 'TP-400', true],
    ['Add scorer (TP-400) (#12)', 'TP-40', false],
    ['agent-chat/hs-cc-202-collision-check', 'CC-202', true],
    ['agent-chat/hs-cc-2020-thing', 'CC-202', false],
    ['XTP-40 is a different prefix', 'TP-40', false],
  ])('%s names %s: %s', (text, id, expected) => {
    expect(namesId(text, id)).toBe(expected)
  })
})

describe('collision', () => {
  it.each<[string, CollisionWork, Partial<CollisionFacts>, string | undefined]>([
    ['a subject naming the id', work('TP-400'), { subjects: ['Add scorer (TP-400) (#12)'] }, 'landed'],
    ['a subject naming a longer id', work('TP-40'), { subjects: ['Add scorer (TP-400) (#12)'] }, undefined],
    [
      'a landed task tagged reconciled',
      work('TP-400', { tags: ['reconciled'] }),
      { subjects: ['Add scorer (TP-400)'] },
      undefined,
    ],
    [
      'a slice whose parent id a sibling slice landed',
      work('CC-202', { slice: 'b' }),
      { subjects: ['Add the check (CC-202) (#190)'] },
      undefined,
    ],
    ['unreadable subjects', work('TP-1'), { subjects: undefined }, 'landed'],
    ['an open PR title', work('R-48'), { prs: [pr(3, { title: 'Fix R-48 paging' })] }, 'open-pr'],
    ['an open PR branch', work('CC-202'), { prs: [pr(3, { branch: 'agent-chat/hs-cc-202-x' })] }, 'open-pr'],
    ['an open PR body', work('R-48'), { prs: [pr(3, { body: 'Closes R-48.' })] }, 'open-pr'],
    [
      "the ledger's own agent branch",
      work('CC-202'),
      { prs: [pr(3, { branch: 'agent-chat/bd-cc-202-a' })], ours: new Set(['bd-cc-202-a']) },
      undefined,
    ],
    ['unlistable PRs', work('R-48'), { prs: undefined }, 'open-pr'],
    ['a live agent carrying the id', work('CC-202'), { names: ['hs-cc-202-collision-check'] }, 'claimed'],
    [
      "the ledger's own live agent",
      work('CC-202'),
      { names: ['bd-cc-202-a'], ours: new Set(['bd-cc-202-a']) },
      undefined,
    ],
    [
      "a file under another session's claim",
      work('CC-9', { owns: ['src/cli/index.ts'] }),
      { claims: [{ owner: 'peer', repo: '/repo', patterns: ['src/cli/**'] }] },
      'claimed',
    ],
    [
      'a file claim in another repo',
      work('CC-9', { owns: ['src/cli/index.ts'] }),
      { claims: [{ owner: 'peer', repo: '/other', patterns: ['src/cli/**'] }] },
      undefined,
    ],
    ['an unreachable broker', work('CC-9'), { names: undefined }, 'claimed'],
    [
      'a slice file an open PR touches',
      work('CC-9', { owns: ['src/agents/burndown/plan.ts'] }),
      { prs: [pr(7)], prFiles: () => ['src/agents/burndown/plan.ts'] },
      'file-overlap',
    ],
    [
      'a slice disjoint from every open PR',
      work('CC-9', { owns: ['src/agents/burndown/plan.ts'] }),
      { prs: [pr(7)], prFiles: () => ['README.md'] },
      undefined,
    ],
    [
      'unlistable PR files',
      work('CC-9', { owns: ['src/x.ts'] }),
      { prs: [pr(7)], prFiles: () => undefined },
      'file-overlap',
    ],
  ])('%s', (_, w, over, kind) => {
    expect(collision(w, facts(over))?.kind).toBe(kind)
  })
})

describe('readSubjects over a real repository', () => {
  let repo: string
  const git = (...args: string[]): string =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
      cwd: repo,
      encoding: 'utf8',
    })
  const commit = (message: string): void => {
    git('commit', '--allow-empty', '-q', '-m', message)
  }

  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-collision-'))
    repo = path.join(root, 'work')
    fs.mkdirSync(repo)
    git('init', '-q', '-b', 'main')
    git('init', '-q', '--bare', path.join(root, 'origin.git'))
    git('remote', 'add', 'origin', path.join(root, 'origin.git'))
    commit('Add the scorer (TP-400) (#12)')
    commit('Fix the TP-248 flake')
    commit('Tidy the docs\n\nLeaves R-48 for later; see R-71.')
    git('push', '-q', 'origin', 'main')
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it.each([
    ['TP-400', 'landed'],
    ['TP-248', 'landed'],
    ['R-48', undefined],
    ['R-71', undefined],
  ])('%s is %s: a body mention is not a landing', (id, kind) => {
    const subjects = readSubjects(repo, 'main')

    expect(collision(work(id), facts({ subjects }))?.kind).toBe(kind)
  })

  it('fetches the default branch first, so a landing the local ref has not seen counts', () => {
    commit('Land the pager (R-9) (#20)')
    git('push', '-q', 'origin', 'main')
    git('update-ref', 'refs/remotes/origin/main', 'HEAD~1')

    expect(readSubjects(repo, 'main')).toContain('Land the pager (R-9) (#20)')
  })

  it('reports a failed fetch as undefined rather than reading the stale ref', () => {
    git('remote', 'set-url', 'origin', path.join(root, 'gone.git'))

    expect(readSubjects(repo, 'main')).toBeUndefined()
  })

  it('reports an unreadable ref as undefined rather than as no subjects', () => {
    expect(readSubjects(repo, 'no-such-branch')).toBeUndefined()
  })
})

describe('readOpenPrs', () => {
  it('asks the REST pulls endpoint, never GraphQL, and parses one PR per line', () => {
    const calls: string[][] = []
    const exec: Runner = (bin, args) => {
      calls.push([bin, ...args])
      return {
        status: 0,
        stdout: '{"number":5,"title":"Fix R-48","branch":"fix/r-48","body":""}\n',
      }
    }

    const prs = readOpenPrs('/repo', exec)

    expect(prs).toEqual([{ number: 5, title: 'Fix R-48', branch: 'fix/r-48', body: '' }])
    expect(calls[0]?.slice(0, 2)).toEqual(['gh', 'api'])
    expect(calls[0]).toContain('repos/{owner}/{repo}/pulls?state=open&per_page=100')
    expect(calls.flat().join(' ')).not.toMatch(/graphql/i)
  })

  it('reports a failed gh call as undefined', () => {
    expect(readOpenPrs('/repo', () => ({ status: 1, stdout: '' }))).toBeUndefined()
  })
})

describe('collisionCheck reader failures', () => {
  const gitOk = (args: string[]): { status: number; stdout: string } =>
    args[0] === 'log' ? { status: 0, stdout: 'init\n' } : { status: 0, stdout: '' }

  it('reports a failed gh-pull-files read once per PR, naming the repo and the PR', () => {
    const failed: unknown[][] = []
    const exec: Runner = (bin, args) => {
      if (bin !== 'gh') return gitOk(args)
      if (args[2]?.includes('/files')) return { status: 1, stdout: '' }
      return { status: 0, stdout: JSON.stringify(pr(4)) }
    }
    const check = collisionCheck({ version: 1, claims: [] }, { names: [], claims: [] }, exec, (...a) =>
      failed.push(a),
    )

    const first = check('/repo', work('CC-9', { slice: 'a', owns: ['src/a.ts'] }))
    check('/repo', work('CC-9', { slice: 'b', owns: ['src/b.ts'] }))

    expect(first).toEqual({
      kind: 'file-overlap',
      reason: 'reader gh-pull-files failed: no file list for #4',
    })
    expect(failed).toEqual([['gh-pull-files', '/repo', '#4']])
  })

  it('reports nothing when every reader answers', () => {
    const failed: unknown[][] = []
    const exec: Runner = (bin, args) => (bin === 'gh' ? { status: 0, stdout: '' } : gitOk(args))
    const check = collisionCheck({ version: 1, claims: [] }, { names: [], claims: [] }, exec, (...a) =>
      failed.push(a),
    )

    expect(check('/repo', work('CC-9'))).toBeUndefined()
    expect(failed).toEqual([])
  })
})

describe('sameTickCollision over earlier seats this tick (CC-275)', () => {
  const earlier = [
    {
      seat: 'seat-a',
      repo: '/repo',
      agentName: 'sa-cc-1-a',
      work: work('CC-1', { slice: 'a', owns: ['src/x.ts'] }),
    },
  ]

  it('refuses the same task and an overlapping owns in the same repo', () => {
    expect(sameTickCollision(earlier, '/other', work('CC-1'))?.reason).toBe(
      'seat seat-a dispatched it earlier this tick as sa-cc-1-a',
    )
    expect(sameTickCollision(earlier, '/repo', work('CC-2', { owns: ['src/**'] }))?.reason).toBe(
      "src/** is under sa-cc-1-a's owns, dispatched by seat seat-a earlier this tick",
    )
  })

  it('passes an overlapping owns in another repo', () => {
    expect(sameTickCollision(earlier, '/other', work('CC-2', { owns: ['src/**'] }))).toBeUndefined()
  })
})
