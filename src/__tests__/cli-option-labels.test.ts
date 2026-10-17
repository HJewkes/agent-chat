import { describe, expect, it } from 'vitest'
import type { Command } from 'commander'
import { buildProgram } from '../cli/index.js'
import { portResumeVerb, portSpawnVerb } from '../cli/verbs/port-agent.js'

const labels = new Set([
  '--spawner <name>',
  '--prefix <p>',
  '--since <msgId>',
  '--limit <n>',
  '--as <label>',
  '--kind <kind>',
  '--task <id>',
  '--header <text>',
  '--recommended <option>',
  '--default <option>',
  '--door <door>',
  '--category <name>',
  '--initiative <slug>',
  '--blocking <mode>',
  '--reversible <text>',
  '--on-no-answer <text>',
  '--ask <label>',
  '--by <who>',
  '--for <duration>',
  '--reason <text>',
  '--apply <approved.json>',
  '--off-plan-ok <reason>',
  '--top <n>',
  '--host <name>',
  '--as <sender>',
  '--surface <surface>',
  '--to <machine>',
])

function commands(command: Command, path = ''): { command: Command; path: string }[] {
  const current = path ? path + ' ' + command.name() : command.name()
  return [{ command, path: current }, ...command.commands.flatMap(child => commands(child, current))]
}

describe('registry option-label ABI', () => {
  it('preserves actual mounted labels and parse results without invoking actions', async () => {
    const rows = commands(buildProgram()).flatMap(({ command, path }) =>
      command.options
        .filter(option => labels.has(option.flags))
        .map(option => {
          command.parseOptions([option.long!, option.long === '--surface' ? 'headless' : '7'])
          return {
            path,
            flags: option.flags,
            attribute: option.attributeName(),
            parsed: command.opts()[option.attributeName()] as unknown,
          }
        }),
    )
    expect(rows.length).toBeGreaterThanOrEqual(28)
    await expect(JSON.stringify(rows, null, 2) + '\n').toMatchFileSnapshot(
      './golden/registry-option-labels.json',
    )
  })

  for (const [name, flag, key, verb] of [
    ['spawn', '--frame-stdin', 'frameStdin', portSpawnVerb],
    ['resume', '--message-stdin', 'messageStdin', portResumeVerb],
  ] as const) {
    it('keeps the ' + name + ' required true switch bare and rejects false', () => {
      const command = buildProgram()
        .commands.find(item => item.name() === 'port')!
        .commands.find(item => item.name() === name)!
      const option = command.options.find(item => item.long === flag)!
      expect(option.flags).toBe(flag)
      expect(option.required).toBe(false)
      expect(option.optional).toBe(false)
      command.parseOptions([flag])
      expect(command.opts()[key]).toBe(true)
      const base = name === 'resume' ? { name: 'fixture' } : {}
      expect(verb.args.safeParse({ ...base, [key]: true }).success).toBe(true)
      expect(verb.args.safeParse({ ...base, [key]: false }).success).toBe(false)
      expect(verb.args.safeParse(base).success).toBe(false)
    })
  }
})
