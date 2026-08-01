import { describe, expect, it } from 'vitest'
import type { QueueItem } from '../../protocol.js'
import { chatParticipants, filterChatEntries, groupChatEntries } from '../chat-feed.js'

function row(overrides: Partial<QueueItem> & Pick<QueueItem, 'msgId'>): QueueItem {
  return {
    kind: 'message',
    from: 'cc50',
    text: 'hello',
    at: 1_000,
    meta: {},
    ...overrides,
  }
}

describe('groupChatEntries', () => {
  it('collapses one-row-per-recipient multicast into a single entry', () => {
    const audience = 'cc51,cc52,cc53'
    const entries = groupChatEntries([
      row({ msgId: 'm1', meta: { target: 'cc51', audience } }),
      row({ msgId: 'm1', at: 1_001, meta: { target: 'cc52', audience } }),
      row({ msgId: 'm1', at: 1_002, meta: { target: 'cc53', audience } }),
    ])

    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ from: 'cc50', scope: 'group', at: 1_000 })
    expect(entries[0]?.recipients).toEqual(['cc51', 'cc52', 'cc53'])
  })

  it('keeps a directed send as a direct entry', () => {
    const entries = groupChatEntries([row({ msgId: 'm2', meta: { target: 'cc51' } })])
    expect(entries[0]).toMatchObject({ scope: 'direct', recipients: ['cc51'] })
  })

  it('marks a tag-addressed send with the tag it was sent to', () => {
    const entries = groupChatEntries([
      row({ msgId: 'm3', meta: { target: 'cc51', audience: 'cc51,cc52', tag: 'dashboard' } }),
      row({ msgId: 'm3', meta: { target: 'cc52', audience: 'cc51,cc52', tag: 'dashboard' } }),
    ])
    expect(entries[0]).toMatchObject({ scope: 'tag', tag: 'dashboard' })
  })

  it('marks broadcasts and human-addressed asks with their own scope', () => {
    const entries = groupChatEntries([
      row({ msgId: 'm4', kind: 'broadcast', meta: { target: 'cc51' } }),
      row({ msgId: 'm5', kind: 'question', at: 2_000, meta: { target: 'human' } }),
    ])
    expect(entries.map(e => e.scope)).toEqual(['broadcast', 'human'])
  })

  it('drops non-conversational kinds and orders oldest first', () => {
    const entries = groupChatEntries([
      row({ msgId: 'later', at: 5_000, meta: { target: 'cc51' } }),
      row({ msgId: 'spawn', kind: 'agent_spawned', at: 4_000 }),
      row({ msgId: 'earlier', at: 3_000, meta: { target: 'cc51' } }),
    ])
    expect(entries.map(e => e.msgId)).toEqual(['earlier', 'later'])
  })
})

describe('filterChatEntries', () => {
  const entries = groupChatEntries([
    row({ msgId: 'a', from: 'cc50', text: 'shipping the parser', meta: { target: 'cc51' } }),
    row({ msgId: 'b', from: 'cc60', text: 'reviewing tokens', at: 2_000, meta: { target: 'cc61' } }),
    row({ msgId: 'c', from: 'cc70', kind: 'broadcast', text: 'broker restart', at: 3_000, meta: {} }),
  ])

  it('keeps entries from or to any selected agent, plus broadcasts', () => {
    const kept = filterChatEntries(entries, { agents: ['cc61'], query: '' })
    expect(kept.map(e => e.msgId)).toEqual(['b', 'c'])
  })

  it('matches the query against body, sender and recipients', () => {
    expect(filterChatEntries(entries, { agents: [], query: 'PARSER' }).map(e => e.msgId)).toEqual(['a'])
    expect(filterChatEntries(entries, { agents: [], query: 'cc61' }).map(e => e.msgId)).toEqual(['b'])
  })

  it('returns everything when no filter is set', () => {
    expect(filterChatEntries(entries, { agents: [], query: '  ' })).toHaveLength(3)
  })
})

describe('chatParticipants', () => {
  it('lists senders and recipients once, sorted', () => {
    const entries = groupChatEntries([
      row({ msgId: 'a', from: 'cc60', meta: { target: 'cc51', audience: 'cc51,cc50' } }),
      row({ msgId: 'b', from: 'cc50', at: 2_000, meta: { target: 'cc60' } }),
    ])
    expect(chatParticipants(entries)).toEqual(['cc50', 'cc51', 'cc60'])
  })
})
