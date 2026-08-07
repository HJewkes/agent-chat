import { logPath } from '../paths.js'
import { type ServerMessage } from '../protocol.js'
import { fail, withBroker } from './client.js'

export async function ps(): Promise<void> {
  const res = (await withBroker(b => b.request({ t: 'list' }, 'list_result'))) as Extract<
    ServerMessage,
    { t: 'list_result' }
  >
  if (res.sessions.length === 0) {
    console.log('No sessions registered.')
    return
  }
  for (const s of res.sessions) {
    const idle = s.idleMs < 60_000 ? `${Math.round(s.idleMs / 1000)}s` : `${Math.round(s.idleMs / 60_000)}m`
    console.log(`${s.name.padEnd(16)} ${s.status.padEnd(10)} idle ${idle.padEnd(6)} ${s.workingOn}`)
    console.log(`${' '.repeat(16)} ${s.cwd}`)
  }
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
export async function claims(): Promise<void> {
  const res = (await withBroker(b => b.request({ t: 'list' }, 'list_result'))) as Extract<
    ServerMessage,
    { t: 'list_result' }
  >
  const held = res.claims ?? []
  if (held.length === 0) {
    console.log('No claims held.')
    return
  }
  const byWorktree = new Map<string, typeof held>()
  for (const claim of held) {
    const group = byWorktree.get(claim.worktreePath)
    if (group) group.push(claim)
    else byWorktree.set(claim.worktreePath, [claim])
  }
  for (const [worktree, group] of byWorktree) {
    console.log(worktree)
    for (const claim of group) {
      const what = claim.kind === 'worktree' ? '(whole worktree)' : claim.patterns.join(', ')
      console.log(`  ${claim.owner.padEnd(16)} ${what}`)
    }
  }
}

export async function send(to: string, words: string[]): Promise<void> {
  if (words.length === 0) fail('usage: agent-chat debug send <to> <text>')
  const res = (await withBroker(b =>
    b.request({ t: 'human_send', to, text: words.join(' ') }, 'send_result'),
  )) as Extract<ServerMessage, { t: 'send_result' }>

  console.log(res.ok ? `Delivered to ${to} (msg_id ${res.msgId}).` : `Not delivered: ${res.reason}`)
  process.exit(res.ok ? 0 : 1)
}

export async function history(limit: number): Promise<void> {
  const res = (await withBroker(b => b.request({ t: 'history', limit }, 'history_result'))) as Extract<
    ServerMessage,
    { t: 'history_result' }
  >
  for (const item of res.items) {
    const target = item.meta.target ? ` -> ${item.meta.target}` : ''
    console.log(
      `${item.kind.padEnd(17)} ${item.from.padEnd(12)}${target.padEnd(14)} ${item.text.slice(0, 60)}`,
    )
  }
}

export async function routingLog(limit: number): Promise<void> {
  console.log(`routing decisions: tail -f ${logPath()} | grep route`)
  return history(limit)
}
