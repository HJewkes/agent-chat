import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { stateCoreRemaining, stateCooldownEnd } from '../cli/gh-write.js'
import {
  BASE_COOLDOWN_MS,
  MAX_SECONDARY_MS,
  budgetPaths,
  nextEntry,
  observedCooldowns,
  recordHit,
  type BudgetPaths,
  type Hit,
} from '../gh-budget/state.js'
import { GH_BUDGET_URL_ENV } from '../gh-shim/rate-limit.js'
import { ghWrite, type GhResult, type ThrottleDeps } from '../gh-write/throttle.js'

/**
 * CC-1162: the shared cooldown's rules, its file, and gh-write reading it instead of `/rate_limit`,
 * which never shows the secondary limit.
 */

const NOW = 1_700_000_000_000
const secondary = (retryAfterSeconds?: number): Hit => ({
  lane: 'rest',
  class: 'secondary',
  retryAfterSeconds,
})

describe('cooldown length', () => {
  it('backs a repeated secondary hit off 60 s × 2^strikes, capped at 15 min', () => {
    const lengths: number[] = []
    let entry = nextEntry(undefined, secondary(), NOW)
    let now = NOW
    for (let i = 0; i < 6; i++) {
      lengths.push(entry.until - now)
      now = entry.until + 1_000
      entry = nextEntry(entry, secondary(), now)
    }

    expect(lengths).toEqual([60_000, 120_000, 240_000, 480_000, 900_000, 900_000])
  })

  it('takes retry-after when it is longer than the backoff', () => {
    expect(nextEntry(undefined, secondary(200), NOW).until).toBe(NOW + 200_000)
    expect(nextEntry(undefined, secondary(10), NOW).until).toBe(NOW + BASE_COOLDOWN_MS)
    expect(nextEntry(undefined, secondary(7200), NOW).until).toBe(NOW + MAX_SECONDARY_MS)
  })

  it('cools a primary hit until x-ratelimit-reset', () => {
    const reset = Math.floor(NOW / 1000) + 1800

    const entry = nextEntry(undefined, { lane: 'rest', class: 'primary', resetSeconds: reset }, NOW)

    expect(entry).toEqual({ until: reset * 1000, class: 'primary', strikes: 0 })
  })

  it('adds no strike for a refusal while the lane is still cooling', () => {
    const first = nextEntry(undefined, secondary(), NOW)

    const again = nextEntry(first, secondary(), NOW + 5_000)

    expect(again).toEqual({ until: NOW + 5_000 + 60_000, class: 'secondary', strikes: 0 })
  })

  it('starts over at 60 s once the last cooldown ended long ago', () => {
    const old = { until: NOW - MAX_SECONDARY_MS - 1, class: 'secondary' as const, strikes: 3 }

    expect(nextEntry(old, secondary(), NOW)).toEqual({ until: NOW + 60_000, class: 'secondary', strikes: 0 })
  })
})

describe('cooldown state file', () => {
  let dir: string
  let paths: BudgetPaths
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-gh-budget-'))
    paths = budgetPaths({ XDG_STATE_HOME: dir })
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  const deps = { now: () => NOW, sleep: async () => {} }

  it('keeps a REST cooldown from closing the GraphQL lane', async () => {
    await recordHit(paths, secondary(), deps)

    expect(observedCooldowns(paths, NOW + 1)).toEqual({
      rest: { until: NOW + 60_000, class: 'secondary', source: 'observed' },
    })
  })

  it('reads an expired cooldown as none', async () => {
    await recordHit(paths, secondary(), deps)

    expect(observedCooldowns(paths, NOW + 60_000)).toEqual({})
  })
})

describe('gh-write reading the shared cooldown', () => {
  let dir: string
  let env: NodeJS.ProcessEnv
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-ghw-budget-'))
    // Port 1 refuses at once: no gateway, which must read as no gateway cooldown.
    env = { XDG_STATE_HOME: dir, [GH_BUDGET_URL_ENV]: 'http://127.0.0.1:1/rpc/shepherd.ghBudget' }
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  const AMBIGUOUS = 'gh: API rate limit exceeded for user ID 1. (HTTP 403)\n'
  const ok = (): GhResult => ({ code: 0, stdout: Buffer.from('done\n'), stderr: Buffer.alloc(0) })
  const fail = (text: string): GhResult => ({ code: 1, stdout: Buffer.alloc(0), stderr: Buffer.from(text) })

  /** Real `/rate_limit` reports 5000 left, as it does under the secondary limit. */
  function harness(replies: GhResult[], beforeReply: (now: number) => Promise<void> = async () => {}) {
    let clock = NOW
    const sleeps: number[] = []
    const calls: string[][] = []
    const deps: ThrottleDeps = {
      now: () => clock,
      sleep: async ms => {
        sleeps.push(ms)
        clock += ms
      },
      runGh: async args => {
        calls.push(args)
        if (args.includes('rate_limit')) return { ...ok(), stdout: Buffer.from('5000\n') }
        await beforeReply(clock)
        return replies.shift() ?? ok()
      },
      coreRemaining: stateCoreRemaining(env, () => clock),
      cooldownEnd: stateCooldownEnd(env, () => clock),
      notice: () => {},
      lockDir: path.join(dir, 'gh-write.lock'),
      stampPath: path.join(dir, 'gh-write.stamp.json'),
      gapMs: 3000,
    }
    return { deps, sleeps, calls }
  }

  it('pauses an ambiguous refusal until the shared cooldown ends, never asking /rate_limit', async () => {
    // The shim on gh-write's PATH records the refusal while gh runs, as the first call fails.
    let recorded = false
    const shimRecords = async (now: number) => {
      if (recorded) return
      recorded = true
      await recordHit(budgetPaths(env), secondary(240), { now: () => now, sleep: async () => {} })
    }
    const { deps, sleeps, calls } = harness([fail(AMBIGUOUS), ok()], shimRecords)

    const result = await ghWrite(
      ['api', '-X', 'POST', 'repos/acme/widgets/issues/7/comments', '-f', 'body=hi'],
      deps,
    )

    expect(result.code).toBe(0)
    expect(sleeps.reduce((sum, ms) => sum + ms, 0)).toBeGreaterThanOrEqual(240_000)
    expect(calls.filter(args => args.includes('rate_limit'))).toEqual([])
    expect(calls).toHaveLength(2)
  })

  it('reports core spent only while a primary limit cools the REST lane', async () => {
    const paths = budgetPaths(env)
    const record = (hit: Hit) => recordHit(paths, hit, { now: () => NOW, sleep: async () => {} })
    const remaining = stateCoreRemaining(env, () => NOW + 1)

    await record({ lane: 'graphql', class: 'primary' })
    expect(await remaining()).toBeUndefined()
    await record({ lane: 'rest', class: 'primary', resetSeconds: Math.floor(NOW / 1000) + 600 })
    expect(await remaining()).toBe(0)
  })

  it('lets a write on an open lane through without waiting', async () => {
    const { deps, sleeps } = harness([ok()])
    await recordHit(
      budgetPaths(env),
      { lane: 'graphql', class: 'secondary' },
      { now: () => NOW, sleep: async () => {} },
    )

    const result = await ghWrite(['api', '-X', 'PUT', 'repos/acme/widgets/pulls/7/merge'], deps)

    expect(result.code).toBe(0)
    expect(sleeps).toEqual([])
  })
})
