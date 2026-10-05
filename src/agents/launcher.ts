import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  surfaceFor as packageSurfaceFor,
  type Launcher,
  type Surface,
  type SurfaceName,
  type SurfaceOptions,
} from '@titan-design/agent-surface'
import { agentDir, cliEntry, home } from '../paths.js'

/** Set to run-agent's own pid, so the process it launched can tell itself apart from that process's descendants. */
export const LAUNCHER_PID_ENV = 'AGENT_CHAT_LAUNCHER_PID'

/**
 * The one command every surface launches: `agent-chat run-agent <id>`.
 *
 * The home is carried explicitly: a pane opens in a fresh login shell that has the
 * user's profile, which is not the broker's home whenever `AGENT_CHAT_HOME` is relocated.
 * Built per call because a test may move the home between launches.
 */
export const agentChatLauncher = (): Launcher => ({
  argv: agentId => [process.execPath, cliEntry(), 'run-agent', agentId],
  env: { AGENT_CHAT_HOME: home() },
  relaunchPath: agentId => relaunchScriptPath(agentId),
})

/** Where teleport's in-place relaunch lives: in the agent's own 0700 dir, beside its plan. */
export const relaunchScriptPath = (agentId: string): string => `${agentDir(agentId)}/relaunch`

export const surfaceFor = (name: SurfaceName, options: SurfaceOptions = {}): Surface =>
  packageSurfaceFor(name, agentChatLauncher(), options)

/** Answers whether `run-agent <id>` is running anywhere; undefined when the process table could not be read. */
export type LauncherProbe = (agentId: string) => Promise<boolean | undefined>

const execFileAsync = promisify(execFile)

const runsAgent = (line: string, agentId: string): boolean => {
  const words = line.trim().split(/\s+/)
  return words.some((word, i) => word === 'run-agent' && words[i + 1] === agentId)
}

/** CC-402: machine-wide rather than per pane, so it also finds a launcher a retry would open beside. */
export const psLauncherProbe: LauncherProbe = async agentId => {
  try {
    const { stdout } = await execFileAsync('ps', ['-axww', '-o', 'command='], { encoding: 'utf8' })
    return stdout.split('\n').some(line => runsAgent(line, agentId))
  } catch {
    return undefined
  }
}
