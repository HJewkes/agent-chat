import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { activeHold, MAX_HOLD_SECONDS, writeHold } from '../broker/hold.js'
import { reapBroker } from './broker-harness.js'

/**
 * CC-153: `service stop --hold <seconds>` keeps attached clients from
 * auto-restarting the broker long enough for an offline job, and always expires.
 */

const run = promisify(execFile)
const shortTmp = (): string => (fs.existsSync('/tmp') ? '/tmp' : os.tmpdir())
const entry = (): string => path.join(import.meta.dirname, '..', '..', 'dist', 'cli.js')
const NOW = Date.parse('2026-09-28T12:00:00.000Z')

let dir: string
let previousHome: string | undefined
let broker: ChildProcess | undefined

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(shortTmp(), 'ac-hold-'))
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

const env = (): NodeJS.ProcessEnv => ({ ...process.env, AGENT_CHAT_HOME: dir, AGENT_CHAT_LEDGER_SHADOW: '0' })
const sock = (): string => path.join(dir, 'chat.sock')

async function until(check: () => boolean, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return check()
}

const exitOf = (child: ChildProcess): Promise<number | null> =>
  new Promise(resolve => child.once('exit', code => resolve(code)))

describe('a broker hold', () => {
  it('is live until its expiry and gone after it, with no renewal', () => {
    const until = writeHold(60, NOW)

    expect([activeHold(NOW), activeHold(until - 1), activeHold(until)]).toEqual([until, until, undefined])
  })

  it('caps a requested hold, and ignores a hand-edited expiry beyond the cap', () => {
    const capped = writeHold(MAX_HOLD_SECONDS * 10, NOW)
    fs.writeFileSync(path.join(dir, 'broker.hold'), String(NOW + (MAX_HOLD_SECONDS + 1) * 1000))

    expect(capped).toBe(NOW + MAX_HOLD_SECONDS * 1000)
    expect(activeHold(NOW)).toBeUndefined()
  })

  it('stops a running broker, refuses a restart while held, and service start lifts it', async () => {
    broker = spawn(process.execPath, [entry(), 'broker'], { env: env(), stdio: 'ignore' })
    expect(await until(() => fs.existsSync(path.join(dir, 'broker.pid')), 5_000)).toBe(true)

    const stopped = await run(process.execPath, [entry(), 'service', 'stop', '--hold', '30'], { env: env() })
    const restart = spawn(process.execPath, [entry(), 'broker'], { env: env(), stdio: 'ignore' })
    const restartExit = await exitOf(restart)

    expect(stopped.stdout).toMatch(/Held until/)
    expect(restartExit).toBe(0)
    expect(fs.existsSync(sock())).toBe(false)
    expect(fs.readFileSync(path.join(dir, 'broker.log'), 'utf8')).toMatch(/held by service stop --hold/)

    await run(process.execPath, [entry(), 'service', 'start'], { env: env() })

    expect(fs.existsSync(path.join(dir, 'broker.hold'))).toBe(false)
    expect(fs.existsSync(sock())).toBe(true)
  })

  it('rejects a hold of zero or beyond the cap', async () => {
    for (const seconds of ['0', String(MAX_HOLD_SECONDS + 1), '1.5']) {
      const attempt = run(process.execPath, [entry(), 'service', 'stop', '--hold', seconds], { env: env() })
      await expect(attempt).rejects.toMatchObject({ stderr: expect.stringMatching(/bad --hold/) })
    }
    expect(fs.existsSync(path.join(dir, 'broker.hold'))).toBe(false)
  })
})
