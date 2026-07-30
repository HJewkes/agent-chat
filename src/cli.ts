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
import { pairPresence } from './agents/identity.js'
import { transcriptLine } from './agents/transcript.js'

const USAGE = `agent-chat — cross-session messaging for Claude Code

  agent-chat inbox                     what your agents need from you
  agent-chat answer <id> <text>        answer a question; routes back to the asker
  agent-chat endorse <id>              approve a composed message; delivers it with your authority
  agent-chat dismiss <id>              close an item without answering, or decline an endorsement
  agent-chat send <to> <text>          message a session as the human
  agent-chat ps                        list registered sessions
  agent-chat history [n]               recent events from the log (default 30)
  agent-chat log [n]                   recent routing decisions
  agent-chat agent ls                  durable agents, with lifecycle and presence
  agent-chat agent spawn <name> <profile> <brief>
  agent-chat agent retire <name>       release isolation and free the name
  agent-chat agent surface <name>      bring a headless agent into a window you can answer
  agent-chat teleport abort <name>     stop a session ending itself for a successor
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
  endorse_request: 'ENDR ',
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
  const needsAnswer = (i: QueueItem): boolean =>
    i.kind === 'question' || i.kind === 'approval_request' || i.kind === 'endorse_request'
  const ordered = [...res.items].sort((a, b) => Number(needsAnswer(b)) - Number(needsAnswer(a)))

  for (const item of ordered) {
    console.log(`${LABEL[item.kind] ?? item.kind} ${item.msgId}  ${item.from.padEnd(14)} ${ago(item.at)}`)
    // The exact bytes that will be delivered, in full and untruncated. This
    // print IS the thing being endorsed — anything elided here would be
    // approved unread, which is the failure the whole flow exists to prevent.
    if (item.kind === 'endorse_request') {
      console.log(`      would be delivered to ${item.meta.recipient} as ${item.from}, with your authority:`)
      // CC-38: any free name is available to whoever registers it first.
      // recipient_durable distinguishes a broker-minted identity from a
      // self-chosen one that could belong to anybody.
      if (item.meta.recipient_durable === 'false') {
        const registeredAt = Number(item.meta.recipient_registered_at ?? Date.now())
        console.log(
          `      warning: "${item.meta.recipient}" has no durable Claude Code identity ` +
            `(registered ${ago(registeredAt)}) — a raw process could have claimed that name.`,
        )
      }
    }
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
  if (res.items.some(i => i.kind === 'endorse_request')) {
    console.log('endorse with: agent-chat endorse <id>   (or dismiss <id> to decline)')
  }
}

/**
 * Approve one composed message and deliver it with the human's authority.
 *
 * A CLI verb and nothing else, for the same reason `teleport abort` is one: the
 * broker refuses this frame from any registered connection, so the only caller
 * that can reach it is a person at a 0600 socket. No text argument — the bytes
 * are the ones already stored and already shown by `inbox`, which is what makes
 * the delivered message necessarily the one that was read.
 */
async function endorse(args: string[]): Promise<void> {
  const msgId = args[0]
  if (!msgId) {
    console.error('usage: agent-chat endorse <id>   (see agent-chat inbox for the full text)')
    process.exit(1)
  }
  const res = (await withBroker(b => b.request({ t: 'endorse_approve', msgId }, 'answer_result'))) as Extract<
    ServerMessage,
    { t: 'answer_result' }
  >
  if (!res.ok) {
    console.error(res.reason)
    process.exit(1)
  }
  console.log(`Endorsed ${msgId}; delivered as written.${res.reason ? ` ${res.reason}` : ''}`)
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

/**
 * The roster: durable lifecycle paired with ephemeral presence.
 *
 * More truthful than `ps` by construction — a live agent whose broker just
 * bounced shows as reconnecting rather than vanishing, because identity is a
 * query over the log and only presence depends on a socket being up.
 */
async function agentLs(): Promise<void> {
  const [agents, sessions] = await withBroker(async b => {
    const roster = (await b.request({ t: 'agents' }, 'agents_result')) as Extract<
      ServerMessage,
      { t: 'agents_result' }
    >
    const live = (await b.request({ t: 'list' }, 'list_result')) as Extract<
      ServerMessage,
      { t: 'list_result' }
    >
    return [roster.agents, live.sessions] as const
  })

  if (agents.length === 0) {
    console.log('No agents. Spawn one with: agent-chat agent spawn <name> <profile> "<brief>"')
    return
  }
  for (const agent of agents) {
    const connected = sessions.some(s => s.name === agent.name)
    const { status } = pairPresence(agent, { connected })
    // Lineage is advertised here rather than smuggled into the name: peers keep
    // addressing "planner" across a teleport, and this is where you find out
    // which generation of it you are talking to. Both fields are broker-derived,
    // so they are fact rather than an agent's claim about itself.
    const lineage = agent.teleportFrom ? `  gen=${agent.generation} from=${agent.teleportFrom}` : ''
    console.log(
      `${agent.name.padEnd(16)} ${status.padEnd(13)} ${agent.profile.padEnd(12)} ${agent.agentId}${lineage}`,
    )
    console.log(`${' '.repeat(16)} ${agent.cwd}`)
    console.log(`${' '.repeat(16)} ${transcriptLine(agent.cwd, agent.sessionId)}`)
  }
}

async function agentSpawn(args: string[]): Promise<void> {
  const [name, profile, ...words] = args
  if (!name || !profile || words.length === 0) {
    console.error('usage: agent-chat agent spawn <name> <profile> "<brief>"')
    process.exit(1)
  }
  const res = (await withBroker(b =>
    // The human holds no registry entry (§6.4), so the broker has no cwd to read
    // for them — send it, or the agent inherits the broker's arbitrary one.
    b.request({ t: 'spawn', name, profile, brief: words.join(' '), cwd: process.cwd() }, 'spawn_result'),
  )) as Extract<ServerMessage, { t: 'spawn_result' }>

  for (const warning of res.warnings ?? []) console.log(warning)
  console.log(res.ok ? `Spawned ${res.name} (${res.agentId}).` : `Not spawned: ${res.reason}`)
  process.exit(res.ok ? 0 : 1)
}

async function agentRetire(args: string[]): Promise<void> {
  const name = args[0]
  if (!name) {
    console.error('usage: agent-chat agent retire <name>')
    process.exit(1)
  }
  const res = (await withBroker(b => b.request({ t: 'retire', name }, 'spawn_result'))) as Extract<
    ServerMessage,
    { t: 'spawn_result' }
  >
  console.log(res.ok ? `Retired ${name}.` : `Not retired: ${res.reason}`)
  process.exit(res.ok ? 0 : 1)
}

/**
 * Bring a headless agent up where it can be seen and answered.
 *
 * A CLI verb because the human is the one who NOTICES. CC-2 established that a
 * headless session relays no permission prompts at all, so a blocked headless
 * agent cannot report being blocked — someone outside it has to pull it up. The
 * agent-facing tool exists too; this is the same operation for a person who is
 * looking at `agent ls` and can see one has gone quiet.
 *
 * No anchor: this connection holds no registration and therefore no pane, which
 * the iTerm ladder resolves as a new window rather than an error.
 */
async function agentSurface(args: string[]): Promise<void> {
  const name = args[0]
  if (!name) {
    console.error('usage: agent-chat agent surface <name>')
    process.exit(1)
  }
  const res = (await withBroker(b => b.request({ t: 'surface', name }, 'switch_result'))) as Extract<
    ServerMessage,
    { t: 'switch_result' }
  >
  console.log(
    res.ok
      ? `${name} is now in ${res.surface}, resumed on its existing conversation. ` +
          'The turn it was part way through was interrupted.'
      : `Not surfaced: ${res.reason}`,
  )
  process.exit(res.ok ? 0 : 1)
}

async function agent(args: string[]): Promise<void> {
  const [verb, ...rest] = args
  switch (verb) {
    case 'ls':
    case undefined:
      return agentLs()
    case 'spawn':
      return agentSpawn(rest)
    case 'retire':
      return agentRetire(rest)
    case 'surface':
      return agentSurface(rest)
    default:
      console.error(`unknown agent verb "${verb}"; try ls, spawn, surface or retire`)
      process.exit(1)
  }
}

/**
 * The human's veto on a teleport countdown, and deliberately a CLI verb rather
 * than a tool: the countdown exists so a person can stop a session ending
 * itself, and a veto any agent could exercise is not a veto. The broker refuses
 * this frame from a registered connection; this one holds no registration.
 */
async function teleportAbort(args: string[]): Promise<void> {
  const name = args[0]
  if (!name) {
    console.error('usage: agent-chat teleport abort <name>')
    process.exit(1)
  }
  const res = (await withBroker(b => b.request({ t: 'teleport_abort', name }, 'teleport_result'))) as Extract<
    ServerMessage,
    { t: 'teleport_result' }
  >
  console.log(res.ok ? `Stopped ${name}'s teleport. It is still live, on the old build.` : res.reason)
  process.exit(res.ok ? 0 : 1)
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
    case 'endorse':
      return endorse(args)
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
    case 'agent':
      return agent(args)
    case 'teleport': {
      const [sub, ...rest] = args
      if (sub !== 'abort') {
        console.error('usage: agent-chat teleport abort <name>')
        process.exit(1)
      }
      return teleportAbort(rest)
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
