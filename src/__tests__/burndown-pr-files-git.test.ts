import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RunResult } from '../agents/burndown/exec.js'
import { parseNumstat, prFiles, prFilesCacheFile, type PrHead } from '../agents/burndown/pr-files-git.js'

let dir: string
let cacheFile: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-pr-files-git-'))
  cacheFile = prFilesCacheFile('Acme/widgets', dir)
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

interface FakeGit {
  calls: string[][]
  refs: string[]
  failFetchOf?: number
  failDiffOf?: number
  /** The sha `refs/pull/<n>/head` still serves, when GitHub has not yet moved it to the API's head. */
  servedHead?: Record<number, string>
}

/**
 * A git that answers fetch, diff, for-each-ref and update-ref. A fetch points `refs/agent-chat/pr/<n>`
 * at the served head; a diff of a commit never fetched fails, and otherwise names `pr<n>-<sha>.ts`.
 */
function fakeGit(git: FakeGit) {
  const prOfSha = new Map<string, number>()
  const fetched = new Set<string>()
  const refs = new Map<string, string>()
  return (prs: readonly PrHead[]) => {
    for (const pr of prs) prOfSha.set(pr.headSha, pr.number)
    return (_bin: string, args: string[]): RunResult => {
      git.calls.push(args)
      const ok = (stdout = ''): RunResult => ({ status: 0, stdout })
      const fail: RunResult = { status: 128, stdout: '' }
      if (args[0] === 'fetch') {
        if (args.some(a => a.startsWith(`+refs/pull/${git.failFetchOf}/head`))) return fail
        for (const pr of prs) {
          if (args.includes(`+refs/pull/${pr.number}/head:refs/agent-chat/pr/${pr.number}`)) {
            const served = git.servedHead?.[pr.number] ?? pr.headSha
            fetched.add(served)
            refs.set(`refs/agent-chat/pr/${pr.number}`, served)
          }
        }
        return ok()
      }
      if (args[0] === 'diff') {
        const head = (args[4] ?? '').split('...')[1] ?? ''
        const sha = refs.get(head) ?? head
        const pr = prOfSha.get(sha)
        return !fetched.has(sha) || pr === git.failDiffOf ? fail : ok(`3\t1\tpr${pr}-${sha}.ts\0`)
      }
      if (args[0] === 'for-each-ref') return ok(git.refs.join('\n'))
      return ok()
    }
  }
}

const pr = (number: number, headSha = `sha${number}`): PrHead => ({ number, headSha, base: 'main' })
const fetches = (git: FakeGit) => git.calls.filter(args => args[0] === 'fetch')

function tick(git: FakeGit, prs: readonly PrHead[], exec = fakeGit(git)) {
  return prFiles('/repo', prs, { exec: exec(prs), cacheFile })
}

const storedKeys = (): string[] =>
  Object.keys(
    (JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as { entries: Record<string, unknown> }).entries,
  )

describe('PR file lists from local git (CC-1157 c)', () => {
  it('fetches three uncached heads in one batch, and none the next tick at the same head shas', () => {
    const git: FakeGit = { calls: [], refs: [] }
    const open = [pr(1), pr(2), pr(3)]

    const first = tick(git, open)
    const second = tick(git, open)

    expect(fetches(git)).toHaveLength(1)
    expect(fetches(git)[0]).toEqual(
      expect.arrayContaining([
        '+refs/pull/1/head:refs/agent-chat/pr/1',
        '+refs/pull/2/head:refs/agent-chat/pr/2',
        '+refs/pull/3/head:refs/agent-chat/pr/3',
        '+refs/heads/main:refs/remotes/origin/main',
      ]),
    )
    expect(first.names(2)).toEqual(['pr2-sha2.ts'])
    expect(second.names(2)).toEqual(['pr2-sha2.ts'])
    expect(second.stats(2)).toEqual([{ path: 'pr2-sha2.ts', additions: 3, deletions: 1 }])
  })

  it('re-fetches only the PR whose head moved, and reads its new files', () => {
    const git: FakeGit = { calls: [], refs: [] }
    const exec = fakeGit(git)
    tick(git, [pr(1), pr(2)], exec)
    git.calls = []

    const after = tick(git, [pr(1), pr(2, 'pushed')], exec)

    expect(fetches(git)).toEqual([
      [
        'fetch',
        '--quiet',
        '--no-tags',
        'origin',
        '+refs/pull/2/head:refs/agent-chat/pr/2',
        expect.any(String),
      ],
    ])
    expect(after.names(2)).toEqual(['pr2-pushed.ts'])
    expect(after.names(1)).toEqual(['pr1-sha1.ts'])
  })

  it("prunes a closed PR's ref and cache entry", () => {
    const git: FakeGit = { calls: [], refs: [] }
    tick(git, [pr(1), pr(2)])
    git.refs = ['refs/agent-chat/pr/1', 'refs/agent-chat/pr/2']
    git.calls = []

    tick(git, [pr(1)])

    expect(git.calls.filter(args => args[0] === 'update-ref')).toEqual([
      ['update-ref', '-d', 'refs/agent-chat/pr/2'],
    ])
    expect(storedKeys()).toEqual(['1:sha1'])
  })

  it('caches nothing when the fetched head lags the head sha the API reported', () => {
    const git: FakeGit = { calls: [], refs: [] }
    const exec = fakeGit(git)
    tick(git, [pr(1)], exec)
    git.servedHead = { 1: 'sha1' }

    const lagging = tick(git, [pr(1, 'pushed')], exec)

    expect(lagging.names(1)).toBeUndefined()
    expect(storedKeys()).toEqual([])
  })

  it('reads the pushed files once GitHub serves the new head', () => {
    const git: FakeGit = { calls: [], refs: [], servedHead: { 1: 'sha1' } }
    const exec = fakeGit(git)
    tick(git, [pr(1, 'pushed')], exec)
    delete git.servedHead

    expect(tick(git, [pr(1, 'pushed')], exec).names(1)).toEqual(['pr1-pushed.ts'])
  })

  it('reads a retargeted PR again against its new base', () => {
    const git: FakeGit = { calls: [], refs: [] }
    const exec = fakeGit(git)
    tick(git, [pr(1)], exec)
    git.calls = []

    tick(git, [{ ...pr(1), base: 'release' }], exec)

    expect(fetches(git)).toHaveLength(1)
    expect(git.calls.find(args => args[0] === 'diff')?.[4]).toMatch(/^origin\/release\.\.\./)
  })

  it('gives undefined for a PR whose diff failed, and still lists the others', () => {
    const git: FakeGit = { calls: [], refs: [], failDiffOf: 2 }

    const files = tick(git, [pr(1), pr(2)])

    expect(files.names(2)).toBeUndefined()
    expect(files.names(1)).toEqual(['pr1-sha1.ts'])
  })

  it('retries a failed batch PR by PR, so one bad ref fails only its own PR', () => {
    const git: FakeGit = { calls: [], refs: [], failFetchOf: 2 }

    const files = tick(git, [pr(1), pr(2), pr(3)])

    expect(files.names(2)).toBeUndefined()
    expect(files.names(1)).toEqual(['pr1-sha1.ts'])
    expect(files.names(3)).toEqual(['pr3-sha3.ts'])
  })

  it('reads a failed PR again on the next tick rather than caching the failure', () => {
    const git: FakeGit = { calls: [], refs: [], failDiffOf: 2 }
    const exec = fakeGit(git)
    tick(git, [pr(2)], exec)
    delete git.failDiffOf

    expect(tick(git, [pr(2)], exec).names(2)).toEqual(['pr2-sha2.ts'])
  })
})

describe('git diff --numstat -z output', () => {
  it('reads plain, renamed and binary files', () => {
    const stdout = '1\t0\t\0a\0b\0-\t-\tbin\0' + '12\t4\tsrc/x.ts\0'

    expect(parseNumstat(stdout)).toEqual([
      { path: 'b', previousPath: 'a', additions: 1, deletions: 0 },
      { path: 'bin', additions: 0, deletions: 0 },
      { path: 'src/x.ts', additions: 12, deletions: 4 },
    ])
  })

  it('refuses the whole list when a record is unreadable', () => {
    expect(parseNumstat('1\t0\tok.ts\0garbage\0')).toBeUndefined()
  })
})
