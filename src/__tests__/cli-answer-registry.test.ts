import type { Command } from 'commander'
import type { ServerMessage } from '../protocol.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({
  sent: [] as unknown[],
  reply: { t: 'answer_result', ok: true } as unknown,
  failure: undefined as unknown,
}))
vi.mock('../cli/client.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../cli/client.js')>()),
  withBroker: async <T>(fn: (broker: unknown) => Promise<T>) =>
    fn({
      request: async (frame: unknown) => {
        fake.sent.push(frame)
        if (fake.failure !== undefined) throw fake.failure
        return fake.reply
      },
    }),
}))
vi.mock('../paths.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../paths.js')>()),
  socketPath: () => '/tmp/registry-fixture/chat.sock',
}))
const { buildProgram } = await import('../cli/index.js')
class Exit extends Error {
  constructor(readonly code: number) {
    super('synthetic process exit')
  }
}
const output: string[] = []
beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    output.push('stdout: ' + args.join(' '))
  })
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    output.push('stderr: ' + args.join(' '))
  })
  vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null): never => {
    throw new Exit(Number(code ?? 0))
  })
})
afterEach(() => vi.restoreAllMocks())

interface Case {
  name: string
  argv: string[]
  reply?: Extract<ServerMessage, { t: 'answer_result' }>
  failure?: unknown
}
const cases: Case[] = [
  { name: 'success', argv: ['answer', 'fixture-id', 'hello', 'there'] },
  {
    name: 'success reason',
    argv: ['answer', 'fixture-id', 'hello'],
    reply: { t: 'answer_result', ok: true, reason: 'fixture note' },
  },
  {
    name: 'success empty reason',
    argv: ['answer', 'fixture-id', 'hello'],
    reply: { t: 'answer_result', ok: true, reason: '' },
  },
  {
    name: 'refusal',
    argv: ['answer', 'fixture-id', 'hello'],
    reply: { t: 'answer_result', ok: false, reason: 'fixture refused' },
  },
  {
    name: 'refusal absent reason',
    argv: ['answer', 'fixture-id', 'hello'],
    reply: { t: 'answer_result', ok: false },
  },
  {
    name: 'refusal empty reason',
    argv: ['answer', 'fixture-id', 'hello'],
    reply: { t: 'answer_result', ok: false, reason: '' },
  },
  { name: 'blank id and text preserved', argv: ['answer', '', ''] },
  { name: 'control words preserved', argv: ['answer', 'fixture-id', 'line1\nline2', '\tword'] },
  { name: 'end of options payload', argv: ['answer', 'fixture-id', '--', '--source', 'watchdog'] },
  { name: 'missing text', argv: ['answer', 'fixture-id'] },
  { name: 'missing id', argv: ['answer'] },
  { name: 'source unsupported', argv: ['answer', 'fixture-id', 'hello', '--source', 'watchdog'] },
  {
    name: 'numeric unavailable error keeps legacy exit1',
    argv: ['answer', 'fixture-id', 'hello'],
    failure: Object.assign(new Error('fixture unavailable'), { code: 69 }),
  },
  { name: 'ordinary error', argv: ['answer', 'fixture-id', 'hello'], failure: new Error('fixture failure') },
  { name: 'string error', argv: ['answer', 'fixture-id', 'hello'], failure: 'fixture string failure' },
]

async function invoke(sample: Case) {
  output.length = 0
  fake.sent = []
  fake.failure = sample.failure
  fake.reply = sample.reply ?? { t: 'answer_result', ok: true }
  let exit = 0
  const program = buildProgram()
  const configure = (command: Command) => {
    command.configureOutput({
      getOutHelpWidth: () => 100,
      getOutHasColors: () => false,
      writeOut: text => {
        output.push('stdout: ' + text)
      },
      writeErr: text => {
        output.push('stderr: ' + text)
      },
    })
    for (const child of command.commands) configure(child)
  }
  configure(program)
  try {
    try {
      await program.parseAsync(['node', 'agent-chat', ...sample.argv])
    } catch (error) {
      if (error instanceof Exit) throw error
      // The actual src/cli.ts entrypoint reports all rejected actions with exit1.
      console.error(error instanceof Error ? error.message : error)
      process.exit(1)
    }
  } catch (error) {
    if (!(error instanceof Exit)) throw error
    exit = error.code
  }
  return { name: sample.name, argv: sample.argv, frames: [...fake.sent], output: [...output], exit }
}

describe('S8 original human answer ABI', () => {
  it('preserves original frames, output, failures and answer argv without invoking a broker', async () => {
    const results = []
    for (const sample of cases) results.push(await invoke(sample))
    await expect(JSON.stringify(results, null, 2) + '\n').toMatchFileSnapshot(
      './golden/registry-answer-calls.json',
    )
  })
})
