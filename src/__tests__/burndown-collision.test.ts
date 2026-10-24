import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Claim } from '../agents/burndown/ledger.js'
import { EMPTY_LEDGER } from '../agents/burndown/ledger.js'
import type { Contract } from '../agents/burndown/report.js'
import {
  collision,
  collisionCheck,
  coveredIds,
  namesId,
  readOpenPrs,
  readSubjects,
  sameTickCollision,
  type CollisionFacts,
  type CollisionWork,
  type FileClaim,
} from '../agents/burndown/collision.js'
import type { Runner } from '../agents/burndown/exec.js'

const AC613_MESSAGE = path.join(import.meta.dirname, 'fixtures', 'ac613-commit-message.txt')

/** The CC-202 collision check: a table per kind over plain facts, and the readers over a real git repo or a stub `gh`. */

const facts = (over: Partial<CollisionFacts> = {}): CollisionFacts => ({
  repo: '/repo',
  subjects: [],
  prs: [],
  prFiles: () => [],
  names: [],
  claims: [],
  ours: new Set(),
  held: [],
  heldOwns: [],
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
    ['agent-chat/sa-cc-202-collision-check', 'CC-202', true],
    ['agent-chat/sa-cc-2020-thing', 'CC-202', false],
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
    ['an open PR branch', work('CC-202'), { prs: [pr(3, { branch: 'agent-chat/sa-cc-202-x' })] }, 'open-pr'],
    ['an open PR body', work('R-48'), { prs: [pr(3, { body: 'Closes R-48.' })] }, 'open-pr'],
    [
      "the ledger's own agent branch",
      work('CC-202'),
      { prs: [pr(3, { branch: 'agent-chat/bd-cc-202-a' })], ours: new Set(['bd-cc-202-a']) },
      undefined,
    ],
    ['unlistable PRs', work('R-48'), { prs: undefined }, 'open-pr'],
    ['a live agent carrying the id', work('CC-202'), { names: ['sa-cc-202-collision-check'] }, 'claimed'],
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
    ['an unreachable broker', work('CC-9'), { names: undefined }, 'broker-view-unavailable'],
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

describe('file-overlap exempts the Version Packages PR and .changeset/ paths (CC-975)', () => {
  it('skips an open changeset-release PR without reading its files', () => {
    const read: number[] = []
    const prFiles = (n: number) => {
      read.push(n)
      return undefined
    }
    const w = work('TP-1', { owns: ['.changeset/tp-x.md', 'src/a.ts'] })
    const result = collision(w, facts({ prs: [pr(1053, { branch: 'changeset-release/main' })], prFiles }))
    expect(result).toBeUndefined()
    expect(read).toEqual([])
  })

  it('does not refuse a changeset glob against a feature PR adding a changeset', () => {
    const w = work('TP-1', { owns: ['.changeset/*.md'] })
    const result = collision(w, facts({ prs: [pr(7)], prFiles: () => ['.changeset/other.md'] }))
    expect(result).toBeUndefined()
  })

  it('still refuses a source file an ordinary open PR touches', () => {
    const w = work('TP-1', { owns: ['.changeset/tp-x.md', 'src/a.ts'] })
    const result = collision(w, facts({ prs: [pr(7)], prFiles: () => ['.changeset/tp-x.md', 'src/a.ts'] }))
    expect(result).toEqual({ kind: 'file-overlap', reason: '#7 touches src/a.ts', pr: 7 })
  })
})

describe('open-pr ignores the Version Packages PR (CC-1152)', () => {
  const release = pr(1152, {
    branch: 'changeset-release/main',
    title: 'Version Packages',
    body: '- TP-737 a',
  })

  it('does not refuse a task named only in a changeset-release PR body', () => {
    expect(collision(work('TP-737'), facts({ prs: [release] }))).toBeUndefined()
  })

  it('still refuses on an ordinary PR naming the task alongside the release PR', () => {
    const ordinary = pr(8, { branch: 'agent-chat/bd-tp-737-a', title: 'Fix the scorer' })
    const result = collision(work('TP-737'), facts({ prs: [release, ordinary] }))
    expect(result).toEqual({
      kind: 'open-pr',
      reason: '#8 (agent-chat/bd-tp-737-a) names TP-737: Fix the scorer',
    })
  })

  it('does not exempt a branch that merely contains changeset-release', () => {
    const lookalike = pr(9, { branch: 'fix/changeset-release-notes', body: 'Closes TP-737.' })
    expect(collision(work('TP-737'), facts({ prs: [lookalike] }))?.kind).toBe('open-pr')
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

  it.each(['CC-695', 'CC-685', 'CC-666', 'CC-294'])(
    "%s is landed: ac#613's Covers clause names it (CC-1068)",
    id => {
      git('commit', '--allow-empty', '-q', '-F', AC613_MESSAGE)
      git('push', '-q', 'origin', 'main')

      const refusal = collision(work(id), facts({ subjects: readSubjects(repo, 'main') }))

      expect(refusal?.kind).toBe('landed')
      expect(refusal?.reason).toContain('[covers')
    },
  )

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

describe('coveredIds', () => {
  it.each([
    ['Covers CC-1, CC-2 and CC-3.', ['CC-1', 'CC-2', 'CC-3']],
    ['Slice 1 of X. Also covers TP-4 & TP-5.', ['TP-4', 'TP-5']],
    ['- Covers: R-9', ['R-9']],
    ['Refs: CC-826, #613', []],
    ['Partly covers CC-9', []],
    ['Leaves R-48 for later', []],
    ['accepted pairs from CC-695', []],
    ['This covers CC-7', []],
    ['The old suite Covers CC-8 only in part', []],
  ])('%j gives %j', (body, ids) => {
    expect(coveredIds(body)).toEqual(ids)
  })

  it("reads ac#613's body as covering exactly its four ids, not its prose or Refs", () => {
    expect(coveredIds(fs.readFileSync(AC613_MESSAGE, 'utf8'))).toEqual([
      'CC-695',
      'CC-685',
      'CC-666',
      'CC-294',
    ])
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

describe('collisionCheck landed in any listed repo (CC-794)', () => {
  const exec: Runner = (bin, args, cwd) => {
    if (bin === 'gh') return { status: 0, stdout: '' }
    const landed = cwd === '/repo-b' ? 'T-1 Land it (#9)\n' : 'init\n'
    return { status: 0, stdout: args[0] === 'log' ? landed : '' }
  }
  const check = () => collisionCheck({ version: 1, claims: [] }, { names: [], claims: [] }, exec)

  it('refuses a task landed in another listed repo than the one its initiative maps to', () => {
    const found = check()('/repo-a', work('T-1'), ['/repo-a', '/repo-b'])

    expect(found?.kind).toBe('landed')
    expect(found?.reason).toContain('T-1 Land it (#9)')
  })

  it('checks only the home repo when no other repos are listed', () => {
    expect(check()('/repo-a', work('T-1'))).toBeUndefined()
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

describe('changeset paths collide only by literal name (CC-1276)', () => {
  const adding = work('TP-9', { slice: 'a', owns: ['src/x.ts', '.changeset/tp-9-a.md'] })
  const claimBy = (patterns: string[]) => facts({ claims: [{ owner: 'peer', repo: '/repo', patterns }] })

  it("passes a changeset under another agent's .changeset/* file claim", () => {
    expect(collision(adding, claimBy(['.changeset/*']))).toBeUndefined()
  })

  it('passes a changeset under a same-tick dispatch owning .changeset/*', () => {
    const earlier = [
      {
        seat: 'seat-a',
        repo: '/repo',
        agentName: 'sa-tp-1-b',
        work: work('TP-1', { owns: ['.changeset/*'] }),
      },
    ]
    expect(sameTickCollision(earlier, '/repo', adding)).toBeUndefined()
  })

  it('still refuses the same literal changeset path', () => {
    const result = collision(work('TP-9', { owns: ['.changeset/tp-9.md'] }), claimBy(['.changeset/tp-9.md']))
    expect(result).toEqual({
      kind: 'claimed',
      reason: ".changeset/tp-9.md is under peer's file claim",
    })
  })

  it('still refuses a source path in a claim that also holds .changeset/*', () => {
    expect(collision(adding, claimBy(['.changeset/*', 'src/x.ts']))).toEqual({
      kind: 'claimed',
      reason: "src/x.ts is under peer's file claim",
    })
  })
})

const contract = (scope: string, op: Contract['op']): Contract => ({ scope, op })
const heldBy = (holder: string, ...contracts: Contract[]) => ({ holder, contracts })

describe('collision on contracts (CC-710)', () => {
  const refusal = (ours: Contract[], theirs: Contract[], over: Partial<CollisionFacts> = {}) =>
    collision(
      work('CC-1', { slice: 'a', contracts: ours }),
      facts({ held: [heldBy('CC-2', ...theirs)], ...over }),
    )

  it.each([
    ['replace against extend', contract('api:/v1/report', 'replace'), contract('api:/v1/report', 'extend')],
    [
      'extend against held replace',
      contract('api:/v1/report', 'extend'),
      contract('api:/v1/report', 'replace'),
    ],
    ['remove against add', contract('api:/v1/report', 'remove'), contract('api:/v1/report', 'add')],
    ['rename against modify', contract('api:/v1/report', 'rename'), contract('api:/v1/report', 'modify')],
    ['migrate against extend', contract('api:/v1/report', 'migrate'), contract('api:/v1/report', 'extend')],
    ['add against held migrate', contract('api:/v1/report', 'add'), contract('api:/v1/report', 'migrate')],
    ['remove against remove', contract('api:/v1/report', 'remove'), contract('api:/v1/report', 'remove')],
  ])('%s on one scope refuses with contract-overlap', (_, ours, theirs) => {
    const result = refusal([ours], [theirs])

    expect(result?.kind).toBe('contract-overlap')
    expect(result?.reason).toContain('api:/v1/report')
    expect(result?.reason).toContain('CC-2')
  })

  it.each([
    ['extend against add', contract('s', 'extend'), contract('s', 'add')],
    ['modify against modify', contract('s', 'modify'), contract('s', 'modify')],
    [
      'a different middle segment',
      contract('App/Billing/Report', 'replace'),
      contract('App/Admin/Report', 'replace'),
    ],
    ['a prefix scope', contract('App/Billing', 'replace'), contract('App/Billing/Report', 'extend')],
    ['a different case', contract('src/a.ts#foo', 'replace'), contract('src/a.ts#Foo', 'replace')],
  ])('%s passes', (_, ours, theirs) => {
    expect(refusal([ours], [theirs])).toBeUndefined()
  })

  it('work with no contracts behaves as today, against a held destructive contract', () => {
    const result = collision(work('CC-1'), facts({ held: [heldBy('CC-2', contract('s', 'remove'))] }))

    expect(result).toBeUndefined()
  })

  it('reports file-overlap, not contract-overlap, when both clash', () => {
    const result = refusal([contract('s', 'remove')], [contract('s', 'remove')], {
      prs: [pr(7)],
      prFiles: () => ['src/x.ts'],
    })
    const owned = collision(
      work('CC-1', { owns: ['src/x.ts'], contracts: [contract('s', 'remove')] }),
      facts({ held: [heldBy('CC-2', contract('s', 'remove'))], prs: [pr(7)], prFiles: () => ['src/x.ts'] }),
    )

    expect(result?.kind).toBe('contract-overlap')
    expect(owned?.kind).toBe('file-overlap')
  })
})

describe('collisionCheck holds contracts from the ledger (CC-710)', () => {
  const claim = (slice: string, over: Partial<Claim> = {}): Claim => ({
    taskId: 'CC-1',
    initiative: 'alpha',
    spawnedAt: '2026-10-06T09:00:00.000Z',
    phase: 'implementing',
    phaseAt: '2026-10-06T09:00:00.000Z',
    slice,
    contracts: [contract('api:/v1/report', 'remove')],
    ...over,
  })
  const check = (claims: Claim[], ours: Contract[]) => {
    const exec: Runner = (bin, args) =>
      bin === 'gh'
        ? { status: 0, stdout: '' }
        : { status: args[0] === 'log' || args[0] === 'fetch' ? 0 : 1, stdout: '' }
    const run = collisionCheck({ ...EMPTY_LEDGER, claims }, { names: [], claims: [] }, exec)
    return run('/repo', work('CC-1', { slice: 'a', contracts: ours }))
  }
  const ours = [contract('api:/v1/report', 'extend')]

  it("never refuses a work on its own held claim's contracts", () => {
    expect(check([claim('a')], ours)).toBeUndefined()
  })

  it('refuses a sibling slice of the same task with a destructive overlap', () => {
    expect(check([claim('a'), claim('b')], ours)?.kind).toBe('contract-overlap')
  })

  it("ignores a done claim's contracts", () => {
    expect(check([claim('b', { phase: 'done' })], ours)).toBeUndefined()
  })

  it('never refuses against a queued claim, so two queued claims cannot block each other', () => {
    const queuedRemove = claim('a', { taskId: 'CC-2', phase: 'queued' })

    expect(check([queuedRemove], ours)).toBeUndefined()
    expect(check([queuedRemove], [contract('api:/v1/report', 'remove')])).toBeUndefined()
  })

  it('refuses another task holding a destructive overlap', () => {
    expect(check([claim('a', { taskId: 'CC-2' })], ours)?.kind).toBe('contract-overlap')
  })
})

describe('sameTickCollision on contracts (CC-710)', () => {
  const earlier = (...contracts: Contract[]) => [
    { seat: 'seat-a', repo: '/repo', agentName: 'sa-cc-1-a', work: work('CC-1', { slice: 'a', contracts }) },
  ]

  it("refuses an earlier seat's replace on the scope this tick, across repos", () => {
    const result = sameTickCollision(
      earlier(contract('api:/v1/report', 'replace')),
      '/other',
      work('CC-2', { contracts: [contract('api:/v1/report', 'extend')] }),
    )

    expect(result?.kind).toBe('contract-overlap')
    expect(result?.reason).toContain('sa-cc-1-a')
  })

  it("passes an earlier seat's add against our extend", () => {
    const result = sameTickCollision(
      earlier(contract('api:/v1/report', 'add')),
      '/repo',
      work('CC-2', { contracts: [contract('api:/v1/report', 'extend')] }),
    )

    expect(result).toBeUndefined()
  })
})

describe('collision: an agent that exited less than one tick ago (CC-946)', () => {
  it('refuses a task a foreign agent carrying its id just exited from', () => {
    const found = collision(work('CC-9'), facts({ recentlyExited: ['pc-cc-9-swap-back'] }))

    expect(found?.kind).toBe('claimed')
    expect(found?.reason).toMatch(/pc-cc-9-swap-back.*exited less than one tick ago/)
  })

  it("lets a task's own previous agent through, so a sibling slice is not held a tick", () => {
    const own = facts({ recentlyExited: ['sa-cc-9-a'], ours: new Set(['sa-cc-9-a']) })

    expect(collision(work('CC-9'), own)).toBeUndefined()
  })

  it('lets a task through when the exited agent carries another id', () => {
    expect(collision(work('CC-9'), facts({ recentlyExited: ['sa-cc-90'] }))).toBeUndefined()
  })
})

describe('collisionCheck holds owns from live ledger claims (CC-952)', () => {
  const claim = (over: Partial<Claim> = {}): Claim => ({
    taskId: 'CC-1',
    initiative: 'alpha',
    spawnedAt: '2026-10-10T09:00:00.000Z',
    phase: 'implementing',
    phaseAt: '2026-10-10T09:00:00.000Z',
    slice: 'a',
    owns: ['src/a/**'],
    worktree: '/repo/.worktrees/sa-cc-1-a',
    ...over,
  })
  const check = (claims: Claim[], owns: string[], repo = '/repo') => {
    const exec: Runner = (bin, args) =>
      bin === 'gh'
        ? { status: 0, stdout: '' }
        : { status: args[0] === 'log' || args[0] === 'fetch' ? 0 : 1, stdout: '' }
    const run = collisionCheck({ ...EMPTY_LEDGER, claims }, { names: [], claims: [] }, exec)
    return run(repo, work('CC-2', { owns }))
  }

  it("refuses a task whose owns overlap a dispatched claim's owns in the same repo", () => {
    const result = check([claim()], ['src/a/x.ts'])

    expect(result).toEqual({ kind: 'file-overlap', reason: "src/a/x.ts is under CC-1 slice a's owns" })
  })

  it('passes a task whose owns are disjoint, so two tasks run in one repo', () => {
    expect(check([claim()], ['src/b.ts'])).toBeUndefined()
  })

  it('never refuses against a queued claim, so two queued claims cannot block each other', () => {
    expect(check([claim({ phase: 'queued' })], ['src/a/x.ts'])).toBeUndefined()
  })

  it("ignores a done claim's owns", () => {
    expect(check([claim({ phase: 'done' })], ['src/a/x.ts'])).toBeUndefined()
  })

  it('ignores a claim whose worktree is in another repo', () => {
    expect(check([claim({ worktree: '/other/.worktrees/sa-cc-1-a' })], ['src/a/x.ts'])).toBeUndefined()
  })

  it("takes a worktree-less claim's repo from its plan", () => {
    const planned = claim({ worktree: undefined, repo: '/repo' })

    expect(check([planned], ['src/a/x.ts'])?.kind).toBe('file-overlap')
    expect(check([planned], ['src/a/x.ts'], '/other')).toBeUndefined()
  })

  it("never refuses a work on its own held claim's owns", () => {
    expect(check([claim({ taskId: 'CC-2', slice: undefined })], ['src/a/x.ts'])).toBeUndefined()
  })

  // CC-1303. Mutation caught: heldOwns dropping the claim's taskId, slice or pr, so no accept can match it.
  it.each([
    ['its slice', { task: 'CC-1', slice: 'a' }, {}],
    ['its PR', { pr: 41 }, { pr: 'https://github.com/acme/demo/pull/41' }],
  ])("passes a work whose overlapsAccepted names the held claim by %s", (_, names, over) => {
    const accept = { ...names, path: 'src/a/x.ts', why: 'other lines' }
    const exec: Runner = (bin, args) =>
      bin === 'gh'
        ? { status: 0, stdout: '' }
        : { status: args[0] === 'log' || args[0] === 'fetch' ? 0 : 1, stdout: '' }
    const run = collisionCheck({ ...EMPTY_LEDGER, claims: [claim(over)] }, { names: [], claims: [] }, exec)

    expect(run('/repo', work('CC-2', { owns: ['src/a/x.ts'], overlapsAccepted: [accept] }))).toBeUndefined()
  })
})

describe("collisionCheck reads burndown agents' owns from the ledger, not their broker claim (CC-1276)", () => {
  const claim = (over: Partial<Claim> = {}): Claim => ({
    taskId: 'TP-1',
    initiative: 'alpha',
    spawnedAt: '2026-10-13T09:00:00.000Z',
    phase: 'implementing',
    phaseAt: '2026-10-13T09:00:00.000Z',
    slice: 'b',
    agentName: 'bd-tp-1-b',
    owns: ['.changeset/tp-1-b*.md', 'src/b.ts'],
    worktree: '/repo/.worktrees/bd-tp-1-b',
    ...over,
  })
  const check = (claims: Claim[], fileClaims: FileClaim[], owns: string[]) => {
    const exec: Runner = (bin, args) =>
      bin === 'gh'
        ? { status: 0, stdout: '' }
        : { status: args[0] === 'log' || args[0] === 'fetch' ? 0 : 1, stdout: '' }
    const run = collisionCheck({ ...EMPTY_LEDGER, claims }, { names: [], claims: fileClaims }, exec)
    return run('/repo', work('CC-2', { owns }))
  }
  const stale: FileClaim = { owner: 'bd-tp-1-b', repo: '/repo', patterns: ['README.md'] }

  it("passes work on a path only the burndown agent's spawn-time broker claim holds", () => {
    expect(check([claim()], [stale], ['README.md'])).toBeUndefined()
  })

  it("refuses work on the ledger's reloaded owns of the same agent", () => {
    const result = check([claim()], [stale], ['src/b.ts'])

    expect(result).toEqual({ kind: 'file-overlap', reason: "src/b.ts is under TP-1 slice b's owns" })
  })

  it("still refuses on a non-burndown owner's broker claim", () => {
    const human: FileClaim = { owner: 'human-session', repo: '/repo', patterns: ['README.md'] }

    expect(check([claim()], [human], ['README.md'])?.kind).toBe('claimed')
  })

  it("still refuses on the broker claim of a queued claim's agent", () => {
    expect(check([claim({ phase: 'queued' })], [stale], ['README.md'])?.kind).toBe('claimed')
  })
})
