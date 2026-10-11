import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SKILL = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../plugins/agent-chat/skills/agent-orchestration/SKILL.md',
)

function answeringSection(): string {
  const text = fs.readFileSync(SKILL, 'utf8')
  const start = text.indexOf('## Answering your owner')
  expect(start, 'SKILL.md has an "Answering your owner" section').toBeGreaterThanOrEqual(0)
  const next = text.indexOf('\n## ', start + 1)
  return next === -1 ? text.slice(start) : text.slice(start, next)
}

describe('agent-orchestration skill: answering your owner', () => {
  it('leads with the value before the evidence', () => {
    expect(answeringSection()).toMatch(/value first/i)
  })

  it('requires a proposal to carry critique, an alternative and a recommendation', () => {
    const section = answeringSection()
    expect(section).toMatch(/critique/i)
    expect(section).toMatch(/alternative/i)
    expect(section).toMatch(/recommendation/i)
  })

  it('routes only genuine owner decisions through AskUserQuestion', () => {
    const section = answeringSection()
    expect(section).toContain('AskUserQuestion')
    expect(section).toMatch(/stated assumption/i)
  })

  it('reads the decision log before proposing a change', () => {
    expect(answeringSection()).toContain('decisions.md')
  })

  it('names no private paths', () => {
    expect(answeringSection()).not.toMatch(/(^|[\s`(])~?\/\w+\//m)
  })
})
