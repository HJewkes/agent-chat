import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadProfile } from '../agents/profiles.js'
import type { AgentProfile } from '../agents/types.js'

const REPO_PROFILES = path.join(__dirname, '../../profiles')

function triager(): AgentProfile {
  const profile = loadProfile('triager', REPO_PROFILES)
  if ('error' in profile) throw new Error(profile.error)
  return profile
}

describe('the triager profile (CC-650)', () => {
  it('loads from the repo profiles directory as a headless, read-only job', () => {
    const profile = triager()

    expect(profile).toMatchObject({ model: 'fable', surface: 'headless', isolation: 'none' })
    expect(profile.surfaceLifetime).toBe('close-on-exit')
  })

  // Mutation caught: dropping a write verb, which leaves the triager unable to release or file a follow-up.
  it('allows the three write verbs and the log read', () => {
    expect(triager().allowedTools).toEqual(
      expect.arrayContaining([
        'Bash(agent-chat burndown release:*)',
        'Bash(active-work task add:*)',
        'Bash(active-work task edit:*)',
        'Bash(agent-chat agent logs:*)',
      ]),
    )
  })

  it('denies editing code and pushing', () => {
    expect(triager().disallowedTools).toEqual(
      expect.arrayContaining(['Edit', 'NotebookEdit', 'Bash(git push:*)']),
    )
  })

  // Mutation caught: splitting the blanket `agent-chat agent:*` deny and losing the spawn deny.
  it('denies every agent verb that acts, by name, and not the blanket that would hide logs', () => {
    const denied = triager().disallowedTools ?? []

    for (const verb of ['spawn', 'resume', 'retire', 'background', 'surface', 'teleport'])
      expect(denied).toContain(`Bash(agent-chat agent ${verb}:*)`)
    expect(denied).not.toContain('Bash(agent-chat agent:*)')
  })
})
