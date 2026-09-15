import fs from 'node:fs'
import path from 'node:path'

/**
 * Reap the broker an integration test caused to be spawned.
 *
 * `BrokerClient.spawnBroker` starts the broker `detached` and `unref`s it, which
 * is correct in production — the broker is meant to outlive whichever session
 * happened to start it. In a test it means every run leaks one process that then
 * lives forever pointing at a temp directory that no longer exists. Closing the
 * MCP transport does not help: the transport is the session, not the broker.
 *
 * So the test has to terminate it explicitly, and `broker.pid` is how it finds
 * it. Call this BEFORE removing the home directory — the pid file lives inside it.
 */
export async function reapBroker(home: string): Promise<void> {
  const pid = await waitForPid(path.join(home, 'broker.pid'))
  if (pid === null) return

  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return // already gone
  }

  // The shutdown handler unlinks the socket and removes the state files, so give
  // it a moment rather than racing the directory removal against it.
  for (let i = 0; i < 30; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 50))
    if (!isAlive(pid)) return
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // it exited between the check and the signal
  }
}

/**
 * The pid file is written AFTER the socket is bound, and callers wait on the
 * socket — so "no pid file" routinely means "not written yet" rather than "no
 * broker". Returning null on the first look let the caller skip the kill
 * entirely and then race `rmSync` against a broker still writing its state
 * files, which surfaced as an intermittent ENOTEMPTY teardown.
 *
 * Bounded, because a genuinely absent pid file must still resolve quickly.
 */
async function waitForPid(file: string, attempts = 20, delayMs = 50): Promise<number | null> {
  for (let i = 0; i < attempts; i += 1) {
    const pid = readPid(file)
    if (pid !== null) return pid
    await new Promise(resolve => setTimeout(resolve, delayMs))
  }
  return null
}

function readPid(file: string): number | null {
  try {
    const parsed = Number.parseInt(fs.readFileSync(file, 'utf8').trim(), 10)
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null
  } catch {
    return null
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Stand in for the thing a real spawn always does next: the agent's own MCP
 * server registers, and the broker appends `agent_attached`.
 *
 * Needed by every test that spawns, because `Supervisor.spawn` now waits for
 * that row before it reports success (CC-95). Without it a test is asserting
 * against a launch that, in production, would be a failure — an agent that never
 * came up — which is exactly the state this task exists to stop reporting as ok.
 *
 * Appended on a microtask rather than inline: `onAppend` fires DURING the append
 * that triggered it, and re-entering the log from inside it is a different test
 * than the one anyone here is writing.
 */
export function autoAttach(core: {
  onAppend: (watch: (row: { kind: string; msgId?: string; target?: string }) => void) => () => void
  append: (input: { kind: 'agent_attached'; actor: string; ref: string }) => unknown
}): () => void {
  return core.onAppend(row => {
    if (row.kind !== 'agent_spawned' || row.msgId === undefined) return
    const ref = row.msgId
    const actor = row.target ?? ''
    queueMicrotask(() => core.append({ kind: 'agent_attached', actor, ref }))
  })
}
