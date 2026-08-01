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
