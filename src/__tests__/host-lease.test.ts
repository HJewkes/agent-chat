import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkHostLease, hostLeaseRefusal, normaliseHost, type LeaseRead } from '../host-lease.js'
import { seatsWatchdogVerb } from '../cli/verbs/seats.js'
import { withBroker } from '../cli/client.js'
import { reapBroker } from './broker-harness.js'

/** CC-806: the factory host lease. Every lease file lives under a per-test AGENT_CHAT_HOME. */

const shortTmp = (): string => os.tmpdir()
const entry = (): string => path.join(import.meta.dirname, '..', '..', 'dist', 'cli.js')
const ctx = { warnings: [], format: 'human' as const, withBroker }
const FILE = '/home/x/factory-host'

let dir: string
let previousHome: string | undefined
let broker: ChildProcess | undefined

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(shortTmp(), 'ac-lease-'))
  previousHome = process.env.AGENT_CHAT_HOME
  process.env.AGENT_CHAT_HOME = dir
})

afterEach(async () => {
  await reapBroker(dir)
  broker?.kill('SIGKILL')
  broker = undefined
  if (previousHome === undefined) delete process.env.AGENT_CHAT_HOME
  else process.env.AGENT_CHAT_HOME = previousHome
  fs.rmSync(dir, { recursive: true, force: true })
})

const lease = (text: string): void => fs.writeFileSync(path.join(dir, 'factory-host'), text)
const thisHost = (): string => os.hostname()

describe('checkHostLease', () => {
  const text = (t: string): LeaseRead => ({ text: t })
  const table: Array<[string, LeaseRead, string, boolean]> = [
    ['absent file', { absent: true }, 'mac', true],
    ['exact match', text('mac'), 'mac', true],
    ['whitespace around the name', text('  mac\n'), 'mac', true],
    ['case differs', text('MAC'), 'mac', true],
    ['lease has .local', text('mac.local'), 'mac', true],
    ['host has .local', text('mac'), 'Mac.local', true],
    ['trailing domain', text('mac.example.com'), 'mac.local', true],
    ['another host', text('basement'), 'mac', false],
    ['prefix of another host', text('mac2'), 'mac', false],
    ['empty file', text(''), 'mac', false],
    ['whitespace only', text(' \n'), 'mac', false],
    ['unreadable file', { error: 'EACCES' }, 'mac', false],
  ]

  it.each(table)('%s', (_name, read, host, ok) => {
    expect(checkHostLease(read, host, FILE).ok).toBe(ok)
  })

  it('names the file, the leased host and this host in a mismatch', () => {
    const verdict = checkHostLease(text('basement'), 'mac', FILE)

    expect(verdict).toEqual({ ok: false, message: expect.stringMatching(/factory-host.*"basement".*"mac"/) })
  })

  it('says so when the file is empty or unreadable', () => {
    expect(checkHostLease(text(''), 'mac', FILE)).toMatchObject({ message: expect.stringMatching(/empty/) })
    expect(checkHostLease({ error: 'EACCES' }, 'mac', FILE)).toMatchObject({
      message: expect.stringMatching(/unreadable \(EACCES\)/),
    })
  })

  it('normalises to the lowercase first label', () => {
    expect(normaliseHost(' Mac.Local ')).toBe('mac')
  })
})

describe('hostLeaseRefusal against the real file under AGENT_CHAT_HOME', () => {
  it('treats a missing file as no lease', () => {
    expect(hostLeaseRefusal()).toBeUndefined()
  })

  it('accepts this host in any case and with .local', () => {
    for (const name of [thisHost(), thisHost().toUpperCase(), `${thisHost().split('.')[0]}.local`]) {
      lease(`${name}\n`)
      expect(hostLeaseRefusal()).toBeUndefined()
    }
  })

  it('refuses another host, an empty file and an unreadable one', () => {
    lease('some-other-host')
    expect(hostLeaseRefusal()).toMatch(/some-other-host/)
    lease('')
    expect(hostLeaseRefusal()).toMatch(/empty/)
    fs.rmSync(path.join(dir, 'factory-host'))
    fs.mkdirSync(path.join(dir, 'factory-host'))
    expect(hostLeaseRefusal()).toMatch(/unreadable/)
  })
})

describe('seats watchdog', () => {
  const run = (): ReturnType<typeof seatsWatchdogVerb.run> =>
    seatsWatchdogVerb.run({ dryRun: true, root: path.join(dir, 'no-autonomy') }, ctx)

  it('refuses before doing any work when the lease names another host', async () => {
    lease('some-other-host')

    expect(await run()).toMatchObject({
      ok: false,
      errors: [expect.stringMatching(/factory host lease.*some-other-host/)],
    })
  })

  it.each(['', ' \n'])('refuses an empty lease file %j', async text => {
    lease(text)

    expect(await run()).toMatchObject({ ok: false, errors: [expect.stringMatching(/empty/)] })
  })

  it('refuses an unreadable lease file', async () => {
    fs.mkdirSync(path.join(dir, 'factory-host'))

    expect(await run()).toMatchObject({ ok: false, errors: [expect.stringMatching(/unreadable/)] })
  })

  it.each([undefined, thisHost(), thisHost().toUpperCase(), `${thisHost().split('.')[0]}.local`])(
    'gets past the lease when the file is %j',
    async text => {
      if (text !== undefined) lease(text)

      const result = await run()

      expect(JSON.stringify(result)).not.toMatch(/factory host lease/)
    },
  )
})

describe('broker start', () => {
  const env = (): NodeJS.ProcessEnv => ({
    ...process.env,
    AGENT_CHAT_HOME: dir,
    AGENT_CHAT_LEDGER_SHADOW: '0',
  })
  const sock = (): string => path.join(dir, 'chat.sock')
  const log = (): string => fs.readFileSync(path.join(dir, 'broker.log'), 'utf8')

  const exitOf = (child: ChildProcess): Promise<number | null> =>
    new Promise(resolve => child.once('exit', code => resolve(code)))

  async function refused(text: string | undefined, directory = false): Promise<void> {
    if (directory) fs.mkdirSync(path.join(dir, 'factory-host'))
    else if (text !== undefined) lease(text)
    broker = spawn(process.execPath, [entry(), 'broker'], { env: env(), stdio: 'ignore' })
    await exitOf(broker)
  }

  it('logs a broker_exit and binds nothing when the lease names another host', async () => {
    await refused('some-other-host')

    expect(fs.existsSync(sock())).toBe(false)
    expect(log()).toMatch(/broker_exit.*factory host lease.*some-other-host/)
  })

  it('refuses an empty lease file', async () => {
    await refused('')

    expect(fs.existsSync(sock())).toBe(false)
    expect(log()).toMatch(/broker_exit.*empty/)
  })

  it('refuses an unreadable lease file', async () => {
    await refused(undefined, true)

    expect(fs.existsSync(sock())).toBe(false)
    expect(log()).toMatch(/broker_exit.*unreadable/)
  })

  it.each([undefined, 'host', 'upper', 'local'])('starts when the lease is %j', async variant => {
    const name = thisHost()
    const text = { host: name, upper: name.toUpperCase(), local: `${name.split('.')[0]}.local` }[
      variant ?? ''
    ]
    if (text !== undefined) lease(text)
    broker = spawn(process.execPath, [entry(), 'broker'], { env: env(), stdio: 'ignore' })

    const deadline = Date.now() + 10_000
    while (!fs.existsSync(sock()) && Date.now() < deadline) await new Promise(r => setTimeout(r, 50))

    expect(fs.existsSync(sock())).toBe(true)
    await reapBroker(dir)
  })
})
