import { z } from 'zod'
import { SELF_TAG } from '../../protocol.js'
import type {
  DeclaredPresence,
  ServerMessage,
  SessionClaim,
  SessionInfo,
  SessionTag,
} from '../../protocol.js'
import { accountName } from '../../agents/config-dir.js'
import {
  accountUsageLine,
  budgetSegment,
  readBudget,
  type BudgetRead,
  type NamedBudgetRead,
} from '../../agents/budget.js'
import { defineTool } from '../command.js'
import { ago } from '../format.js'

/**
 * The declared line, and the `(self-reported)` marker is the point of it: a
 * reader must be able to tell a session's claim about its role from a fact about
 * its checkout, and the two sit one line apart. Rendered only when there is
 * something to render, so an undeclared session stays a two-line entry.
 */
function declaredLine(declared: DeclaredPresence | undefined): string {
  const pairs = Object.entries(declared ?? {})
  if (pairs.length === 0) return ''
  return `\n    declared: ${pairs.map(([key, value]) => `${key}=${value}`).join(', ')}   (self-reported)`
}

/**
 * The tags line, and the attribution on it is the point (CC-13): `(self)` is a
 * session's own claim about itself and `(by cc-main, 4m ago)` is somebody else's
 * label for it, and those are worth exactly different amounts. Sits beside the
 * declared line for the same reason — both are claims, neither is a fact about
 * the process, and NEITHER IS AUTHORIZATION. A session tagged `owner:src` said
 * so, or a peer said so; nothing here checked anything.
 */
function tagsLine(tags: SessionTag[] | undefined, now: number): string {
  if (tags === undefined || tags.length === 0) return ''
  const rendered = tags.map(t =>
    t.by === SELF_TAG ? `${t.tag} (self)` : `${t.tag} (by ${t.by}, ${ago(now - t.at)} ago)`,
  )
  return `\n    tags: ${rendered.join(', ')}`
}

/**
 * cwd, then whatever the process could be OBSERVED to be sitting in. Everything
 * on this line is derived from the session's own process rather than typed by
 * it, which is what makes "main checkout" worth reading — two rows on the same
 * worktree are two sessions that will edit the same files.
 */
function observedLine(s: SessionInfo): string {
  const parts = [
    s.cwd,
    s.observed?.gitBranch,
    s.observed?.isLinkedWorktree === undefined
      ? undefined
      : s.observed.isLinkedWorktree
        ? 'linked worktree'
        : 'main checkout',
    // CC-100: which Claude ACCOUNT that session is spending. The last segment is
    // what a human calls it (`agents`, `workout`); the full path is on `agent ls`,
    // where there is room for it. Absent means the default `~/.claude`.
    s.observed?.configDir === undefined ? undefined : `account: ${accountName(s.observed.configDir)}`,
  ].filter((part): part is string => part !== undefined && part !== '')
  return `\n    ${parts.join('  ·  ')}`
}

function formatSessions(
  sessions: SessionInfo[],
  self: string | null,
  claims: SessionClaim[] = [],
  budgets: NamedBudgetRead[] = [],
  slots?: { held: number; cap: number },
): string {
  if (sessions.length === 0) return 'No sessions are registered.'
  const now = Date.now()
  const budgetByName = new Map(budgets.map(b => [b.name, b.read]))
  const rows = sessions.map(s => {
    const you = s.name === self ? ' (you)' : ''
    const quiet = s.dnd ? ', dnd' : ''
    // CC-82: a derived name is not a chosen one, and addressing it means "whoever
    // is working in that directory". Marked so a reader does not mistake it for
    // an identity the session declared.
    const named = s.provisional === true ? ', unnamed' : ''
    const budget = budgetByName.get(s.name)
    // One extra segment, CC-94: budget goes in the bracket alongside status
    // rather than adding a whole new line per row.
    const budgetPart = budget === undefined ? '' : `, ${budgetSegment(budget)}`
    const head = `- ${s.name}${you} [${s.status}${quiet}${named}, idle ${ago(s.idleMs)}${budgetPart}] — ${s.workingOn || 'no description'}`
    return `${head}${tagsLine(s.tags, now)}${declaredLine(s.declared)}${observedLine(s)}${claimLine(claims, s.name)}`
  })
  return `Active sessions:\n${accountUsageLine(budgets, slots)}\n${rows.join('\n')}${claimsFooter(claims, sessions, self)}`
}

/** What this session holds, on its own row, so the roster answers "who has what". */
function claimLine(claims: SessionClaim[], name: string): string {
  const mine = claims.filter(c => c.owner === name)
  if (mine.length === 0) return ''
  const parts = mine.map(c =>
    c.kind === 'worktree'
      ? `holds all of ${c.worktreePath}`
      : `holds ${c.patterns.join(', ')} in ${c.worktreePath}`,
  )
  return `\n    claim: ${parts.join(' | ')}`
}

/**
 * Named only when the reader could actually collide — same worktree, someone
 * else. A claim in a checkout you are not in is noise, and the whole value of
 * this signal depends on it not becoming noise (CC-56).
 */
function claimsFooter(claims: SessionClaim[], sessions: SessionInfo[], self: string | null): string {
  if (self === null) return ''
  const mine = sessions.find(s => s.name === self)?.observed?.worktreePath
  if (mine === undefined) return ''
  const here = claims.filter(c => c.worktreePath === mine && c.owner !== self)
  if (here.length === 0) return ''
  return (
    `\n\nIn your worktree (${mine}), ${here.map(c => `"${c.owner}"`).join(' and ')} ` +
    `${here.length === 1 ? 'has' : 'have'} claimed work. Message them before editing those paths — ` +
    `claims are advisory and mark who got there first.`
  )
}

/**
 * A raw socket client never sent `CLAUDE_CODE_SESSION_ID` on register, so a
 * roster row for it has no session id to read a budget from at all — a MISSING
 * reading like any other, not a distinct case a caller has to branch on.
 */
const readBudgetSafe = (sessionId: string | undefined, dir?: string): BudgetRead =>
  sessionId === undefined
    ? { found: false, path: '(no session id)', reason: 'no_file' }
    : readBudget(sessionId, Date.now(), dir)

export const chatList = defineTool({
  name: 'chat_list',
  description:
    'Check who else is active before you start any work that could overlap with someone else — an ' +
    'independent parallel task, editing a file another session might also touch, or before deciding to ' +
    'spawn an agent to do something a peer might already be doing. This is free and answers "is anyone ' +
    'already on this?" in one call. Call it proactively, at the start of a session and again before ' +
    "diverging into independent work — don't wait to be asked, and don't assume you're the only session " +
    'in this checkout.',
  args: z.object({}),
  result: z.string(),
  async run(_args, ctx) {
    const res = (await ctx.broker.request({ t: 'list' }, 'list_result')) as Extract<
      ServerMessage,
      { t: 'list_result' }
    >
    const budgets = res.sessions.map(s => ({
      name: s.name,
      // The status line writes into the cache of the account its own session runs
      // on, so a peer on a different one publishes where this process would never
      // look (CC-100).
      read: readBudgetSafe(s.observed?.claudeSessionId, s.observed?.configDir),
    }))
    return formatSessions(res.sessions, ctx.registeredName, res.claims ?? [], budgets, res.slots)
  },
})
