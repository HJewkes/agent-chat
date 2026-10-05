import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isProcessAlive } from '../broker/lifecycle.js'
import { EXIT_WITH_PID_VAR, exitWithWatchedPid, watchedPid } from '../broker/parent-watch.js'

/**
 * CC-435: a broker a test starts must not outlive the test run, and a broker started
 * any other way must behave exactly as before.
 */

const shortTmp = (): string => (fs.existsSync('/tmp') ? '/tmp' : os.tmpdir())
const entry = (): string => path.join(import.meta.dirname, '..', '..', 'dist', 'cli.js')
const DEATH_BUDGET_MS = 10_000

/** A stand-in for vitest: starts a detached broker, prints its pid, then idles until killed. */
const PARENT_SCRIPT = `
const { spawn } = require('node:child_process')
const env = { ...process.env }
delete env.${EXIT_WITH_PID_VAR}
if (process.env.WATCH_SELF === '1') env.${EXIT_WITH_PID_VAR} = String(process.pid)
const broker = spawn(process.execPath, [process.argv[1], 'broker'], { detached: true, stdio: 'ignore', env })
broker.unref()
console.log(broker.pid)
setInterval(() => {}, 60_000)
`

let dir: string
let spawned: number[]

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(shortTmp(), 'ac435-'))
  spawned = []
})

afterEach(() => {
  for (const pid of spawned) {
    if (isProcessAlive(pid)) process.kill(pid, 'SIGKILL')
  }
  fs.rmSync(dir, { recursive: true, force: true })
})

async function until(check: () => boolean, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return check()
}

/** Starts the stand-in parent and its broker, recording both pids for cleanup before anything can fail. */
async function startParentAndBroker(watchSelf: boolean): Promise<{ parent: number; broker: number }> {
  const env = {
    ...process.env,
    AGENT_CHAT_HOME: dir,
    AGENT_CHAT_LEDGER_SHADOW: '0',
    WATCH_SELF: watchSelf ? '1' : '0',
  }
  const parent = spawn(process.execPath, ['-e', PARENT_SCRIPT, entry()], {
    env,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  spawned.push(parent.pid as number)
  const broker = await new Promise<number>(resolve =>
    parent.stdout.once('data', chunk => resolve(Number(String(chunk).trim()))),
  )
  spawned.push(broker)
  expect(await until(() => fs.existsSync(path.join(dir, 'broker.pid')), 5_000)).toBe(true)
  return { parent: parent.pid as number, broker }
}

describe('the watched pid in the env', () => {
  it('is read only from a well-formed pid above 1', () => {
    const read = (value: string | undefined) =>
      watchedPid(value === undefined ? {} : { [EXIT_WITH_PID_VAR]: value })

    expect([
      read(undefined),
      read(''),
      read('abc'),
      read('-5'),
      read('1'),
      read('1.5'),
      read('4242'),
    ]).toEqual([null, null, null, null, null, null, 4242])
  })

  it('starts no watch when the variable is absent', () => {
    const onGone = vi.fn()

    expect(exitWithWatchedPid({}, { isAlive: () => false, onGone })).toBeNull()
  })

  it('fires once, within one interval of the watched pid dying', () => {
    vi.useFakeTimers()
    let alive = true
    const onGone = vi.fn()
    exitWithWatchedPid({ [EXIT_WITH_PID_VAR]: '4242' }, { isAlive: () => alive, onGone, intervalMs: 1_000 })

    vi.advanceTimersByTime(3_000)
    const whileAlive = onGone.mock.calls.length
    alive = false
    vi.advanceTimersByTime(5_000)
    vi.useRealTimers()

    expect([whileAlive, onGone.mock.calls.length]).toEqual([0, 1])
  })
})

describe('a broker whose parent is SIGKILLed', () => {
  it('exits within 10 s when the test harness opted it in', async () => {
    const { parent, broker } = await startParentAndBroker(true)

    process.kill(parent, 'SIGKILL')
    const gone = await until(() => !isProcessAlive(broker), DEATH_BUDGET_MS)

    expect(gone).toBe(true)
    expect(fs.existsSync(path.join(dir, 'chat.sock'))).toBe(false)
  }, 30_000)

  it('keeps running when started without the opt-in, as a hand-started broker does', async () => {
    const { parent, broker } = await startParentAndBroker(false)

    process.kill(parent, 'SIGKILL')
    const died = await until(() => !isProcessAlive(broker), 6_000)

    expect(died).toBe(false)
    expect(fs.existsSync(path.join(dir, 'chat.sock'))).toBe(true)
  }, 30_000)
})
