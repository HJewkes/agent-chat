import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveAgentSlots } from '../config.js'
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
