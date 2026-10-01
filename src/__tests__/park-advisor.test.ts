import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BudgetRead, PromptCache } from '../agents/budget.js'
import { DEFAULT_PARK_ADVICE, resolveParkAdvicePolicy, type ParkAdvicePolicy } from '../config.js'
import type { WaitClass } from '../server/human-wait.js'
import { ParkAdvisor, usableReading } from '../server/park-advisor.js'

const NOW = 1_800_000_000_000
const MIN = 60_000
const POLICY: ParkAdvicePolicy = { tokens: 200_000, leadMinutes: 8, ttlMinutes: 60 }

const expiresIn = (ms: number): number => Math.round((NOW + ms) / 1000)

function reading(tokens: number, cache: PromptCache | undefined): BudgetRead {
  return {
    found: true,
    path: '/tmp/status.json',
    age_seconds: 3000,
    stale: true,
    budget: {
      session_id: 'sess-1',
      written_at: Math.round(NOW / 1000) - 3000,
      context: { input_tokens: tokens, exceeds_200k: tokens > 200_000 },
      cost: {},
      rate_limits: {},
      ...(cache === undefined ? {} : { prompt_cache: cache }),
    },
  }
}

const warm = (msLeft: number): PromptCache => ({
  warm: true,
  caching_observed: true,
  ttl: '1h',
  expires_at: expiresIn(msLeft),
})

interface Rig {
  advisor: ParkAdvisor
  notices: string[]
  logs: { event: string; detail: Record<string, unknown> }[]
  setBudget: (read: BudgetRead) => void
}

function rig(opts: { policy?: ParkAdvicePolicy | null; budget?: BudgetRead; wait?: WaitClass } = {}): Rig {
  const notices: string[] = []
  const logs: Rig['logs'] = []
  let budget = opts.budget ?? reading(260_000, warm(7 * MIN))
  const advisor = new ParkAdvisor({
    sessionId: 'sess-1',
    policy: opts.policy === undefined ? POLICY : opts.policy,
    now: () => NOW,
    readBudget: () => budget,
    classify: async () => opts.wait ?? { kind: 'awaiting-turn-end' },
    notify: content => notices.push(content),
    log: (event, detail) => logs.push({ event, detail }),
    name: () => 'coord',
  })
  return { advisor, notices, logs, setBudget: read => (budget = read) }
}

describe('ParkAdvisor', () => {
  it('a warm 260k session idle on the human 7 min before cache expiry gets one park notice', async () => {
    const { advisor, notices, logs } = rig()

    await advisor.tick()

    expect(notices).toHaveLength(1)
    expect(logs).toEqual([
      {
        event: 'park_advised',
        detail: {
          name: 'coord',
          session_id: 'sess-1',
          tokens: 260_000,
          minutes_left: 7,
          wait_kind: 'awaiting-turn-end',
        },
      },
    ])
  })

  it('names the minutes left, the tokens, the teleport call and its advisory standing', async () => {
    const { advisor, notices } = rig()

    await advisor.tick()

    const [notice] = notices
    expect(notice).toMatch(/^\[park\] /)
    expect(notice).toContain('about 53 min at 260k tokens')
    expect(notice).toContain('expires in about 7 min')
    expect(notice).toContain('agent_teleport')
    expect(notice).toContain('reason "park"')
    expect(notice).toContain('advisory')
  })

  it('sends nothing again for the same cache expiry', async () => {
    const { advisor, notices, logs } = rig()

    await advisor.tick()
    await advisor.tick()

    expect(notices).toHaveLength(1)
    expect(logs).toHaveLength(1)
  })

  it('re-arms when a new turn moves the cache expiry', async () => {
    const { advisor, notices, setBudget } = rig()
    await advisor.tick()

    setBudget(reading(270_000, warm(6 * MIN)))
    await advisor.tick()

    expect(notices).toHaveLength(2)
  })

  it('also advises a session blocked on an unanswered AskUserQuestion', async () => {
    const { advisor, logs } = rig({ wait: { kind: 'awaiting-ask' } })

    await advisor.tick()

    expect(logs[0]?.detail.wait_kind).toBe('awaiting-ask')
  })

  it('sends nothing to a session mid-episode', async () => {
    const { advisor, notices } = rig({ wait: { kind: 'mid-episode', reason: 'partial-edit' } })

    await advisor.tick()

    expect(notices).toEqual([])
  })

  it('sends nothing when the wait cannot be classified', async () => {
    const { advisor, notices } = rig({ wait: { kind: 'unknown' } })

    await advisor.tick()

    expect(notices).toEqual([])
  })

  it('sends nothing once the cache has gone cold', async () => {
    const cold = rig({ budget: reading(260_000, { ...warm(7 * MIN), warm: false }) })
    const expired = rig({ budget: reading(260_000, warm(-1 * MIN)) })

    await cold.advisor.tick()
    await expired.advisor.tick()

    expect([...cold.notices, ...expired.notices]).toEqual([])
  })

  it('sends nothing under the token threshold', async () => {
    const { advisor, notices } = rig({ budget: reading(150_000, warm(7 * MIN)) })

    await advisor.tick()

    expect(notices).toEqual([])
  })

  it('waits until the cache is within the lead time of expiring', async () => {
    const { advisor, notices } = rig({ budget: reading(260_000, warm(30 * MIN)) })

    await advisor.tick()

    expect(notices).toEqual([])
  })

  it('sends nothing when the policy is off', async () => {
    const { advisor, notices } = rig({ policy: null })

    await advisor.tick()

    expect(notices).toEqual([])
  })

  it('derives expiry from the last request and the fallback TTL when the status line has none', async () => {
    const read = reading(260_000, undefined)
    if (read.found) read.budget.written_at = Math.round((NOW - 53 * MIN) / 1000)
    const { advisor, notices } = rig({ budget: read })

    await advisor.tick()

    expect(notices[0]).toContain('expires in about 7 min')
  })

  it('never advises a cache whose TTL is no longer than the lead time', async () => {
    const { advisor, notices } = rig({ budget: reading(260_000, { ...warm(3 * MIN), ttl: '5m' }) })

    await advisor.tick()

    expect(notices).toEqual([])
  })
})

describe('usableReading', () => {
  it('keeps a stale status-line reading written after the last request', () => {
    const read = reading(260_000, warm(7 * MIN))
    const writtenAt = read.found ? read.budget.written_at : 0

    expect(usableReading(read, writtenAt - 5)).toBe(true)
  })

  it('drops a stale status-line reading older than the last request', () => {
    const read = reading(260_000, warm(7 * MIN))
    const writtenAt = read.found ? read.budget.written_at : 0

    expect(usableReading(read, writtenAt + 60)).toBe(false)
  })

  it('drops a stale reading when the last request time is unknown', () => {
    expect(usableReading(reading(260_000, warm(7 * MIN)), undefined)).toBe(false)
  })
})

describe('resolveParkAdvicePolicy', () => {
  let home: string

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'park-advice-'))
    process.env.AGENT_CHAT_HOME = home
  })

  afterEach(() => {
    delete process.env.AGENT_CHAT_HOME
    fs.rmSync(home, { recursive: true, force: true })
  })

  const writeConfig = (config: object) =>
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(config))

  it('advises a human session at 200k by default', () => {
    expect(resolveParkAdvicePolicy(undefined, undefined)).toEqual(DEFAULT_PARK_ADVICE)
    expect(DEFAULT_PARK_ADVICE).toEqual({ tokens: 200_000, leadMinutes: 8, ttlMinutes: 60 })
  })

  it('is off for a planner, whose context hint policy is null', () => {
    expect(resolveParkAdvicePolicy('planner', 'iterm-pane')).toBeNull()
  })

  it('is off on a headless surface', () => {
    expect(resolveParkAdvicePolicy('implementer', 'headless')).toBeNull()
  })

  it('is off when parkAdvice.enabled is false', () => {
    writeConfig({ parkAdvice: { enabled: false } })

    expect(resolveParkAdvicePolicy(undefined, undefined)).toBeNull()
  })

  it('takes configured numbers and keeps the default for an invalid one', () => {
    writeConfig({ parkAdvice: { tokens: 260_000, leadMinutes: 0 } })

    expect(resolveParkAdvicePolicy(undefined, undefined)).toEqual({ ...DEFAULT_PARK_ADVICE, tokens: 260_000 })
  })
})
