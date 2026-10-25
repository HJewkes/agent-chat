import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseProfile } from '../agents/profiles.js'
import type { ServerMessage } from '../protocol.js'
import { describeSpawn } from '../server/commands/agent-spawn.js'

type SpawnResult = Extract<ServerMessage, { t: 'spawn_result' }>

function bdImplementerDenies(): string[] {
  const file = path.join(__dirname, '../../profiles/bd-implementer.json')
  const profile = parseProfile('bd-implementer', JSON.parse(fs.readFileSync(file, 'utf8')))
  if ('error' in profile) throw new Error(profile.error)
  return profile.disallowedTools ?? []
}

const WARNINGS = [
  'predecessor old-scout is not retired',
  'brief names a tool the profile denies: Bash(gh api:*)',
]

const spawned = (disallowedTools: string[]): SpawnResult => ({
  t: 'spawn_result',
  ok: true,
  agentId: 'a-1',
  name: 'worker-1',
  base: { ref: 'origin/main', sha: 'abc1234' },
  warnings: WARNINGS,
  disallowedTools,
})

describe('a spawn result for a worker profile with a long deny list', () => {
  it('stays under 600 chars and still carries every warning line', () => {
    const denied = bdImplementerDenies()

    const text = describeSpawn(spawned(denied), false, 'bd-implementer')

    expect(denied.length).toBeGreaterThan(100)
    expect(text.length).toBeLessThan(600)
    for (const warning of WARNINGS) expect(text).toContain(`\n  warning: ${warning}`)
    expect(text).toContain('branched from origin/main at abc1234')
  })

  it('names whole denied tools and counts command patterns with a pointer to the full list', () => {
    const text = describeSpawn(
      spawned(['AskUserQuestion', 'Bash(git push:*)', 'Bash(gh api:*)']),
      false,
      'bd-implementer',
    )

    expect(text).toContain(
      '\n  denied tools: AskUserQuestion + 2 command patterns (agent_profiles bd-implementer lists them)',
    )
    expect(text).not.toContain('git push')
  })

  it('lists a toolset-confined profile whose denies are all whole tools without a pointer', () => {
    const text = describeSpawn(spawned(['Bash', 'Write']), false, 'explorer')

    expect(text.endsWith('\n  denied tools: Bash, Write')).toBe(true)
  })

  it('says "pattern" for a single command pattern and omits the line for no denies', () => {
    expect(describeSpawn(spawned(['Bash(git stash:*)']), false, 'p')).toContain(
      'denied tools: 1 command pattern (agent_profiles p lists them)',
    )
    expect(describeSpawn(spawned([]), false, 'p')).not.toContain('denied tools')
  })
})
