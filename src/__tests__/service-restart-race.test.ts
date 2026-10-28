import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_RESTART_LOCK_S,
  releaseRestartLock,
  restartLockHolder,
  takeRestartLock,
} from '../broker/restart-lock.js'
import { BrokerClient } from '../client/broker-client.js'
import { reapBroker } from './broker-harness.js'

/**
 * TP-4347: while `service restart` holds its lock, a session MCP that lost the broker must not
 * start one of its own. The restart's broker has to be the one on the socket.
 */

const dist = (...parts: string[]): string => path.join(import.meta.dirname, '..', '..', 'dist', ...parts)
const entry = (): string => dist('cli.js')
const NOW = Date.parse('2026-09-28T12:00:00.000Z')

/**
 * The session MCP's own client code: a `BrokerClient` with auto-start on. `oldBuild` adds what an
 * MCP built before the lock does at the drop, a direct broker spawn, so the daemon's refusal is
 * tested on its own.
 */
const RACER = `
import { spawn } from 'node:child_process'
const [clientUrl, entry, oldBuild] = process.argv.slice(1)
const { BrokerClient } = await import(clientUrl)
const spawnBroker = () => spawn(process.execPath, [entry, 'broker'], { detached: true, stdio: 'ignore' }).unref()
const client = new BrokerClient(() => undefined, undefined, undefined, undefined, oldBuild === '1' ? spawnBroker : undefined)
await client.connect()
await client.request({ t: 'register', name: 'racer', workingOn: 'racing a restart', cwd: process.cwd(), pid: process.pid }, 'register_result')
console.log('ready')
setInterval(() => undefined, 60_000)
`

let dir: string
let previousHome: string | undefined
const children: ChildProcess[] = []

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-rlock-'))
  previousHome = process.env.AGENT_CHAT_HOME
  process.env.AGENT_CHAT_HOME = dir
})

afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL')
  await reapBroker(dir)
  if (previousHome === undefined) delete process.env.AGENT_CHAT_HOME
  else process.env.AGENT_CHAT_HOME = previousHome
  fs.rmSync(dir, { recursive: true, force: true })
})

const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  ...process.env,
  AGENT_CHAT_HOME: dir,
  AGENT_CHAT_LEDGER_SHADOW: '0',
  ...extra,
})
const lockFile = (): string => path.join(dir, 'broker.restart-lock')
const brokerPid = (): number => Number(fs.readFileSync(path.join(dir, 'broker.pid'), 'utf8').trim())

async function until(check: () => boolean, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return check()
}

function cli(args: string[], extra: NodeJS.ProcessEnv = {}): ChildProcess {
  const child = spawn(process.execPath, [entry(), ...args], {
    env: env(extra),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(child)
  return child
}

/** The exit code, with the child's output appended on failure so a red run says why. */
function exitOf(child: ChildProcess): Promise<number | string | null> {
  let out = ''
  child.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString()))
  child.stderr?.on('data', (chunk: Buffer) => (out += chunk.toString()))
  return new Promise(resolve => child.once('close', code => resolve(code === 0 ? 0 : `${code}: ${out}`)))
}

async function startRacer(oldBuild: boolean): Promise<void> {
  const args = [
    '--input-type=module',
    '-e',
    RACER,
    pathToFileURL(dist('client', 'broker-client.js')).href,
    entry(),
  ]
  const racer = spawn(process.execPath, [...args, oldBuild ? '1' : '0'], {
    env: env(),
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  children.push(racer)
  await new Promise<void>((resolve, reject) => {
    racer.stdout?.on('data', (chunk: Buffer) => chunk.toString().includes('ready') && resolve())
    racer.once('exit', code => reject(new Error(`racer exited ${code}`)))
  })
}

interface Row {
  ts: string
  event: string
  pid?: number
  ppid?: number
  launcher?: string
  reason?: string
}

function rowsSince(since: string): Row[] {
  return fs
    .readFileSync(path.join(dir, 'broker.log'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as Row)
    .filter(row => row.ts >= since)
}

async function sessionNames(): Promise<string[]> {
  const client = new BrokerClient(() => undefined, undefined, undefined, undefined, undefined, {
    autoStart: false,
  })
  await client.connect()
  try {
    const reply = await client.request({ t: 'list' }, 'list_result')
    return reply.t === 'list_result' ? reply.sessions.map(s => s.name) : []
  } finally {
    client.close()
  }
}

async function racerRegistered(): Promise<boolean> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if ((await sessionNames().catch((): string[] => [])).includes('racer')) return true
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return false
}

async function brokerWithRacer(oldBuild: boolean): Promise<void> {
  expect(await exitOf(cli(['service', 'start']))).toBe(0)
  // The pid file follows the HTTP bind, so `service start` can return before it is there to stop by.
  expect(await until(() => fs.existsSync(path.join(dir, 'broker.pid')), 5_000)).toBe(true)
  await startRacer(oldBuild)
}

describe('service restart racing a session that auto-starts the broker', () => {
  it.each([
    ['a current-build session waits for the lock', false],
    ['an old-build session spawns at the drop and its broker refuses', true],
  ])(
    'leaves the restart’s own broker on the socket: %s',
    async (_name, oldBuild) => {
      await brokerWithRacer(oldBuild)
      const since = new Date().toISOString()

      const restart = cli(['service', 'restart'], { AGENT_CHAT_TEST_RESTART_GAP_MS: '750' })
      const code = await exitOf(restart)

      const started = rowsSince(since).filter(row => row.event === 'broker_started')
      const refused = rowsSince(since).filter(row => row.reason === 'restart lock held')
      expect(code).toBe(0)
      expect(started).toHaveLength(1)
      expect(started[0]).toMatchObject({ launcher: 'restart', ppid: restart.pid, pid: brokerPid() })
      expect(refused.length > 0).toBe(oldBuild)
      expect(await racerRegistered()).toBe(true)
      expect(fs.existsSync(lockFile())).toBe(false)
    },
    30_000,
  )

  it('lets the session start a broker once a restart killed mid-lock is gone, and the next restart takes over', async () => {
    await brokerWithRacer(false)
    const since = new Date().toISOString()
    const restart = cli(['service', 'restart'], { AGENT_CHAT_TEST_RESTART_GAP_MS: '5000' })
    expect(
      await until(() => fs.existsSync(lockFile()) && !fs.existsSync(path.join(dir, 'chat.sock')), 10_000),
    ).toBe(true)

    restart.kill('SIGKILL')

    expect(await racerRegistered()).toBe(true)
    expect(rowsSince(since).filter(row => row.event === 'broker_started')).toMatchObject([
      { launcher: 'auto' },
    ])
    expect(await exitOf(cli(['service', 'restart']))).toBe(0)
    expect(fs.existsSync(lockFile())).toBe(false)
  }, 30_000)
})

describe('the restart lock', () => {
  const deadPid = (): number => spawnSync(process.execPath, ['-e', 'process.pid']).pid ?? 0
  const writeLock = (lock: object): void => fs.writeFileSync(lockFile(), JSON.stringify(lock))

  it('is held by one taker and released only by its own token', () => {
    const first = takeRestartLock(60, NOW)
    const second = takeRestartLock(60, NOW)
    if (!('token' in first)) throw new Error('first take refused')

    releaseRestartLock('not-the-token')
    const heldAfterWrongRelease = restartLockHolder(NOW)
    releaseRestartLock(first.token)

    expect(second).toEqual({ holder: { token: first.token, pid: process.pid, until: NOW + 60_000 } })
    expect(heldAfterWrongRelease?.token).toBe(first.token)
    expect(fs.existsSync(lockFile())).toBe(false)
  })

  it('caps the requested length', () => {
    takeRestartLock(MAX_RESTART_LOCK_S * 10, NOW)

    expect(restartLockHolder(NOW)?.until).toBe(NOW + MAX_RESTART_LOCK_S * 1000)
  })

  it.each([
    ['expired', () => ({ token: 't', pid: process.pid, until: NOW - 1 })],
    [
      'beyond the cap',
      () => ({ token: 't', pid: process.pid, until: NOW + (MAX_RESTART_LOCK_S + 1) * 1000 }),
    ],
    ['held by a dead process', () => ({ token: 't', pid: deadPid(), until: NOW + 60_000 })],
    ['malformed', () => ({ token: 't' })],
  ])('counts a lock that is %s as none, and a new restart takes it', (_name, lock) => {
    writeLock(lock())

    const holder = restartLockHolder(NOW)
    const taken = takeRestartLock(60, NOW)

    expect(holder).toBeUndefined()
    expect(taken).toHaveProperty('token')
  })
})
