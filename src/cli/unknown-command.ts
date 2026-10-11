import type { Command } from 'commander'

const subcommand = (command: Command, name: string): Command | undefined =>
  command.commands.find(c => c.name() === name || c.aliases().includes(name))

/**
 * Commander answers `--help` before it checks for an unknown command, so
 * `agent-chat nosuch --help` prints top-level help and exits 0, and a probe for
 * a verb passes on a build that lacks it. This finds the first word naming no
 * command, walking down groups and stopping at the first option-like arg.
 */
export function unknownCommand(program: Command, args: readonly string[]): string | undefined {
  let current = program
  for (const arg of args) {
    if (current.commands.length === 0 || arg.startsWith('-') || arg === 'help') return undefined
    const next = subcommand(current, arg)
    if (next === undefined) return arg
    current = next
  }
  return undefined
}
