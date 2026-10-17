import { Console } from 'node:console'
import { Writable } from 'node:stream'
import { Command } from 'commander'
import { z } from 'zod'
import { afterEach, describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({
  calls: [] as unknown[],
  failure: undefined as unknown,
  lines: ['synthetic listing', 'second synthetic line'],
}))
function forbidden(): never {
  throw new Error('unexpected agent-list IO/controller/broker operation')
}
vi.mock('../cli/agents.js', async original => ({
  ...(await original<typeof import('../cli/agents.js')>()),
  agentLs: async (options: object) => {
    // The unchanged effect reads named fields, not option-object insertion order.
    // Preserve every value/array order; stdout/stderr snapshots remain byte-exact.
    fake.calls.push(
      Object.fromEntries(Object.entries(options).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    )
    if (fake.failure !== undefined) throw fake.failure
    for (const line of fake.lines) console.log(line)
  },
}))
vi.mock('../cli/client.js', async original => ({
  ...(await original<typeof import('../cli/client.js')>()),
  withBroker: forbidden,
}))
vi.mock('../cli/service.js', async original => ({
  ...(await original<typeof import('../cli/service.js')>()),
  start: forbidden,
  stop: forbidden,
  restart: forbidden,
  open: forbidden,
}))
vi.mock('node:child_process', async original => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: forbidden,
  exec: forbidden,
  execFile: forbidden,
}))
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  const overrides = {
    readFileSync: forbidden,
    writeFileSync: forbidden,
    mkdirSync: forbidden,
    unlinkSync: forbidden,
  }
  return { ...fs, ...overrides, default: { ...fs, ...overrides } }
})
vi.mock('../paths.js', async original => ({
  ...(await original<typeof import('../paths.js')>()),
  socketPath: () => '/tmp/synthetic-agent-list/chat.sock',
}))
const { buildProgram, run } = await import('../cli/index.js')
const { addVerb, defineVerb, Report } = await import('../cli/command.js')
class Exit extends Error {
  constructor(readonly code: number) {
    super('synthetic exit')
  }
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
interface Sample {
  name: string
  argv: string[]
  actualRun?: boolean
  failure?: unknown
  lines?: string[]
}
async function invoke(sample: Sample) {
  fake.calls = []
  fake.failure = sample.failure
  fake.lines = sample.lines ?? ['synthetic listing', 'second synthetic line']
  let stdout = ''
  let stderr = ''
  const exits: number[] = []
  const sink = (write: (text: string) => void) =>
    new Writable({
      write(chunk, _encoding, done) {
        write(String(chunk))
        done()
      },
    })
  const actual = new Console({
    stdout: sink(text => {
      stdout += text
    }),
    stderr: sink(text => {
      stderr += text
    }),
    colorMode: false,
  })
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => actual.log(...args))
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => actual.error(...args))
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => {
    stdout += String(chunk)
    return false
  })
  vi.spyOn(process.stderr, 'write').mockImplementation(chunk => {
    stderr += String(chunk)
    return false
  })
  vi.spyOn(process, 'kill').mockImplementation(forbidden)
  vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null): never => {
    exits.push(Number(code ?? 0))
    throw new Exit(Number(code ?? 0))
  })
  vi.stubGlobal('fetch', forbidden)
  const program = buildProgram()
  const configure = (command: Command) => {
    command.configureOutput({
      getOutHelpWidth: () => 100,
      getOutHasColors: () => false,
      writeOut: text => {
        stdout += text
      },
      writeErr: text => {
        stderr += text
      },
    })
    for (const sub of command.commands) configure(sub)
  }
  configure(program)
  try {
    try {
      if (sample.actualRun) await run(['node', 'agent-chat', ...sample.argv])
      else await program.parseAsync(['node', 'agent-chat', ...sample.argv])
    } catch (error) {
      if (error instanceof Exit) throw error
      console.error(error instanceof Error ? error.message : error)
      process.exit(1)
    }
  } catch (error) {
    if (!(error instanceof Exit)) throw error
  } finally {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  }
  return { name: sample.name, argv: sample.argv, stdout, stderr, exits, calls: [...fake.calls] }
}
const cases: Sample[] = [
  { name: 'bare default', argv: ['agent'] },
  { name: 'explicit listing', argv: ['agent', 'ls'] },
  { name: 'bare default actual run', argv: ['agent'], actualRun: true },
  { name: 'bare JSON', argv: ['agent', '--json'] },
  { name: 'explicit JSON', argv: ['agent', 'ls', '--json'] },
  { name: 'bare line format', argv: ['agent', '--format', 'line'] },
  { name: 'JSON and line flags', argv: ['agent', 'ls', '--json', '--format', 'line'] },
  {
    name: 'all filters',
    argv: [
      'agent',
      'ls',
      '--mine',
      '--spawner',
      'boss',
      '--prefix',
      'work-',
      '--name',
      'worker',
      '--state',
      'running',
      '--format',
      'line',
    ],
  },
  {
    name: 'repeat union duplicates',
    argv: ['agent', 'ls', '--state', 'finished', '--state', 'retired', '--state', 'finished'],
  },
  { name: 'raw invalid state forwarded', argv: ['agent', 'ls', '--state', 'sleeping'] },
  {
    name: 'empty strings forwarded',
    argv: ['agent', 'ls', '--spawner', '', '--prefix', '', '--name', '', '--format', '', '--state', ''],
  },
  {
    name: 'whitespace strings forwarded',
    argv: [
      'agent',
      'ls',
      '--spawner',
      '  ',
      '--prefix',
      '  ',
      '--name',
      '  ',
      '--format',
      '  ',
      '--state',
      '  ',
    ],
  },
  { name: 'repeat last strings', argv: ['agent', 'ls', '--name', 'old', '--name', 'new'] },
  { name: 'unknown actual preflight', argv: ['agent', 'unknown', '--help'], actualRun: true },
  { name: 'extra actual positional', argv: ['agent', 'ls', 'extra'], actualRun: true },
  { name: 'unknown option', argv: ['agent', 'ls', '--unexpected'] },
  { name: 'missing spawner value', argv: ['agent', 'ls', '--spawner'] },
  { name: 'missing state value', argv: ['agent', 'ls', '--state'] },
  { name: 'group help', argv: ['agent', '--help'] },
  { name: 'list help', argv: ['agent', 'ls', '--help'] },
  { name: 'empty effect output', argv: ['agent', 'ls'], lines: [] },
  { name: 'Error rejection', argv: ['agent', 'ls'], failure: new Error('synthetic rejected') },
  {
    name: 'code69 Error remains1',
    argv: ['agent', 'ls'],
    failure: Object.assign(new Error('synthetic unavailable'), { code: 69 }),
  },
  { name: 'object rejection', argv: ['agent', 'ls'], failure: { code: 69, message: 'synthetic object' } },
  { name: 'array rejection', argv: ['agent', 'ls'], failure: ['synthetic array', 69] },
  { name: 'primitive rejection', argv: ['agent', 'ls'], failure: 69 },
]
describe('original agent listing CLI boundary', () => {
  it('preserves default routing, arguments, help, output and rejection frames', async () => {
    const results = []
    for (const sample of cases) results.push(await invoke(sample))
    await expect(JSON.stringify(results, null, 2) + '\n').toMatchFileSnapshot(
      './golden/registry-agent-ls-calls.json',
    )
  })
  it('returns naturally without resetting inherited exitCode or starving callbacks', async () => {
    const previous = process.exitCode
    try {
      process.exitCode = 7
      let late = false
      const pending = new Promise<void>(resolve =>
        setTimeout(() => {
          late = true
          resolve()
        }, 0),
      )
      const result = await invoke({ name: 'natural default', argv: ['agent'] })
      expect(result.exits).toEqual([])
      expect(process.exitCode).toBe(7)
      await pending
      expect(late).toBe(true)
    } finally {
      process.exitCode = previous
    }
  })
})
describe('default registry child bridge', () => {
  it('dispatches one definition from a bare parent through the supported Commander option', async () => {
    let calls = 0
    const verb = defineVerb({
      name: 'fixture.child',
      description: 'synthetic default-child fixture',
      args: z.object({}),
      result: Report,
      run: async () => {
        calls++
        return { ok: true, lines: [] }
      },
    })
    const parent = new Command('fixture').exitOverride()
    parent.configureOutput({ writeOut: () => undefined, writeErr: () => undefined })
    const options = { isDefault: true, exitOnSuccess: false }
    addVerb(parent, verb, options)
    try {
      await parent.parseAsync(['node', 'fixture'])
    } catch {
      /* Original helper lacks default forwarding. */
    }
    expect(calls).toBe(1)
  })
})

describe('registry listing compatibility boundaries', () => {
  it.each([undefined, false] as const)('does not create a default child when flag is %s', async isDefault => {
    let calls = 0
    const verb = defineVerb({
      name: 'fixture.child',
      description: 'synthetic default-child fixture',
      args: z.object({}),
      result: Report,
      run: async () => {
        calls++
        return { ok: true, lines: [] }
      },
    })
    const parent = new Command('fixture').exitOverride()
    parent.configureOutput({ writeOut: () => undefined, writeErr: () => undefined })
    addVerb(parent, verb, {
      exitOnSuccess: false,
      ...(isDefault === undefined ? {} : { isDefault }),
    })
    try {
      await parent.parseAsync(['node', 'fixture'])
    } catch {
      /* No default action is selected. */
    }
    expect(calls).toBe(0)
  })
  it('invokes the original effect once and returns no additional Report output', async () => {
    const { agentLsVerb } = await import('../cli/verbs/agent-ls.js')
    const { invokeCommand } = await import('@titan-design/registry')
    fake.calls = []
    fake.failure = undefined
    fake.lines = []
    const result = await invokeCommand(
      agentLsVerb,
      {
        json: true,
        name: '',
        state: ['running', 'running'],
      },
      { warnings: [], format: 'human', withBroker: forbidden },
      { invalidArgsCode: 1 },
    )
    expect(result.envelope.ok).toBe(true)
    if (!result.envelope.ok) throw Error('expected listing result')
    expect(result.envelope.data).toEqual({ ok: true, lines: [] })
    expect(fake.calls).toEqual([{ json: true, name: '', state: ['running', 'running'] }])
  })
})
