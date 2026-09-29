import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  frontmatter,
  loadPolicy,
  mergeDefaults,
  parseCharter,
  parseSeat,
  seatScope,
  type Policy,
} from '../agents/burndown/policy.js'
import { parseScoredTask, readScoredTasks, tasksFromList } from '../agents/burndown/score-source.js'

/** CC-228: charter and seat frontmatter, the score.py default merge and seat scope, and the scorer's task reader. */

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'autonomy-2026-09-29')
const SEATS = ['hjewkes-surplus', 'titan-coord', 'voltras-coord', 'self-improve']

describe('frontmatter', () => {
  it.each([
    ['text between the first two fences', '---\na: 1\n---\nbody', { a: 1 }],
    ['a file that does not open with a fence', 'a: 1\n---\nb: 2\n---\n', {}],
    ['a file with one fence', '---\na: 1\n', {}],
    ['an empty block', '---\n---\n', {}],
    ['an unquoted date, which stays a string', '---\ncreated: 2026-09-18\n---\n', { created: '2026-09-18' }],
  ])('reads %s', (_name, text, expected) => {
    expect(frontmatter(text)).toEqual(expected)
  })
})

describe('the real charter and seats (frontmatter copies from 2026-09-29)', () => {
  let policy: Policy
  beforeEach(() => {
    policy = loadPolicy(FIXTURE, 'titan-coord')
  })

  it('parses every seat the charter lists', () => {
    expect(Object.keys(policy.seats)).toEqual(SEATS)
  })

  it('reads the charter keys the scorer uses', () => {
    expect(policy.charter.hard_stops).toContain('broker-restart')
    expect(policy.charter.human_only_initiatives).toContain('chatgpt-archive')
    expect(policy.defaults.score_terms).toEqual({
      severity: 0.4,
      priority_pct: 0.3,
      unblocks: 0.2,
      staleness: 0.1,
    })
  })

  it('reads each seat the way score.py does', () => {
    const { seats } = policy
    expect(seats['titan-coord']?.initiatives.relay).toBe(1)
    expect(seats['titan-coord']?.unclaimed_engineering).toBe(true)
    expect(seats['self-improve']?.initiatives).toEqual({})
    expect(seats['voltras-coord']?.excluded_title_patterns).toContain('\\blabs?\\b')
    expect(seats['hjewkes-surplus']?.unclaimed_weight).toBe(0.5)
  })

  it('merges the owner seat kind weights and share caps over the charter defaults', () => {
    const { defaults } = loadPolicy(FIXTURE, 'hjewkes-surplus')
    expect(defaults.kind_weights['agent-tooling']).toBe(1)
    expect(defaults.kind_weights.security).toBe(1)
    expect(defaults.share_caps).toEqual({ 'agent-tooling': 1, nit: 0.2, discovery: 0.25 })
  })

  it('leaves the charter defaults whole for a seat with empty overrides', () => {
    expect(policy.defaults).toEqual(policy.charter.defaults)
  })

  it('refuses a seat the charter does not list', () => {
    expect(() => loadPolicy(FIXTURE, 'nobody')).toThrow('nobody is not a seat')
  })
})

const charterText = (defaultsExtra = '') => `---
seats: [a, b, hub]
human_only_initiatives: [private]
hard_stops: [deploy]
defaults:
  kind_weights: {product: 1.0, nit: 0.35}
  share_caps: {nit: 0.2}
  initiative_decay: 0.85
  score_terms: {severity: 0.4, priority_pct: 0.3, unblocks: 0.2, staleness: 0.1}
  severity: {high: 0.7, unset: 0.3}
  readiness: {ready: 1.0, untriaged: 0.6, blocked: 0.25}
  size: {le3: 1.0, le8: 0.9, gt8: 0.75}
  stop_short_factor: 0.8${defaultsExtra}
---
`

describe('mergeDefaults', () => {
  it('overrides kind weights and share caps key by key and nothing else', () => {
    const charter = parseCharter(charterText())
    const seat = parseSeat(
      '---\nkind_weights: {nit: 0.9}\nshare_caps: {x: 1}\ninitiative_decay: 0.1\n---\n',
      'a',
    )
    const merged = mergeDefaults(charter, seat)
    expect(merged.kind_weights).toEqual({ product: 1, nit: 0.9 })
    expect(merged.share_caps).toEqual({ nit: 0.2, x: 1 })
    expect(merged.initiative_decay).toBe(0.85)
  })

  it('throws with the zod message on a charter missing a default the scorer reads', () => {
    expect(() => parseCharter(charterText().replace('  stop_short_factor: 0.8\n', ''))).toThrow(
      /autonomy charter is malformed: .*stop_short_factor/s,
    )
  })
})

describe('seatScope', () => {
  const charter = parseCharter(charterText())
  const seats = {
    a: parseSeat(
      '---\ninitiatives: {mine: 1.0}\nunclaimed_engineering: true\nunclaimed_weight: 0.4\n---\n',
      'a',
    ),
    b: parseSeat('---\ninitiatives: {theirs: 0.9}\n---\n', 'b'),
    hub: parseSeat('---\ninitiatives: {}\n---\n', 'hub'),
  }
  const briefs = [
    { slug: 'mine', state: 'focused' },
    { slug: 'theirs', state: 'focused' },
    { slug: 'private', state: 'focused' },
    { slug: 'paused', state: 'paused' },
    { slug: 'loose', state: 'focused' },
    { slug: 'stateless' },
  ]

  it('adds focused, unclaimed, non-human-only initiatives at the unclaimed weight', () => {
    expect(seatScope(charter, seats, 'a', briefs)).toEqual({ mine: 1, loose: 0.4 })
  })

  it('keeps only its own initiatives when the seat does not take unclaimed work', () => {
    expect(seatScope(charter, seats, 'b', briefs)).toEqual({ theirs: 0.9 })
  })

  it('throws for a hub seat', () => {
    expect(() => seatScope(charter, seats, 'hub', briefs)).toThrow('hub has no dispatch scope (hub seat)')
  })

  it('scopes the real titan-coord seat over its nine initiatives plus unclaimed focused ones', () => {
    const policy = loadPolicy(FIXTURE, 'titan-coord')
    const scope = seatScope(policy.charter, policy.seats, 'titan-coord', [
      { slug: 'claude-channels', state: 'focused' },
      { slug: 'finances', state: 'focused' },
      { slug: 'new-engine', state: 'focused' },
    ])
    expect(Object.keys(scope)).toHaveLength(10)
    expect(scope['new-engine']).toBe(0.5)
    expect(scope.hermes).toBe(0.4)
  })
})

const TASK = `id: CC-1
title: "Quoted: title"
status: open
priority: 3
severity: high
estimate: 2
done_when: Tests pass.
notes: null
tags: [kind:security, 7]
created: 2026-09-18
updated: '2026-09-20'
done_at: null
`

const EXPECTED = {
  id: 'CC-1',
  title: 'Quoted: title',
  priority: 3,
  severity: 'high',
  estimate: 2,
  done_when: 'Tests pass.',
  tags: ['kind:security', '7'],
  created: '2026-09-18',
  updated: '2026-09-20',
  slug: 'claude-channels',
}

describe('score-source', () => {
  let root: string
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'burndown-policy-'))
  })
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('reads a task file with a real YAML parser and drops null keys', () => {
    expect(parseScoredTask(TASK, 'claude-channels')).toEqual(EXPECTED)
  })

  it.each([
    ['a done task', TASK.replace('status: open', 'status: done')],
    ['a file that is not a mapping', '- a\n- b\n'],
    ['an empty file', ''],
  ])('skips %s', (_name, text) => {
    expect(parseScoredTask(text, 'x')).toBeUndefined()
  })

  it('throws naming the file for an open task without a priority', () => {
    expect(() => parseScoredTask(TASK.replace('priority: 3\n', ''), 'x', 'x/CC-1.yml')).toThrow(
      'open task x/CC-1.yml is malformed',
    )
  })

  it('reads only open tasks from each scoped initiative', () => {
    const dir = path.join(root, 'claude-channels', 'tasks')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'CC-1.yml'), TASK)
    fs.writeFileSync(path.join(dir, 'CC-2.yml'), TASK.replace('status: open', 'status: done'))
    fs.writeFileSync(path.join(dir, 'README.md'), 'not a task')
    expect(readScoredTasks(root, ['claude-channels', 'absent'])).toEqual([EXPECTED])
  })

  it('produces the same objects from task list JSON as from the task file', () => {
    const entry = { ...EXPECTED, tags: ['kind:security', 7], status: 'open', notes: null, done_at: null }
    const done = { ...entry, id: 'CC-2', status: 'done' }
    expect(tasksFromList({ ok: true, data: { tasks: [entry, done] } })).toEqual([EXPECTED])
    expect(tasksFromList({ tasks: [entry] })).toEqual([EXPECTED])
  })

  it('refuses task list JSON without a tasks array or an entry without a slug', () => {
    expect(() => tasksFromList({ ok: true })).toThrow('task list JSON is malformed')
    expect(() => tasksFromList({ tasks: [{ ...EXPECTED, slug: undefined, status: 'open' }] })).toThrow(
      'task list entry 0 has no slug',
    )
  })
})
