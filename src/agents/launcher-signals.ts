/**
 * Evidence for why an agent's launcher and its claude ended (CC-438).
 *
 * Several seats exited at once with nothing recorded about who signalled them. `run-agent`
 * now logs each SIGTERM, SIGINT and SIGHUP it receives, forwards it to claude, and logs
 * claude's exit code and signal. Before this, a SIGTERM to the launcher killed it outright
 * and left claude running with no parent.
 *
 * The lines go to a file in the agent's directory, not stderr: a headless launcher's stderr
 * is /dev/null, and a pane's is claude's own TUI.
 *
 * Product-side adapter: `@titan-design/agent-surface` 0.1.0 spawns claude without exposing
 * the child, so `captureNextSpawn` takes the handle from `child_process.spawn` itself. Delete
 * this file once the package forwards and logs signals itself (TP task filed from CC-438).
 */
import childProcess, { spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'

export const FORWARDED_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const

export const launcherLogPath = (agentDir: string): string => path.join(agentDir, 'launcher.log')

export type LauncherLog = (event: string) => void

/** One line per event: ISO time, the agent's name, then the event. */
export function launcherLog(agentDir: string, name: string): LauncherLog {
  return event => {
    try {
      fs.appendFileSync(launcherLogPath(agentDir), `${new Date().toISOString()} ${name} ${event}\n`)
    } catch {
      // Evidence is best effort: a full disk must not change how the agent ends.
    }
  }
}

function processGroup(): string {
  const ps = spawnSync('/bin/ps', ['-o', 'pgid=', '-p', String(process.pid)], {
    encoding: 'utf8',
    timeout: 1000,
  })
  return ps.stdout?.trim() || 'unknown'
}

/** Node does not expose siginfo's si_pid, so the parent and process group stand in for the sender. */
export const senderClues = (): string => `sender_pid=unavailable ppid=${process.ppid} pgid=${processGroup()}`

const isRunning = (child: ChildProcess): boolean => child.exitCode === null && child.signalCode === null

/**
 * Log each forwarded signal, then pass it to claude. With no claude yet, the launcher exits
 * as the signal's default action would have.
 */
export function forwardSignals(child: () => ChildProcess | undefined, log: LauncherLog): void {
  for (const signal of FORWARDED_SIGNALS) {
    process.on(signal, () => {
      log(`received ${signal} ${senderClues()}`)
      const target = child()
      if (target === undefined) process.exit(128 + os.constants.signals[signal])
      if (isRunning(target)) target.kill(signal)
    })
  }
}

export function logChildExit(child: ChildProcess, log: LauncherLog): void {
  child.once('exit', (code, signal) => {
    log(`child pid=${child.pid} exited code=${code ?? 'none'} signal=${signal ?? 'none'}`)
  })
}

/** Hands `onChild` the next process `child_process.spawn` starts, including one spawned by a package. */
export function captureNextSpawn(onChild: (child: ChildProcess) => void): void {
  const original = childProcess.spawn
  const restore = (): void => {
    childProcess.spawn = original
    syncBuiltinESMExports()
  }
  childProcess.spawn = ((...args: Parameters<typeof original>) => {
    restore()
    const child = original(...args)
    onChild(child)
    return child
  }) as typeof original
  syncBuiltinESMExports()
}

/** Install everything before the package spawns, so its exit handler runs after ours has logged. */
export function watchLauncherSignals(agentDir: string, name: string): void {
  const log = launcherLog(agentDir, name)
  let launched: ChildProcess | undefined
  forwardSignals(() => launched, log)
  captureNextSpawn(child => {
    launched = child
    logChildExit(child, log)
  })
}
