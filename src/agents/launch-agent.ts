import path from 'node:path'
import {
  LaunchBinUnresolved,
  runAgent,
  type LaunchPlan,
  type RunAgentOptions,
} from '@titan-design/agent-surface'
import { withShimOnPath, writeGhShim } from '../gh-shim/install.js'
import { GIT_SHIM_DIR_ENV } from '../leak-guard/git-shim.js'
import { agentDir, distDir, ghShimDir, home } from '../paths.js'
import { agentEnv } from './agent-env.js'
import { resolveBasePath } from './base-path.js'
import { recordClaudeBin, resolveClaudeBin } from './claude-bin.js'
import { LAUNCHER_PID_ENV } from './launcher.js'
import { watchLauncherSignals } from './launcher-signals.js'
import { diskPaneSources } from './pane-sources.js'
import { readLaunchPlan } from './launch-files.js'

/**
 * Resolve `plan.bin` to an absolute path without depending on `PATH` (CC-132). Only
 * `'claude'` is resolved: the plan keeps `bin: 'claude'` so a stored plan stays readable.
 */
function resolveBin(bin: string): string {
  if (bin !== 'claude') return bin
  const resolution = resolveClaudeBin({ env: process.env, stateDir: home() })
  if ('error' in resolution) throw new LaunchBinUnresolved(resolution.error)
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

/** `agentEnv()` with a PATH that keeps agent-chat, gh and sbin however the broker was started (CC-456). */
export function agentBaseEnv(
  parent: NodeJS.ProcessEnv = process.env,
  resolvePath: (env: NodeJS.ProcessEnv) => string = env => resolveBasePath({ env, stateDir: home() }),
): Record<string, string> {
  return { ...agentEnv(parent), PATH: resolvePath(parent) }
}

/**
 * The plan with the shim dirs on its PATH. The launcher layers `plan.env` over the base env,
 * so a PATH the plan sets wins over the base's: the shims go onto whichever PATH will win.
 */
export function withShims(plan: LaunchPlan, base: Record<string, string> = agentBaseEnv()): LaunchPlan {
  const env = {
    ...(plan.env.PATH === undefined && base.PATH !== undefined ? { PATH: base.PATH } : {}),
    ...plan.env,
  }
  const { PATH } = withGitShim(withGhShim(env))
  return { ...plan, env: { ...plan.env, ...(PATH === undefined ? {} : { PATH }) } }
}

/** `agentEnv()`, never `process.env`: the launched agent must not inherit the broker's credentials. */
export function launchOptions(agentId: string): RunAgentOptions {
  return {
    agentDir: agentDir(agentId),
    baseEnv: agentBaseEnv(),
    resolveBin,
    launcherPidEnv: LAUNCHER_PID_ENV,
    paneSources: diskPaneSources,
    label: 'agent-chat run-agent',
  }
}

/** `agent-chat run-agent <id>`: the verb every stored relaunch script calls. */
export function runAgentVerb(agentId: string): void {
  const plan = withShims(readLaunchPlan(agentId))
  watchLauncherSignals(agentDir(agentId), plan.title || agentId)
  runAgent(plan, launchOptions(agentId))
}
