import { describe, expect, it } from 'vitest'
import {
  BACKGROUND_RESUME,
  backgroundResumeDecision,
  resumedForBackground,
} from '../agents/background-resume.js'
import type { AgentEventRow } from '../broker/event-store.js'

/** CC-336: one resume per chain for an exit on a background task, then the spawner's notice. */

describe('the decision for an unreported headless exit', () => {
  it.each([
    [true, false, 'resume'],
    [true, true, 'notice'],
    [false, false, 'notice'],
    [false, true, 'notice'],
  ] as const)(
    'with pending background %s and an earlier background resume %s is %s',
    (pendingBackground, resumedForBackgroundThisChain, expected) => {
      expect(backgroundResumeDecision({ pendingBackground, resumedForBackgroundThisChain })).toBe(expected)
    },
  )
})

const row = (kind: AgentEventRow['kind'], meta: Record<string, string> = {}): AgentEventRow => ({
  kind,
  ts: 0,
  actor: 'coord',
  target: 'scout',
  msgId: null,
  ref: 'a1',
  body: null,
  meta,
})

describe('whether the run that ended came from a background resume', () => {
  it('is false for a run that was spawned', () => {
    expect(resumedForBackground([row('agent_spawned'), row('agent_exited')])).toBe(false)
  })

  it('is true when the newest resume was the background resume', () => {
    const rows = [
      row('agent_spawned'),
      row('agent_resumed', { cause: BACKGROUND_RESUME }),
      row('agent_exited'),
    ]

    expect(resumedForBackground(rows)).toBe(true)
  })

  it('is false once someone else resumed it after the background resume', () => {
    const rows = [
      row('agent_spawned'),
      row('agent_resumed', { cause: BACKGROUND_RESUME }),
      row('agent_exited'),
      row('agent_resumed', { source: 'watchdog' }),
    ]

    expect(resumedForBackground(rows)).toBe(false)
  })
})
