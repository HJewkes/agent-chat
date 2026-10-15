import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildProgram } from '../cli/index.js'
import { INSTRUCTIONS } from '../server/index.js'
import { TOOL_DEFINITIONS } from '../server/tools.js'

/**
 * CC-1357: agent-facing text must not send a human or agent to a verb the CLI does not register.
 * Only backticked `agent-chat <verb>` forms count; prose naming the product is not a command.
 */

const SKILL = path.resolve(
  import.meta.dirname,
  '../../plugins/agent-chat/skills/agent-orchestration/SKILL.md',
)

const registered = (): Set<string> =>
  new Set(buildProgram().commands.flatMap(command => [command.name(), ...command.aliases()]))

const taughtVerbs = (text: string): string[] =>
  [...text.matchAll(/`agent-chat ([a-z][a-z-]*)/g)].map(match => match[1] as string)

const sources: Array<[string, string]> = [
  ['SKILL.md', fs.readFileSync(SKILL, 'utf8')],
  ['server instructions', INSTRUCTIONS],
  ['tool definitions', JSON.stringify(TOOL_DEFINITIONS)],
]

describe('agent-chat verbs taught in agent-facing text', () => {
  it('finds the verbs it is meant to check', () => {
    expect(taughtVerbs('run `agent-chat account move` or `agent-chat watch x`')).toEqual(['account', 'watch'])
  })

  it.each(sources)('%s names only registered commands', (_label, text) => {
    const known = registered()

    expect(taughtVerbs(text).filter(verb => !known.has(verb))).toEqual([])
  })
})
