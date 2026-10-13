import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RunResult, Runner } from '../agents/burndown/exec.js'
import { prFactsFile, prFactsReader, readPrFacts } from '../agents/burndown/pr-facts.js'

const REPO = 'acme/widgets'
const T0 = Date.parse('2026-10-12T16:00:00Z')
const MIN = 60_000

// Shapes recorded from live `gh api -i` calls on 2026-10-12; headers trimmed to the ones read.
const ok = (etag: string, pulls: unknown[]): RunResult => ({
  status: 0,
  stdout: `HTTP/2.0 200 OK\nContent-Type: application/json\r\nEtag: ${etag}\r\n\r\n${JSON.stringify(pulls)}`,
  stderr: '',
})
const notModified = (etag: string): RunResult => ({
  status: 1,
  stdout: `HTTP/2.0 304 Not Modified\nEtag: ${etag}\r\nX-Ratelimit-Resource: core\r\n\r\n`,
  stderr: 'gh: HTTP 304\n',
})
const secondaryLimit: RunResult = {
  status: 1,
  stdout: 'HTTP/2.0 403 Forbidden\r\n\r\n{"message":"You have exceeded a secondary rate limit."}',
  stderr: 'gh: You have exceeded a secondary rate limit. (HTTP 403)\n',
}

const pull = (n: number) => ({
  number: n,
  title: `PR ${n}`,
  body: null,
  draft: false,
  updated_at: '2026-10-12T15:00:00Z',
  head: { ref: `agent-chat/a-${n}`, sha: `sha${n}` },
  base: { ref: 'main' },
})

function fakeGh(responses: RunResult[]): { exec: Runner; calls: string[][] } {
  const calls: string[][] = []
  const exec: Runner = (_bin, args) => {
    calls.push(args)
    return responses.shift() ?? secondaryLimit
  }
  return { exec, calls }
}

let dir: string
let now: number
const clock = () => now

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-facts-'))
  now = T0
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('readPrFacts', () => {
  it('stores the etag, time and projected PRs on a 200', () => {
    const { exec, calls } = fakeGh([ok('W/"e1"', [pull(7)])])

    const facts = readPrFacts(REPO, { exec, dir, now: clock })

    expect(calls).toEqual([['api', '-i', 'repos/acme/widgets/pulls?state=open&per_page=100']])
    expect(facts).toMatchObject({ stale: false, ageMs: 0, complete: true })
    expect(facts?.prs).toEqual([
      {
        number: 7,
        title: 'PR 7',
        branch: 'agent-chat/a-7',
        body: '',
        headSha: 'sha7',
        base: 'main',
        draft: false,
        updatedAt: '2026-10-12T15:00:00Z',
      },
    ])
    const stored = JSON.parse(fs.readFileSync(prFactsFile(REPO, dir) ?? '', 'utf8')) as unknown
    expect(stored).toEqual({ v: 1, etag: 'W/"e1"', at: '2026-10-12T16:00:00.000Z', prs: facts?.prs })
  })

  it('sends the stored etag and reuses the stored list on a 304, re-stamping its time', () => {
    readPrFacts(REPO, { exec: fakeGh([ok('W/"e1"', [pull(7)])]).exec, dir, now: clock })
    now = T0 + 10 * MIN
    const { exec, calls } = fakeGh([notModified('"e1"')])

    const facts = readPrFacts(REPO, { exec, dir, now: clock })

    expect(calls[0]).toEqual(['api', '-i', '-H', 'If-None-Match: W/"e1"', expect.stringContaining('pulls?')])
    expect(facts).toMatchObject({ stale: false, ageMs: 0, at: '2026-10-12T16:10:00.000Z' })
    expect(facts?.prs.map(pr => pr.number)).toEqual([7])
  })

  it('answers a failed read with the stored list, marked stale with its age', () => {
    readPrFacts(REPO, { exec: fakeGh([ok('W/"e1"', [pull(7)])]).exec, dir, now: clock })
    now = T0 + 30 * MIN

    const facts = readPrFacts(REPO, { exec: fakeGh([secondaryLimit]).exec, dir, now: clock })

    expect(facts).toMatchObject({ stale: true, ageMs: 30 * MIN, at: '2026-10-12T16:00:00.000Z' })
    expect(facts?.prs.map(pr => pr.number)).toEqual([7])
  })

  it('fails closed when a read fails and nothing is stored', () => {
    expect(readPrFacts(REPO, { exec: fakeGh([secondaryLimit]).exec, dir, now: clock })).toBeUndefined()
  })

  it('treats a 304 with nothing stored as a failed read', () => {
    expect(readPrFacts(REPO, { exec: fakeGh([notModified('"e1"')]).exec, dir, now: clock })).toBeUndefined()
  })

  it('keeps the stored list when a 200 carries an unreadable body', () => {
    readPrFacts(REPO, { exec: fakeGh([ok('W/"e1"', [pull(7)])]).exec, dir, now: clock })
    const garbled: RunResult = { status: 0, stdout: 'HTTP/2.0 200 OK\r\n\r\n{"not":"a list"}', stderr: '' }

    const facts = readPrFacts(REPO, { exec: fakeGh([garbled]).exec, dir, now: clock })

    expect(facts).toMatchObject({ stale: true })
    expect(facts?.prs.map(pr => pr.number)).toEqual([7])
  })

  it('marks a full page incomplete, since a PR missing from it may still be open', () => {
    const pulls = Array.from({ length: 100 }, (_, i) => pull(i + 1))

    const facts = readPrFacts(REPO, { exec: fakeGh([ok('W/"e1"', pulls)]).exec, dir, now: clock })

    expect(facts?.complete).toBe(false)
  })

  it('refuses a repo name that is not owner/name, never touching disk or GitHub', () => {
    const { exec, calls } = fakeGh([ok('W/"e1"', [])])

    expect(readPrFacts('../etc', { exec, dir, now: clock })).toBeUndefined()
    expect(calls).toEqual([])
  })
})

describe('prFactsReader', () => {
  it('reads each repo once per tick, however many callers ask', () => {
    const { exec, calls } = fakeGh([ok('W/"a"', [pull(1)]), ok('W/"b"', [pull(2)])])
    const read = prFactsReader({ exec, dir, now: clock })

    read(REPO)
    read('acme/gadgets')
    const again = read(REPO)

    expect(calls).toHaveLength(2)
    expect(again?.prs.map(pr => pr.number)).toEqual([1])
  })

  it('remembers a failed read for the rest of the tick instead of retrying it', () => {
    const { exec, calls } = fakeGh([secondaryLimit, ok('W/"a"', [pull(1)])])
    const read = prFactsReader({ exec, dir, now: clock })

    read(REPO)

    expect(read(REPO)).toBeUndefined()
    expect(calls).toHaveLength(1)
  })
})
