import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrokerCore } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { ClaimLedger } from '../broker/claims.js'
import { claimWake, parseClaimWake, type ClaimWakeConfig, type ExecFileFn } from '../broker/claim-wake.js'
import { resolveClaimWake } from '../config.js'

/**
 * TP-4867: when a claim ends, the broker wakes the burndown unit through the configured argv,
 * once per settle window, without a shell and without waiting on the child.
 */

const ARGV: [string, ...string[]] = ['systemctl', '--user', 'start', '--no-block', 'burndown.service']
const CONFIG: ClaimWakeConfig = { argv: ARGV, timeoutMs: 10_000, settleMs: 20_000 }

type Callback = Parameters<ExecFileFn>[3]

function world(resolve: () => ClaimWakeConfig | undefined = () => CONFIG) {
  const calls: Array<{ file: string; args: readonly string[]; timeout: number; done: Callback }> = []
  const execFile = vi.fn<ExecFileFn>((file, args, options, done) => {
    calls.push({ file, args, timeout: options.timeout, done })
  })
  const log = vi.fn<(event: string, detail: Record<string, unknown>) => void>()
  const ledger = new ClaimLedger(Date.now, () => wake.event())
  const wake = claimWake({ resolve, execFile, log })
  const claimAndRelease = (owner: string) => {
    ledger.claim({ owner, worktreePath: `/wt/${owner}` })
    ledger.releaseAll(owner)
  }
  return { calls, execFile, log, ledger, claimAndRelease }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('claim wake', () => {
  it('fires once for two claim ends inside one settle window', () => {
    const { calls, claimAndRelease } = world()

    claimAndRelease('a')
    vi.advanceTimersByTime(5_000)
    claimAndRelease('b')
    vi.advanceTimersByTime(15_000)

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ file: 'systemctl', args: ARGV.slice(1), timeout: 10_000 })
  })

  it('does not fire before the window closes', () => {
    const { calls, claimAndRelease } = world()

    claimAndRelease('a')
    vi.advanceTimersByTime(19_999)

    expect(calls).toHaveLength(0)
  })

  it('fires twice for claim ends in separate windows', () => {
    const { calls, claimAndRelease } = world()

    claimAndRelease('a')
    vi.advanceTimersByTime(20_000)
    claimAndRelease('b')
    vi.advanceTimersByTime(20_000)

    expect(calls).toHaveLength(2)
  })

  it('fires nothing while the config is unset', () => {
    const { execFile, claimAndRelease } = world(() => undefined)

    claimAndRelease('a')
    vi.advanceTimersByTime(60_000)

    expect(execFile).not.toHaveBeenCalled()
  })

  it('treats a re-claim that replaces its own claim as no end', () => {
    const { execFile, ledger } = world()

    ledger.claim({ owner: 'a', worktreePath: '/wt', patterns: ['src/**'] })
    ledger.claim({ owner: 'a', worktreePath: '/wt', patterns: ['docs/**'] })
    ledger.releaseAll('nobody')
    vi.advanceTimersByTime(60_000)

    expect(execFile).not.toHaveBeenCalled()
  })

  it('fires on a release of one worktree', () => {
    const { calls, ledger } = world()

    ledger.claim({ owner: 'a', worktreePath: '/wt' })
    ledger.releaseIn('a', '/wt')
    vi.advanceTimersByTime(20_000)

    expect(calls).toHaveLength(1)
  })

  it('logs a failing command and still wakes in the next window', () => {
    const { calls, log, claimAndRelease } = world()

    claimAndRelease('a')
    vi.advanceTimersByTime(20_000)
    calls[0]!.done(Object.assign(new Error('Unit not found'), { code: 5 }))
    claimAndRelease('b')
    vi.advanceTimersByTime(20_000)
    calls[1]!.done(null)

    expect(log).toHaveBeenNthCalledWith(
      1,
      'claim_wake_failed',
      expect.objectContaining({ error: 'Unit not found', code: 5, timedOut: false }),
    )
    expect(log).toHaveBeenNthCalledWith(2, 'claim_wake_ran', { argv: ARGV })
  })

  it('logs a command that throws on launch instead of crashing', () => {
    const log = vi.fn()
    const execFile = vi.fn<ExecFileFn>(() => {
      throw new Error('spawn EACCES')
    })
    const wake = claimWake({ resolve: () => CONFIG, execFile, log })

    wake.event()
    expect(() => vi.advanceTimersByTime(20_000)).not.toThrow()

    expect(log).toHaveBeenCalledWith(
      'claim_wake_failed',
      expect.objectContaining({ error: 'Error: spawn EACCES' }),
    )
  })
})

describe('broker claim wake', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-wake-core-'))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('wakes once when two holders release their claims in one window', () => {
    const execFile = vi.fn<ExecFileFn>()
    const wake = claimWake({ resolve: () => CONFIG, execFile, log: vi.fn() })
    const core = new BrokerCore(() => undefined, {
      events: new EventLog(path.join(dir, 'events.db')),
      claimWake: wake,
    })
    core.claims.claim({ owner: 'a', worktreePath: '/wt/a' })
    core.claims.claim({ owner: 'b', worktreePath: '/wt/b' })

    core.claims.releaseAll('a')
    core.claims.releaseIn('b', '/wt/b')
    vi.advanceTimersByTime(20_000)

    expect(execFile).toHaveBeenCalledOnce()
  })
})

describe('claimWake config', () => {
  it('fills the default timeout and settle window', () => {
    expect(parseClaimWake({ argv: ['wake'] })).toEqual({
      argv: ['wake'],
      timeoutMs: 10_000,
      settleMs: 20_000,
    })
  })

  it.each([
    ['a shell string argv', { argv: 'wake now' }, /argv/],
    ['an empty argv', { argv: [] }, /argv/],
    ['a settle window over 30 s', { argv: ['wake'], settleMs: 30_001 }, /settleMs/],
    ['a relative cwd', { argv: ['wake'], cwd: 'here' }, /cwd/],
    ['a shell flag', { argv: ['wake'], shell: true }, /shell/],
  ])('refuses %s', (_label, value, reason) => {
    expect(parseClaimWake(value)).toMatch(reason)
  })

  describe('from config.json', () => {
    let dir: string
    const previousHome = process.env.AGENT_CHAT_HOME

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-wake-'))
      process.env.AGENT_CHAT_HOME = dir
    })

    afterEach(() => {
      if (previousHome === undefined) delete process.env.AGENT_CHAT_HOME
      else process.env.AGENT_CHAT_HOME = previousHome
      fs.rmSync(dir, { recursive: true, force: true })
    })

    const writeConfig = (config: unknown) =>
      fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config))

    it('is off when the key is unset', () => {
      writeConfig({})
      expect(resolveClaimWake()).toBeUndefined()
    })

    it('is off when the key is invalid', () => {
      writeConfig({ claimWake: { argv: 'systemctl start x' } })
      expect(resolveClaimWake()).toBeUndefined()
    })

    it('reads a set key', () => {
      writeConfig({ claimWake: { argv: ARGV, settleMs: 5_000 } })
      expect(resolveClaimWake()).toEqual({ argv: ARGV, timeoutMs: 10_000, settleMs: 5_000 })
    })
  })
})
