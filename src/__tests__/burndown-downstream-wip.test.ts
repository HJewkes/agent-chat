import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Runner } from '../agents/burndown/exec.js'
import {
  downstreamCounts,
  downstreamReader,
  repoKeyFromRemote,
  type ShepherdRow,
} from '../agents/burndown/shepherd.js'
import { resolveSeatDispatch, type SeatDispatch } from '../agents/burndown/seat-dispatch.js'
import { loadPolicy, type Policy } from '../agents/burndown/policy.js'

/** CC-784: the per-repo WIP count a seat's dispatch is held against. Synthetic repos and ids only. */

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'autonomy-2026-09-29')

const withSeat = (policy: Policy, name: string, patch: Record<string, unknown>): Policy => ({
  ...policy,
  seats: { ...policy.seats, [name]: { ...policy.seats[name], ...patch } as Policy['seat'] },
})

const row = (repo: string, phase: ShepherdRow['phase'], pr = 1): ShepherdRow => ({
  repo,
  pr,
  runId: `run-${repo}-${pr}`,
  phase,
  headSha: null,
  stalled: null,
})

const dispatch = (reviewers: number, wipLimits: Record<string, number> = {}): SeatDispatch =>
  ({ caps: { implementers: 2, reviewers, planners: 0 }, wipLimits }) as SeatDispatch

const originRunner =
  (remotes: Record<string, string>): Runner =>
  (_bin, args) => {
    const url = remotes[args[1] as string]
    return url === undefined ? { status: 128, stdout: '' } : { status: 0, stdout: `${url}\n` }
  }

describe('downstream WIP count', () => {
  it('counts review, awaiting-approval and merging rows for the repo only', () => {
    const counts = downstreamCounts([
      row('acme/widgets', 'review', 1),
      row('acme/widgets', 'awaiting-approval', 2),
      row('acme/widgets', 'merging', 3),
      row('acme/widgets', 'ci', 4),
      row('acme/widgets', 'fixing', 5),
      row('acme/widgets', 'awaiting-pr', 6),
      row('acme/widgets', 'done', 7),
      row('acme/gadgets', 'review', 1),
    ])

    expect(counts.get('acme/widgets')).toBe(3)
    expect(counts.get('acme/gadgets')).toBe(1)
  })

  it('matches a checkout to its lowercased owner/name from ssh and https remotes', () => {
    expect(repoKeyFromRemote('git@github.com:Acme/Widgets.git')).toBe('acme/widgets')
    expect(repoKeyFromRemote('https://github.com/Acme/Widgets.git')).toBe('acme/widgets')
    expect(repoKeyFromRemote('https://github.com/Acme/Widgets')).toBe('acme/widgets')
    expect(repoKeyFromRemote('ssh://git@github.com/Acme/Widgets.git')).toBe('acme/widgets')
    expect(repoKeyFromRemote('/tmp/origin.git')).toBeUndefined()
  })

  it('answers per checkout from one Shepherd read and says why when it cannot', () => {
    let reads = 0
    const read = (): ShepherdRow[] => (reads++, [row('acme/widgets', 'review')])
    const exec = originRunner({
      '/w/a': 'git@github.com:Acme/Widgets.git',
      '/w/b': 'git@github.com:acme/widgets.git',
    })
    const downstream = downstreamReader(read, exec)(dispatch(1))

    expect(downstream('/w/a')).toMatchObject({ name: 'acme/widgets', count: 1 })
    expect(downstream('/w/b')).toMatchObject({ name: 'acme/widgets', count: 1 })
    expect(downstream('/w/none')).toEqual({ unknown: 'no origin remote for /w/none' })
    expect(reads).toBe(1)
    expect(downstreamReader(() => undefined, exec)(dispatch(1))('/w/a')).toEqual({
      unknown: 'could not read Shepherd status',
    })
  })

  it('the limit is twice the reviewer cap, at least 2', () => {
    const exec = originRunner({ '/w/a': 'https://github.com/acme/widgets.git' })
    const limitFor = (reviewers: number) => downstreamReader(() => [], exec)(dispatch(reviewers))('/w/a')

    expect(limitFor(3)).toMatchObject({ limit: 6 })
    expect(limitFor(1)).toMatchObject({ limit: 2 })
    expect(limitFor(0)).toMatchObject({ limit: 2 })
  })

  it('wip_limit on the repo row overrides the default', () => {
    const base = loadPolicy(FIXTURE, 'seat-a')
    const seat = base.seats['seat-a'] as Policy['seat']
    const policy = withSeat(base, 'seat-a', {
      repos: seat.repos.map((r, i) => (i === 0 ? { ...r, wip_limit: 5 } : r)),
    })
    const resolved = resolveSeatDispatch(policy, 'seat-a', '/tmp/home')
    const exec = originRunner({
      '/tmp/repos/alpha-app': 'https://github.com/acme/widgets.git',
      '/tmp/repos/alpha-docs': 'https://github.com/acme/docs.git',
    })
    const downstream = downstreamReader(() => [], exec)(resolved)

    expect(resolved.wipLimits).toEqual({ '/tmp/repos/alpha-app': 5 })
    expect(downstream('/tmp/repos/alpha-app')).toMatchObject({ limit: 5, setting: 'wip_limit' })
    expect(downstream('/tmp/repos/alpha-docs')).toMatchObject({ limit: 4 })
  })
})
