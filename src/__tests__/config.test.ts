import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_NOTICE_TTL_HOURS,
  DEFAULT_PERMISSION_HOOK_TIMEOUT_S,
  resolveAgentSlots,
  resolveContextHintPolicy,
  resolveFullSuiteSlots,
  resolveMachineLimits,
  resolveNoticeTtlMs,
  resolvePermissionHookTimeout,
  resolveReportBatchMs,
  resolveWorktreeBudget,
} from '../config.js'
import { newAgentSlots } from '../broker/daemon.js'
import { Semaphore, DEFAULT_SLOTS } from '../agents/semaphore.js'

/**
 * `resolveAgentSlots` is exercised against a real tmp `AGENT_CHAT_HOME`, the
 * same isolation `hooks.test.ts` uses for `hooks.json` — never the real
 * `~/.agent-chat`.
 */

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-config-'))
  process.env.AGENT_CHAT_HOME = dir
})

afterEach(() => {
  delete process.env.AGENT_CHAT_HOME
  delete process.env.AGENT_CHAT_REPORT_BATCH_SECONDS
  fs.rmSync(dir, { recursive: true, force: true })
})

function writeConfigJson(config: unknown): void {
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config))
}

describe('resolveAgentSlots', () => {
  it('keeps DEFAULT_SLOTS when config.json does not exist', () => {
    expect(resolveAgentSlots()).toBe(DEFAULT_SLOTS)
  })

  it('keeps DEFAULT_SLOTS when agentSlots is absent from an existing config.json', () => {
    writeConfigJson({ worktreeBudget: 8 })

    expect(resolveAgentSlots()).toBe(DEFAULT_SLOTS)
  })

  it('honors a configured agentSlots value, allowing a 21st acquire at 30', () => {
    writeConfigJson({ agentSlots: 30 })

    const slots = resolveAgentSlots()
    const semaphore = new Semaphore(slots)
    for (let i = 0; i < 20; i++) expect(semaphore.acquire(`agent-${i}`)).toBe(true)

    expect(semaphore.acquire('agent-21')).toBe(true)
    expect(semaphore.summary()).toBe('21/30 slots')
  })

  it.each([
    ['a non-integer', 12.5],
    ['a value below 1', 0],
    ['a non-number', 'thirty'],
  ])('falls back to DEFAULT_SLOTS for %s agentSlots', (_scenario, value) => {
    writeConfigJson({ agentSlots: value })

    expect(resolveAgentSlots()).toBe(DEFAULT_SLOTS)
  })
})

describe('agent slot cap read per spawn (CC-159)', () => {
  it('applies a raised agentSlots to the next acquire without rebuilding the semaphore', () => {
    writeConfigJson({ agentSlots: 2 })
    const semaphore = new Semaphore(resolveAgentSlots)
    semaphore.acquire('a1')
    semaphore.acquire('a2')
    expect(semaphore.acquire('a3')).toBe(false)

    writeConfigJson({ agentSlots: 3 })

    expect(semaphore.acquire('a3')).toBe(true)
    expect(semaphore.summary()).toBe('3/3 slots')
  })

  it('keeps running agents when agentSlots drops below the live count and refuses only new ones', () => {
    writeConfigJson({ agentSlots: 3 })
    const semaphore = new Semaphore(resolveAgentSlots)
    for (const id of ['a1', 'a2', 'a3']) semaphore.acquire(id)

    writeConfigJson({ agentSlots: 1 })

    expect(semaphore.ids()).toEqual(['a1', 'a2', 'a3'])
    expect(semaphore.acquire('a4')).toBe(false)
    expect(semaphore.acquire('a1')).toBe(true)
    expect(semaphore.available).toBe(0)
    semaphore.release('a1')
    semaphore.release('a2')
    expect(semaphore.acquire('a4')).toBe(false)
    semaphore.release('a3')
    expect(semaphore.acquire('a4')).toBe(true)
  })
})

describe("the broker's own slot semaphore (CC-159)", () => {
  it('sees an agentSlots edit made after the broker built it', () => {
    writeConfigJson({ agentSlots: 2 })
    const semaphore = newAgentSlots()
    semaphore.acquire('a1')
    semaphore.acquire('a2')
    expect(semaphore.acquire('a3')).toBe(false)

    writeConfigJson({ agentSlots: 3 })

    expect(semaphore.acquire('a3')).toBe(true)
  })
})

describe('resolveWorktreeBudget', () => {
  it('keeps the fallback when config.json does not exist', () => {
    expect(resolveWorktreeBudget(3)).toBe(3)
  })

  it('returns a positive integer worktreeBudget from config.json', () => {
    writeConfigJson({ worktreeBudget: 10 })

    expect(resolveWorktreeBudget(3)).toBe(10)
  })

  it.each([0, -2, 2.5, '10', null])('falls back when worktreeBudget is %j', value => {
    writeConfigJson({ worktreeBudget: value })

    expect(resolveWorktreeBudget(3)).toBe(3)
  })
})

describe('machine guard limits (CC-406)', () => {
  it('defaults to 10 headless agents, 85 percent swap and 4 full-suite slots', () => {
    expect(resolveMachineLimits()).toEqual({ headlessAgents: 10, swapPercent: 85 })
    expect(resolveFullSuiteSlots()).toBe(4)
  })

  it('reads all three limits from config.json', () => {
    writeConfigJson({ machineHeadlessAgents: 6, machineSwapPercent: 70, fullSuiteSlots: 2 })

    expect(resolveMachineLimits()).toEqual({ headlessAgents: 6, swapPercent: 70 })
    expect(resolveFullSuiteSlots()).toBe(2)
  })

  it.each([0, 101, 50.5, '70'])('falls back to 85 when machineSwapPercent is %j', value => {
    writeConfigJson({ machineSwapPercent: value })

    expect(resolveMachineLimits().swapPercent).toBe(85)
  })
})

describe('resolveContextHintPolicy', () => {
  it('uses the owner-chosen defaults per role when config.json is silent', () => {
    expect(resolveContextHintPolicy('implementer')?.tokens).toBe(200_000)
    expect(resolveContextHintPolicy('implementer-lite')?.tokens).toBe(200_000)
    expect(resolveContextHintPolicy('peer')).toEqual({ tokens: 250_000, boundary: 'assignment boundary' })
  })

  it('gives a session with no profile the configurable default, phrased at an episode boundary', () => {
    expect(resolveContextHintPolicy(undefined)).toEqual({ tokens: 250_000, boundary: 'episode boundary' })
  })

  it.each(['planner', 'researcher', 'explorer', 'reviewer'])('never hints the %s role', profile => {
    expect(resolveContextHintPolicy(profile)).toBeNull()
  })

  it('gives an unlisted profile the default', () => {
    expect(resolveContextHintPolicy('fable-architect')?.tokens).toBe(250_000)
  })

  it('lets config.json move a role threshold, add a role, and silence one', () => {
    writeConfigJson({
      contextHints: {
        default: { tokens: 300_000 },
        profiles: {
          implementer: { tokens: 180_000 },
          designer: { tokens: 200_000, boundary: 'round boundary' },
          peer: null,
        },
      },
    })

    expect(resolveContextHintPolicy('implementer')).toEqual({
      tokens: 180_000,
      boundary: 'natural stopping point',
    })
    expect(resolveContextHintPolicy('designer')).toEqual({ tokens: 200_000, boundary: 'round boundary' })
    expect(resolveContextHintPolicy('peer')).toBeNull()
    expect(resolveContextHintPolicy(undefined)).toEqual({ tokens: 300_000, boundary: 'episode boundary' })
  })

  it('falls back to the built-in value for a malformed entry', () => {
    writeConfigJson({ contextHints: { profiles: { implementer: { tokens: '200k' } } } })

    expect(resolveContextHintPolicy('implementer')?.tokens).toBe(200_000)
  })
})

describe('resolvePermissionHookTimeout', () => {
  it('defaults to thirty minutes, long enough to answer from a phone', () => {
    expect(resolvePermissionHookTimeout()).toBe(DEFAULT_PERMISSION_HOOK_TIMEOUT_S)
    expect(DEFAULT_PERMISSION_HOOK_TIMEOUT_S).toBe(1800)
  })

  it('reads permissionHookTimeoutSeconds from config.json', () => {
    writeConfigJson({ permissionHookTimeoutSeconds: 600 })

    expect(resolvePermissionHookTimeout()).toBe(600)
  })

  it('falls back to the default on a value that is not a positive integer', () => {
    writeConfigJson({ permissionHookTimeoutSeconds: 'soon' })

    expect(resolvePermissionHookTimeout()).toBe(DEFAULT_PERMISSION_HOOK_TIMEOUT_S)
  })
})

describe('resolveNoticeTtlMs', () => {
  it('defaults to three days, so a weekend away does not lose a notice', () => {
    expect(DEFAULT_NOTICE_TTL_HOURS).toBe(72)
    expect(resolveNoticeTtlMs()).toBe(72 * 3_600_000)
  })

  it('reads noticeTtlHours from config.json', () => {
    writeConfigJson({ noticeTtlHours: 6 })

    expect(resolveNoticeTtlMs()).toBe(6 * 3_600_000)
  })

  it('falls back to the default on a value that is not a positive integer', () => {
    writeConfigJson({ noticeTtlHours: 0 })

    expect(resolveNoticeTtlMs()).toBe(DEFAULT_NOTICE_TTL_HOURS * 3_600_000)
  })
})

describe('resolveReportBatchMs', () => {
  it('defaults to a 20 second window', () => {
    expect(resolveReportBatchMs()).toBe(20_000)
  })

  it('reads reportBatchSeconds from config.json, where 0 turns batching off', () => {
    writeConfigJson({ reportBatchSeconds: 5 })
    expect(resolveReportBatchMs()).toBe(5_000)

    writeConfigJson({ reportBatchSeconds: 0 })
    expect(resolveReportBatchMs()).toBe(0)
  })

  it('lets AGENT_CHAT_REPORT_BATCH_SECONDS override the file', () => {
    writeConfigJson({ reportBatchSeconds: 5 })
    process.env.AGENT_CHAT_REPORT_BATCH_SECONDS = '0'

    expect(resolveReportBatchMs()).toBe(0)
  })

  it.each(['soon', '-1', '301'])('falls back to the file value when the override is %s', override => {
    writeConfigJson({ reportBatchSeconds: 5 })
    process.env.AGENT_CHAT_REPORT_BATCH_SECONDS = override

    expect(resolveReportBatchMs()).toBe(5_000)
  })

  it('falls back to the default when the override is bad and the file sets nothing', () => {
    process.env.AGENT_CHAT_REPORT_BATCH_SECONDS = 'soon'

    expect(resolveReportBatchMs()).toBe(20_000)
  })

  it.each([-1, 1.5, 301, 'soon'])(
    'falls back to the default on %s, which would stall a coordinator',
    value => {
      writeConfigJson({ reportBatchSeconds: value })

      expect(resolveReportBatchMs()).toBe(20_000)
    },
  )
})
