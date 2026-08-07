import { PassThrough, Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { exitWhenStdinEnds } from '../server/stdio-lifetime.js'

/**
 * The regression these cover is CC-75: an MCP server whose client had gone
 * stayed up indefinitely, because `StdioServerTransport` never raises `onclose`
 * for EOF on stdin. Two were found six days old, each having stranded a
 * detached broker in turn.
 *
 * They exercise the stream contract rather than the server, deliberately — the
 * real teardown ends in `process.exit(0)`, which under vitest would take the
 * runner with it.
 */
describe('exitWhenStdinEnds', () => {
  it('ends the server when the peer sends EOF', () => {
    const stdin = new PassThrough()
    const onEnd = vi.fn()

    exitWhenStdinEnds({ stdin, onEnd })
    stdin.end()

    return new Promise<void>(resolve =>
      setImmediate(() => {
        expect(onEnd).toHaveBeenCalledTimes(1)
        resolve()
      }),
    )
  })

  it('ends it for a stream that is already at EOF, the /dev/null case', () => {
    // One of the two leaked servers had stdin on /dev/null, which is readable
    // and immediately exhausted. Arming after EOF is already available must
    // still fire, or the fix misses the case that produced it.
    const stdin = Readable.from([])
    const onEnd = vi.fn()

    exitWhenStdinEnds({ stdin, onEnd })

    return new Promise<void>(resolve =>
      setImmediate(() => {
        expect(onEnd).toHaveBeenCalledTimes(1)
        resolve()
      }),
    )
  })

  it('runs the teardown once when both end and close arrive for one EOF', () => {
    // The normal case for a pipe: both events fire. Tearing the broker down
    // twice would turn one orderly exit into a double close.
    const stdin = new PassThrough()
    const onEnd = vi.fn()

    exitWhenStdinEnds({ stdin, onEnd })
    stdin.emit('end')
    stdin.emit('close')

    expect(onEnd).toHaveBeenCalledTimes(1)
  })

  it('fires on close alone, for a descriptor that vanishes without EOF', () => {
    // The other leaked server had stdin on a unix socketpair whose peer was
    // already gone — a descriptor that dies rather than a stream that ends.
    const stdin = new PassThrough()
    const onEnd = vi.fn()

    exitWhenStdinEnds({ stdin, onEnd })
    stdin.emit('close')

    expect(onEnd).toHaveBeenCalledTimes(1)
  })

  it('resumes a paused stream, since a paused one never reaches end', () => {
    const stdin = new PassThrough()
    stdin.pause()

    exitWhenStdinEnds({ stdin, onEnd: () => undefined })

    expect(stdin.isPaused()).toBe(false)
  })

  it('stops watching once cancelled, so a reused stream is not double-served', () => {
    const stdin = new PassThrough()
    const onEnd = vi.fn()

    exitWhenStdinEnds({ stdin, onEnd })()
    stdin.emit('end')
    stdin.emit('close')

    expect(onEnd).not.toHaveBeenCalled()
  })
})
