import { logPath } from '../paths.js'
import { type ServerMessage } from '../protocol.js'
import type { Report } from './command.js'
import { fail, withBroker } from './client.js'

export function describePs(res: Extract<ServerMessage, { t: 'list_result' }>): Report {
  if (res.sessions.length === 0) return { ok: true, lines: ['No sessions registered.'] }
  const lines: string[] = []
  for (const s of res.sessions) {
    const idle = s.idleMs < 60_000 ? `${Math.round(s.idleMs / 1000)}s` : `${Math.round(s.idleMs / 60_000)}m`
    lines.push(`${s.name.padEnd(16)} ${s.status.padEnd(10)} idle ${idle.padEnd(6)} ${s.workingOn}`)
    lines.push(`${' '.repeat(16)} ${s.cwd}`)
  }
  return { ok: true, lines }
}

/**
 * Who currently holds what (CC-56).
 *
 * Claims are otherwise visible only to agents, through `chat_list`, which leaves
 * a human diagnosing "why was that refused" with nothing to look at.
 *
 * Grouped by worktree because the worktree is the unit of collision: claims in
 * two different ones never contend, so a flat list would invite exactly the
 * misreading the design exists to prevent.
 */
export function describeClaims(res: Extract<ServerMessage, { t: 'list_result' }>): Report {
  const held = res.claims ?? []
  if (held.length === 0) return { ok: true, lines: ['No claims held.'] }
  const byWorktree = new Map<string, typeof held>()
  for (const claim of held) {
    const group = byWorktree.get(claim.worktreePath)
    if (group) group.push(claim)
    else byWorktree.set(claim.worktreePath, [claim])
  }
  const lines: string[] = []
  for (const [worktree, group] of byWorktree) {
    lines.push(worktree)
    for (const claim of group) {
      const what = claim.kind === 'worktree' ? '(whole worktree)' : claim.patterns.join(', ')
      lines.push(`  ${claim.owner.padEnd(16)} ${what}`)
    }
  }
  return { ok: true, lines }
}

export async function send(to: string, words: string[]): Promise<void> {
  if (words.length === 0) fail('usage: agent-chat debug send <to> <text>')
  const res = (await withBroker(b =>
    b.request({ t: 'human_send', to, text: words.join(' ') }, 'send_result'),
  )) as Extract<ServerMessage, { t: 'send_result' }>

  console.log(res.ok ? `Delivered to ${to} (msg_id ${res.msgId}).` : `Not delivered: ${res.reason}`)
  process.exit(res.ok ? 0 : 1)
}

export function describeHistory(res: Extract<ServerMessage, { t: 'history_result' }>): Report {
  const lines = res.items.map(item => {
    const target = item.meta.target ? ` -> ${item.meta.target}` : ''
    return `${item.kind.padEnd(17)} ${item.from.padEnd(12)}${target.padEnd(14)} ${item.text.slice(0, 60)}`
  })
  return { ok: true, lines }
}

export function describeRoutingLog(res: Extract<ServerMessage, { t: 'history_result' }>): Report {
  const { lines } = describeHistory(res)
  return { ok: true, lines: [`routing decisions: tail -f ${logPath()} | grep route`, ...lines] }
}
