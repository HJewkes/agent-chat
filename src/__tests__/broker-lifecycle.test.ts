import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { watchSocket } from '../broker/lifecycle.js'

/**
 * The leak reaper, and why it exists.
 *
 * `BrokerClient` auto-starts a broker `detached` and `unref`ed, so it outlives
 * whichever session needed it first — correct in production, and the reason any
 * test pointing `AGENT_CHAT_HOME` at a temp directory causes one. Removing that
 * directory does not end the process: seven such brokers were found running
 * against directories that no longer existed, the oldest a day old.
 *
 * Real timers with a tiny interval, deliberately: the thing under test is a
 * poll, and faking the clock would only prove the callback can be called.
 */

const tmpDirs: string[] = []
const cancels: Array<() => void> = []

const OWN_PID = 4242

function socketFile(): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-watch-'))
  tmpDirs.push(dir)
  const file = path.join(dir, 'chat.sock')
  fs.writeFileSync(file, '')
  return { dir, file }
}

/** Resolves with the reason, or rejects if the watchdog stays quiet. */
function lostReason(file: string, owner: () => number | null): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('watchdog never fired')), 2000)
    cancels.push(
      watchSocket({
        path: file,
        owner,
        ownPid: OWN_PID,
        intervalMs: 10,
        onLost: reason => {
          clearTimeout(timer)
          resolve(reason)
        },
      }),
    )
  })
}

afterEach(() => {
  for (const cancel of cancels.splice(0)) cancel()
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('a broker watching its own socket', () => {
  it('reports itself unreachable once the socket is unlinked', async () => {
    const { file } = socketFile()
    const lost = lostReason(file, () => OWN_PID)

    fs.rmSync(file)

    await expect(lost).resolves.toMatch(/is gone/)
  })

  /** The whole leak, in one line: the home a test made goes away, the broker does not. */
  it('reports it when the entire home directory is removed', async () => {
    const { dir, file } = socketFile()
    const lost = lostReason(file, () => OWN_PID)

    fs.rmSync(dir, { recursive: true, force: true })

    await expect(lost).resolves.toMatch(/is gone/)
  })

  /**
   * A socket owned by someone else is a REPLACEMENT broker, and the distinction
   * is load-bearing rather than cosmetic: the caller must NOT unlink the path or
   * remove the state files on its way out, or being orphaned turns into an
   * outage for whichever broker replaced it.
   *
   * Ownership is asked of the pid file. The first version of this compared the
   * socket's INODE, and CI is what proved that wrong: on the Linux runner,
   * deleting a socket and creating another at the same path returned the same
   * inode, so the watchdog concluded the file was still its own. The bug was in
   * the implementation, not the test — a reused inode is a false negative on
   * every filesystem that recycles them.
   */
  it('distinguishes a replacement broker from a deletion', async () => {
    const { file } = socketFile()
    const lost = lostReason(file, () => OWN_PID + 1)

    await expect(lost).resolves.toMatch(/belongs to broker/)
  })

  it('stays quiet while the socket is still its own', async () => {
    const { file } = socketFile()
    let fired = false
    cancels.push(
      watchSocket({
        path: file,
        owner: () => OWN_PID,
        ownPid: OWN_PID,
        intervalMs: 10,
        onLost: () => (fired = true),
      }),
    )

    await new Promise(resolve => setTimeout(resolve, 100))

    expect(fired).toBe(false)
  })

  /**
   * A missing or half-written pid file is routine — it is diagnostic, not
   * authoritative — so an unknown owner must not read as "someone else". Exiting
   * on it would make a file the design deliberately does not trust into the
   * thing that decides whether the broker lives.
   */
  it('stays quiet when the owner cannot be determined', async () => {
    const { file } = socketFile()
    let fired = false
    cancels.push(
      watchSocket({
        path: file,
        owner: () => null,
        ownPid: OWN_PID,
        intervalMs: 10,
        onLost: () => (fired = true),
      }),
    )

    await new Promise(resolve => setTimeout(resolve, 100))

    expect(fired).toBe(false)
  })

  it('can be cancelled, so a normal shutdown does not race its own watchdog', async () => {
    const { file } = socketFile()
    let fired = false
    const cancel = watchSocket({
      path: file,
      owner: () => OWN_PID,
      ownPid: OWN_PID,
      intervalMs: 10,
      onLost: () => (fired = true),
    })

    cancel()
    fs.rmSync(file)
    await new Promise(resolve => setTimeout(resolve, 100))

    expect(fired).toBe(false)
  })
})
