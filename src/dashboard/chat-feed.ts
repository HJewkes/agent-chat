/**
 * Turns the raw event log into a conversation.
 *
 * The log stores ONE ROW PER RECIPIENT — a multicast to three peers is three
 * rows sharing a msgId, each with its own `meta.target` and a `meta.audience`
 * listing everyone on it. Rendering that verbatim would repeat the same
 * sentence three times, so the feed regroups by msgId back into the single send
 * the agent actually made.
 */
import type { EventKind, QueueItem } from '../protocol.js'

/** The conversational kinds. Lifecycle rows (spawns, registrations) are not talk. */
export const CHAT_KINDS: readonly EventKind[] = ['message', 'broadcast', 'question', 'notice']

const CHAT_KIND_SET = new Set<string>(CHAT_KINDS)

const HUMAN = 'human'

/** How the send was addressed, which is what the recipient chip renders. */
export type ChatScope = 'direct' | 'group' | 'tag' | 'broadcast' | 'human'

export interface ChatEntry {
  msgId: string
  kind: EventKind
  from: string
  text: string
  at: number
  recipients: string[]
  scope: ChatScope
  /** Set only when scope is 'tag'. */
  tag?: string
}

/** One feed entry per msgId, oldest first. */
export function groupChatEntries(items: QueueItem[]): ChatEntry[] {
  const byMsgId = new Map<string, ChatEntry>()

  for (const item of items) {
    if (!CHAT_KIND_SET.has(item.kind)) continue
    const existing = byMsgId.get(item.msgId)
    if (existing) {
      mergeRecipients(existing, item)
      existing.at = Math.min(existing.at, item.at)
      continue
    }
    byMsgId.set(item.msgId, newEntry(item))
  }

  const entries = [...byMsgId.values()]
  for (const entry of entries) entry.scope = scopeOf(entry)
  return entries.sort((a, b) => a.at - b.at)
}

function newEntry(item: QueueItem): ChatEntry {
  const tag = item.meta.tag
  return {
    msgId: item.msgId,
    kind: item.kind,
    from: item.from,
    text: item.text,
    at: item.at,
    recipients: recipientsOf(item),
    scope: 'direct',
    ...(tag ? { tag } : {}),
  }
}

function recipientsOf(item: QueueItem): string[] {
  const audience = item.meta.audience ? item.meta.audience.split(',') : []
  const named = [item.meta.target ?? '', ...audience].map(name => name.trim()).filter(Boolean)
  return [...new Set(named)]
}

function mergeRecipients(entry: ChatEntry, item: QueueItem): void {
  const merged = new Set(entry.recipients)
  for (const name of recipientsOf(item)) merged.add(name)
  entry.recipients = [...merged]
}

function scopeOf(entry: ChatEntry): ChatScope {
  if (entry.kind === 'broadcast') return 'broadcast'
  if (entry.tag) return 'tag'
  if (entry.recipients.length === 1 && entry.recipients[0] === HUMAN) return 'human'
  return entry.recipients.length > 1 ? 'group' : 'direct'
}

/** Every name that has spoken or been spoken to, for the agent filter. */
export function chatParticipants(entries: ChatEntry[]): string[] {
  const names = new Set<string>()
  for (const entry of entries) {
    names.add(entry.from)
    for (const recipient of entry.recipients) names.add(recipient)
  }
  return [...names].sort()
}

export interface ChatFilter {
  /** Empty means "every agent". An entry matches if it is from or to any of these. */
  agents: string[]
  query: string
}

export function filterChatEntries(entries: ChatEntry[], filter: ChatFilter): ChatEntry[] {
  const agents = new Set(filter.agents)
  const query = filter.query.trim().toLowerCase()
  return entries.filter(entry => matchesAgents(entry, agents) && matchesQuery(entry, query))
}

function matchesAgents(entry: ChatEntry, agents: Set<string>): boolean {
  if (agents.size === 0) return true
  // A broadcast reaches everyone, so it stays visible whoever is selected.
  if (entry.scope === 'broadcast') return true
  return agents.has(entry.from) || entry.recipients.some(name => agents.has(name))
}

function matchesQuery(entry: ChatEntry, query: string): boolean {
  if (query === '') return true
  const haystack = [entry.text, entry.from, entry.tag ?? '', ...entry.recipients].join(' ')
  return haystack.toLowerCase().includes(query)
}
