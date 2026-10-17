import { Console } from 'node:console'
import { Writable } from 'node:stream'
import { format } from 'node:util'
import type { Command } from 'commander'
import type { ServerMessage } from '../protocol.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({
  sent: [] as unknown[],
  shouldFail: false,
  reply: { t: 'send_result', ok: true, recipients: [], msgId: 'fixture-msg' } as unknown,
  failure: undefined as unknown,
}))
const forbidden = () => {
  throw new Error('unexpected human command controller/process/fs operation')
}
vi.mock('node:child_process', async importOriginal => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: forbidden,
  exec: forbidden,
  execFile: forbidden,
}))
vi.mock('node:fs', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs')>()
  const overrides = {
    readFileSync: forbidden,
    writeFileSync: forbidden,
    unlinkSync: forbidden,
    mkdirSync: forbidden,
  }
  return { ...original, ...overrides, default: { ...original, ...overrides } }
})
vi.mock('../cli/service.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../cli/service.js')>()),
  start: forbidden,
  stop: forbidden,
  status: forbidden,
  restart: forbidden,
  logs: forbidden,
  open: forbidden,
}))
vi.mock('../cli/client.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../cli/client.js')>()),
  withBroker: async <T>(fn: (broker: unknown) => Promise<T>) =>
    fn({
      request: async (frame: unknown) => {
        fake.sent.push(frame)
        if (fake.shouldFail) throw fake.failure
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
  vi.spyOn(process, 'kill').mockImplementation(forbidden)
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    output.push('stdout: ' + format(...args))
  })
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    output.push('stderr: ' + format(...args))
  })
  vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null): never => {
    throw new Exit(Number(code ?? 0))
  })
})
afterEach(() => vi.restoreAllMocks())

interface Case {
  name: string
  argv: string[]
  reply?: Extract<ServerMessage, { t: 'send_result' }>
  failure?: unknown
}
const cases: Case[] = [
  { name: 'debug success', argv: ['debug', 'send', 'bob', 'hello', 'there'] },
  {
    name: 'success missing message id',
    argv: ['send', 'bob', 'hello'],
    reply: { t: 'send_result', ok: true, recipients: [] },
  },
  { name: 'hidden success', argv: ['send', 'bob', 'hello', 'there'] },
  { name: 'watchdog source', argv: ['debug', 'send', 'bob', 'hello', '--source', 'watchdog'] },
  { name: 'shepherd source', argv: ['debug', 'send', 'bob', '--source', 'shepherd', 'hello'] },
  { name: 'empty source', argv: ['debug', 'send', 'bob', 'hello', '--source', ''] },
  { name: 'invalid source', argv: ['debug', 'send', 'bob', 'hello', '--source', 'WATCHDOG'] },
  { name: 'hidden source unsupported', argv: ['send', 'bob', 'hello', '--source', 'watchdog'] },
  {
    name: 'refusal',
    argv: ['debug', 'send', 'bob', 'hello'],
    reply: { t: 'send_result', ok: false, recipients: [], reason: 'fixture refused' },
  },
  {
    name: 'reason absent',
    argv: ['send', 'bob', 'hello'],
    reply: { t: 'send_result', ok: false, recipients: [] },
  },
  { name: 'blank recipient and text preserved', argv: ['send', '', ''] },
  { name: 'control words preserved', argv: ['debug', 'send', 'bob', 'line1\nline2', '\tword'] },
  { name: 'end of options payload', argv: ['send', 'bob', '--', '--source', 'watchdog'] },
  { name: 'missing text', argv: ['send', 'bob'] },
  { name: 'missing recipient', argv: ['debug', 'send'] },
  {
    name: 'numeric unavailable error keeps legacy exit1',
    argv: ['send', 'bob', 'hello'],
    failure: Object.assign(new Error('fixture unavailable'), { code: 69 }),
  },
  { name: 'ordinary error', argv: ['debug', 'send', 'bob', 'hello'], failure: new Error('fixture failure') },
  { name: 'string error', argv: ['send', 'bob', 'hello'], failure: 'fixture string failure' },
]

const rejectionCases: [string, unknown][] = [
  ['object', { code: 69, message: 'synthetic failure' }],
  ['array', ['synthetic', 'failure']],
  ['null', null],
  ['number', 69],
  ['boolean', false],
  ['undefined', undefined],
  ['error69', Object.assign(new Error('synthetic unavailable'), { code: 69 })],
  ['string', 'synthetic failure'],
]
for (const [name, failure] of rejectionCases)
  cases.push({ name: 'debug rejection ' + name, argv: ['debug', 'send', 'bob', 'hello', 'there'], failure })
for (const [name, failure] of rejectionCases)
  cases.push({ name: 'hidden rejection ' + name, argv: ['send', 'bob', 'hello', 'there'], failure })

async function invoke(sample: Case) {
  output.length = 0
  fake.sent = []
  fake.failure = sample.failure
  fake.shouldFail = Object.hasOwn(sample, 'failure')
  fake.reply = sample.reply ?? { t: 'send_result', ok: true, recipients: [], msgId: 'fixture-msg' }
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

describe('S8 original human send ABI', () => {
  it('captures structured rejections as an actual Console and Writable', () => {
    const chunks: string[] = []
    const sink = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(String(chunk))
        callback()
      },
    })
    const actual = new Console({ stdout: sink, stderr: sink, colorMode: false })
    for (const rejection of [
      { code: 69, message: 'synthetic failure' },
      ['synthetic', 'failure'],
      null,
      69,
      false,
      undefined,
    ]) {
      chunks.length = 0
      actual.error(rejection)
      expect(chunks.join('')).toBe(format(rejection) + '\n')
    }
  })

  it('preserves original frames, output, failures and hidden argv without invoking a broker', async () => {
    const results = []
    for (const sample of cases) results.push(await invoke(sample))
    await expect(JSON.stringify(results, null, 2) + '\n').toMatchFileSnapshot(
      './golden/registry-send-calls.json',
    )
  })
})

describe('original send process lifetime remains explicit', () => {
  it.each([
    ['debug', 'send', 'fixture-recipient', 'fixture text'],
    ['send', 'fixture-recipient', 'fixture text'],
  ])('still exits immediately with zero for %j', async (...argv) => {
    await invoke({ name: 'send lifecycle', argv })
    expect(process.exit).toHaveBeenCalledExactlyOnceWith(0)
  })
})
