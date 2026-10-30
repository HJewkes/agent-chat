import { spawnSync } from 'node:child_process'

/** A zombie still answers kill 0 until its new parent reaps it, so ps decides. */
export function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  // ps exits 1 when the pid went between the two calls, and prints nothing.
  const stat = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim()
  return stat !== '' && !stat.startsWith('Z')
}

export async function waitUntilGone(pid: number, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (!isRunning(pid)) return true
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return !isRunning(pid)
}

/** Negative for a process group. */
export function killQuietly(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // Already gone.
  }
}
