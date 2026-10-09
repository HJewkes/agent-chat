import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startProcessGuard, type GuardDeps } from '../agents/process-guard-monitor.js'
import type { ProcessGuardMode } from '../agents/process-guard.js'
import type { ProcRow } from '../broker/reaper.js'

const UID = 1000
const BROKER = 100
const GIB_KB = 1024 ** 2
const LIMIT = 8 * 1024 ** 3
const TICK = 2_000

function row(pid: number, ppid: number, command: string, rssGib = 0.1): ProcRow {
  return { pid, ppid, uid: UID, startMs: 0, rssKb: Math.round(rssGib * GIB_KB), command }
}

const broker = row(BROKER, 1, '/usr/bin/node /opt/agent-chat/dist/cli.js broker')
const claude = row(200, BROKER, '/opt/agent/.local/bin/claude --model opus')
const runaway = row(400, 200, 'git gc', 9)
const secondRunaway = row(500, 200, '/usr/bin/python3 train.py', 9)

function deps(mode: ProcessGuardMode, overrides: Partial<GuardDeps> = {}): GuardDeps {
  return {
    readTable: vi.fn(async () => [broker, claude, runaway]),
    kill: vi.fn(),
    log: vi.fn(),
    mode: () => mode,
    limitBytes: () => LIMIT,
    now: () => Date.now(),
    brokerPid: BROKER,
    uid: UID,
    ...overrides,
  }
}

function events(d: GuardDeps, name: string): Array<Record<string, unknown>> {
  return vi
    .mocked(d.log)
    .mock.calls.filter(([event]) => event === name)
    .map(([, detail]) => detail)
}

async function runFor(d: GuardDeps, ms: number): Promise<void> {
  const stop = startProcessGuard(d, TICK)
  await vi.advanceTimersByTimeAsync(ms)
  stop()
}

describe('process guard monitor (CC-495)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('mode log records process_over_limit and sends no signal', async () => {
    const d = deps('log')

    await runFor(d, TICK)

    expect(d.kill).not.toHaveBeenCalled()
    expect(events(d, 'process_killed')).toEqual([])
    expect(events(d, 'process_over_limit')).toEqual([
      expect.objectContaining({
        pid: 400,
        ppid: 200,
        rssBytes: 9 * 1024 ** 3,
        limitBytes: LIMIT,
        command: 'git gc',
        root: { pid: 200, command: claude.command },
        mode: 'log',
      }),
    ])
  })

  it('a standing runaway in log mode is recorded once per ten minutes, not every tick', async () => {
    const d = deps('log')

    await runFor(d, 10 * 60_000 + TICK)

    expect(events(d, 'process_over_limit')).toHaveLength(2)
  })

  it('a ps failure kills nothing and logs the failure once per minute', async () => {
    const d = deps('kill', { readTable: vi.fn(async () => Promise.reject(new Error('ps timed out'))) })
    const stop = startProcessGuard(d, TICK)

    await vi.advanceTimersByTimeAsync(59_000)
    expect(events(d, 'process_guard_reader_failed')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(4_000)
    stop()

    expect(events(d, 'process_guard_reader_failed')).toHaveLength(2)
    expect(events(d, 'process_guard_reader_failed')[0]).toMatchObject({ error: 'Error: ps timed out' })
    expect(d.kill).not.toHaveBeenCalled()
  })

  it('flipping log to kill kills a runaway already recorded on the next poll', async () => {
    let mode: ProcessGuardMode = 'log'
    const d = deps('log', { mode: () => mode })
    const stop = startProcessGuard(d, TICK)

    await vi.advanceTimersByTimeAsync(2 * TICK)
    expect(events(d, 'process_over_limit')).toHaveLength(1)
    mode = 'kill'
    await vi.advanceTimersByTimeAsync(TICK)
    stop()

    expect(d.kill).toHaveBeenCalledWith(400)
  })

  it('mode kill sends SIGKILL once and logs process_killed', async () => {
    const d = deps('kill')

    await runFor(d, 8_000)

    expect(d.kill).toHaveBeenCalledTimes(1)
    expect(d.kill).toHaveBeenCalledWith(400)
    expect(events(d, 'process_killed')).toEqual([expect.objectContaining({ pid: 400, mode: 'kill' })])
    expect(events(d, 'process_over_limit')).toEqual([])
  })

  it('a runaway that outlives its kill is killed again after ten seconds', async () => {
    const d = deps('kill')

    await runFor(d, 12_000)

    expect(d.kill).toHaveBeenCalledTimes(2)
  })

  it('mode off never reads the process table', async () => {
    const d = deps('off')

    await runFor(d, 60_000)

    expect(d.readTable).not.toHaveBeenCalled()
    expect(d.log).not.toHaveBeenCalled()
  })

  it('a slow ps does not start a second overlapping read', async () => {
    const readTable = vi.fn(
      () => new Promise<ProcRow[]>(resolve => setTimeout(() => resolve([broker, claude, runaway]), 7_000)),
    )
    const d = deps('kill', { readTable })

    await runFor(d, 9_000)

    expect(readTable).toHaveBeenCalledTimes(1)
    expect(d.kill).toHaveBeenCalledTimes(1)
  })

  it('a kill that throws ESRCH is logged and the tick continues to the next victim', async () => {
    const kill = vi.fn((pid: number) => {
      if (pid === 400) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
    })
    const d = deps('kill', { kill, readTable: vi.fn(async () => [broker, claude, runaway, secondRunaway]) })

    await runFor(d, TICK)

    expect(kill.mock.calls).toEqual([[400], [500]])
    expect(events(d, 'process_killed')).toEqual([
      expect.objectContaining({ pid: 400, error: 'ESRCH' }),
      expect.not.objectContaining({ error: expect.anything() }),
    ])
  })

  it('an agent-chat MCP server over the limit is recorded but never killed', async () => {
    const mcp = row(600, 200, '/usr/bin/node /opt/agent-chat/dist/cli.js mcp', 9)
    const d = deps('kill', { readTable: vi.fn(async () => [broker, claude, mcp]) })

    await runFor(d, TICK)

    expect(d.kill).not.toHaveBeenCalled()
    expect(events(d, 'process_over_limit')).toEqual([
      expect.objectContaining({ pid: 600, mode: 'kill', spared: 'agent-chat or host daemon' }),
    ])
  })

  it('stops reading once cancelled', async () => {
    const d = deps('log')
    const stop = startProcessGuard(d, TICK)

    await vi.advanceTimersByTimeAsync(TICK)
    stop()
    await vi.advanceTimersByTimeAsync(10 * TICK)

    expect(d.readTable).toHaveBeenCalledTimes(1)
  })
})
