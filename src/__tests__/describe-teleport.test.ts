import { describe, expect, it } from 'vitest'
import type { ServerMessage } from '../protocol.js'
import { describeTeleport } from '../server/commands/agent-teleport.js'

type Result = Extract<ServerMessage, { t: 'teleport_result' }>

const accepted = (extra: Partial<Result>): Result => ({
  t: 'teleport_result',
  ok: true,
  name: 'me',
  agentId: 'a-2',
  countdownMs: 30_000,
  ...extra,
})

describe('describeTeleport placement wording', () => {
  it('says the same window only when the successor is typed into the predecessor pane', () => {
    expect(describeTeleport(accepted({ placement: 'same-pane' }))).toContain('in the same window')
  })

  it('does not say the same window when a surface was requested', () => {
    const text = describeTeleport(accepted({ placement: 'new-surface' }))
    expect(text).not.toContain('same window')
    expect(text).toContain('new surface')
  })

  it('names another machine when the successor lands elsewhere', () => {
    const text = describeTeleport(accepted({ placement: 'other-machine' }))
    expect(text).not.toContain('same window')
    expect(text).toContain('another machine')
  })

  it('does not claim a window when the broker did not report a placement', () => {
    expect(describeTeleport(accepted({}))).not.toContain('same window')
  })
})
