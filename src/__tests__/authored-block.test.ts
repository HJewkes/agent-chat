import { describe, expect, it } from 'vitest'
import {
  AUTHORED_MAX_CHARS,
  authoredBlockSchema,
  parseAuthored,
  renderAuthored,
} from '../agents/seats/authored-block.js'

const fullBlock = {
  continuations: [
    { on: 'pr', ref: 'acme/widgets#12', do: 'merge once CI is green' },
    { on: 'agent', ref: 'worker-a', do: 'review its report' },
  ],
  standing_rules: [{ text: 'hold eval runs', source: 'owner 10-02', expires: '2026-10-20' }],
  open_questions: [],
  next_why: 'Finish X.\nThen Y.\nY waits on the release.',
}

const lateOnTheFourteenth = new Date('2026-10-14T23:59:00Z')

const padTo = (length: number, json: string): string => json + ' '.repeat(length - json.length)

describe('parseAuthored', () => {
  it('round-trips a full block', () => {
    expect(parseAuthored(JSON.stringify(fullBlock))).toEqual({ ok: true, block: fullBlock })
  })

  it('accepts text of exactly the cap and refuses one char more', () => {
    const json = JSON.stringify(fullBlock)

    const atCap = parseAuthored(padTo(AUTHORED_MAX_CHARS, json))
    const overCap = parseAuthored(padTo(AUTHORED_MAX_CHARS + 1, json))

    expect(atCap.ok).toBe(true)
    expect(overCap.ok).toBe(false)
    if (overCap.ok) return
    expect(overCap.errors[0]?.code).toBe('too-long')
    expect(overCap.errors[0]?.message).toContain('1501')
  })

  it('refuses an unknown continuation trigger at its key path', () => {
    const result = parseAuthored(JSON.stringify({ continuations: [{ on: 'issue', ref: 'x', do: 'y' }] }))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.map(e => e.path)).toEqual(['continuations.0.on'])
  })

  it.each([
    [
      'a bad ISO expires',
      { standing_rules: [{ text: 't', source: 's', expires: '2026-13-01' }] },
      'standing_rules.0.expires',
    ],
    ['a six-line next_why', { next_why: '1\n2\n3\n4\n5\n6' }, 'next_why'],
    ['a misspelt top-level key', { continuation: [] }, ''],
  ])('refuses %s', (_name, block, path) => {
    const result = parseAuthored(JSON.stringify(block))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors[0]?.path).toBe(path)
  })

  it('reads the cleared block and {} as an empty block', () => {
    const empty = { continuations: [], standing_rules: [], open_questions: [], next_why: '' }

    expect(parseAuthored('')).toEqual({ ok: true, block: empty })
    expect(parseAuthored('{}')).toEqual({ ok: true, block: empty })
  })

  it('returns invalid-json for malformed text instead of throwing', () => {
    const result = parseAuthored('{not json')

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors[0]?.code).toBe('invalid-json')
  })
})

describe('authoredBlockSchema', () => {
  it('enforces the size cap on an object handed in directly', () => {
    expect(authoredBlockSchema.safeParse({ next_why: 'x'.repeat(2000) }).success).toBe(false)
  })
})

describe('renderAuthored', () => {
  it('renders sections in order and leaves out empty ones', () => {
    const block = authoredBlockSchema.parse(fullBlock)

    expect(renderAuthored(block, lateOnTheFourteenth)).toBe(
      [
        'Continuations:',
        '- on pr acme/widgets#12: merge once CI is green',
        '- on agent worker-a: review its report',
        '',
        'Standing rules:',
        '- hold eval runs (source owner 10-02, until 2026-10-20)',
        '',
        'Next/why:',
        'Finish X.',
        'Then Y.',
        'Y waits on the release.',
      ].join('\n'),
    )
  })

  it('keeps a rule on its last UTC day and drops it the day after', () => {
    const block = authoredBlockSchema.parse({
      standing_rules: [
        { text: 'last day', source: 's', expires: '2026-10-14' },
        { text: 'expired', source: 's', expires: '2026-10-13' },
      ],
    })

    const rendered = renderAuthored(block, lateOnTheFourteenth)

    expect(rendered).toContain('last day')
    expect(rendered).not.toContain('expired')
  })

  it('renders an empty block, or one whose rules all expired, as an empty string', () => {
    const expired = authoredBlockSchema.parse({
      standing_rules: [{ text: 'old', source: 's', expires: '2026-01-01' }],
    })

    expect(renderAuthored(authoredBlockSchema.parse({}), lateOnTheFourteenth)).toBe('')
    expect(renderAuthored(expired, lateOnTheFourteenth)).toBe('')
  })
})
