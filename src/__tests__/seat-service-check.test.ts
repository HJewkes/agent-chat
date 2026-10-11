import { describe, expect, it } from 'vitest'
import type { WatchdogDoc } from '../agents/seats/io.js'
import { runWatchdog, type WatchdogDeps } from '../agents/seats/run.js'
import {
  judgeService,
  serviceCause,
  serviceCheckRunner,
  type ExecFile,
  type ServiceCheckRun,
} from '../agents/seats/service-check.js'

const NOW = new Date(2026, 9, 6, 12, 8).getTime()
const CHARTER = `---
owner_seat: seat-a
seats: [seat-a]
pools:
  alpha: {config_dir: /synthetic/alpha, human_uses: false, reserve_seven_day: 14, ceiling_five_hour: 100}
---
`
const SEAT = '---\nprefix: sa\npool: alpha\n---\n'
const DESK = '---\nprefix: dk\nrole: attended\npool: alpha\n---\n'

const healthy: ServiceCheckRun = { exitCode: 0, stdout: '{}' }
const failing = (cause: string): ServiceCheckRun => ({ exitCode: 1, stdout: JSON.stringify({ cause }) })

interface Harness {
  deps: WatchdogDeps
  doc: WatchdogDoc
  check: ServiceCheckRun
  woken: Array<{ seat: string; message: string }>
  nowMs: number
}

function harness(): Harness {
  const h: Harness = {
    doc: { seats: {}, pools: {}, stopped: {} },
    check: healthy,
    woken: [],
    nowMs: NOW,
    deps: {
      now: () => new Date(h.nowMs),
      readCharter: () => CHARTER,
      readSeatFile: name => (name === 'desk' ? DESK : SEAT),
      seatNames: () => ['seat-a', 'desk'],
      seatLogDays: () => [],
      readSeatLog: () => undefined,
      readBudget: dir => ({ found: false, path: dir, reason: 'no_file' }),
      ownerMessages: () => [],
      roster: async () => ({ agents: [], connected: ['seat-a', 'desk'] }),
      presence: () => undefined,
      eligible: () => ({ count: 0, skipped: 0 }),
      loadDoc: () => structuredClone(h.doc),
      saveDoc: doc => void (h.doc = { ...doc, stopped: {} }),
      wake: async (seat, message) => {
        h.woken.push({ seat, message })
        return { ok: true, detail: 'm1' }
      },
      appendLog: () => undefined,
      lock: () => ({ held: true, release: () => undefined }),
      serviceCheck: async () => h.check,
    },
  }
  return h
}

async function tick(h: Harness): Promise<void> {
  h.nowMs += 15 * 60_000
  await runWatchdog(h.deps, { dryRun: false })
}

const notices = (h: Harness): string[] => h.woken.filter(w => w.seat === 'desk').map(w => w.message)

describe('the service check in a watchdog pass', () => {
  it('tells the attended seat once while one cause persists over several passes', async () => {
    const h = harness()
    await tick(h)
    h.check = failing('stale build')

    for (let i = 0; i < 4; i++) await tick(h)

    expect(notices(h)).toEqual(['Watchdog: titan-factory service check failing: stale build'])
  })

  it('tells the attended seat once on recovery', async () => {
    const h = harness()
    h.check = failing('crash loop')
    await tick(h)
    h.check = healthy

    await tick(h)
    await tick(h)

    expect(notices(h)).toEqual([
      'Watchdog: titan-factory service check failing: crash loop',
      'Watchdog: titan-factory service recovered',
    ])
    expect(h.doc.serviceHeard).toBeUndefined()
  })

  it('tells the attended seat again when the cause changes', async () => {
    const h = harness()
    h.check = failing('stale pid')
    await tick(h)
    h.check = failing('GitHub down')

    await tick(h)
    await tick(h)

    expect(notices(h)).toEqual([
      'Watchdog: titan-factory service check failing: stale pid',
      'Watchdog: titan-factory service check failing: GitHub down',
    ])
    expect(h.doc.serviceHeard).toEqual({ desk: 'GitHub down' })
  })

  it('counts a missing binary as its own cause and does not end the pass', async () => {
    const h = harness()
    h.deps.serviceCheck = async () => {
      throw new Error('spawn titan-factory ENOENT')
    }

    await tick(h)
    await tick(h)

    expect(notices(h)).toEqual([
      'Watchdog: titan-factory service check failing: service check could not run: spawn titan-factory ENOENT',
    ])
  })

  it('sends again next pass when the attended seat is not connected', async () => {
    const h = harness()
    h.check = failing('not loaded')
    h.deps.roster = async () => ({ agents: [], connected: ['seat-a'] })
    await tick(h)
    await tick(h)
    h.deps.roster = async () => ({ agents: [], connected: ['seat-a', 'desk'] })

    await tick(h)

    expect(notices(h)).toHaveLength(1)
  })

  it('re-sends next pass only to the attended seat a send missed', async () => {
    const h = harness()
    h.deps.seatNames = () => ['seat-a', 'desk', 'desk-b']
    h.deps.readSeatFile = name => (name.startsWith('desk') ? DESK : SEAT)
    h.deps.roster = async () => ({ agents: [], connected: ['seat-a', 'desk', 'desk-b'] })
    let deskBDown = true
    h.deps.wake = async (seat, message) => {
      if (seat === 'desk-b' && deskBDown) return { ok: false, detail: 'socket closed' }
      h.woken.push({ seat, message })
      return { ok: true, detail: 'm1' }
    }
    h.check = failing('stale build')
    await tick(h)
    deskBDown = false

    await tick(h)
    await tick(h)

    expect(h.woken).toEqual([
      { seat: 'desk', message: 'Watchdog: titan-factory service check failing: stale build' },
      { seat: 'desk-b', message: 'Watchdog: titan-factory service check failing: stale build' },
    ])
  })

  it('does not check or notify under --dry-run', async () => {
    const h = harness()
    let checks = 0
    h.deps.serviceCheck = async () => {
      checks++
      return failing('not loaded')
    }

    await runWatchdog(h.deps, { dryRun: true })

    expect(notices(h)).toEqual([])
    expect(checks).toBe(0)
  })
})

describe('the cause of a service check', () => {
  it('reads a non-JSON failing answer as its own cause', () => {
    expect(serviceCause({ exitCode: 2, stdout: 'boom' })).toBe(
      'service check answered with no readable cause',
    )
  })

  it('reads an exit 0 with non-JSON output as unparsed, not healthy', () => {
    expect(serviceCause({ exitCode: 0, stdout: 'service ok' })).toBe(
      'unparsed: service check exited 0 but printed no JSON',
    )
  })

  it('reads an exit 0 that says ok: false as not-ok, not healthy', () => {
    expect(serviceCause({ exitCode: 0, stdout: '{"ok":false,"cause":"queue stalled"}' })).toBe(
      'not-ok: queue stalled',
    )
    expect(serviceCause({ exitCode: 0, stdout: '{"ok":false}' })).toBe('not-ok: service check said ok: false')
  })

  it('has no cause and no notice for a healthy service that was healthy', () => {
    expect(judgeService(undefined, healthy)).toEqual({ cause: undefined, message: undefined })
  })
})

const failedExec =
  (fields: { code?: string | number; killed?: boolean }): ExecFile =>
  (_file, _args, _options, callback) =>
    callback(Object.assign(new Error('exec failed'), fields), '')

describe('the live service check runner', () => {
  it('reads a timeout as its own cause', async () => {
    const run = serviceCheckRunner(failedExec({ killed: true }))

    const result = await run()

    expect(serviceCause(result)).toBe('service check could not run: timed out after 5000 ms')
  })

  it('reads a missing binary as its own cause', async () => {
    const run = serviceCheckRunner(failedExec({ code: 'ENOENT' }))

    const result = await run()

    expect(serviceCause(result)).toBe('service check could not run: titan-factory not found (ENOENT)')
  })

  it('reads an output overflow as its own cause, not a timeout', async () => {
    const run = serviceCheckRunner(failedExec({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true }))

    const result = await run()

    expect(serviceCause(result)).toBe('service check could not run: output overflowed the buffer')
  })
})
