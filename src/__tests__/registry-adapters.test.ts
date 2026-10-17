import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { cliArgs, defineVerb, Report } from '../cli/command.js'
import { declaredField, declaredLabels, defineTool, toolDefinition } from '../server/command.js'

describe('registry adapter legacy ABI', () => {
  it('keeps nested output schemas closed while opening only the stripping root', () => {
    const tool = defineTool({
      name: 'fixture',
      description: 'fixture',
      args: z.object({ nested: z.object({ value: z.string() }) }),
      result: z.string(),
      async run() {
        return 'unused'
      },
    })
    expect(toolDefinition(tool).inputSchema).toEqual({
      type: 'object',
      properties: {
        nested: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
          additionalProperties: false,
        },
      },
      required: ['nested'],
    })
    expect(tool.args.parse({ nested: { value: 'ok', extra: 'stripped' }, extra: true })).toEqual({
      nested: { value: 'ok' },
    })
  })

  it('retains catchall root representation rather than deleting a real schema', () => {
    const tool = defineTool({
      name: 'fixture',
      description: 'fixture',
      args: z.object({}).catchall(z.string()),
      result: z.string(),
      async run() {
        return 'unused'
      },
    })
    expect(toolDefinition(tool).inputSchema.additionalProperties).toEqual({ type: 'string' })
  })

  it('keeps declared description, null evidence and exact rejection wording', () => {
    const field = declaredField('legacy labels')
    const tool = defineTool({
      name: 'fixture',
      description: 'fixture',
      args: z.object({ declared: field }),
      result: z.string(),
      async run() {
        return 'unused'
      },
    })
    expect(toolDefinition(tool).inputSchema.properties).toEqual({
      declared: { type: 'object', additionalProperties: { type: 'string' }, description: 'legacy labels' },
    })
    expect(field.parse(null)).toBeNull()
    expect(declaredLabels(null)).toBeUndefined()
    expect(field.parse({ role: 'worker' })).toEqual({ role: 'worker' })
    const invalid = field.safeParse({ role: {} })
    expect(invalid.success).toBe(false)
    if (!invalid.success)
      expect(invalid.error.issues[0]?.message).toBe(
        'declared.role must be a string — declared carries labels, not nested structure',
      )
    expect(() => declaredLabels({ role: 'x'.repeat(100000) })).toThrow('declared.role must be at most')
  })

  it('reads existing placeholder flags and variadic values without leaking Commander names', () => {
    const verb = defineVerb({
      name: 'fixture',
      description: 'fixture',
      args: z.object({
        text: z.array(z.string()),
        count: z.number().optional(),
        tags: z.array(z.string()).optional(),
      }),
      result: Report,
      cli: {
        positional: ['text'],
        options: {
          count: { long: '--count <n>', description: 'count' },
          tags: { long: '--tag <label>', description: 'tag' },
        },
      },
      async run() {
        return { ok: true, lines: [] }
      },
    })
    expect(cliArgs(verb, [['first', 'second']], { count: '3', tag: ['a', 'b'] })).toEqual({
      text: ['first', 'second'],
      count: 3,
      tags: ['a', 'b'],
    })
  })
})
