import type { Command } from 'commander'
import { startCodexAppServer } from '../../codex/app-server-client.js'
import { superviseCodex } from '../../codex/supervisor.js'
import { cliEntry } from '../../paths.js'

/** `-c` overrides that put agent-chat's MCP server, marked as a Codex host, under the app-server. */
export function mcpOverrides(nodePath: string, entry: string): string[] {
  const toml = (value: unknown): string => JSON.stringify(value)
  return [
    `mcp_servers.agent-chat.command=${toml(nodePath)}`,
    `mcp_servers.agent-chat.args=${toml([entry, 'mcp'])}`,
    'mcp_servers.agent-chat.env={AGENT_CHAT_HOST="codex"}',
  ].flatMap(override => ['-c', override])
}

export const appServerArgs = (codexArgs: readonly string[]): string[] => [
  'app-server',
  ...mcpOverrides(process.execPath, cliEntry()),
  ...codexArgs,
]

interface RunOptions {
  resume?: string
  wakeCap?: string
  codex?: string
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
    args: appServerArgs(codexArgs),
  })
  const forward = (signal: NodeJS.Signals) => () => void server.close(signal)
  process.once('SIGINT', forward('SIGINT')).once('SIGTERM', forward('SIGTERM'))
  process.exitCode = await superviseCodex({ server, resume: options.resume, cwd: process.cwd(), wakeCap })
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
    .option('--resume <thread>', 'resume this Codex thread instead of starting one')
    .option('--wake-cap <n>', 'at most n idle wakes per hour; uncapped by default')
    .option('--codex <path>', 'the codex executable', 'codex')
    .action((codexArgs: string[], options: RunOptions) => runCodex(codexArgs, options))
}
