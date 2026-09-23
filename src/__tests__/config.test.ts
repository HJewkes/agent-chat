import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveAgentSlots, resolveContextHintPolicy, resolveWorktreeBudget } from '../config.js'
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
