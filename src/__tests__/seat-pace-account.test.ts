import { describe, expect, it } from 'vitest'
import type { BudgetRead } from '../agents/budget.js'
import type { WatchdogDoc } from '../agents/seats/io.js'
import type { PaceDoc, ReadingRow } from '../agents/seats/pace-pass.js'
import { runWatchdog, type WatchdogDeps } from '../agents/seats/run.js'

/** CC-1289: two charter pools logged in to one Anthropic account are read, probed, metered and paced once. */

const DAY = 86_400_000
const NOW = new Date(2026, 9, 6, 12, 8).getTime()
const RESET_S = Math.round((NOW + 4 * DAY) / 1000)

const CHARTER = `---
owner_seat: seat-a
seats: [seat-a]
pools:
  claude:   {config_dir: /synthetic/claude, human_uses: false, reserve_seven_day: 14, ceiling_five_hour: 100}
  personal: {config_dir: /synthetic/personal, human_uses: false, reserve_seven_day: 20, ceiling_five_hour: 95}
---
`

const read = (sevenDay: number, ageSeconds: number): BudgetRead => ({
  found: true,
  path: '/x',
  age_seconds: ageSeconds,
  stale: ageSeconds > 120,
  budget: {
    session_id: 's',
    written_at: 0,
    context: { exceeds_200k: false },
    cost: {},
    rate_limits: { five_hour: { used_pct: 21 }, seven_day: { used_pct: sevenDay, resets_at: RESET_S } },
  },
})

interface Harness {
  deps: WatchdogDeps
  pace: PaceDoc | undefined
  history: ReadingRow[]
  probed: string[]
  doc: WatchdogDoc
}

function harness(logins: Record<string, string | undefined>, ageSeconds = 60): Harness {
  const h: Harness = {
    pace: undefined,
    history: [],
    probed: [],
    doc: { seats: {}, pools: {}, stopped: {} },
    deps: {
      now: () => new Date(NOW),
      readCharter: () => CHARTER,
      readSeatFile: () => '---\nprefix: sa\npool: personal\n---\n',
      seatLogDays: () => [],
      readSeatLog: () => undefined,
      readBudget: dir => read(dir === '/synthetic/claude' ? 16 : 15, h.probed.includes(dir) ? 0 : ageSeconds),
      ownerMessages: () => [],
      roster: async () => ({ agents: [], connected: ['seat-a'] }),
      presence: () => undefined,
      eligible: () => ({ count: 0, skipped: 0 }),
      loadDoc: () => structuredClone(h.doc),
      saveDoc: doc => void (h.doc = { ...doc, stopped: {} }),
      wake: async () => ({ ok: true, detail: 'm1' }),
      appendLog: () => undefined,
      lock: () => ({ held: true, release: () => undefined }),
      pace: {
        read: () => h.pace,
        write: doc => void (h.pace = doc),
        append: rows => void h.history.push(...rows),
      },
      probe: dir => h.probed.push(dir) > 0,
      identify: dir => logins[dir],
    },
  }
  return h
}

const ONE_LOGIN = { '/synthetic/claude': 'acct-1/org-1', '/synthetic/personal': 'acct-1/org-1' }
const TWO_LOGINS = { '/synthetic/claude': 'acct-1/org-1', '/synthetic/personal': 'acct-2/org-1' }

describe('the watchdog pass counts one Anthropic account once', () => {
  it('writes one pace row keyed by the first pool and naming both members', async () => {
    const h = harness(ONE_LOGIN)

    await runWatchdog(h.deps, { dryRun: false })

    expect(Object.keys(h.pace?.pools ?? {})).toEqual(['claude'])
    expect(h.pace?.pools.claude).toMatchObject({ sevenDay: 16, members: ['claude', 'personal'] })
  })

  it('appends one history row for the account', async () => {
    const h = harness(ONE_LOGIN)

    await runWatchdog(h.deps, { dryRun: false })

    expect(h.history.map(row => `${row.pool} ${row.seven_day}`)).toEqual(['claude 16'])
  })

  it('probes a stale account once, through its key pool', async () => {
    const h = harness(ONE_LOGIN, 3_600)

    await runWatchdog(h.deps, { dryRun: false })

    expect(h.probed).toEqual(['/synthetic/claude'])
  })

  it('keeps one day meter and mirrors it to the member the seat calls home', async () => {
    const h = harness(ONE_LOGIN)

    await runWatchdog(h.deps, { dryRun: false })

    expect(h.doc.pools.claude).toBeDefined()
    expect(h.doc.pools.personal).toEqual(h.doc.pools.claude)
    expect(h.doc.lastReadings?.personal).toEqual(h.doc.lastReadings?.claude)
  })

  it("carries the key pool's meter over a member's diverged one from before the merge", async () => {
    const h = harness(ONE_LOGIN)
    const since = new Date(2026, 9, 6, 7).getTime()
    h.doc.pools = { claude: { since, last: 10, spent: 6 }, personal: { since, last: 12, spent: 3 } }

    await runWatchdog(h.deps, { dryRun: false })

    expect(h.doc.pools.claude).toMatchObject({ spent: 12, last: 16 })
    expect(h.doc.pools.personal).toEqual(h.doc.pools.claude)
  })

  it('still paces, records and probes two accounts as two', async () => {
    const h = harness(TWO_LOGINS, 3_600)

    await runWatchdog(h.deps, { dryRun: false })

    expect(Object.keys(h.pace?.pools ?? {})).toEqual(['claude', 'personal'])
    expect(h.pace?.pools.claude?.members).toBeUndefined()
    expect(h.history.map(row => row.pool)).toEqual(['claude', 'personal'])
    expect([...h.probed].sort()).toEqual(['/synthetic/claude', '/synthetic/personal'])
  })

  it('keeps a pool whose login cannot be read as its own account', async () => {
    const h = harness({ '/synthetic/claude': undefined, '/synthetic/personal': undefined })

    await runWatchdog(h.deps, { dryRun: false })

    expect(Object.keys(h.pace?.pools ?? {})).toEqual(['claude', 'personal'])
    expect(h.history).toHaveLength(2)
  })
})
