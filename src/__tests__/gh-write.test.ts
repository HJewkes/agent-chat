import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { setTimeout as realSleep } from 'node:timers/promises'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { backoffDelay, classifyFailure, parseRetryAfter } from '../gh-write/policy.js'
import { ghWrite, type GhResult, type ThrottleDeps } from '../gh-write/throttle.js'

const execFileAsync = promisify(execFile)
const CLI = path.resolve(import.meta.dirname, '../../dist/cli.js')

const SECONDARY = 'gh: You have exceeded a secondary rate limit. Please wait a few minutes. (HTTP 403)\n'
const AMBIGUOUS = 'gh: API rate limit exceeded for user ID 1. (HTTP 403)\n'
const ok = (stdout = '{"merged":true}\n'): GhResult => ({ code: 0, stdout, stderr: '' })
const fail = (stderr: string, code = 1): GhResult => ({ code, stdout: '', stderr })

describe('classifyFailure', () => {
  it('reads a secondary-limit message as secondary', () => {
    expect(classifyFailure(SECONDARY)).toBe('secondary')
  })

  it('leaves a bare rate-limit message for the core-quota check', () => {
    expect(classifyFailure(AMBIGUOUS)).toBe('ambiguous')
  })

  it('treats any other failure as other', () => {
    expect(classifyFailure('gh: Pull Request is not mergeable (HTTP 405)')).toBe('other')
  })
})

describe('parseRetryAfter', () => {
  it('reads a Retry-After header line', () => {
    expect(parseRetryAfter('HTTP/2.0 403 Forbidden\nRetry-After: 42\n')).toBe(42)
  })

  it('is undefined when gh printed none', () => {
    expect(parseRetryAfter(SECONDARY)).toBeUndefined()
  })
})

describe('backoffDelay', () => {
  it('waits 60, 120, then 300 seconds, then gives up', () => {
    expect([0, 1, 2, 3].map(n => backoffDelay(n, undefined))).toEqual([60_000, 120_000, 300_000, undefined])
  })

  it('prefers the server Retry-After', () => {
    expect(backoffDelay(0, 7)).toBe(7_000)
  })
})

describe('ghWrite', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-ghw-'))
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  /** A virtual clock: every sleep advances it instantly. */
  function fakeDeps(replies: GhResult[], overrides: Partial<ThrottleDeps> = {}) {
    let clock = 1_000_000
    const sleeps: number[] = []
    const calls: string[][] = []
    const notices: string[] = []
    const deps: ThrottleDeps = {
      now: () => clock,
      sleep: async ms => {
        sleeps.push(ms)
        clock += ms
      },
      runGh: async args => {
        calls.push(args)
        return replies.shift() ?? ok()
      },
      coreRemaining: async () => 4999,
      notice: line => notices.push(line),
      lockDir: path.join(dir, 'gh-write.lock'),
      stampPath: path.join(dir, 'gh-write.stamp.json'),
      gapMs: 3000,
      ...overrides,
    }
    return { deps, sleeps, calls, notices }
  }

  it('retries a secondary-limit failure after 60 s and returns the success', async () => {
    const { deps, sleeps, calls, notices } = fakeDeps([fail(SECONDARY), ok()])

    const result = await ghWrite(['api', '-X', 'PUT', 'repos/o/r/pulls/1/merge'], deps)

    expect(result).toEqual(ok())
    expect(calls).toHaveLength(2)
    expect(sleeps).toEqual([60_000])
    expect(notices).toHaveLength(1)
  })

  it('retries a bare rate-limit message while core quota remains', async () => {
    const { deps, calls } = fakeDeps([fail(AMBIGUOUS), ok()])

    const result = await ghWrite(['pr', 'create'], deps)

    expect(result.code).toBe(0)
    expect(calls).toHaveLength(2)
  })

  it('passes a bare rate-limit message through when core quota is spent', async () => {
    const { deps, calls } = fakeDeps([fail(AMBIGUOUS)], { coreRemaining: async () => 0 })

    const result = await ghWrite(['pr', 'create'], deps)

    expect(result).toEqual(fail(AMBIGUOUS))
    expect(calls).toHaveLength(1)
  })

  it('passes another failure through at once with its exit code', async () => {
    const { deps, sleeps } = fakeDeps([fail('gh: Not Found (HTTP 404)\n', 4)])

    const result = await ghWrite(['api', '-X', 'PUT', 'x'], deps)

    expect(result).toEqual(fail('gh: Not Found (HTTP 404)\n', 4))
    expect(sleeps).toEqual([])
  })

  it('gives up after three retries with the last failure', async () => {
    const { deps, sleeps, calls } = fakeDeps([
      fail(SECONDARY),
      fail(SECONDARY),
      fail(SECONDARY),
      fail(SECONDARY),
    ])

    const result = await ghWrite(['pr', 'comment'], deps)

    expect(result).toEqual(fail(SECONDARY))
    expect(calls).toHaveLength(4)
    expect(sleeps).toEqual([60_000, 120_000, 300_000])
  })

  it('spaces a second write from the first by the gap', async () => {
    const { deps, sleeps } = fakeDeps([ok(), ok()])

    await ghWrite(['a'], deps)
    await ghWrite(['b'], deps)

    expect(sleeps).toEqual([3000])
  })

  it('serializes two concurrent writers at least the gap apart', async () => {
    const gapMs = 300
    const starts: number[] = []
    const deps: ThrottleDeps = {
      now: Date.now,
      sleep: ms => realSleep(ms),
      runGh: async () => {
        starts.push(Date.now())
        await realSleep(50)
        return ok()
      },
      coreRemaining: async () => 4999,
      notice: () => {},
      lockDir: path.join(dir, 'gh-write.lock'),
      stampPath: path.join(dir, 'gh-write.stamp.json'),
      gapMs,
    }

    await Promise.all([ghWrite(['a'], deps), ghWrite(['b'], deps)])

    expect(starts).toHaveLength(2)
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(gapMs)
  })
})

describe('agent-chat gh-write', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-ghw-cli-'))
    const bin = path.join(dir, 'bin')
    fs.mkdirSync(bin)
    // A fake gh that logs when it started and echoes its args, exiting with $FAKE_GH_CODE.
    fs.writeFileSync(
      path.join(bin, 'gh'),
      `#!/bin/sh\nnode -e 'console.log(Date.now())' >> "${dir}/starts"\necho "out:$*"\necho "err:$*" >&2\nexit \${FAKE_GH_CODE:-0}\n`,
      { mode: 0o755 },
    )
    const home = path.join(dir, 'home')
    fs.mkdirSync(home)
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ ghWriteGapSeconds: 1 }))
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  const run = (args: string[], extra: Record<string, string> = {}) =>
    execFileAsync(process.execPath, [CLI, 'gh-write', '--', ...args], {
      env: {
        ...process.env,
        PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`,
        AGENT_CHAT_HOME: path.join(dir, 'home'),
        ...extra,
      },
    })

  it('passes stdout and stderr through unchanged', async () => {
    const { stdout, stderr } = await run(['api', '-X', 'PUT', 'repos/o/r/pulls/1/merge'])

    expect(stdout).toBe('out:api -X PUT repos/o/r/pulls/1/merge\n')
    expect(stderr).toBe('err:api -X PUT repos/o/r/pulls/1/merge\n')
  })

  it("exits with gh's exit code on a plain failure", async () => {
    await expect(run(['pr', 'create'], { FAKE_GH_CODE: '3' })).rejects.toMatchObject({ code: 3 })
  })

  it('spaces two concurrent processes by the configured gap', async () => {
    await Promise.all([run(['a']), run(['b'])])

    const starts = fs.readFileSync(path.join(dir, 'starts'), 'utf8').trim().split('\n').map(Number)
    expect(starts).toHaveLength(2)
    expect(Math.abs(starts[1]! - starts[0]!)).toBeGreaterThanOrEqual(1000)
  })
})
