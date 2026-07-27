#!/usr/bin/env node
// node:sqlite is still flagged experimental and warns on first use. The warning
// would land in every CLI invocation and, worse, in the MCP server's stderr.
process.removeAllListeners('warning')
process.on('warning', warning => {
  if (warning.name !== 'ExperimentalWarning' || !warning.message.includes('SQLite')) console.warn(warning)
})

import { startBroker } from './broker/index.js'
import { startMcpServer } from './server/index.js'
import { BrokerClient } from './client/broker-client.js'
import { logPath, socketPath } from './paths.js'
import { type QueueItem, type ServerMessage } from './protocol.js'
import { runAgent } from './agents/run-agent.js'
import { listProfileNames, loadProfile } from './agents/profiles.js'

const USAGE = `agent-chat — cross-session messaging for Claude Code

  agent-chat inbox                     what your agents need from you
  agent-chat answer <id> <text>        answer a question; routes back to the asker
  agent-chat dismiss <id>              close an item without answering
  agent-chat send <to> <text>          message a session as the human
  agent-chat ps                        list registered sessions
  agent-chat history [n]               recent events from the log (default 30)
  agent-chat log [n]                   recent routing decisions
  agent-chat profiles                  agent profiles available to spawn with
  agent-chat run-agent <id>            run a planned agent (surfaces call this)
  agent-chat broker                    run the broker in the foreground
  agent-chat mcp                       the MCP server (Claude Code spawns this)

State lives in ~/.agent-chat (override with AGENT_CHAT_HOME).`

/** Short-lived client for the one-shot CLI verbs. */
async function withBroker<T>(fn: (broker: BrokerClient) => Promise<T>): Promise<T> {
  const broker = new BrokerClient(() => undefined)
  await broker.connect()
  try {
    return await fn(broker)
  } finally {
    broker.close()
  }
}

const ago = (at: number): string => {
  const ms = Date.now() - at
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`
  return `${Math.round(ms / 3_600_000)}h ago`
}

const LABEL: Record<string, string> = {
  question: 'ASK  ',
  approval_request: 'APPR ',
  notice: 'note ',
  message: 'msg  ',
}

async function inbox(): Promise<void> {
  const res = (await withBroker(b => b.request({ t: 'queue' }, 'queue_result'))) as Extract<
    ServerMessage,
    { t: 'queue_result' }
  >
  if (res.items.length === 0) {
    console.log('Nothing waiting.')
    return
  }
  // Things that need an answer first; notices are just there when you look.
  const needsAnswer = (i: QueueItem): boolean => i.kind === 'question' || i.kind === 'approval_request'
  const ordered = [...res.items].sort((a, b) => Number(needsAnswer(b)) - Number(needsAnswer(a)))

  for (const item of ordered) {
    console.log(`${LABEL[item.kind] ?? item.kind} ${item.msgId}  ${item.from.padEnd(14)} ${ago(item.at)}`)
    console.log(`      ${item.text}`)
    // For an approval the description is often just "Run shell command", so the
    // preview is the only place the actual command shows up.
    if (item.meta.input_preview) console.log(`      ${item.meta.input_preview.slice(0, 200)}`)
  }
  const open = res.items.filter(needsAnswer).length
  const blocked = res.items.filter(i => i.kind === 'approval_request')
  console.log(`\n${res.items.length} waiting, ${open} needing an answer.`)
  if (blocked.length > 0) {
    const who = [...new Set(blocked.map(i => i.from))].join(', ')
    console.log(`${who} blocked on a permission prompt — answer in that session's terminal.`)
  }
  if (open > blocked.length) console.log('answer with: agent-chat answer <id> "..."')
}

async function answer(args: string[], verb: 'answer' | 'dismiss'): Promise<void> {
  const [msgId, ...words] = args
  if (!msgId || (verb === 'answer' && words.length === 0)) {
    console.error(`usage: agent-chat ${verb} <id>${verb === 'answer' ? ' <text>' : ''}`)
    process.exit(1)
  }
  const request =
    verb === 'answer'
      ? ({ t: 'answer', msgId, text: words.join(' ') } as const)
      : ({ t: 'dismiss', msgId } as const)

  const res = (await withBroker(b => b.request(request, 'answer_result'))) as Extract<
    ServerMessage,
    { t: 'answer_result' }
  >
  if (!res.ok) {
    console.error(res.reason)
    process.exit(1)
  }
  console.log(
    verb === 'answer' ? `Answered ${msgId}.${res.reason ? ` ${res.reason}` : ''}` : `Dismissed ${msgId}.`,
  )
}

async function ps(): Promise<void> {
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

async function send(args: string[]): Promise<void> {
  const [to, ...words] = args
  if (!to || words.length === 0) {
    console.error('usage: agent-chat send <to> <text>')
    process.exit(1)
  }
  const res = (await withBroker(b =>
    b.request({ t: 'human_send', to, text: words.join(' ') }, 'send_result'),
  )) as Extract<ServerMessage, { t: 'send_result' }>

  console.log(res.ok ? `Delivered to ${to} (msg_id ${res.msgId}).` : `Not delivered: ${res.reason}`)
  process.exit(res.ok ? 0 : 1)
}

async function history(limit: number): Promise<void> {
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

function profiles(): void {
  for (const name of listProfileNames()) {
    const profile = loadProfile(name)
    if ('error' in profile) {
      console.log(`${name.padEnd(14)} !! ${profile.error}`)
      continue
    }
    console.log(
      `${name.padEnd(14)} ${profile.model.padEnd(7)} ${profile.surface.padEnd(12)} ${profile.description}`,
    )
    console.log(`${' '.repeat(14)} tools: ${profile.allowedTools.join(', ')}`)
  }
}

async function main(): Promise<void> {
  const [verb, ...args] = process.argv.slice(2)
  switch (verb) {
    case 'mcp':
      return startMcpServer()
    case 'broker': {
      const server = await startBroker()
      if (!server) console.error(`a broker is already listening on ${socketPath()}`)
      return
    }
    case 'inbox':
      return inbox()
    case 'answer':
      return answer(args, 'answer')
    case 'dismiss':
      return answer(args, 'dismiss')
    case 'ps':
      return ps()
    case 'send':
      return send(args)
    case 'history':
      return history(Number(args[0] ?? 30))
    case 'log':
      console.log(`routing decisions: tail -f ${logPath()} | grep route`)
      return history(Number(args[0] ?? 20))
    case 'run-agent': {
      const agentId = args[0]
      if (agentId === undefined) throw new Error('usage: agent-chat run-agent <agent-id>')
      return runAgent(agentId)
    }
    case 'profiles':
      return profiles()
    default:
      console.log(USAGE)
      process.exit(verb === undefined || verb === '--help' || verb === '-h' ? 0 : 1)
  }
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
