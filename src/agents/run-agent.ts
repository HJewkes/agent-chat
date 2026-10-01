import { spawn } from 'node:child_process'
import path from 'node:path'
import { resolvePaneColourConfig } from '../config.js'
import { withShimOnPath, writeGhShim } from '../gh-shim/install.js'
import { GIT_SHIM_DIR_ENV } from '../leak-guard/git-shim.js'
import { distDir, ghShimDir, home } from '../paths.js'
import { agentEnv } from './agent-env.js'
import { recordClaudeBin, resolveClaudeBin } from './claude-bin.js'
import { readLaunchPlan } from './launch-files.js'
import { clearOutputTail, tailKeeper, writeOutputTail } from './launch-output.js'
import {
  isITerm,
  itermIdentity,
  oscTitle,
  paneColour,
  parseHex,
  seatPrefixes,
  type PaneColourConfig,
  type SeatPrefix,
} from './pane-identity.js'
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

/** The launcher pid comes last so no plan can forge it (CC-174). */
export const launchEnv = (
  planEnv: Record<string, string>,
  base: Record<string, string> = agentEnv(),
  launcherPid: number = process.pid,
  unset: readonly string[] = [],
): Record<string, string> => {
  const env: Record<string, string> = { ...base, ...planEnv }
  for (const name of unset) delete env[name]
  return { ...env, [LAUNCHER_PID_ENV]: String(launcherPid) }
}

export { oscTitle }

/** Where the pane's colour comes from; injected so a test needs no charter or config on disk. */
export interface PaneSources {
  seats: () => SeatPrefix[]
  colours: () => PaneColourConfig
}

const diskSources: PaneSources = { seats: () => seatPrefixes(), colours: resolvePaneColourConfig }

/**
 * Title via OSC 0 rather than iTerm's `set name`, which does not stick: iTerm
 * overwrites it with the running job. In iTerm the tab colour and badge follow
 * (CC-327); any other terminal gets the title alone, and a headless agent nothing.
 */
export function paneEscapes(
  plan: LaunchPlan,
  env: NodeJS.ProcessEnv,
  sources: PaneSources = diskSources,
): string {
  if (plan.surface === 'headless') return ''
  if (!isITerm(env)) return oscTitle(plan.title)
  const colour = paneColour(plan.title, plan.env.AGENT_CHAT_PROFILE, sources.seats(), sources.colours())
  const rgb = parseHex(colour)
  return oscTitle(plan.title) + (rgb === undefined ? '' : itermIdentity(plan.title, rgb))
}

export function runAgent(agentId: string): void {
  const plan = readLaunchPlan(agentId)
  process.stdout.write(paneEscapes(plan, process.env))
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

/** Puts the REST-backed `gh` first on PATH; a failure to write it costs the agent the shim, not the spawn. */
function withGhShim(env: Record<string, string>): Record<string, string> {
  try {
    return withShimOnPath(
      env,
      writeGhShim(ghShimDir(), process.execPath, path.join(distDir(), 'gh-shim', 'main.js')),
    )
  } catch (err) {
    process.stderr.write(`agent-chat run-agent: gh shim not installed: ${(err as Error).message}\n`)
    return env
  }
}

/** Last applied, so first on PATH: the push guard sits ahead of every other shim dir. */
function withGitShim(env: Record<string, string>): Record<string, string> {
  const dir = env[GIT_SHIM_DIR_ENV]
  return dir === undefined ? env : withShimOnPath(env, dir)
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
    env: withGitShim(withGhShim(launchEnv(plan.env, agentEnv(), process.pid, plan.unsetEnv))),
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
