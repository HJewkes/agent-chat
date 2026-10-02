import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { LaunchPlan } from '../agents/types.js'

/**
 * CC-438, against the built CLI: a signal sent to `run-agent` is logged and still reaches
 * claude, and claude's exit is logged. The fake claude writes `ready` once its handler is
 * installed, so the test signals only after both processes can react.
 */

const CLI = path.join(import.meta.dirname, '..', '..', 'dist', 'cli.js')
const AGENT = 'agt-sig'
const NAME = 'sig-seat'

let stateDir: string
let fakeClaude: string
let received: string
let claudePid: string

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-run-agent-sig-'))
  fakeClaude = path.join(stateDir, 'fake-claude.js')
  received = path.join(stateDir, 'received.txt')
  claudePid = path.join(stateDir, 'claude.pid')
})

// A failing run can leave the fake claude orphaned, which is the very bug under test.
afterEach(() => {
  try {
    process.kill(Number(fs.readFileSync(claudePid, 'utf8')), 'SIGKILL')
  } catch {
    // already gone, the passing case
  }
  fs.rmSync(stateDir, { recursive: true, force: true })
})

function writePlan(script: string): void {
  fs.writeFileSync(
    fakeClaude,
    `require('node:fs').writeFileSync(${JSON.stringify(claudePid)}, String(process.pid))\n${script}`,
  )
  const plan: LaunchPlan = {
    agentId: AGENT,
    bin: 'claude',
    args: [fakeClaude],
    cwd: stateDir,
    env: {},
    title: NAME,
    surface: 'headless',
  }
  const agentDir = path.join(stateDir, 'agents', AGENT)
  fs.mkdirSync(agentDir, { recursive: true })
  fs.writeFileSync(path.join(agentDir, 'plan.json'), JSON.stringify(plan))
}

const logLines = (): string[] =>
  fs
    .readFileSync(path.join(stateDir, 'agents', AGENT, 'launcher.log'), 'utf8')
    .trim()
    .split('\n')

/** Starts run-agent, sends `signal` once claude says ready, and resolves with run-agent's exit. */
function launchAndSignal(signal: NodeJS.Signals): Promise<number | null> {
  const launcher = spawn(process.execPath, [CLI, 'run-agent', AGENT], {
    env: { PATH: '/usr/bin:/bin', AGENT_CHAT_HOME: stateDir, AGENT_CHAT_CLAUDE: process.execPath },
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  launcher.stdout.on('data', (chunk: Buffer) => {
    if (chunk.toString().includes('ready')) launcher.kill(signal)
  })
  return new Promise(resolve => launcher.on('exit', code => resolve(code)))
}

const recordingClaude = (exitCode: number): string =>
  `for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(s, () => {
     require('node:fs').writeFileSync(${JSON.stringify(received)}, s); process.exit(${exitCode})
   })
   setInterval(() => {}, 1000); process.stdout.write('ready')\n`

describe('run-agent logging the signals it receives (CC-438)', () => {
  // Catches: dropping a signal from FORWARDED_SIGNALS, or deleting the log call in the handler.
  it.each(['SIGTERM', 'SIGINT', 'SIGHUP'] as const)(
    'logs %s with the agent name, a timestamp and the sender clues',
    async signal => {
      writePlan(recordingClaude(0))

      await launchAndSignal(signal)

      const line = logLines().find(l => l.includes(`received ${signal}`))
      expect(line).toMatch(
        new RegExp(
          `^\\d{4}-\\d\\d-\\d\\dT[\\d:.]+Z ${NAME} received ${signal} sender_pid=unavailable ppid=\\d+ pgid=\\d+$`,
        ),
      )
    },
  )

  // Catches: deleting `target.kill(signal)`, or forwarding a fixed signal instead of the one received.
  it('forwards the signal to claude, which ends the launcher with claude', async () => {
    writePlan(recordingClaude(0))

    const status = await launchAndSignal('SIGHUP')

    expect(fs.readFileSync(received, 'utf8')).toBe('SIGHUP')
    expect(status).toBe(0)
  })
})

describe("run-agent logging claude's exit (CC-438)", () => {
  // Catches: removing logChildExit, or logging the code where the signal belongs.
  it('logs the exit code claude chose', async () => {
    writePlan(recordingClaude(9))

    await launchAndSignal('SIGTERM')

    expect(logLines().at(-1)).toMatch(new RegExp(`${NAME} child pid=\\d+ exited code=9 signal=none$`))
  })

  // Catches: the same, on the path where claude dies of the signal rather than handling it.
  it('logs the signal claude died of', async () => {
    writePlan("setInterval(() => {}, 1000); process.stdout.write('ready')\n")

    const status = await launchAndSignal('SIGTERM')

    expect(logLines().at(-1)).toMatch(new RegExp(`${NAME} child pid=\\d+ exited code=none signal=SIGTERM$`))
    expect(status).toBe(128)
  })
})
