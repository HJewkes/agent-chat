import type { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClientMessage, ServerMessage } from '../protocol.js'

/**
 * Golden files for what a CLI caller sees (CC-106).
 *
 * Relay shells `agent spawn --brief-stdin`, `agent ls` and `send` and parses
 * what comes back, and every verb's argv is a launch contract. These pin the
 * help text of every verb and the full output of representative invocations,
 * so moving a verb onto registry definitions cannot quietly change either.
 */

const broker = vi.hoisted(() => ({
  reply: undefined as unknown,
  sent: [] as unknown[],
}))

vi.mock('../cli/client.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../cli/client.js')>()),
  withBroker: async <T>(fn: (b: unknown) => Promise<T>): Promise<T> =>
    fn({
      request: async (message: unknown) => {
        broker.sent.push(message)
        return broker.reply
      },
    }),
}))

const { buildProgram } = await import('../cli/index.js')

/** Fixed width and no colour, so the text does not depend on the terminal running the suite. */
function helpOf(cmd: Command): string {
  cmd.configureOutput({ getOutHelpWidth: () => 100, getOutHasColors: () => false })
  return cmd.helpInformation()
}

function pathOf(cmd: Command): string {
  const names: string[] = []
  for (let c: Command | null = cmd; c !== null; c = c.parent) names.unshift(c.name())
  return names.join(' ')
}

function everyCommand(cmd: Command): Command[] {
  return [cmd, ...cmd.commands.flatMap(everyCommand)]
}

describe('--help golden', () => {
  it('matches the pinned help of every verb, hidden ones included', async () => {
    const sections = everyCommand(buildProgram()).map(cmd => `=== ${pathOf(cmd)}\n${helpOf(cmd)}`)

    await expect(sections.join('\n')).toMatchFileSnapshot('./golden/cli-help.txt')
  })
})

class Exit extends Error {
  constructor(readonly code: number | undefined) {
    super(`exit ${code}`)
  }
}

interface Invocation {
  argv: string[]
  reply: ServerMessage
}

const out: string[] = []

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(
    (...args: unknown[]) => void out.push(`stdout: ${args.join(' ')}`),
  )
  vi.spyOn(console, 'error').mockImplementation(
    (...args: unknown[]) => void out.push(`stderr: ${args.join(' ')}`),
  )
  vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
    throw new Exit(code === null ? undefined : Number(code))
  })
})

afterEach(() => vi.restoreAllMocks())

async function invoke({ argv, reply }: Invocation): Promise<string> {
  broker.reply = reply
  broker.sent = []
  out.length = 0
  let exit = 'returned'
  try {
    await buildProgram()
      .exitOverride()
      .parseAsync(['node', 'agent-chat', ...argv])
  } catch (err) {
    exit = err instanceof Exit ? `exit ${err.code}` : `threw: ${(err as Error).message}`
  }
  const frames = (broker.sent as ClientMessage[]).map(f => `frame: ${JSON.stringify(f)}`)
  return [`=== agent-chat ${argv.join(' ')}`, ...frames, ...out, exit, ''].join('\n')
}

const retired = (extra: Partial<Extract<ServerMessage, { t: 'spawn_result' }>>): ServerMessage => ({
  t: 'spawn_result',
  ok: true,
  ...extra,
})

const RETIRE_CASES: Invocation[] = [
  { argv: ['agent', 'retire', 'bob'], reply: retired({}) },
  {
    argv: ['agent', 'retire', 'bob', '--force'],
    reply: retired({ reason: 'the process was already gone; nothing to stop' }),
  },
  {
    argv: ['agent', 'retire', 'bob'],
    reply: retired({ ok: false, reason: 'worktree has uncommitted work' }),
  },
]

describe('CLI call golden', () => {
  it('agent retire prints and exits exactly as before', async () => {
    const rendered: string[] = []
    for (const c of RETIRE_CASES) rendered.push(await invoke(c))

    await expect(rendered.join('\n')).toMatchFileSnapshot('./golden/calls-agent-retire.txt')
  })
})

describe('registry verbs', () => {
  it('refuses a blank agent name as a usage error before anything reaches the broker', async () => {
    const rendered = await invoke({ argv: ['agent', 'retire', ' '], reply: retired({}) })

    expect(rendered).toBe(
      [
        '=== agent-chat agent retire  ',
        'stderr: Invalid arguments: name: name is required and must be a non-empty string',
        'exit 64',
        '',
      ].join('\n'),
    )
  })
})
