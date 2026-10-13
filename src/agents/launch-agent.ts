import os from 'node:os'
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
import { pinGitProtocols } from '../git.js'
import { agentEnv, type AgentEnvOptions } from './agent-env.js'
import { resolveBasePath } from './base-path.js'
import { recordClaudeBin, resolveClaudeBin } from './claude-bin.js'
import { resolveOrphanReapKill } from '../config.js'
import { logEvent } from '../broker/log.js'
import { LAUNCHER_PID_ENV } from './launcher.js'
import { reapOwnLaunch, realExitDeps } from './orphan-reap.js'
import {
  diskTmpRoot,
  realExitTmpDeps,
  removeOwnTmpDir,
  TMP_ROOT,
  type AgentTmpRequest,
} from './agent-tmpdir.js'
import { watchLauncherSignals } from './launcher-signals.js'
import { diskPaneSources } from './pane-sources.js'
import { readLaunchPlan } from './launch-files.js'
import { holderOf } from './launch-guard.js'
import { continueStarted } from './launch-plan.js'
import { findTranscript } from './transcript.js'
import { isReviewerSpawn, reviewerScratchDir, withScratchAddDir } from './reviewer-tree.js'

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
  options: AgentEnvOptions = {},
): Record<string, string> {
  return { ...agentEnv(parent, options), PATH: resolvePath(parent) }
}

/**
 * The plan with the shim dirs on its PATH. The launcher layers `plan.env` over the base env,
 * so a PATH the plan sets wins over the base's: the shims go onto whichever PATH will win.
 * GIT_ALLOW_PROTOCOL is pinned the same way, so a profile's env cannot re-enable `ext` (CC-1095).
 */
export function withShims(plan: LaunchPlan, base: Record<string, string> = agentBaseEnv()): LaunchPlan {
  const env = {
    ...(plan.env.PATH === undefined && base.PATH !== undefined ? { PATH: base.PATH } : {}),
    ...plan.env,
  }
  const { PATH } = withGitShim(withGhShim(env))
  const GIT_ALLOW_PROTOCOL = pinGitProtocols(plan.env.GIT_ALLOW_PROTOCOL ?? base.GIT_ALLOW_PROTOCOL)
  return { ...plan, env: { ...plan.env, ...(PATH === undefined ? {} : { PATH }), GIT_ALLOW_PROTOCOL } }
}

/** Where the launch's private TMPDIR goes, beyond its name and pid. Injected by tests. */
export type LaunchTmp = Omit<AgentTmpRequest, 'name' | 'pid'>

/**
 * CC-1184: a Linux reviewer's TMPDIR goes on disk, because its review checkouts under
 * `$TMPDIR/<name>` each carry an install, and three at once fill /tmp's inodes. Implementers
 * and macOS keep /tmp.
 */
export function launchTmpRoot(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
  homeDir: string = os.homedir(),
): string {
  const name = env.AGENT_CHAT_NAME
  const reviewer = name !== undefined && isReviewerSpawn(env.AGENT_CHAT_PROFILE ?? '', name)
  return platform === 'linux' && reviewer ? diskTmpRoot(homeDir) : TMP_ROOT
}

/** `agentEnv()`, never `process.env`: the launched agent must not inherit the broker's credentials. */
export function launchOptions(agentId: string, name?: string, tmp: LaunchTmp = {}): RunAgentOptions {
  const options = name === undefined ? {} : { agentTmp: { ...tmp, name, pid: process.pid } }
  return {
    agentDir: agentDir(agentId),
    baseEnv: agentBaseEnv(process.env, undefined, options),
    resolveBin,
    launcherPidEnv: LAUNCHER_PID_ENV,
    paneSources: diskPaneSources,
    label: 'agent-chat run-agent',
  }
}

/** The account dir the launched claude will use: the plan's, else the home one if the plan unsets it. */
export function planConfigDir(plan: LaunchPlan, base: NodeJS.ProcessEnv = process.env): string | undefined {
  if (plan.env.CLAUDE_CONFIG_DIR !== undefined) return plan.env.CLAUDE_CONFIG_DIR
  if (plan.unsetEnv?.includes('CLAUDE_CONFIG_DIR')) return path.join(os.homedir(), '.claude')
  return base.CLAUDE_CONFIG_DIR
}

/** `agent-chat run-agent <id>`: the verb every stored relaunch script calls. */
export function runAgentVerb(agentId: string): void {
  const stored = readLaunchPlan(agentId)
  const dir = planConfigDir(stored)
  const continued = continueStarted(stored, id => findTranscript(stored.cwd, id, dir).exists)
  if (continued !== stored) refuseIfHeld(agentId, continued, dir)
  const shimmed = withShims(continued)
  const name = shimmed.env.AGENT_CHAT_NAME
  const root = launchTmpRoot(shimmed.env)
  const options = launchOptions(agentId, name, { root })
  const plan = withScratchAddDir(shimmed, reviewerScratchDir({ ...options.baseEnv, ...shimmed.env }))
  watchLauncherSignals(agentDir(agentId), plan.title || agentId)
  process.on('exit', launchExitHook(agentId, name, root))
  runAgent(plan, options)
}

export interface LaunchExitSteps {
  reap: typeof reapOwnLaunch
  removeTmp: typeof removeOwnTmpDir
}

const realExitSteps: LaunchExitSteps = { reap: reapOwnLaunch, removeTmp: removeOwnTmpDir }

/** Reaps the launch's orphans, then removes its TMPDIR from the same root it was made under. */
export function launchExitHook(
  agentId: string,
  name: string | undefined,
  root: string,
  steps: LaunchExitSteps = realExitSteps,
): () => void {
  return () => {
    steps.reap(agentId, process.pid, realExitDeps(logEvent, resolveOrphanReapKill()))
    if (name !== undefined) steps.removeTmp(name, agentId, process.pid, realExitTmpDeps(logEvent), root)
  }
}

function refuseIfHeld(agentId: string, plan: LaunchPlan, dir: string | undefined): void {
  const sessionId = plan.args[plan.args.indexOf('--resume') + 1] ?? ''
  const holder = holderOf(agentId, sessionId, [process.pid, process.ppid], undefined, dir)
  if (holder !== undefined) {
    process.stderr.write(`agent-chat run-agent: already running as pid ${holder}; not launched twice\n`)
    process.exit(75)
  }
  process.stderr.write(`agent-chat run-agent: transcript for session ${sessionId} exists; resuming it\n`)
}
