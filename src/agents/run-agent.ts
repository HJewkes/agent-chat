import { spawn } from 'node:child_process'
import { home } from '../paths.js'
import { agentEnv } from './agent-env.js'
import { recordClaudeBin, resolveClaudeBin } from './claude-bin.js'
import { readLaunchPlan } from './launch-files.js'
import type { LaunchPlan } from './types.js'

/**
 * `agent-chat run-agent <id>` — the fixed command every surface launches.
 *
 * It reads the plan, sets the terminal title, and runs the binary with an argv
 * ARRAY. No shell is involved at any point, which is what makes it safe for a
 * model-authored brief to be in the plan at all.
 */

/**
 * Title via OSC 0 rather than iTerm's `set name`, which does not stick — iTerm
 * overwrites it with the running job. Here it is a plain stdout write instead of
 * an escaped string inside an AppleScript inside a shell.
 */
export const oscTitle = (title: string): string => `]0;${title}`

export function runAgent(agentId: string): void {
  const plan = readLaunchPlan(agentId)
  if (plan.surface !== 'headless') process.stdout.write(oscTitle(plan.title))
  exec(plan)
}

/**
 * Resolve `plan.bin` to an absolute path before spawning, without depending on
 * `PATH` (CC-132). Only `'claude'` is resolved this way — the plan itself keeps
 * `bin: 'claude'` so a stored plan stays readable, and resolution happens here,
 * in the process that actually execs, so it always sees this process's real env.
 *
 * On resolution failure, prints what was tried and exits 127 — the same code a
 * bare `spawn('claude', ...)` would already exit with on ENOENT.
 */
function resolvedBin(bin: string): string {
  if (bin !== 'claude') return bin
  const resolution = resolveClaudeBin({ env: process.env, stateDir: home() })
  if ('error' in resolution) {
    process.stderr.write(`agent-chat run-agent: ${resolution.error}\n`)
    process.exit(127)
  }
  if (resolution.source === 'path') recordClaudeBin(home(), resolution.bin)
  return resolution.bin
}

function exec(plan: LaunchPlan): void {
  const bin = resolvedBin(plan.bin)
  const child = spawn(bin, plan.args, {
    cwd: plan.cwd,
    // `agentEnv()`, not `process.env`: an agent inherited every credential
    // exported by whatever shell started the broker, which is relay's T7/M8
    // minimal-env clause not surviving delegation. See agent-env.ts for why
    // this is a denylist and what that costs.
    //
    // `plan.env` still wins, and deliberately: it is what the SPAWNER chose for
    // this agent, which is the bounded thing the clause asks for.
    env: { ...agentEnv(), ...plan.env },
    // The brief goes in on stdin for headless; an interactive surface hands the
    // terminal straight through so the human can type into the pane.
    stdio: plan.stdin === undefined ? 'inherit' : ['pipe', 'inherit', 'inherit'],
  })

  if (plan.stdin !== undefined) {
    child.stdin?.end(plan.stdin)
  }

  child.on('error', err => {
    process.stderr.write(`agent-chat run-agent: could not start ${bin}: ${err.message}\n`)
    process.exit(127)
  })
  // Exit the way the child did, so whatever is watching the surface sees the
  // agent's own outcome rather than this wrapper's.
  child.on('exit', (code, signal) => {
    process.exit(signal !== null ? 128 : (code ?? 0))
  })
}
