import { describe, expect, it } from 'vitest'
import type { BudgetRead } from '../agents/budget.js'
import type { ContextHintPolicy } from '../config.js'
import { chatInbox } from '../server/commands/chat-inbox.js'
import { ContextHinter } from '../server/context-hint.js'

/** CC-922: a seat that pulls with chat_inbox never gets a channel push, so the advisory rides the reply. */
const policy: ContextHintPolicy = { tokens: 200_000, boundary: 'natural stopping point' }

const reading = (tokens: number): BudgetRead =>
  ({
    found: true,
    path: '/cache/s.json',
    age_seconds: 1,
    stale: false,
    budget: {
      session_id: 's',
      cwd: '/repo',
      written_at: 0,
      context: { exceeds_200k: false, window_size: 1_000_000, input_tokens: tokens },
      cost: {},
      rate_limits: {},
    },
  }) as BudgetRead

function readInbox(hinter: ContextHinter) {
  const ctx = {
    registeredName: 'me',
    broker: {
      request: async () => ({
        t: 'inbox_result',
        messages: [{ msgId: 'm1', from: 'bob', text: 'hello' }],
      }),
    },
    contextHint: () => hinter.hint(),
  } as never
  return chatInbox.run({}, ctx)
}

describe('chat_inbox budget advisory', () => {
  it('appends the budget line once context is past the threshold', async () => {
    const hinter = new ContextHinter('s', policy, () => reading(250_000))

    const out = await readInbox(hinter)

    expect(out).toContain('from bob: hello')
    expect(out).toContain('[budget] Your context holds 250k tokens, past the 200k advisory mark.')
  })

  it('says nothing below the threshold', async () => {
    const hinter = new ContextHinter('s', policy, () => reading(150_000))

    expect(await readInbox(hinter)).not.toContain('[budget]')
  })

  it('does not repeat the line on every read of one crossing', async () => {
    const hinter = new ContextHinter('s', policy, () => reading(250_000))

    await readInbox(hinter)

    expect(await readInbox(hinter)).not.toContain('[budget]')
  })

  it('shares the crossing with the push path', async () => {
    const hinter = new ContextHinter('s', policy, () => reading(250_000))

    expect(hinter.hint()).toContain('[budget]')
    expect(await readInbox(hinter)).not.toContain('[budget]')
  })
})
