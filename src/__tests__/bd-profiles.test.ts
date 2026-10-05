import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseProfile } from '../agents/profiles.js'
import type { AgentProfile } from '../agents/types.js'

/**
 * Slice 4f follow-up: the shared `~/.claude/settings.json` allows `Bash(*)` with
 * no deny rules, so a burndown worker's confinement is entirely in its own
 * profile's `disallowedTools`. These tests pin the deny list rather than trust
 * the JSON files not to drift — a deny quietly dropped from one profile is
 * exactly the mutation that would let an unattended worker merge, publish, or
 * deploy.
 */

const PROFILES_DIR = path.join(__dirname, '../../profiles')

const WORKER_PROFILES = ['bd-implementer', 'bd-implementer-lite', 'bd-reviewer'] as const

function loadBdProfile(name: string): AgentProfile {
  const raw: unknown = JSON.parse(fs.readFileSync(path.join(PROFILES_DIR, `${name}.json`), 'utf8'))
  const profile = parseProfile(name, raw)
  if ('error' in profile) throw new Error(profile.error)
  return profile
}

/** Reserved for humans by the unlock table: never something an unattended worker may reach. */
const HUMAN_ONLY_ACTIONS = [
  'Bash(gh pr merge:*)',
  'Bash(gh pr review:*)',
  'Bash(gh api:*)',
  'Bash(gh release:*)',
  'Bash(gh repo:*)',
  'Bash(npm publish:*)',
  'Bash(npx changeset:*)',
  'Bash(wrangler:*)',
  'Bash(launchctl:*)',
  'Bash(agent-chat agent:*)',
  'Bash(agent-chat service:*)',
  'Bash(agent-chat teleport:*)',
  'Bash(agent-chat mirror:*)',
  'Bash(agent-chat lifecycle:*)',
  'Bash(agent-chat burndown:*)',
]

/** What a worker needs to land its own branch and open a PR; none of this may ever be denied. */
const WORKER_NEEDS = [
  'Bash(git fetch:*)',
  'Bash(git merge --ff-only:*)',
  'Bash(git add:*)',
  'Bash(git commit:*)',
  'Bash(git push -u origin agent-chat/bd-deny:*)',
  'Bash(npm run format:check)',
  'Bash(npm run typecheck)',
  'Bash(npm run build)',
  'Bash(npx vitest run)',
  'Bash(gh pr create:*)',
  'Bash(gh pr view:*)',
  'Bash(gh pr checks:*)',
]

describe.each(WORKER_PROFILES)('the %s profile', name => {
  const profile = loadBdProfile(name)
  const denied = profile.disallowedTools ?? []

  it('reserves every unlock-table action for humans', () => {
    expect(denied).toEqual(expect.arrayContaining(HUMAN_ONLY_ACTIONS))
  })

  it('denies pushing to main or master, however the push is spelled', () => {
    expect(denied).toEqual(
      expect.arrayContaining([
        'Bash(git push origin main:*)',
        'Bash(git push origin master:*)',
        'Bash(git push -u origin main:*)',
        'Bash(git push -u origin master:*)',
        'Bash(git push origin HEAD:main:*)',
        'Bash(git push origin HEAD:master:*)',
      ]),
    )
  })

  it('denies force pushes in every flag spelling', () => {
    expect(denied).toEqual(
      expect.arrayContaining([
        'Bash(git push -f:*)',
        'Bash(git push --force:*)',
        'Bash(git push --force-with-lease:*)',
      ]),
    )
  })

  it('denies deleting a remote branch', () => {
    expect(denied).toEqual(expect.arrayContaining(['Bash(git push --delete:*)']))
  })

  it('does not deny anything a worker legitimately needs to land a branch or open a PR', () => {
    for (const need of WORKER_NEEDS) expect(denied).not.toContain(need)
    // The broad denial a naive fix would reach for — it would also block the
    // worker's own `git push -u origin agent-chat/*`.
    expect(denied).not.toContain('Bash(git push:*)')
  })
})

describe('the bd-reviewer profile', () => {
  const profile = loadBdProfile('bd-reviewer')

  it('denies git stash, Monitor and ScheduleWakeup', () => {
    expect(profile.disallowedTools).toEqual(
      expect.arrayContaining(['Bash(git stash:*)', 'Monitor', 'ScheduleWakeup']),
    )
  })

  it('pins the prompt cache TTL to five minutes', () => {
    expect(profile.env).toEqual({ CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' })
  })
})

describe('the bd-planner profile', () => {
  const profile = loadBdProfile('bd-planner')
  const denied = profile.disallowedTools ?? []

  it('keeps its existing blanket git push deny, since it shares the checkout and never pushes', () => {
    expect(denied).toContain('Bash(git push:*)')
  })

  it('reserves every unlock-table action for humans, same as the worker profiles', () => {
    expect(denied).toEqual(expect.arrayContaining(HUMAN_ONLY_ACTIONS))
  })

  it('can still write its plan file and run tests', () => {
    expect(denied).not.toContain('Bash(npm run:*)')
    expect(denied).not.toContain('Bash(npx vitest:*)')
  })
})
