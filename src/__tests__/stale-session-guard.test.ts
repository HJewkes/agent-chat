import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildHookSettings, markSuperseded } from '../agents/launch-files.js'
import { staleGuardOutput, staleSessionGuard } from '../cli/verbs/stale-session-guard.js'

describe('stale session guard', () => {
  let home: string
  let written: string
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-guard-'))
    vi.stubEnv('AGENT_CHAT_HOME', home)
    written = ''
    vi.spyOn(process.stdout, 'write').mockImplementation(chunk => {
      written += String(chunk)
      return true
    })
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('blocks the prompts of an identity a teleport superseded', () => {
    markSuperseded('old-agent')
    staleSessionGuard('old-agent')
    const out = JSON.parse(written) as { decision: string; reason: string }
    expect(out.decision).toBe('block')
    expect(out.reason).toContain('old-agent')
    expect(out.reason).toContain('agent-chat agent ls --prefix')
    expect(out.reason).not.toContain('Close it.')
  })

  it('lets the seat’s own identity through when it is resumed after a predecessor was marked', () => {
    markSuperseded('old-agent')
    staleSessionGuard('current-agent')
    expect(written).toBe('')
    expect(staleGuardOutput('current-agent')).toBe('')
  })

  it('installs the guard on a UserPromptSubmit hook only when an agent id is known', () => {
    const withId = buildHookSettings('/x/cli.js', undefined, undefined, 'a1') as {
      hooks: Record<string, unknown>
    }
    const without = buildHookSettings('/x/cli.js') as { hooks: Record<string, unknown> }
    expect(JSON.stringify(withId.hooks.UserPromptSubmit)).toContain("stale-session-guard 'a1'")
    expect(JSON.stringify(without.hooks.UserPromptSubmit)).not.toContain('stale-session-guard')
  })
})
