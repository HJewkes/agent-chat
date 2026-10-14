import { describe, expect, it, vi } from 'vitest'
import type { BudgetRead } from '../agents/budget.js'
import { BACKGROUND_RESUME_MESSAGE } from '../agents/background-resume.js'
import { EXTERNAL_HEARTBEAT_MESSAGE } from '../agents/seats/heartbeat-external.js'
import { HEARTBEAT_MESSAGE, IDLE_LIVE_MESSAGE, PAUSE_WAKE_MESSAGE } from '../agents/seats/heartbeat.js'
import type { WatchdogDoc } from '../agents/seats/io.js'
import { RESUME_MESSAGE } from '../agents/seats/liveness.js'
import { isOwnerPrompt, restartRunOnOwnerPrompt, submittedPrompt } from '../agents/seats/owner-prompt.js'
import { renderRelaunchHandoff, renderTeleportHandoff } from '../agents/seats/relaunch-handoff.js'
import type { RunStartDeps } from '../agents/seats/run-start.js'
import { WAKE_MESSAGE } from '../agents/seats/watchdog.js'

/** CC-281 b: an owner's typed prompt restarts a seat's run meter; machine prompts never do. */

const NOW = new Date(2026, 9, 14, 9, 0)

const CHARTER = [
  '---',
  'seats: [alpha-coord]',
  'pools:',
  '  agents: {config_dir: /synthetic, human_uses: false, reserve_seven_day: 25, ceiling_five_hour: 85}',
  '---',
  '',
].join('\n')

const reading: BudgetRead = {
  found: true,
  path: '/synthetic',
  age_seconds: 30,
  stale: false,
  budget: {
    session_id: 's',
    written_at: 0,
    context: { exceeds_200k: false },
    cost: {},
    rate_limits: { five_hour: { used_pct: 20 }, seven_day: { used_pct: 50 } },
  },
}

const emptyDoc = (): WatchdogDoc => ({ seats: {}, pools: {}, stopped: {} })

function fakeDeps(over: Partial<RunStartDeps> = {}) {
  const saved: Omit<WatchdogDoc, 'stopped'>[] = []
  const sleep = vi.fn(async () => undefined)
  const deps: RunStartDeps = {
    now: () => NOW,
    readCharter: () => CHARTER,
    readSeatFile: () => '---\nprefix: ac\npool: agents\n---\n',
    readBudget: () => reading,
    loadDoc: emptyDoc,
    saveDoc: doc => void saved.push(doc),
    lock: () => ({ held: true, release: () => undefined }),
    sleep,
    ...over,
  }
  return { deps, saved, sleep }
}

describe('which prompts count as the owner typing to a seat', () => {
  it('counts a typed line', () => {
    expect(isOwnerPrompt('ship CC-281 next, then look at the red main')).toBe(true)
  })

  it.each([
    ['the heartbeat cron', HEARTBEAT_MESSAGE],
    ['the external heartbeat', EXTERNAL_HEARTBEAT_MESSAGE],
    ['the budget-pause wake', PAUSE_WAKE_MESSAGE],
    ['the watchdog discovery wake', WAKE_MESSAGE],
    ['the watchdog resume', RESUME_MESSAGE],
    ['the idle-live nudge', IDLE_LIVE_MESSAGE(2, 25)],
    ['the background resume', BACKGROUND_RESUME_MESSAGE],
    [
      'a relaunch handoff',
      renderRelaunchHandoff({
        root: '/r',
        seat: 'alpha-coord',
        found: undefined,
        quietMinutes: 40,
        heartbeatSource: 'watchdog',
      }),
    ],
    [
      'a teleport handoff',
      renderTeleportHandoff({
        root: '/r',
        seat: 'alpha-coord',
        found: undefined,
        after: 'm1',
        heartbeatSource: 'cron',
      }),
    ],
    ['a channel delivery', '<channel source="agent-chat" from="peer" msg_id="m1">done</channel>'],
    ['a task notification', '<task-notification>bash exited</task-notification>'],
    ['the loop sentinel', '<<autonomous-loop-dynamic>>'],
    ['an empty prompt', '   '],
  ])('does not count %s', (_what, prompt) => {
    expect(isOwnerPrompt(prompt)).toBe(false)
  })
})

describe('the prompt a hook payload carries', () => {
  it('reads the prompt of a UserPromptSubmit', () => {
    const raw = JSON.stringify({ session_id: 's1', hook_event_name: 'UserPromptSubmit', prompt: 'go' })

    expect(submittedPrompt(raw)).toBe('go')
  })

  it.each(['Stop', 'SessionEnd'])('reads nothing from a %s', event => {
    expect(
      submittedPrompt(JSON.stringify({ session_id: 's1', hook_event_name: event, prompt: 'go' })),
    ).toBeUndefined()
  })
})

describe('restarting the run meter on a prompt', () => {
  it('starts one run for an owner prompt', async () => {
    const { deps, saved } = fakeDeps()

    const outcome = await restartRunOnOwnerPrompt(deps, 'alpha-coord', 'pick up CC-281', () => undefined)

    expect(outcome).toBe('started')
    expect(saved).toHaveLength(1)
    expect(saved[0]?.seats['alpha-coord']?.run).toEqual({ since: NOW.getTime(), last: 50, spent: 0 })
  })

  it('never starts a run for a heartbeat', async () => {
    const { deps, saved } = fakeDeps()

    const outcome = await restartRunOnOwnerPrompt(deps, 'alpha-coord', HEARTBEAT_MESSAGE, () => undefined)

    expect(outcome).toBe('not_owner')
    expect(saved).toEqual([])
  })

  it('logs a held lock and returns at once instead of waiting it out', async () => {
    const { deps, saved, sleep } = fakeDeps({ lock: () => ({ held: false, reason: 'watchdog pid 7' }) })
    const refused: unknown[] = []

    const outcome = await restartRunOnOwnerPrompt(deps, 'alpha-coord', 'go', err => void refused.push(err))

    expect(outcome).toBe('refused')
    expect(String(refused[0])).toContain('lock_held')
    expect(sleep).not.toHaveBeenCalled()
    expect(saved).toEqual([])
  })

  it('stays quiet for an agent that is not a charter seat', async () => {
    const { deps, saved } = fakeDeps()
    const refused: unknown[] = []

    const outcome = await restartRunOnOwnerPrompt(deps, 'some-worker', 'go', err => void refused.push(err))

    expect(outcome).toBe('not_a_seat')
    expect(refused).toEqual([])
    expect(saved).toEqual([])
  })
})
