import type { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({
  reads: [] as unknown[],
  raw: 'first\nsecond\nthird\n',
  failure: undefined as unknown,
}))
const forbidden = () => {
  throw new Error('unexpected controller or process operation in logs fixture')
}
vi.mock('node:child_process', async importOriginal => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: forbidden,
  exec: forbidden,
  execFile: forbidden,
}))
vi.mock('node:fs', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs')>()
  const readFileSync = (path: unknown, encoding: unknown) => {
    fake.reads.push({ path, encoding })
    if (fake.failure !== undefined) throw fake.failure
    return fake.raw
  }
  return {
    ...original,
    readFileSync,
    default: { ...original, readFileSync },
  }
})
vi.mock('../cli/client.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../cli/client.js')>()),
  withBroker: forbidden,
}))
vi.mock('../cli/service.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../cli/service.js')>()),
  start: forbidden,
  stop: forbidden,
  restart: forbidden,
  status: forbidden,
  open: forbidden,
  collectStatus: forbidden,
}))
vi.mock('../paths.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../paths.js')>()),
  logPath: () => '/tmp/synthetic-service-logs/broker.log',
  socketPath: () => '/tmp/synthetic-service-logs/chat.sock',
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
  raw?: string
  failure?: unknown
}
const cases: Case[] = [
  {
    name: 'default fifty lines',
    argv: ['service', 'logs'],
    raw: Array.from({ length: 55 }, (_, i) => 'line ' + (i + 1)).join('\n') + '\n',
  },
  { name: 'short tail', argv: ['service', 'logs', '-n', '2'] },
  { name: 'long equals trailing text', argv: ['service', 'logs', '--lines=2tail'] },
  { name: 'zero', argv: ['service', 'logs', '--lines', '0'] },
  { name: 'negative', argv: ['service', 'logs', '--lines', '-1'] },
  { name: 'fractional', argv: ['service', 'logs', '--lines', '2.9'] },
  { name: 'exponent', argv: ['service', 'logs', '--lines', '1e2'] },
  { name: 'empty value becomes NaN', argv: ['service', 'logs', '--lines', ''] },
  { name: 'non numeric becomes NaN', argv: ['service', 'logs', '--lines', 'nonsense'] },
  { name: 'infinity becomes NaN', argv: ['service', 'logs', '--lines', 'Infinity'] },
  { name: 'last repeated value wins', argv: ['service', 'logs', '-n', '3', '--lines', '1'] },
  { name: 'empty file', argv: ['service', 'logs'], raw: '' },
  { name: 'blank final line preserved', argv: ['service', 'logs'], raw: 'first\n\n' },
  {
    name: 'missing file',
    argv: ['service', 'logs'],
    failure: Object.assign(new Error('synthetic missing'), { code: 'ENOENT' }),
  },
  {
    name: 'unreadable file',
    argv: ['service', 'logs'],
    failure: Object.assign(new Error('synthetic denied'), { code: 'EACCES' }),
  },
  { name: 'string read failure', argv: ['service', 'logs'], failure: 'synthetic failure' },
  { name: 'follow unsupported', argv: ['service', 'logs', '--follow'] },
  { name: 'missing option argument', argv: ['service', 'logs', '-n'] },
  { name: 'help default retained', argv: ['service', 'logs', '--help'] },
]

async function invoke(sample: Case) {
  output.length = 0
  fake.reads = []
  fake.failure = sample.failure
  fake.raw = sample.raw ?? 'first\nsecond\nthird\n'
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
  return { name: sample.name, argv: sample.argv, reads: [...fake.reads], output: [...output], exit }
}

describe('S8 original service logs ABI', () => {
  it('preserves original frames, output, failures and service logs argv without invoking a broker', async () => {
    const results = []
    for (const sample of cases) results.push(await invoke(sample))
    await expect(JSON.stringify(results, null, 2) + '\n').toMatchFileSnapshot(
      './golden/registry-service-logs-calls.json',
    )
  })
})

describe('original successful logs process lifetime', () => {
  it.each([
    { name: 'readable', argv: ['service', 'logs'] },
    { name: 'missing', argv: ['service', 'logs'], failure: new Error('synthetic missing') },
    { name: 'unreadable', argv: ['service', 'logs'], failure: new Error('synthetic unreadable') },
  ])('returns naturally for $name logs', async sample => {
    await invoke(sample)
    expect(process.exit).not.toHaveBeenCalled()
  })
  it('preserves an inherited exitCode while returning naturally', async () => {
    const previous = process.exitCode
    try {
      process.exitCode = 23
      await invoke({ name: 'inherited code', argv: ['service', 'logs'] })
      expect(process.exit).not.toHaveBeenCalled()
      expect(process.exitCode).toBe(23)
    } finally {
      process.exitCode = previous
    }
  })
})
