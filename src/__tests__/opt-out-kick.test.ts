import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { reapBroker } from './broker-harness.js'

/**
 * CC-1151: from an agent's shell (AGENT_CHAT_AGENT_ID set) a hand-run tick, watchdog or heartbeat check
 * sends the broker a `job_kick` frame and runs nothing in-process, so the caller's PATH, GH_*, HOME and
 * CLAUDE_CONFIG_DIR never steer it. The harness broker's home is under os.tmpdir(), an ephemeral home,
 * so the broker records each kick without launching the job.
 */

const run = promisify(execFile)
const entry = (): string => path.join(import.meta.dirname, '..', '..', 'dist', 'cli.js')
const PLANTED_TOOLS = ['gh', 'titan-factory', 'active-work', 'git']

let dir: string
let planted: string
let broker: ChildProcess | undefined

const marker = (): string => path.join(planted, 'planted-ran')

function plantFakeBin(): string {
  const bin = path.join(planted, 'fake-bin')
  fs.mkdirSync(bin)
  for (const tool of PLANTED_TOOLS) {
    fs.writeFileSync(path.join(bin, tool), `#!/bin/sh\ntouch '${marker()}'\nexit 1\n`, { mode: 0o755 })
  }
  return bin
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-kick-'))
  planted = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-kick-planted-'))
  broker = spawn(process.execPath, [entry(), 'broker'], {
    env: { ...process.env, AGENT_CHAT_HOME: dir, AGENT_CHAT_LEDGER_SHADOW: '0' },
    stdio: 'ignore',
  })
  const deadline = Date.now() + 5_000
  while (!fs.existsSync(path.join(dir, 'broker.pid')) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50))
  }
})

afterEach(async () => {
  await reapBroker(dir)
  broker?.kill('SIGKILL')
  broker = undefined
  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(planted, { recursive: true, force: true })
})

function callerEnv(agentId: string | undefined): NodeJS.ProcessEnv {
  const plantedHome = path.join(planted, 'planted-home')
  fs.mkdirSync(plantedHome, { recursive: true })
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AGENT_CHAT_HOME: dir,
    PATH: `${plantFakeBin()}${path.delimiter}${process.env.PATH ?? ''}`,
    GH_TOKEN: 'planted',
    GH_CONFIG_DIR: path.join(planted, 'gh'),
    HOME: plantedHome,
    CLAUDE_CONFIG_DIR: path.join(planted, 'claude'),
    ACTIVE_ROOT: path.join(planted, 'active-root'),
  }
  if (agentId !== undefined) env.AGENT_CHAT_AGENT_ID = agentId
  return env
}

async function cli(args: string[], agentId: string | undefined): Promise<{ code: number; out: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [entry(), ...args], { env: callerEnv(agentId) })
    return { code: 0, out: stdout + stderr }
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string }
    return { code: e.code ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

const kickRows = (): Record<string, unknown>[] => {
  const log = path.join(dir, 'broker.log')
  if (!fs.existsSync(log)) return []
  return fs
    .readFileSync(log, 'utf8')
    .split('\n')
    .filter(line => line.includes('"event":"job_kick"'))
    .map(line => JSON.parse(line) as Record<string, unknown>)
}

describe('an opt-out site run from an agent shell', () => {
  it.each([
    [['burndown', 'tick', '--once'], { job: 'burndown_tick' }],
    [['seats', 'watchdog'], { job: 'seats_watchdog' }],
    [['seats', 'heartbeat-check', '--seat', 's1'], { job: 'seats_heartbeat_check', seat: 's1' }],
  ])('%j kicks the broker and runs none of the planted tools', async (args, request) => {
    const result = await cli(args, 'agent-under-test')

    expect(result).toMatchObject({
      code: 0,
      out: expect.stringMatching(/^kicked .* in the broker: accepted/),
    })
    expect(kickRows()).toEqual([expect.objectContaining({ event: 'job_kick', ...request })])
    expect(JSON.stringify(kickRows())).not.toMatch(/planted/)
    expect(fs.existsSync(marker())).toBe(false)
  })

  it.each([
    [['burndown', 'tick', '--once', '--dry-run'], /use `agent-chat burndown plan`/],
    [['seats', 'watchdog', '--root', '/tmp/x'], /--root refused from an agent shell/],
    [['seats', 'watchdog', '--seat', 's1', '--fire-cap', '2'], /--seat, --fire-cap refused/],
    [['seats', 'heartbeat-check', '--seat', 's1', '--root', '/tmp/x'], /--root refused from an agent shell/],
  ])('%j is refused and sends no kick', async (args, message) => {
    const result = await cli(args, 'agent-under-test')

    expect(result.code).not.toBe(0)
    expect(result.out).toMatch(message)
    expect(kickRows()).toEqual([])
  })

  it('runs the tick in-process, with no kick, when no agent id is set', async () => {
    const result = await cli(['burndown', 'tick', '--once'], undefined)

    expect(result.out).not.toMatch(/kicked/)
    expect(kickRows()).toEqual([])
  })
})
