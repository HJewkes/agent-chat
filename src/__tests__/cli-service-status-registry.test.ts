import { Console } from 'node:console'
import { Writable } from 'node:stream'
import { format } from 'node:util'
import type { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({
  calls: [] as unknown[],
  socket: true,
  pid: 123 as number | null,
  meta: { version: 'fixture-version', port: 7600 } as unknown,
  health: { uptime_ms: 1500, sessions: 2, queue_open: 3 } as unknown,
  alive: true,
  failureAt: undefined as string | undefined,
  failure: undefined as unknown,
}))
const forbidden = () => {
  throw new Error('unexpected service controller/process/fs/broker operation')
}
const step = (name: string, value: unknown, arg?: unknown) => {
  fake.calls.push({ name, ...(arg === undefined ? {} : { arg }) })
  if (fake.failureAt === name) throw fake.failure
  return value
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
vi.mock('../broker/lifecycle.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../broker/lifecycle.js')>()),
  probeSocket: async () => step('probeSocket', fake.socket),
  readMeta: () => step('readMeta', fake.meta),
  readPidFile: () => step('readPidFile', fake.pid),
  isProcessAlive: (pid: unknown) => step('isProcessAlive', fake.alive, pid),
  removeStateFiles: forbidden,
}))
vi.mock('../broker/doctor.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../broker/doctor.js')>()),
  probeHealth: async (port: unknown) => step('probeHealth', fake.health, port),
}))
vi.mock('../cli/client.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../cli/client.js')>()),
  withBroker: forbidden,
}))
vi.mock('../cli/service.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../cli/service.js')>()),
  start: forbidden,
  stop: forbidden,
  restart: forbidden,
  open: forbidden,
}))
vi.mock('../paths.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../paths.js')>()),
  socketPath: () => '/tmp/synthetic-service-status/chat.sock',
  logPath: forbidden,
  defaultPort: () => 8765,
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
  socket?: boolean
  pid?: number | null
  meta?: unknown
  health?: unknown
  alive?: boolean
  failureAt?: string
  failure?: unknown
}
const cases: Case[] = [
  { name: 'healthy metadata port and uptime rounding up', argv: ['service', 'status'] },
  { name: 'socket down despite live pid and HTTP', argv: ['service', 'status'], socket: false },
  { name: 'socket up without HTTP', argv: ['service', 'status'], health: null },
  { name: 'no pid file', argv: ['service', 'status'], pid: null },
  { name: 'stale pid', argv: ['service', 'status'], alive: false },
  { name: 'no metadata default port', argv: ['service', 'status'], meta: null },
  {
    name: 'metadata null port falls back',
    argv: ['service', 'status'],
    meta: { version: 'fixture-version', port: null },
  },
  { name: 'explicit port wins', argv: ['service', 'status', '-p', '9001'] },
  { name: 'trailing text port', argv: ['service', 'status', '--port=9002tail'] },
  { name: 'fractional port parseInt', argv: ['service', 'status', '-p', '9003.9'] },
  { name: 'exponent port parseInt', argv: ['service', 'status', '-p', '1e2'] },
  { name: 'last repeated port wins', argv: ['service', 'status', '-p', '9001', '--port', '9004'] },
  { name: 'zero bad port', argv: ['service', 'status', '-p', '0'] },
  { name: 'negative bad port', argv: ['service', 'status', '-p', '-1'] },
  { name: 'ceiling bad port', argv: ['service', 'status', '-p', '65536'] },
  { name: 'nonnumeric bad port', argv: ['service', 'status', '-p', 'nonsense'] },
  { name: 'empty bad port', argv: ['service', 'status', '-p', ''] },
  { name: 'missing port argument', argv: ['service', 'status', '-p'] },
  {
    name: 'uptime rounding down',
    argv: ['service', 'status'],
    health: { uptime_ms: 1499, sessions: 0, queue_open: 0 },
  },
  {
    name: 'probe error',
    argv: ['service', 'status'],
    failureAt: 'probeSocket',
    failure: new Error('synthetic probe failed'),
  },
  {
    name: 'health code69 maps legacy1',
    argv: ['service', 'status'],
    failureAt: 'probeHealth',
    failure: Object.assign(new Error('synthetic health unavailable'), { code: 69 }),
  },
  {
    name: 'pid read string failure',
    argv: ['service', 'status'],
    failureAt: 'readPidFile',
    failure: 'synthetic pid failure',
  },
  {
    name: 'partial socket output before liveness error69',
    argv: ['service', 'status'],
    failureAt: 'isProcessAlive',
    failure: Object.assign(new Error('synthetic liveness failed'), { code: 69 }),
  },
  { name: 'help', argv: ['service', 'status', '--help'] },
  {
    name: 'plain object probe rejection preserves console formatting',
    argv: ['service', 'status'],
    failureAt: 'probeSocket',
    failure: { code: 69, message: 'synthetic failure' },
  },
  {
    name: 'plain object liveness rejection preserves partial output',
    argv: ['service', 'status'],
    failureAt: 'isProcessAlive',
    failure: { code: 69, message: 'synthetic failure' },
  },
]

async function invoke(sample: Case) {
  output.length = 0
  fake.calls = []
  fake.socket = sample.socket ?? true
  fake.pid = sample.pid === undefined ? 123 : sample.pid
  fake.meta = sample.meta === undefined ? { version: 'fixture-version', port: 7600 } : sample.meta
  fake.health = sample.health === undefined ? { uptime_ms: 1500, sessions: 2, queue_open: 3 } : sample.health
  fake.alive = sample.alive ?? true
  fake.failureAt = sample.failureAt
  fake.failure = sample.failure

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
  return { name: sample.name, argv: sample.argv, calls: [...fake.calls], output: [...output], exit }
}

describe('S8 original service status ABI', () => {
  it('captures plain object errors exactly as an actual Console and Writable', () => {
    const chunks: string[] = []
    const sink = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(String(chunk))
        callback()
      },
    })
    const actual = new Console({ stdout: sink, stderr: sink, colorMode: false })
    const rejection = { code: 69, message: 'synthetic failure' }
    actual.error(rejection)
    expect(chunks.join('')).toBe(format(rejection) + '\n')
    expect(chunks.join('')).toBe("{ code: 69, message: 'synthetic failure' }\n")
  })

  it('preserves original frames, output, failures and service status argv without invoking a broker', async () => {
    const results = []
    for (const sample of cases) results.push(await invoke(sample))
    await expect(JSON.stringify(results, null, 2) + '\n').toMatchFileSnapshot(
      './golden/registry-service-status-calls.json',
    )
  })
})
