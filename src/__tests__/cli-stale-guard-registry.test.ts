import { Console } from 'node:console'
import { Writable } from 'node:stream'
import type { Command } from 'commander'
import { afterEach, describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({
  present: false,
  failureAt: undefined as 'path' | 'read' | undefined,
  failure: undefined as unknown,
  calls: [] as unknown[],
  loaded: 0,
}))
function forbidden(): never {
  throw new Error('unexpected stale-guard IO/controller/broker operation')
}
vi.mock('node:child_process', async original => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: forbidden,
  exec: forbidden,
  execFile: forbidden,
  execSync: forbidden,
  execFileSync: forbidden,
}))
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  const overrides = {
    readFileSync: forbidden,
    writeFileSync: forbidden,
    mkdirSync: forbidden,
    unlinkSync: forbidden,
    existsSync: (file: unknown) => {
      fake.calls.push({ read: file })
      if (fake.failureAt === 'read') throw fake.failure
      return fake.present
    },
  }
  return { ...fs, ...overrides, default: { ...fs, ...overrides } }
})
vi.mock('../agents/launch-files.js', async original => ({
  ...(await original<typeof import('../agents/launch-files.js')>()),
  supersededMarkerPath: (id: string) => {
    fake.calls.push({ id })
    if (fake.failureAt === 'path') throw fake.failure
    return '/synthetic-marker/' + id
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
vi.mock('../paths.js', async original => ({
  ...(await original<typeof import('../paths.js')>()),
  socketPath: () => '/tmp/synthetic-stale-guard/chat.sock',
}))
vi.mock('../cli/verbs/stale-session-guard.js', async original => {
  fake.loaded++
  return original<typeof import('../cli/verbs/stale-session-guard.js')>()
})
const { buildProgram } = await import('../cli/index.js')
class Exit extends Error {
  constructor(readonly code: number) {
    super('synthetic exit')
  }
}
afterEach(() => vi.restoreAllMocks())

interface Sample {
  name: string
  argv: string[]
  present?: boolean
  failureAt?: 'path' | 'read'
  failure?: unknown
}
async function invoke(sample: Sample) {
  fake.calls = []
  fake.present = sample.present ?? false
  fake.failureAt = sample.failureAt
  fake.failure = sample.failure
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
      await program.parseAsync(['node', 'agent-chat', ...sample.argv])
    } catch (error) {
      if (error instanceof Exit) throw error
      // Actual src/cli.ts rejection boundary, including raw non-Error Console rendering.
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
  { name: 'current session no output', argv: ['stale-session-guard', 'current'] },
  { name: 'superseded exact hook JSON', argv: ['stale-session-guard', 'old'], present: true },
  { name: 'empty id remains allowed', argv: ['stale-session-guard', ''] },
  { name: 'whitespace id unchanged', argv: ['stale-session-guard', '  '] },
  { name: 'option-like id after terminator', argv: ['stale-session-guard', '--', '-old'] },
  { name: 'missing id', argv: ['stale-session-guard'] },
  { name: 'excess positional', argv: ['stale-session-guard', 'old', 'extra'] },
  { name: 'unknown option', argv: ['stale-session-guard', 'old', '--unexpected'] },
  { name: 'command help', argv: ['stale-session-guard', '--help'] },
  {
    name: 'read Error message',
    argv: ['stale-session-guard', 'old'],
    failureAt: 'read',
    failure: new Error('synthetic read error'),
  },
  {
    name: 'read numeric code Error remains one',
    argv: ['stale-session-guard', 'old'],
    failureAt: 'read',
    failure: Object.assign(new Error('synthetic unavailable'), { code: 69 }),
  },
  {
    name: 'read object exact Console',
    argv: ['stale-session-guard', 'old'],
    failureAt: 'read',
    failure: { code: 69, message: 'synthetic rejected' },
  },
  {
    name: 'read array exact Console',
    argv: ['stale-session-guard', 'old'],
    failureAt: 'read',
    failure: ['synthetic', 69],
  },
  {
    name: 'read primitive exact Console',
    argv: ['stale-session-guard', 'old'],
    failureAt: 'read',
    failure: 69,
  },
  {
    name: 'path rejection exact Console',
    argv: ['stale-session-guard', 'old'],
    failureAt: 'path',
    failure: { code: 69 },
  },
]
describe('original stale guard CLI boundary', () => {
  it('keeps the effect lazy on root help and hidden from the root command list', async () => {
    expect(fake.loaded).toBe(0)
    const result = await invoke({ name: 'root help', argv: ['--help'] })
    expect(fake.loaded).toBe(0)
    expect(result.stdout).not.toContain('stale-session-guard')
    expect(result.calls).toEqual([])
    expect(result.exits).toEqual([0])
  })
  it('preserves original argument, output, errors and exit frames with all IO faked', async () => {
    const results = []
    for (const sample of cases) results.push(await invoke(sample))
    await expect(JSON.stringify(results, null, 2) + '\n').toMatchFileSnapshot(
      './golden/registry-stale-guard-calls.json',
    )
  })
  it('returns naturally with inherited exitCode and pending callbacks', async () => {
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
      const result = await invoke({
        name: 'pending output',
        argv: ['stale-session-guard', 'old'],
        present: true,
      })
      expect(result.exits).toEqual([])
      expect(process.exitCode).toBe(7)
      expect(result.stdout.endsWith('\n')).toBe(true)
      await pending
      expect(late).toBe(true)
    } finally {
      process.exitCode = previous
    }
  })
})
describe('registry stale guard declaration', () => {
  it('retains the sole hook effect without duplicating it in the report', async () => {
    const { staleSessionGuardVerb } = await import('../cli/verbs/stale-session-guard-command.js')
    const { invokeCommand } = await import('@titan-design/registry')
    fake.present = true
    fake.failureAt = undefined
    fake.calls = []
    const written: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation(chunk => {
      written.push(String(chunk))
      return false
    })
    const result = await invokeCommand(
      staleSessionGuardVerb,
      { agentId: '' },
      {
        warnings: [],
        format: 'human',
        withBroker: forbidden,
      },
      { invalidArgsCode: 1 },
    )
    expect(result.envelope.ok).toBe(true)
    if (!result.envelope.ok) throw new Error('expected successful hook result')
    expect(result.envelope.data).toEqual({ ok: true, lines: [] })
    expect(fake.calls).toEqual([{ id: '' }, { read: '/synthetic-marker/' }])
    expect(written).toHaveLength(1)
    expect(JSON.parse(written[0] ?? '')).toMatchObject({ decision: 'block' })
    expect(written[0]?.endsWith('\n')).toBe(true)
  })
})
