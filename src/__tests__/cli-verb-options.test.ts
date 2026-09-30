import { describe, expect, it } from 'vitest'
import { cliArgs, type Verb } from '../cli/command.js'

const modules = import.meta.glob('../cli/verbs/*.ts', { eager: true }) as Record<
  string,
  Record<string, unknown>
>

const isVerb = (value: unknown): value is Verb<unknown> =>
  typeof value === 'object' && value !== null && 'cli' in value && 'run' in value && 'name' in value

const declared = Object.values(modules)
  .flatMap(mod => Object.values(mod))
  .filter(isVerb)
  .flatMap(verb =>
    Object.entries(verb.cli?.options ?? {})
      .filter(([, option]) => /[<[]/.test(option.long))
      .map(([key, option]) => ({ verb, key, flag: option.long })),
  )

const commanderKey = (key: string) => key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())

describe('registry verbs that declare an option argument in the flag', () => {
  it('finds the agent budget filters, so the table below is not vacuous', () => {
    expect(declared.map(d => `${d.verb.name} ${d.flag}`)).toEqual(
      expect.arrayContaining(['agent.budget --spawner <name>', 'agent.budget --prefix <p>']),
    )
  })

  it.each(declared.map(d => [`${d.verb.name} ${d.flag}`, d] as const))('%s reaches the verb args', (_, d) => {
    const args = cliArgs(d.verb, [], { [commanderKey(d.key)]: 'synthetic-value' })
    expect(args[d.key]).toBe('synthetic-value')
  })
})
