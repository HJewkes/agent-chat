import { spawn } from 'node:child_process'
import { home } from '../paths.js'
import { agentEnv } from './agent-env.js'
import { recordClaudeBin, resolveClaudeBin } from './claude-bin.js'
import { readLaunchPlan } from './launch-files.js'
import { clearOutputTail, tailKeeper, writeOutputTail } from './launch-output.js'
import type { LaunchPlan } from './types.js'

/**
 * `agent-chat run-agent <id>` — the fixed command every surface launches.
 *
 * It reads the plan, sets the terminal title, and runs the binary with an argv
 * ARRAY. No shell is involved at any point, which is what makes it safe for a
 * model-authored brief to be in the plan at all.
 */

/** Set to run-agent's own pid, so the process it launched can tell itself apart from that process's descendants. */
export const LAUNCHER_PID_ENV = 'AGENT_CHAT_LAUNCHER_PID'

/**
 * Title via OSC 0 rather than iTerm's `set name`, which does not stick — iTerm
 * overwrites it with the running job. Here it is a plain stdout write instead of
 * an escaped string inside an AppleScript inside a shell.
 */
/** The launcher pid comes last so no plan can forge it (CC-174). */
export const launchEnv = (
  planEnv: Record<string, string>,
  base: Record<string, string> = agentEnv(),
  launcherPid: number = process.pid,
): Record<string, string> => ({ ...base, ...planEnv, [LAUNCHER_PID_ENV]: String(launcherPid) })

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

/** Longest the wrapper waits for stderr to drain after claude exits; a grandchild holding fd 2 must not stall it. */
const STDERR_FLUSH_MS = 250

function exec(plan: LaunchPlan): void {
  clearOutputTail(plan.agentId)
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
    env: launchEnv(plan.env),
    // The brief goes in on stdin for headless; an interactive surface hands the
    // terminal straight through so the human can type into the pane.
    stdio: plan.stdin === undefined ? 'inherit' : ['pipe', 'inherit', 'pipe'],
  })
  const stderrTail = tailKeeper()
  // Headless only. Drained and passed on so the pipe never fills; the tail is what CC-161 reads.
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrTail.append(chunk.toString('utf8'))
    process.stderr.write(chunk)
  })

  if (plan.stdin !== undefined) {
    // A child that exits before reading its brief closes the pipe; its exit code is what matters, not the failed write.
    child.stdin?.on('error', err => {
      if ((err as NodeJS.ErrnoException).code !== 'EPIPE') {
        process.stderr.write(`agent-chat run-agent: could not write the brief to ${bin}: ${err.message}\n`)
      }
    })
    child.stdin?.end(plan.stdin)
  }

  child.on('error', err => {
    process.stderr.write(`agent-chat run-agent: could not start ${bin}: ${err.message}\n`)
    process.exit(127)
  })
  // Exit the way the child did, so whatever is watching the surface sees the
  // agent's own outcome rather than this wrapper's.
  child.on('exit', (code, signal) => {
    const finish = (): never => {
      writeOutputTail(plan.agentId, stderrTail.text())
      process.exit(signal !== null ? 128 : (code ?? 0))
    }
    if (child.stderr === null || child.stderr.readableEnded) return finish()
    child.stderr.once('end', finish)
    setTimeout(finish, STDERR_FLUSH_MS)
  })
}
