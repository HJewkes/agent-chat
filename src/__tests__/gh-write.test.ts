import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawnSync } from 'node:child_process'
import { setTimeout as realSleep } from 'node:timers/promises'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { backoffDelay, classifyFailure, parseRetryAfter } from '../gh-write/policy.js'
import { ghWrite, type GhResult, type ThrottleDeps } from '../gh-write/throttle.js'

const execFileAsync = promisify(execFile)
const CLI = path.resolve(import.meta.dirname, '../../dist/cli.js')

const SECONDARY = 'gh: You have exceeded a secondary rate limit. Please wait a few minutes. (HTTP 403)\n'
const AMBIGUOUS = 'gh: API rate limit exceeded for user ID 1. (HTTP 403)\n'
const ok = (stdout = '{"merged":true}\n'): GhResult => ({
  code: 0,
  stdout: Buffer.from(stdout),
  stderr: Buffer.alloc(0),
})
const fail = (stderr: string, code = 1): GhResult => ({
  code,
  stdout: Buffer.alloc(0),
  stderr: Buffer.from(stderr),
})

/** The pid of a process that has already exited. */
const deadPid = (): number => spawnSync(process.execPath, ['-e', '']).pid

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

  it('caps Retry-After at 300 seconds', () => {
    expect(backoffDelay(0, 3600)).toBe(300_000)
  })
})

describe('ghWrite', () => {
  let dir: string
  let lockDir: string
  let stampPath: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-ghw-'))
    lockDir = path.join(dir, 'gh-write.lock')
    stampPath = path.join(dir, 'gh-write.stamp.json')
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  const writeToken = (token: object) => {
    fs.mkdirSync(lockDir)
    fs.writeFileSync(path.join(lockDir, 'owner'), JSON.stringify(token))
  }

  /** A virtual clock: every sleep advances it instantly. Refuses to spin forever on a lock it never gets. */
  function fakeDeps(replies: GhResult[], overrides: Partial<ThrottleDeps> = {}) {
    let clock = 1_000_000
    const sleeps: number[] = []
    const calls: string[][] = []
    const notices: string[] = []
    const deps: ThrottleDeps = {
      now: () => clock,
      sleep: async ms => {
        sleeps.push(ms)
        if (sleeps.length > 50) throw new Error('still waiting for the lock after 50 sleeps')
        clock += ms
      },
      runGh: async args => {
        calls.push(args)
        return replies.shift() ?? ok()
      },
      coreRemaining: async () => 4999,
      notice: line => notices.push(line),
      lockDir,
      stampPath,
      gapMs: 3000,
      ...overrides,
    }
    return { deps, sleeps, calls, notices, clock: () => clock }
  }

  it('retries a secondary-limit failure after 60 s and returns the success', async () => {
    const { deps, sleeps, calls, notices } = fakeDeps([fail(SECONDARY), ok()])

    const result = await ghWrite(['api', '-X', 'PUT', 'repos/o/r/pulls/1/merge'], deps)

    expect(result).toEqual(ok())
    expect(calls).toHaveLength(2)
    expect(sleeps).toEqual([60_000])
    expect(notices).toHaveLength(1)
  })

  it('waits the Retry-After gh printed before retrying, capped at 300 s', async () => {
    const withHeader = (seconds: number) =>
      fail(`HTTP/2.0 403 Forbidden\nRetry-After: ${seconds}\n\n${SECONDARY}`)
    const { deps, sleeps } = fakeDeps([withHeader(7), withHeader(900), ok()])

    const result = await ghWrite(['pr', 'create'], deps)

    expect(result.code).toBe(0)
    expect(sleeps).toEqual([7_000, 300_000])
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

  it('takes over a lock whose owner process is dead', async () => {
    const { deps, clock, calls } = fakeDeps([])
    writeToken({ pid: deadPid(), nonce: 'gone', at: clock() })

    const result = await ghWrite(['a'], deps)

    expect(result.code).toBe(0)
    expect(calls).toHaveLength(1)
    expect(fs.existsSync(lockDir)).toBe(false)
    expect(fs.readdirSync(dir).filter(name => name.includes('.stale.'))).toEqual([])
  })

  it('takes over a lock held longer than ten minutes by a live process', async () => {
    const { deps, clock, calls } = fakeDeps([])
    writeToken({ pid: process.pid, nonce: 'hung', at: clock() - 11 * 60_000 })

    await ghWrite(['a'], deps)

    expect(calls).toHaveLength(1)
  })

  it('leaves alone a lock that was taken over while it ran', async () => {
    const foreign = JSON.stringify({ pid: process.pid, nonce: 'someone-else', at: 0 })
    const { deps } = fakeDeps([], {
      runGh: async () => {
        fs.writeFileSync(path.join(lockDir, 'owner'), foreign)
        return ok()
      },
    })

    await ghWrite(['a'], deps)

    expect(fs.readFileSync(path.join(lockDir, 'owner'), 'utf8')).toBe(foreign)
  })

  it('releases the lock during a backoff so another writer can acquire it', async () => {
    let lockHeldDuringBackoff: boolean | undefined
    let endBackoff: () => void = () => {}
    let backoffStarted: () => void = () => {}
    const inBackoff = new Promise<void>(resolve => (backoffStarted = resolve))
    let clock = 1_000_000
    const sleeper = ghWrite(['a'], {
      ...fakeDeps([fail(SECONDARY), ok()]).deps,
      now: () => clock,
      sleep: async ms => {
        clock += ms
        if (lockHeldDuringBackoff !== undefined) return
        lockHeldDuringBackoff = fs.existsSync(lockDir)
        backoffStarted()
        await new Promise<void>(resolve => (endBackoff = resolve))
      },
    })
    await inBackoff

    const other = fakeDeps([])
    const result = await ghWrite(['b'], { ...other.deps, now: () => clock + 1 })

    expect(lockHeldDuringBackoff).toBe(false)
    expect(result.code).toBe(0)
    expect(other.calls).toEqual([['b']])
    endBackoff()
    await expect(sleeper).resolves.toMatchObject({ code: 0 })
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
      lockDir,
      stampPath,
      gapMs,
    }

    await Promise.all([ghWrite(['a'], deps), ghWrite(['b'], deps)])

    expect(starts).toHaveLength(2)
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(gapMs)
  })

  it('eight writers racing for a dead owner lock all succeed one at a time, 15 runs', async () => {
    for (let run = 0; run < 15; run++) {
      fs.rmSync(stampPath, { force: true })
      writeToken({ pid: deadPid(), nonce: `dead-${run}`, at: Date.now() })
      let active = 0
      let maxActive = 0
      const deps: ThrottleDeps = {
        now: Date.now,
        sleep: ms => realSleep(ms),
        runGh: async () => {
          maxActive = Math.max(maxActive, ++active)
          await realSleep(2)
          active--
          return ok()
        },
        coreRemaining: async () => 4999,
        notice: () => {},
        lockDir,
        stampPath,
        gapMs: 0,
      }

      const results = await Promise.all(Array.from({ length: 8 }, (_, i) => ghWrite([`w${i}`], deps)))

      expect(results.map(r => r.code)).toEqual(Array(8).fill(0))
      expect(maxActive).toBe(1)
      expect(fs.existsSync(lockDir)).toBe(false)
    }
  }, 60_000)
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

  it('shows how to post a body from a quoted heredoc in its help', async () => {
    const { stdout } = await execFileAsync(process.execPath, [CLI, 'gh-write', '--help'])

    expect(stdout).toContain(
      "agent-chat gh-write -- pr create -R <owner>/<repo> -t <title> --body-file - <<'EOF'",
    )
  })

  it("exits with gh's exit code on a plain failure", async () => {
    await expect(run(['pr', 'create'], { FAKE_GH_CODE: '3' })).rejects.toMatchObject({ code: 3 })
  })

  it('spaces two concurrent processes by the configured gap', async () => {
    await Promise.all([run(['pr', 'view', '1']), run(['pr', 'view', '2'])])

    const starts = fs.readFileSync(path.join(dir, 'starts'), 'utf8').trim().split('\n').map(Number)
    expect(starts).toHaveLength(2)
    expect(Math.abs(starts[1]! - starts[0]!)).toBeGreaterThanOrEqual(1000)
  })
})
