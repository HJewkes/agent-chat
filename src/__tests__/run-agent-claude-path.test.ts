import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { LaunchPlan } from '../agents/types.js'

/**
 * CC-132, against the built CLI rather than the resolver in isolation: proves
 * `run-agent` actually resolves `plan.bin` at exec time instead of handing the
 * literal string `'claude'` straight to `spawn()`.
 *
 * `PATH=/usr/bin:/bin` reproduces the outage — a broker autostarted with a
 * minimal `PATH` and no `claude` on it anywhere. `AGENT_CHAT_CLAUDE` is the one
 * thing that should rescue the spawn. Against the pre-fix code this is the
 * NEGATIVE CONTROL: `exec(plan)` spawned `plan.bin` ('claude') directly and
 * never read `AGENT_CHAT_CLAUDE` at all, so this same env would still fail with
 * exit 127 — `AGENT_CHAT_CLAUDE` only pointing anywhere is new behaviour.
 */

const CLI = path.join(import.meta.dirname, '..', '..', 'dist', 'cli.js')
const MINIMAL_PATH = '/usr/bin:/bin'

let stateDir: string
let fakeClaude: string

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-run-agent-'))
  fakeClaude = path.join(stateDir, 'fake-claude.js')
  fs.writeFileSync(fakeClaude, "process.stdout.write('fake-claude-ran')\n")
})

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true })
})

function writePlan(
  agentId: string,
  env: Record<string, string> = {},
  stdin?: string,
  extra: Partial<LaunchPlan> = {},
): void {
  const plan: LaunchPlan = {
    agentId,
    bin: 'claude',
    args: [fakeClaude],
    cwd: stateDir,
    env,
    title: agentId,
    surface: 'headless',
    ...(stdin === undefined ? {} : { stdin }),
    ...extra,
  }
  const agentDir = path.join(stateDir, 'agents', agentId)
  fs.mkdirSync(agentDir, { recursive: true })
  fs.writeFileSync(path.join(agentDir, 'plan.json'), JSON.stringify(plan))
}

const runAgent = (env: Record<string, string>) =>
  spawnSync(process.execPath, [CLI, 'run-agent', 'agt-test'], {
    encoding: 'utf8',
    env: { ...env, PATH: MINIMAL_PATH, AGENT_CHAT_HOME: stateDir },
  })

describe('run-agent resolving claude without a usable PATH', () => {
  it('spawns the AGENT_CHAT_CLAUDE override rather than failing on a bare PATH lookup', () => {
    writePlan('agt-test')

    const result = runAgent({ AGENT_CHAT_CLAUDE: process.execPath })

    expect(result.stdout).toBe('fake-claude-ran')
    expect(result.status).toBe(0)
  })
})

describe('run-agent stamping the launched process', () => {
  it('hands the launched process its own pid as the launcher, over anything the plan says', () => {
    fs.writeFileSync(
      fakeClaude,
      'process.stdout.write(JSON.stringify([process.env.AGENT_CHAT_LAUNCHER_PID, String(process.ppid)]))\n',
    )
    writePlan('agt-test', { AGENT_CHAT_LAUNCHER_PID: '1' })

    const result = runAgent({ AGENT_CHAT_CLAUDE: process.execPath })

    const [launcher, parent] = JSON.parse(result.stdout) as [string, string]
    expect(launcher).toBe(parent)
  })
})

describe('run-agent putting the REST gh shim on the agent PATH (CC-395)', () => {
  it('launches claude with the shim directory first on PATH and a gh script in it', () => {
    fs.writeFileSync(fakeClaude, "process.stdout.write(process.env.PATH.split(':')[0])\n")
    writePlan('agt-test')

    const result = runAgent({ AGENT_CHAT_CLAUDE: process.execPath })

    const shimDir = result.stdout
    expect(path.dirname(shimDir)).toBe(path.join(stateDir, 'gh-shim'))
    expect(fs.statSync(path.join(shimDir, 'gh')).mode & 0o111).not.toBe(0)
    expect(fs.readFileSync(path.join(shimDir, 'gh'), 'utf8')).toContain(
      path.join('dist', 'gh-shim', 'main.js'),
    )
  })
})

describe('run-agent honouring an unset marker in the plan (CC-200)', () => {
  // The deletion must not be gated on the surface: only a headless plan was ever tested (CC-221).
  it.each(['headless', 'iterm-pane', 'iterm-tab'] as const)(
    'launches claude on %s with CLAUDE_CONFIG_DIR absent, though its own environment had one',
    surface => {
      const seen = path.join(stateDir, 'seen.txt')
      fs.writeFileSync(
        fakeClaude,
        `require('node:fs').writeFileSync(${JSON.stringify(seen)}, String('CLAUDE_CONFIG_DIR' in process.env))\n`,
      )
      writePlan('agt-test', {}, undefined, { surface, unsetEnv: ['CLAUDE_CONFIG_DIR'] })

      runAgent({ AGENT_CHAT_CLAUDE: process.execPath, CLAUDE_CONFIG_DIR: stateDir })

      expect(fs.readFileSync(seen, 'utf8')).toBe('false')
    },
  )
})

describe('run-agent keeping the stderr tail of a headless claude (CC-161)', () => {
  const tailFile = () => path.join(stateDir, 'agents', 'agt-test', 'stderr-tail.txt')

  it('leaves only the bounded tail of what claude wrote to stderr, and still passes it on', () => {
    fs.writeFileSync(
      fakeClaude,
      "process.stdin.resume(); process.stderr.write('x'.repeat(100000) + 'Not logged in · Please run /login\\n'); process.exitCode = 1\n",
    )
    writePlan('agt-test', {}, 'the brief')

    const result = runAgent({ AGENT_CHAT_CLAUDE: process.execPath })

    const tail = fs.readFileSync(tailFile(), 'utf8')
    expect(tail).toMatch(/Not logged in · Please run \/login\n$/)
    expect(tail.length).toBeLessThanOrEqual(4096)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Not logged in')
  })

  it('writes no tail file when claude says nothing on stderr', () => {
    writePlan('agt-test', {}, 'the brief')

    runAgent({ AGENT_CHAT_CLAUDE: process.execPath })

    expect(fs.existsSync(tailFile())).toBe(false)
  })

  it("exits promptly when a grandchild keeps holding claude's stderr", () => {
    fs.writeFileSync(
      fakeClaude,
      "process.stdin.resume(); require('node:child_process').spawn('sleep', ['4'], { stdio: ['ignore', 'ignore', 'inherit'], detached: true }).unref(); process.stderr.write('Not logged in\\n'); process.exitCode = 3\n",
    )
    writePlan('agt-test', {}, 'the brief')

    const started = Date.now()
    const result = runAgent({ AGENT_CHAT_CLAUDE: process.execPath })

    expect(Date.now() - started).toBeLessThan(2500)
    expect(result.status).toBe(3)
    expect(fs.readFileSync(tailFile(), 'utf8')).toContain('Not logged in')
  })

  it('waits for stderr that lands just after claude exits, so the tail keeps it', () => {
    fs.writeFileSync(
      fakeClaude,
      "process.stdin.resume(); require('node:child_process').spawn(process.execPath, ['-e', \"setTimeout(() => process.stderr.write('late words\\\\n'), 100)\"], { stdio: ['ignore', 'ignore', 'inherit'], detached: true }).unref(); process.exitCode = 2\n",
    )
    writePlan('agt-test', {}, 'the brief')

    const result = runAgent({ AGENT_CHAT_CLAUDE: process.execPath })

    expect(result.status).toBe(2)
    expect(fs.readFileSync(tailFile(), 'utf8')).toContain('late words')
  })

  it('exits with the claude exit code when claude closes stdin before reading its brief (CC-197)', () => {
    fs.writeFileSync(fakeClaude, 'process.stdin.destroy(); process.exit(7)\n')
    writePlan('agt-test', {}, 'x'.repeat(4 * 1024 * 1024))

    const result = runAgent({ AGENT_CHAT_CLAUDE: process.execPath })

    expect(result.status).toBe(7)
    expect(result.stderr).not.toMatch(/EPIPE|Unhandled|node:events/)
  })

  it('discards a tail left by an earlier launch of the same agent', () => {
    fs.mkdirSync(path.dirname(tailFile()), { recursive: true })
    fs.writeFileSync(tailFile(), 'Not logged in\n')
    writePlan('agt-test', {}, 'the brief')

    runAgent({ AGENT_CHAT_CLAUDE: process.execPath })

    expect(fs.existsSync(tailFile())).toBe(false)
  })
})
