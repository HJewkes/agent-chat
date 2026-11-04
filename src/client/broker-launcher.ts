import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * CC-1695: an auto-started broker forked straight from an MCP client lives in that
 * client's process tree, so retiring the worker that noticed first drops the broker.
 * With the user unit installed, systemd starts it instead: its parent is the user
 * manager, and concurrent starts coalesce into one job rather than racing to listen.
 */
export const BROKER_UNIT = 'agent-chat-broker.service'

export interface LauncherDeps {
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  homedir: string
  exists: (file: string) => boolean
  startUnit: (unit: string) => Promise<void>
  spawnDirect: () => void
  warn: (message: string) => void
}

export type LaunchChoice = { via: 'unit' } | { via: 'spawn'; warning?: string }

export const userUnitPath = (env: NodeJS.ProcessEnv, homedir: string): string =>
  path.join(env.XDG_CONFIG_HOME || path.join(homedir, '.config'), 'systemd', 'user', BROKER_UNIT)

export function chooseLauncher(
  deps: Pick<LauncherDeps, 'env' | 'platform' | 'homedir' | 'exists'>,
): LaunchChoice {
  // The unit serves the default home only; a broker for another home (tests, a second bus) forks as before.
  if (deps.env.AGENT_CHAT_HOME !== undefined || deps.platform !== 'linux') return { via: 'spawn' }
  const unit = userUnitPath(deps.env, deps.homedir)
  if (deps.exists(unit)) return { via: 'unit' }
  return {
    via: 'spawn',
    warning: `agent-chat: ${unit} is not installed; forking the broker from this process (run scripts/install-systemd-units.sh)`,
  }
}

export async function launchBroker(deps: LauncherDeps): Promise<LaunchChoice['via']> {
  const choice = chooseLauncher(deps)
  if (choice.via === 'unit') {
    try {
      await deps.startUnit(BROKER_UNIT)
      return 'unit'
    } catch (err) {
      deps.warn(
        `agent-chat: systemctl --user start ${BROKER_UNIT} failed (${String(err)}); forking the broker instead`,
      )
    }
  } else if (choice.warning) {
    deps.warn(choice.warning)
  }
  deps.spawnDirect()
  return 'spawn'
}

const systemctlStart = (unit: string): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile('systemctl', ['--user', 'start', unit], { timeout: 10_000 }, err =>
      err ? reject(err) : resolve(),
    )
  })

export const defaultLauncherDeps = (spawnDirect: () => void): LauncherDeps => ({
  env: process.env,
  platform: process.platform,
  homedir: os.homedir(),
  exists: file => fs.existsSync(file),
  startUnit: systemctlStart,
  spawnDirect,
  warn: message => console.error(message),
})
