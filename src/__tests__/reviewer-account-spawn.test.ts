import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReviewerAccountRead } from '../agents/reviewer-account-gate.js'
import { startSupervisor, type RestartHarness } from './helpers/restart-harness.js'

const HOUR_MS = 3_600_000

/** A five_hour reading against a ceiling of 90, resetting an hour from the real clock the supervisor reads. */
const reading =
  (usedPct: number, resetsAtMs: number | undefined = Date.now() + HOUR_MS) =>
  (configDir: string): ReviewerAccountRead => ({
    configDir,
    ceiling: 90,
    pool: 'review-pool',
    window: { usedPct, ageSeconds: 30, ...(resetsAtMs === undefined ? {} : { resetsAtMs }) },
  })

const RESET_WORDS =
  /resets [A-Z][a-z]{2} \d{1,2} at \d{1,2}:\d{2}(am|pm) \(UTC\) \[\d{4}-\d{2}-\d{2}T[\d:.]+Z\]$/

describe('a reviewer spawn into an account past its five_hour ceiling', () => {
  let sup: RestartHarness | undefined
  const dirs: string[] = []

  afterEach(() => {
    sup?.close()
    sup = undefined
    vi.restoreAllMocks()
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  })

  const gated = (read: (configDir: string) => ReviewerAccountRead) => {
    const seen: string[] = []
    sup = startSupervisor({
      reviewerAccount: {
        read: configDir => {
          seen.push(configDir)
          return read(configDir)
        },
      },
    })
    return { sup, seen }
  }

  const refusals = (h: RestartHarness) =>
    h.core.events.history(20).filter(r => r.kind === 'agent_spawn_refused')

  it('refuses retryably with the reset time when the reading is at or over the ceiling', async () => {
    const { sup, seen } = gated(reading(92))
    const free = sup.semaphore.summary()

    const outcome = await sup.spawnAgent('rv-x-1', { profile: 'reviewer' })

    expect(outcome).toMatchObject({ ok: false, code: 'reviewer_account_limit', retryable: true })
    expect(outcome.reason).toContain('five_hour 92% at or over ceiling 90% (review-pool)')
    expect(outcome.reason).toMatch(RESET_WORDS)
    expect(refusals(sup)).toHaveLength(1)
    expect(sup.semaphore.summary()).toBe(free)
    expect(seen).toHaveLength(1)
  })

  it('spawns the same reviewer when the reading is under the ceiling', async () => {
    const { sup } = gated(reading(40))

    const outcome = await sup.spawnAgent('rv-x-2', { profile: 'reviewer' })

    expect(outcome.ok).toBe(true)
  })

  it('spawns a reviewer whose window has already reset', async () => {
    const { sup } = gated(reading(100, Date.now() - HOUR_MS))

    const outcome = await sup.spawnAgent('rv-x-3', { profile: 'reviewer' })

    expect(outcome.ok).toBe(true)
  })

  it('spawns a reviewer when the account has no five_hour reading', async () => {
    const { sup } = gated(configDir => ({ configDir, ceiling: 90, miss: 'no status file' }))

    const outcome = await sup.spawnAgent('rv-x-4', { profile: 'reviewer' })

    expect(outcome.ok).toBe(true)
  })

  it('leaves a non-reviewer spawn alone however full the account is', async () => {
    const { sup, seen } = gated(reading(99))

    const outcome = await sup.spawnAgent('ac-peer', { profile: 'peer' })

    expect(outcome.ok).toBe(true)
    expect(seen).toEqual([])
  })

  it('gates a non-reviewer profile whose work role is reviewer', async () => {
    const { sup } = gated(reading(99))

    const outcome = await sup.spawnAgent('ac-peer-review', { profile: 'peer', workRole: 'reviewer' })

    expect(outcome).toMatchObject({ ok: false, code: 'reviewer_account_limit', retryable: true })
  })

  it('lets the spawn through and logs when the reader throws', async () => {
    const { sup } = gated(() => {
      throw new Error('charter unreadable')
    })

    const outcome = await sup.spawnAgent('rv-x-5', { profile: 'reviewer' })

    expect(outcome.ok).toBe(true)
    expect(fs.readFileSync(path.join(sup.home, 'broker.log'), 'utf8')).toContain(
      'reviewer_account_gate_failed',
    )
  })

  it('reads the account the spawn bills', async () => {
    const billed = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewer-account-'))
    dirs.push(billed)
    vi.spyOn(os, 'homedir').mockReturnValue(path.dirname(billed))
    const { sup, seen } = gated(reading(40))

    const outcome = await sup.spawnAgent('rv-x-6', { profile: 'reviewer', configDir: billed })

    expect(outcome.ok).toBe(true)
    expect(seen).toEqual([billed])
  })
})
