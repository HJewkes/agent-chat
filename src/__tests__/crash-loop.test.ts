import { describe, expect, it } from 'vitest'
import {
  crashLoopRefusal,
  crashStreak,
  isAutomaticRelaunch,
  stderrTail,
  STDERR_TAIL_MAX,
  type LaunchEnd,
} from '../agents/crash-loop.js'

const LIMITS = { seconds: 30, launches: 3 }

const end = (over: Partial<LaunchEnd> = {}): LaunchEnd => ({
  code: 1,
  signal: null,
  failed: false,
  cancelled: false,
  ranMs: 5_000,
  priorStreak: 0,
  ...over,
})

describe('counting a crash at launch', () => {
  it('counts a non-zero exit and a signal inside the window', () => {
    expect(crashStreak(end({ priorStreak: 1 }), LIMITS)).toEqual({ streak: 2, looped: false })
    expect(crashStreak(end({ code: null, signal: 'SIGSEGV' }), LIMITS).streak).toBe(1)
  })

  it('reaches the limit at K in a row', () => {
    expect(crashStreak(end({ priorStreak: 2 }), LIMITS)).toEqual({ streak: 3, looped: true })
  })

  it('counts a launch that never registered, however long the attach wait ran', () => {
    expect(crashStreak(end({ code: null, failed: true, ranMs: 40_000 }), LIMITS).streak).toBe(1)
  })

  it.each<[string, Partial<LaunchEnd>]>([
    ['a clean exit', { code: 0 }],
    ['a clean exit that never registered', { code: 0, failed: true }],
    ['a crash after the window', { ranMs: 30_001 }],
    ['an exit the broker caused', { code: null, signal: 'SIGTERM', cancelled: true }],
    ['an inferred exit', { code: null, inferred: true }],
    ['no code and no evidence', { code: null }],
  ])('ends a streak on %s', (_label, over) => {
    expect(crashStreak(end({ priorStreak: 2, ...over }), LIMITS)).toEqual({ streak: 0, looped: false })
  })

  it('counts nothing with either limit null', () => {
    const crash = end({ priorStreak: 5 })

    expect(crashStreak(crash, { seconds: null, launches: 3 }).looped).toBe(false)
    expect(crashStreak(crash, { seconds: 30, launches: null }).streak).toBe(0)
  })
})

describe('who may relaunch a marked identity', () => {
  const marked = { name: 'n', crashLoop: { count: 3, code: 1, at: 0 } }

  it.each([
    [{ cause: 'background-resume' }],
    [{ forChild: 'c' }],
    [{ launchedBy: 'shepherd' as const }],
    [{ launchedBy: 'autoresearch' as const }],
    [{ source: 'watchdog' as const }],
    [{ source: 'shepherd' as const }],
    [{ source: 'burndown' as const }],
  ])('refuses automation: %j', origin => {
    expect(isAutomaticRelaunch(origin)).toBe(true)
    expect(crashLoopRefusal(marked, origin)).toMatch(/crash-looping/)
  })

  it.each([[{}], [{ source: 'console' as const }]])('lets a request by hand through: %j', origin => {
    expect(crashLoopRefusal(marked, origin)).toBeUndefined()
  })

  it('refuses nothing for an unmarked identity', () => {
    expect(crashLoopRefusal({ name: 'n' }, { source: 'watchdog' })).toBeUndefined()
  })

  it('names a signal death by its signal', () => {
    const killed = { name: 'n', crashLoop: { count: 3, code: null, signal: 'SIGKILL', at: 0 } }

    expect(crashLoopRefusal(killed, { source: 'watchdog' })).toMatch(/last signal SIGKILL/)
  })
})

describe('the output tail', () => {
  it('keeps the end and reads blank as none', () => {
    expect(stderrTail(`${'x'.repeat(STDERR_TAIL_MAX)}end`)).toMatch(/end$/)
    expect(stderrTail(`${'x'.repeat(STDERR_TAIL_MAX)}end`)).toHaveLength(STDERR_TAIL_MAX)
    expect(stderrTail('  \n')).toBeUndefined()
    expect(stderrTail(undefined)).toBeUndefined()
  })
})
