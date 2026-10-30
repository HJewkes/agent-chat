import os from 'node:os'
import type { Command } from 'commander'
import { startCodexAppServer } from '../../codex/app-server-client.js'
import { superviseCodex, type ThreadDelivery } from '../../codex/supervisor.js'
import { AGENT_NAME_PATTERN } from '../../launch-identity.js'
import { EventLog } from '../../broker/event-log.js'
import { cliEntry } from '../../paths.js'
import type { AppendInput } from '../../broker/event-store.js'
import type { ClientMessage, ServerMessage } from '../../protocol.js'
import { withBroker } from '../client.js'

/**
 * `-c` overrides that put agent-chat's MCP server, marked as a Codex host, under the app-server.
 * A `name` goes in its env as `AGENT_CHAT_NAME`, which it registers under before any turn (CC-1545).
 * Codex passes MCP children only a short allowlist of variables, so `AGENT_CHAT_HOME` must go in
 * here too: without it the server joins the default broker and spools where the supervisor never looks.
 */
export function mcpOverrides(nodePath: string, entry: string, name?: string, home?: string): string[] {
  const toml = (value: unknown): string => JSON.stringify(value)
  const named = name === undefined ? '' : `,AGENT_CHAT_NAME=${toml(name)}`
  const homed = home === undefined ? '' : `,AGENT_CHAT_HOME=${toml(home)}`
  return [
    `mcp_servers.agent-chat.command=${toml(nodePath)}`,
    `mcp_servers.agent-chat.args=${toml([entry, 'mcp'])}`,
    `mcp_servers.agent-chat.env={AGENT_CHAT_HOST="codex"${named}${homed}}`,
  ].flatMap(override => ['-c', override])
}

export const appServerArgs = (codexArgs: readonly string[], name?: string): string[] => [
  'app-server',
  ...mcpOverrides(process.execPath, cliEntry(), name, process.env.AGENT_CHAT_HOME),
  ...codexArgs,
]

interface RunOptions {
  name?: string
  resume?: string
  wakeCap?: string
  codex?: string
}

const NAME = new RegExp(`^${AGENT_NAME_PATTERN}$`)

export function parseName(raw: string | undefined): string | undefined {
  if (raw === undefined || NAME.test(raw)) return raw
  throw new Error(
    `--name wants lowercase letters, digits, - and _, starting with a letter or digit; got ${raw}`,
  )
}

type Request = (frame: ClientMessage) => Promise<ServerMessage>

/**
 * Tell the broker, which tells the session's spawner. Never starts a broker for it: with
 * none running, or no session registered from that pid, the line goes to stderr instead.
 */
export async function reportWakeCapped(
  hostPids: number[],
  cap: number,
  send: (fn: (request: Request) => Promise<void>) => Promise<void> = fn =>
    withBroker(broker => fn(frame => broker.request(frame, 'send_result')), { autoStart: false }),
): Promise<void> {
  try {
    await send(async request => {
      for (const hostPid of hostPids) {
        const res = await request({ t: 'codex_wake_capped', hostPid, host: os.hostname(), cap })
        if (res.t !== 'send_result' || !res.ok) throw new Error(res.t === 'send_result' ? res.reason : res.t)
      }
    })
  } catch {
    process.stderr.write(`agent-chat codex run: wake cap of ${cap}/hour reached; records wait in the spool\n`)
  }
}

/** CC-1680: the receipt for one message handed to the thread, written straight into events.db like the inbox hook's. */
export function recordDelivered(
  log: { append(input: AppendInput): unknown },
  actor: string,
  delivery: ThreadDelivery,
): void {
  log.append({
    kind: 'delivered_to_thread',
    actor,
    ref: delivery.threadId,
    meta: {
      msgId: delivery.msgId,
      mode: delivery.mode,
      ...(delivery.latencyMs === undefined ? {} : { latencyMs: String(delivery.latencyMs) }),
    },
  })
}

function writeDelivered(actor: string, delivery: ThreadDelivery): void {
  try {
    const log = new EventLog()
    try {
      recordDelivered(log, actor, delivery)
    } finally {
      log.close()
    }
  } catch {
    // A receipt must never cost the delivery it describes.
  }
}

function parseWakeCap(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const cap = Number(raw)
  if (!Number.isInteger(cap) || cap < 1) throw new Error(`--wake-cap wants a positive integer, got ${raw}`)
  return cap
}

async function runCodex(codexArgs: string[], options: RunOptions): Promise<void> {
  const wakeCap = parseWakeCap(options.wakeCap)
  const server = await startCodexAppServer({
    cwd: process.cwd(),
    env: process.env,
    executablePath: options.codex,
    args: appServerArgs(codexArgs, parseName(options.name)),
  })
  const forward = (signal: NodeJS.Signals) => () => void server.close(signal)
  process.once('SIGINT', forward('SIGINT')).once('SIGTERM', forward('SIGTERM'))
  process.exitCode = await superviseCodex({
    server,
    resume: options.resume,
    cwd: process.cwd(),
    wakeCap,
    onWakeCapped: (hostPids, cap) => void reportWakeCapped(hostPids, cap),
    onDelivered: delivery => writeDelivered(options.name ?? 'codex', delivery),
  })
}

export function addCodexCommands(program: Command, helpGroup: string): void {
  const codex = program
    .command('codex')
    .description('run Codex sessions on the agent-chat bus')
    .helpGroup(helpGroup)
  codex
    .command('run [codexArgs...]')
    .description(
      'run `codex app-server` and deliver agent-chat messages to its thread: a steer while a turn runs, ' +
        'a new turn when idle; exits with the app-server exit code (CC-1523)',
    )
    .option('--name <name>', 'register the session under this name, so peers can address it')
    .option('--resume <thread>', 'resume this Codex thread instead of starting one')
    .option('--wake-cap <n>', 'at most n idle wakes per hour; uncapped by default')
    .option('--codex <path>', 'the codex executable', 'codex')
    .action((codexArgs: string[], options: RunOptions) => runCodex(codexArgs, options))
}
