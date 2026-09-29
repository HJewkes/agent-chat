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
import { scoreAll } from '../agents/burndown/score.js'

/** CC-228: charter and seat frontmatter, the score.py default merge and seat scope, and the scorer's task reader. */

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'autonomy-2026-09-29')
const SEATS = ['seat-a', 'seat-b', 'seat-c', 'seat-hub']

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

describe('the synthetic charter and seats', () => {
  let policy: Policy
  beforeEach(() => {
    policy = loadPolicy(FIXTURE, 'seat-b')
  })

  it('parses every seat the charter lists', () => {
    expect(Object.keys(policy.seats)).toEqual(SEATS)
  })

  it('reads the charter keys the scorer uses', () => {
    expect(policy.charter.hard_stops).toContain('broker-restart')
    expect(policy.charter.human_only_initiatives).toContain('init-private')
    expect(policy.defaults.score_terms).toEqual({
      severity: 0.4,
      priority_pct: 0.3,
      unblocks: 0.2,
      staleness: 0.1,
    })
  })

  it('reads each seat the way score.py does', () => {
    const { seats } = policy
    expect(seats['seat-b']?.initiatives['init-beta']).toBe(1)
    expect(seats['seat-b']?.unclaimed_engineering).toBe(true)
    expect(seats['seat-b']?.unclaimed_weight).toBe(0.6)
    expect(seats['seat-hub']?.initiatives).toEqual({})
    expect(seats['seat-c']?.excluded_title_patterns).toContain('\\bdraft\\b')
    expect(seats['seat-a']?.unclaimed_weight).toBe(0.5)
  })

  it('merges the owner seat kind weights and share caps over the charter defaults', () => {
    const { defaults } = loadPolicy(FIXTURE, 'seat-a')
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

  it('parses a charter without worktrees_per_repo_per_seat, leaving it undefined', () => {
    const text = fs.readFileSync(path.join(FIXTURE, 'charter.md'), 'utf8')
    const charter = parseCharter(text.replace('  worktrees_per_repo_per_seat: 3\n', ''))

    expect(charter.defaults.worktrees_per_repo_per_seat).toBeUndefined()
    expect(charter.defaults.worktrees_left_free_per_repo).toBe(2)
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

  it('scopes the fixture seat over its own initiatives plus unclaimed, non-human-only focused ones', () => {
    const policy = loadPolicy(FIXTURE, 'seat-b')
    const scope = seatScope(policy.charter, policy.seats, 'seat-b', [
      { slug: 'init-alpha', state: 'focused' },
      { slug: 'init-private', state: 'focused' },
      { slug: 'init-new', state: 'focused' },
    ])
    expect(scope).toEqual({ 'init-beta': 1, 'init-gamma': 0.8, 'init-delta': 0.4, 'init-new': 0.6 })
  })

  it('throws for the fixture hub seat', () => {
    const policy = loadPolicy(FIXTURE, 'seat-hub')
    expect(() => seatScope(policy.charter, policy.seats, 'seat-hub', [])).toThrow(
      'seat-hub has no dispatch scope (hub seat)',
    )
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
  slug: 'init-alpha',
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
    expect(parseScoredTask(TASK, 'init-alpha')).toEqual(EXPECTED)
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
    const dir = path.join(root, 'init-alpha', 'tasks')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'CC-1.yml'), TASK)
    fs.writeFileSync(path.join(dir, 'CC-2.yml'), TASK.replace('status: open', 'status: done'))
    fs.writeFileSync(path.join(dir, 'README.md'), 'not a task')
    expect(readScoredTasks(root, ['init-alpha', 'absent'])).toEqual([EXPECTED])
  })

  it('normalizes compact YYYYMMDD dates to ISO', () => {
    const compact = TASK.replace('created: 2026-09-18', 'created: 20260918').replace(
      "updated: '2026-09-20'",
      'updated: 20260920',
    )
    expect(parseScoredTask(compact, 'init-alpha')).toEqual(EXPECTED)
  })

  it('rejects an impossible compact date naming the file', () => {
    const bad = TASK.replace('created: 2026-09-18', 'created: 20260230')
    expect(() => parseScoredTask(bad, 'init-alpha', 'init-alpha/CC-1.yml')).toThrow(
      'open task init-alpha/CC-1.yml has an invalid created date: 20260230',
    )
  })

  it.each(['..', '../escape', 'a/../b', 'a/b', 'a\\b', '', '/abs'])('refuses initiative slug %j', slug => {
    expect(() => readScoredTasks(root, [slug])).toThrow('unsafe initiative slug name')
  })

  it('reports and skips one malformed open task without dropping the rest', () => {
    const dir = path.join(root, 'init-alpha', 'tasks')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'CC-1.yml'), TASK)
    fs.writeFileSync(path.join(dir, 'CC-2.yml'), TASK.replace('priority: 3\n', ''))
    fs.writeFileSync(path.join(dir, 'CC-3.yml'), 'id: [unclosed')
    const skipped: string[] = []
    expect(readScoredTasks(root, ['init-alpha'], m => skipped.push(m))).toEqual([EXPECTED])
    expect(skipped).toHaveLength(2)
    expect(skipped[0]).toContain('init-alpha/CC-2.yml')
    expect(skipped[1]).toContain('init-alpha/CC-3.yml')
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

describe('policy and task reader feeding scoreAll', () => {
  it.each(['2026-02-30', '2026-13-45'])('refuses --today %s even with no tasks', today => {
    const { charter, seat, defaults } = loadPolicy(FIXTURE, 'seat-b')
    const exclusions = { tags: seat.excluded_tags, titlePatterns: seat.excluded_title_patterns }
    expect(() => scoreAll([], {}, defaults, exclusions, charter.hard_stops, today)).toThrow(
      `today is an invalid date, got ${today}`,
    )
  })

  it.each(['..', '../escape', 'a/b'])('refuses charter seat entry %j before reading it', entry => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'burndown-charter-'))
    try {
      const charter = fs.readFileSync(path.join(FIXTURE, 'charter.md'), 'utf8')
      fs.writeFileSync(
        path.join(root, 'charter.md'),
        charter.replace('seats: [seat-a,', `seats: ['${entry}', seat-a,`),
      )
      expect(() => loadPolicy(root, 'seat-a')).toThrow('unsafe seat name')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('scores a task read from YAML under the fixture seat defaults', () => {
    const { charter, seat, defaults } = loadPolicy(FIXTURE, 'seat-b')
    const task = parseScoredTask(TASK, 'init-alpha')
    const { rows } = scoreAll(
      task === undefined ? [] : [task],
      { 'init-alpha': 1 },
      defaults,
      { tags: seat.excluded_tags, titlePatterns: seat.excluded_title_patterns },
      charter.hard_stops,
      '2026-09-29',
    )
    expect(rows.map(r => [r.id, r.kind, r.kindSource, r.score])).toEqual([['CC-1', 'security', 'tag', 61]])
  })
})
