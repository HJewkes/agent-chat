import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IDLE_EXIT_MS, isEphemeralHome, watchIdle } from '../broker/ephemeral.js'

/**
 * CC-76: a broker started for a throwaway home outlived it indefinitely.
 * `watchSocket` only reaps one whose socket was unlinked, so a temp directory
 * that was leaked rather than cleaned up left the broker running — two were
 * found six days old, and running the CC-75 verification stranded two more
 * inside a minute.
 */

const made: string[] = []
afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const tempHome = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-ephemeral-'))
  made.push(dir)
  return dir
}

describe('isEphemeralHome', () => {
  it('recognises a per-run directory under the system temp root', () => {
    expect(isEphemeralHome(tempHome())).toBe(true)
  })

  it('leaves the real bus alone, which is the whole point of gating on location', () => {
    // The shared broker sits at zero connections for days by design. If this
    // ever returns true for it, the reaper kills the machine's messaging bus.
    expect(isEphemeralHome(path.join(os.homedir(), '.agent-chat'))).toBe(false)
  })

  it('resolves symlinked temp roots, so /var and /private/var compare equal', () => {
    // macOS reports os.tmpdir() as /var/folders/... while the real path is
    // /private/var/folders/... A prefix test on the raw strings misses this and
    // silently exempts every temp home on the platform this was found on.
    const dir = tempHome()
    const real = fs.realpathSync(dir)

    expect(isEphemeralHome(real)).toBe(true)
    expect(isEphemeralHome(dir)).toBe(true)
  })

  it('does not treat the temp root itself as a per-run directory', () => {
    // AGENT_CHAT_HOME=/tmp is odd, but it is a stable place a human chose
    // rather than a directory some test minted and forgot.
    expect(isEphemeralHome(os.tmpdir())).toBe(false)
  })

  it('is not fooled by a sibling whose name merely starts with the temp root', () => {
    expect(isEphemeralHome(`${os.tmpdir()}-not-temp`)).toBe(false)
  })

  it('answers for a directory that does not exist yet', () => {
    // The home is created during startup; this must not throw on the way there.
    expect(isEphemeralHome(path.join(os.tmpdir(), 'agent-chat-never-created'))).toBe(true)
  })
})

describe('watchIdle', () => {
  // An explicit window and tick, rather than the shipped defaults: the assertions
  // are about the RULE, and pinning them to two-minute constants would make them
  // re-derive tick alignment every time a default moved.
  const IDLE = 100
  const TICK = 10

  const run = (connections: () => number) => {
    vi.useFakeTimers()
    const onIdle = vi.fn()
    const stop = watchIdle({ connections, onIdle, idleMs: IDLE, checkMs: TICK })
    return { onIdle, stop }
  }

  afterEach(() => vi.useRealTimers())

  it('ends a broker that has had nothing connected for the full window', () => {
    const { onIdle } = run(() => 0)

    vi.advanceTimersByTime(IDLE + TICK)

    expect(onIdle).toHaveBeenCalledTimes(1)
    expect(onIdle.mock.calls[0]?.[0]).toBeGreaterThanOrEqual(IDLE)
  })

  it('never fires while a client is attached, however long it stays', () => {
    const { onIdle } = run(() => 1)

    vi.advanceTimersByTime(IDLE * 10)

    expect(onIdle).not.toHaveBeenCalled()
  })

  it('does not fire before the window is up', () => {
    const { onIdle } = run(() => 0)

    vi.advanceTimersByTime(IDLE - TICK)

    expect(onIdle).not.toHaveBeenCalled()
  })

  it('restarts the clock when a client comes back', () => {
    // The deadline is "nothing seen for this long", not "N empty polls" — a
    // broker serving a client periodically must never be reaped.
    let open = 0
    const { onIdle } = run(() => open)

    vi.advanceTimersByTime(IDLE - TICK)
    open = 1
    vi.advanceTimersByTime(TICK * 2)
    open = 0
    vi.advanceTimersByTime(IDLE - TICK * 2)

    expect(onIdle).not.toHaveBeenCalled()

    vi.advanceTimersByTime(TICK * 3)
    expect(onIdle).toHaveBeenCalledTimes(1)
  })

  it('fires once and stops checking, so shutdown is not re-entered', () => {
    const { onIdle } = run(() => 0)

    vi.advanceTimersByTime(IDLE * 5)

    expect(onIdle).toHaveBeenCalledTimes(1)
  })

  it('stops watching once cancelled', () => {
    const { onIdle, stop } = run(() => 0)

    stop()
    vi.advanceTimersByTime(IDLE * 3)

    expect(onIdle).not.toHaveBeenCalled()
  })

  it('uses a two-minute window by default, long enough not to race a first client', () => {
    // A broker is auto-started BEFORE the client that wanted it connects, so a
    // short default would reap it on the way to serving its very first request.
    expect(IDLE_EXIT_MS).toBeGreaterThanOrEqual(60_000)
  })
})
