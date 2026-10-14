import { heldClaims, type Claim, type Phase } from '../burndown/ledger.js'
import {
  AGREE,
  explainClaim,
  explainTree,
  isLiveRow,
  isRead,
  readFailure,
  unread,
  type ClaimContext,
} from './explain.js'
import type {
  Count,
  CountId,
  CountItem,
  LiveSnapshot,
  PrRow,
  Read,
  Roster,
  ShepherdRun,
  Surface,
} from './types.js'

/**
 * CC-1282 (K1): every count derived once from a `LiveSnapshot`. Pure: the caller reads live state, this module only
 * derives and reconciles, so the tick, `seats status`, `agent ls` and `counts` share one definition per count.
 */

const ROLES = [
  ['implementers', 'implementing'],
  ['reviewers', 'reviewing'],
  ['planners', 'planning'],
] as const satisfies readonly (readonly [CountId, Phase])[]
type RoleId = (typeof ROLES)[number][0]

const REVIEWER_NAME = /^rv-/

export function deriveCounts(s: LiveSnapshot): Count[] {
  return [
    ...seatCounts(s),
    ...worktreeCounts(s),
    slotsCount(s),
    fileClaimsCount(s),
    shepherdReviewersCount(s),
  ]
}

function shownFor(s: LiveSnapshot, id: CountId, seat?: string): Count['shown'] {
  const given = (s.shown ?? []).filter(v => v.count === id && v.seat === seat)
  return given.map(v => ({ surface: v.surface, value: v.value }))
}

function unreadCount(id: CountId, why: string, extra: Partial<Count> = {}): Count {
  return { id, shown: [], ...extra, items: [{ key: id, verdict: unread(why) }] }
}

function seatCounts(s: LiveSnapshot): Count[] {
  const read = s.ledger
  if (!isRead(read)) {
    const why = `ledger: ${readFailure(read) ?? 'unread'}`
    return [...ROLES.map(([id]) => id), 'claims' as const].map(id => unreadCount(id, why))
  }
  const held = heldClaims(read.value)
  const seats = [...new Set([...held.map(c => c.seat), ...Object.keys(s.lastTick?.seats ?? {})])]
  return seats.flatMap(seat => {
    const mine = held.filter(c => c.seat === seat)
    return [...ROLES.map(([id, phase]) => roleCount(s, id, phase, mine, seat)), claimsCount(s, mine, seat)]
  })
}

function prLookup(prs: LiveSnapshot['prs']): (pr: string) => Read<PrRow | undefined> {
  return pr => {
    const reads = Object.values(prs)
    const found = reads.flatMap(r => (isRead(r) ? r.value : [])).find(row => row.pr === pr)
    const failed = readFailure(...reads)
    return found === undefined && failed !== undefined ? { error: failed } : { value: found }
  }
}

const claimKey = (c: Claim): string => `${c.taskId}${c.slice === undefined ? '' : ` ${c.slice}`}`

function claimItems(s: LiveSnapshot, roster: Roster, claims: Claim[]): CountItem[] {
  const ctx: ClaimContext = { now: s.now, tickMs: s.tickMs, roster, pr: prLookup(s.prs), runs: runsOf(s) }
  return claims.map(c => ({ key: claimKey(c), verdict: explainClaim(c, ctx) }))
}

const runsOf = (s: LiveSnapshot): Read<ShepherdRun[]> =>
  isRead(s.shepherd) ? { value: s.shepherd.value.runs } : s.shepherd

function withSeat(seat: string | undefined): { seat?: string } {
  return seat === undefined ? {} : { seat }
}

function roleCount(s: LiveSnapshot, id: RoleId, phase: Phase, mine: Claim[], seat?: string): Count {
  const claims = mine.filter(c => c.phase === phase || (c.phase === 'spawning' && c.nextPhase === phase))
  const tick = seat === undefined ? undefined : s.lastTick?.seats[seat]?.roles?.used[id]
  const shown: Count['shown'] = [
    ...(tick === undefined ? [] : [{ surface: 'tick' as Surface, value: tick }]),
    { surface: 'ledger', value: claims.length },
    ...shownFor(s, id, seat),
  ]
  if (!isRead(s.roster)) return unreadCount(id, `roster: ${s.roster.error}`, { ...withSeat(seat), shown })
  const items = claimItems(s, s.roster.value, claims)
  const live = items.filter(i => i.verdict.kind === 'agree').length
  const derivation = `roster rows spawning, live or detached that hold the seat's ${phase} claims`
  return { id, ...withSeat(seat), shown, live: { value: live, derivation }, items }
}

/** Live claims are the ones a live agent or an open review holds; every other held claim needs a disposition. */
function claimsCount(s: LiveSnapshot, mine: Claim[], seat?: string): Count {
  const shown: Count['shown'] = [{ surface: 'ledger', value: mine.length }, ...shownFor(s, 'claims', seat)]
  if (!isRead(s.roster))
    return unreadCount('claims', `roster: ${s.roster.error}`, { ...withSeat(seat), shown })
  const items = claimItems(s, s.roster.value, mine)
  const live = items.filter(
    i => i.verdict.kind === 'agree' || (i.verdict.kind === 'explained' && i.verdict.code === 'in-review'),
  )
  const derivation = 'held claims whose agent is live or whose PR is open at Shepherd'
  return { id: 'claims', ...withSeat(seat), shown, live: { value: live.length, derivation }, items }
}

function worktreeCounts(s: LiveSnapshot): Count[] {
  const held: Read<Claim[]> = isRead(s.ledger) ? { value: heldClaims(s.ledger.value) } : s.ledger
  const ctx = {
    now: s.now,
    sweepMs: s.sweepMs,
    roster: s.roster,
    heldClaims: held,
    runs: runsOf(s),
    parkKept: s.parkKept,
  }
  return Object.entries(s.worktrees).map(([repo, read]) => {
    const shown = shownFor(s, 'worktrees')
    if (!isRead(read)) return unreadCount('worktrees', `git worktree list: ${read.error}`, { repo, shown })
    const items = read.value.map(tree => ({ key: tree.path, verdict: explainTree(tree, ctx) }))
    return {
      id: 'worktrees',
      repo,
      shown,
      live: { value: read.value.length, derivation: 'git worktree list' },
      items,
    }
  })
}

/** Every process holds a semaphore slot through a live roster row, or is a seat or human session that holds none. */
function slotsCount(s: LiveSnapshot): Count {
  const shown: Count['shown'] = [
    ...(isRead(s.semaphore) ? [{ surface: 'agent ls' as Surface, value: s.semaphore.value.held }] : []),
    ...shownFor(s, 'slots'),
  ]
  if (!isRead(s.processes) || !isRead(s.roster) || !isRead(s.sessions) || !isRead(s.semaphore))
    return unreadCount('slots', readFailure(s.processes, s.roster, s.sessions, s.semaphore) ?? 'unread', {
      shown,
    })
  const liveIds = new Set(s.roster.value.rows.filter(isLiveRow).map(r => r.agentId))
  const sessions = new Set(s.sessions.value)
  const since = s.now.toISOString()
  const items: CountItem[] = s.processes.value.map(p => ({
    key: `pid ${p.pid}${p.name === undefined ? '' : ` ${p.name}`}`,
    verdict:
      p.agentId !== undefined && liveIds.has(p.agentId)
        ? AGREE
        : p.name !== undefined && sessions.has(p.name)
          ? { kind: 'explained', code: 'seat-session', since }
          : { kind: 'unexplained', why: 'process holds no slot and is no seat or human session' },
  }))
  const holders = items.filter(i => i.verdict.kind === 'agree').length
  if (s.semaphore.value.held !== holders)
    items.push({
      key: 'semaphore',
      verdict: {
        kind: 'unexplained',
        why: `semaphore holds ${s.semaphore.value.held}, live processes hold ${holders}`,
      },
    })
  return {
    id: 'slots',
    shown,
    live: { value: s.processes.value.length, derivation: 'ps: claude processes' },
    items,
  }
}

/** A broker file claim ends with its owner's connection, so a claim whose owner is gone is a leak, never a hold. */
function fileClaimsCount(s: LiveSnapshot): Count {
  const shown = shownFor(s, 'file-claims')
  if (!isRead(s.fileClaims) || !isRead(s.roster) || !isRead(s.sessions))
    return unreadCount('file-claims', readFailure(s.fileClaims, s.roster, s.sessions) ?? 'unread', { shown })
  const roster = s.roster.value
  const sessions = new Set(s.sessions.value)
  const items: CountItem[] = s.fileClaims.value.map(c => {
    const key = `${c.owner} ${c.repo} ${c.patterns.join(',')}`
    const rows = roster.rows.filter(r => r.name === c.owner)
    if (rows.some(isLiveRow) || sessions.has(c.owner)) return { key, verdict: AGREE }
    if (rows.length === 0 && roster.partial !== undefined)
      return { key, verdict: unread('owner has no row on a partial roster') }
    return { key, verdict: { kind: 'unexplained', why: `leaked file claim ${key}` } }
  })
  const live = items.filter(i => i.verdict.kind === 'agree').length
  return {
    id: 'file-claims',
    shown,
    live: { value: live, derivation: 'broker file claims whose owner is live' },
    items,
  }
}

/** Shepherd's own reviewer reading against the roster's live `rv-` rows; a Shepherd that exports none is unread. */
function shepherdReviewersCount(s: LiveSnapshot): Count {
  const slots = isRead(s.shepherd) ? s.shepherd.value.reviewSlots : undefined
  const shown: Count['shown'] = [
    ...(slots === undefined ? [] : [{ surface: 'shepherd' as Surface, value: slots.running.length }]),
    ...shownFor(s, 'shepherd-reviewers'),
  ]
  if (!isRead(s.roster) || !isRead(s.shepherd))
    return unreadCount('shepherd-reviewers', readFailure(s.roster, s.shepherd) ?? 'unread', { shown })
  if (slots === undefined)
    return unreadCount('shepherd-reviewers', 'Shepherd exports no reviewer-slot reading', { shown })
  const live = new Set(
    s.roster.value.rows.filter(r => REVIEWER_NAME.test(r.name) && isLiveRow(r)).map(r => r.name),
  )
  const running = new Set(slots.running)
  const items: CountItem[] = [...new Set([...live, ...running])].map(name => ({
    key: name,
    verdict:
      live.has(name) && running.has(name)
        ? AGREE
        : {
            kind: 'unexplained',
            why: live.has(name)
              ? 'live rv- row Shepherd does not count'
              : 'Shepherd counts a reviewer with no live row',
          },
  }))
  return {
    id: 'shepherd-reviewers',
    shown,
    live: { value: live.size, derivation: 'roster rows rv-* spawning, live or detached' },
    items,
  }
}
