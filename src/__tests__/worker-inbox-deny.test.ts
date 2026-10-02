import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { BUILTIN_PROFILES, parseProfile, roleOf } from '../agents/profiles.js'
import type { AgentProfile } from '../agents/types.js'

/**
 * CC-425: `agent-chat inbox --batch --answers -` reaches the human-authority verbs
 * (approve a permission prompt, endorse), so a Bash-capable worker must not be able
 * to run it. Pin the deny on every worker profile rather than trust it not to drift.
 */

const INBOX_DENY = 'Bash(agent-chat inbox:*)'
const PROFILES_DIR = path.join(__dirname, '../../profiles')
// The decider reads the human queue with `agent-chat inbox` by design; see CC-425 follow-up.
const READS_HUMAN_QUEUE = ['decider']

const filed = fs
  .readdirSync(PROFILES_DIR)
  .filter(f => f.endsWith('.json'))
  .map(f => path.basename(f, '.json'))
  .filter(name => !READS_HUMAN_QUEUE.includes(name))
  .map((name): AgentProfile => {
    const parsed = parseProfile(
      name,
      JSON.parse(fs.readFileSync(path.join(PROFILES_DIR, `${name}.json`), 'utf8')),
    )
    if ('error' in parsed) throw new Error(parsed.error)
    return parsed
  })

const bashCapable = (p: AgentProfile): boolean => !(p.disallowedTools ?? []).includes('Bash')

const workers = [...BUILTIN_PROFILES, ...filed].filter(p => roleOf(p) === 'worker')

describe('worker profiles', () => {
  it('cover the built-in and filed profiles', () => {
    const names = workers.map(p => p.name)
    expect(names).toEqual(
      expect.arrayContaining([
        'implementer',
        'reviewer',
        'planner',
        'peer',
        'bd-implementer',
        'bd-implementer-lite',
        'bd-reviewer',
        'bd-planner',
      ]),
    )
  })

  it.each(workers.filter(bashCapable).map(p => [p.name, p] as const))(
    'deny agent-chat inbox on %s, so batch mode cannot self-approve',
    (_name, profile) => {
      expect(profile.disallowedTools).toContain(INBOX_DENY)
    },
  )
})

describe('builtin profiles that grant Bash', () => {
  it.each(BUILTIN_PROFILES.filter(p => (p.allowedTools ?? []).includes('Bash')).map(p => [p.name, p]))(
    '%s denies self-endorsement (CC-421)',
    (_name, profile) => {
      expect((profile as AgentProfile).disallowedTools).toContain('Bash(agent-chat endorse:*)')
    },
  )
})
