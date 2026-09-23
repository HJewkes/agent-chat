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

function writePlan(agentId: string): void {
  const plan: LaunchPlan = {
    agentId,
    bin: 'claude',
    args: [fakeClaude],
    cwd: stateDir,
    env: {},
    title: agentId,
    surface: 'headless',
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
