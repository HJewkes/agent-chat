import { contextTokens, readBudget, type BudgetRead, type SessionBudget } from '../agents/budget.js'
import { readTranscriptUsage } from '../agents/transcript-usage.js'
import type { ParkAdvicePolicy } from '../config.js'
import type { WaitClass } from './human-wait.js'

/**
 * Tell a session idle on the human that its warm cache is about to expire (CC-135 S3).
 *
 * WHY A TIMER rather than riding a frame like the `[budget]` hint: a session waiting on
 * the human gets no frames, which is exactly the wait that costs a cold rebuild. One push
 * to one session, once per cache expiry, is not the fanout the broadcast budget guards.
 *
 * WHY THIS LATE: a turn-end hook cannot tell a two-minute wait from a three-hour one. A
 * notice `leadMinutes` before expiry only reaches waits that are already long.
 *
 * Advisory only: the notice starts one warm turn, and only the model's own
 * `agent_teleport` can end the session.
 */

export const TICK_MS = 60_000

const MIN_MS = 60_000
const TTL_UNITS: Readonly<Record<string, number>> = { m: 1, h: 60 }

export interface ParkAdvisorDeps {
  sessionId: string | undefined
  /** Null means this session is never advised. */
  policy: ParkAdvicePolicy | null
  now: () => number
  /** Undefined when no reading can be trusted for the current token count. */
  readBudget: (sessionId: string, now: number) => BudgetRead | undefined
  classify: () => Promise<WaitClass>
  notify: (content: string) => void
  log: (event: string, detail: Record<string, unknown>) => void
  name: () => string | null
}

interface Expiry {
  /** Unix seconds; the once-per-expiry key. */
  at: number
  ttlMinutes: number
}

const kTokens = (n: number): string => `${Math.round(n / 1000)}k`

/** `1h` and `5m` as Claude Code reports them; anything else falls back to the configured TTL. */
function ttlMinutesOf(ttl: string | undefined, fallback: number): number {
  const match = ttl === undefined ? null : /^(\d+)([mh])$/.exec(ttl)
  return match === null ? fallback : Number(match[1]) * (TTL_UNITS[match[2] ?? ''] ?? 0)
}

/** Undefined for a cache already known cold; derived from the last request when the status line has no expiry. */
function expiryOf(budget: SessionBudget, policy: ParkAdvicePolicy): Expiry | undefined {
  const cache = budget.prompt_cache
  if (cache?.caching_observed === false || cache?.warm === false) return undefined
  const ttlMinutes = ttlMinutesOf(cache?.ttl, policy.ttlMinutes)
  return { at: cache?.expires_at ?? budget.written_at + ttlMinutes * 60, ttlMinutes }
}

export function parkNotice(waitedMinutes: number, tokens: number, minutesLeft: number): string {
  const k = kTokens(tokens)
  return [
    `[park] You have been waiting on the human for about ${waitedMinutes} min at ${k} tokens.`,
    `Your prompt cache expires in about ${minutesLeft} min, and answering after that rebuilds all ${k}.`,
    'If your next step does not depend on detail only this context holds, hand off now.',
    'Call agent_teleport with reason "park" and a handoff that states the open question word for word,',
    'the decisions so far, and the files to read first, using @-paths. Keep it under 8 KB.',
    'If teleport refuses, run active-work wrap with next-steps instead.',
    'If your next step does depend on this context, ignore this notice and keep waiting.',
    'This notice is advisory.',
  ].join(' ')
}

export class ParkAdvisor {
  /** The expiry already advised on; a new turn moves it and so re-arms the advisor. */
  private advisedFor: number | undefined
  private running = false

  constructor(private readonly deps: ParkAdvisorDeps) {}

  /** One check. Never throws, and never overlaps itself. */
  async tick(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      await this.check()
    } catch {
      // Advice is best-effort; a failed read must not take down the session's MCP server.
    } finally {
      this.running = false
    }
  }

  /** Unref'd, so a pending tick never holds the process open. */
  start(intervalMs = TICK_MS): () => void {
    const timer = setInterval(() => void this.tick(), intervalMs)
    timer.unref()
    return () => clearInterval(timer)
  }

  private async check(): Promise<void> {
    const { sessionId, policy, now: clock } = this.deps
    if (sessionId === undefined || policy === null) return
    const now = clock()
    const read = this.deps.readBudget(sessionId, now)
    if (read === undefined || !read.found) return
    const tokens = contextTokens(read.budget.context)
    if (tokens === undefined || tokens < policy.tokens) return
    const expiry = expiryOf(read.budget, policy)
    if (expiry === undefined || expiry.at === this.advisedFor) return
    if (expiry.ttlMinutes <= policy.leadMinutes) return
    const msLeft = expiry.at * 1000 - now
    if (msLeft <= 0 || msLeft > policy.leadMinutes * MIN_MS) return
    const wait = await this.deps.classify()
    if (wait.kind !== 'awaiting-turn-end' && wait.kind !== 'awaiting-ask') return
    this.advise(sessionId, tokens, expiry, msLeft, wait.kind)
  }

  private advise(sessionId: string, tokens: number, expiry: Expiry, msLeft: number, waitKind: string): void {
    this.advisedFor = expiry.at
    const minutesLeft = Math.max(1, Math.round(msLeft / MIN_MS))
    this.deps.notify(parkNotice(expiry.ttlMinutes - minutesLeft, tokens, minutesLeft))
    this.deps.log('park_advised', {
      name: this.deps.name(),
      session_id: sessionId,
      tokens,
      minutes_left: minutesLeft,
      wait_kind: waitKind,
    })
  }
}

/**
 * Whether a reading's token count is current. Tokens do not move while a session idles, so a
 * stale status line is fine unless the session made a request after it was written.
 */
export function usableReading(read: BudgetRead, lastRequestAt: number | undefined): boolean {
  if (!read.found || !read.stale || read.source === 'transcript') return read.found
  return lastRequestAt !== undefined && read.budget.written_at >= lastRequestAt
}

/** The production budget reader: the status line or transcript, held to {@link usableReading}. */
export function readParkBudget(sessionId: string, now: number, cwd: string): BudgetRead | undefined {
  const read = readBudget(sessionId, now, undefined, cwd)
  if (!read.found || !read.stale || read.source === 'transcript') return read
  const usage = readTranscriptUsage(sessionId, undefined, cwd)
  return usableReading(read, usage.ok ? usage.recorded_at : undefined) ? read : undefined
}
