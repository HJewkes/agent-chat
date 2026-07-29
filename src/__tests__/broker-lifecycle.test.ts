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

function socketFile(): { dir: string; file: string; ino: number } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-watch-'))
  tmpDirs.push(dir)
  const file = path.join(dir, 'chat.sock')
  fs.writeFileSync(file, '')
  return { dir, file, ino: fs.statSync(file).ino }
}

/** Resolves with the reason, or rejects if the watchdog stays quiet. */
function lostReason(file: string, ino: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('watchdog never fired')), 2000)
    cancels.push(
      watchSocket({
        path: file,
        ino,
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
    const { file, ino } = socketFile()
    const lost = lostReason(file, ino)

    fs.rmSync(file)

    await expect(lost).resolves.toMatch(/is gone/)
  })

  /** The whole leak, in one line: the home a test made goes away, the broker does not. */
  it('reports it when the entire home directory is removed', async () => {
    const { dir, file, ino } = socketFile()
    const lost = lostReason(file, ino)

    fs.rmSync(dir, { recursive: true, force: true })

    await expect(lost).resolves.toMatch(/is gone/)
  })

  /**
   * A different socket at the same path is another broker, and the distinction
   * is load-bearing rather than cosmetic: the caller must NOT unlink the path or
   * remove the state files on its way out, or being orphaned turns into an
   * outage for whichever broker replaced it.
   */
  it('distinguishes a replacement broker from a deletion', async () => {
    const { file, ino } = socketFile()
    const lost = lostReason(file, ino)

    fs.rmSync(file)
    fs.writeFileSync(file, '')

    await expect(lost).resolves.toMatch(/belongs to another broker/)
  })

  it('stays quiet while the socket is still its own', async () => {
    const { file, ino } = socketFile()
    let fired = false
    cancels.push(watchSocket({ path: file, ino, intervalMs: 10, onLost: () => (fired = true) }))

    await new Promise(resolve => setTimeout(resolve, 100))

    expect(fired).toBe(false)
  })

  it('can be cancelled, so a normal shutdown does not race its own watchdog', async () => {
    const { file, ino } = socketFile()
    let fired = false
    const cancel = watchSocket({ path: file, ino, intervalMs: 10, onLost: () => (fired = true) })

    cancel()
    fs.rmSync(file)
    await new Promise(resolve => setTimeout(resolve, 100))

    expect(fired).toBe(false)
  })
})
