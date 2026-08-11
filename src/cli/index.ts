// FIRST, before anything that can touch node:sqlite — including the imports
// below, which reach the event log transitively. See warnings.ts.
import './warnings.js'

import { Command } from 'commander'
import { VERSION } from '../broker/version.js'
import { socketPath } from '../paths.js'
import * as agents from './agents.js'
import * as debug from './debug.js'
import { doctor } from './doctor.js'
import * as human from './human.js'
import * as service from './service.js'
import { watch, type WatchOptions } from './watch.js'

const HUMAN = 'Human commands:'
const AGENTS = 'Agent commands:'

/**
 * `inbox`/`answer`/`dismiss` are top-level rather than under a `human` noun on
 * purpose: they are the daily verbs and the dashboard's CLI peer, and the whole
 * argument for keeping a CLI at all (§10) is that they stay the shortest thing
 * to type when the dashboard is not reachable. The grouping is in the help.
 */
function addHumanCommands(program: Command): void {
  program.command('inbox').description('what your agents need from you').helpGroup(HUMAN).action(human.inbox)

  program
    .command('answer <id> <text...>')
    .description('answer a question; routes back to the asker')
    .helpGroup(HUMAN)
    .action((id: string, text: string[]) => human.verdict(id, text, 'answer'))

  program
    .command('dismiss <id>')
    .description('close an item without answering, or decline an endorsement')
    .helpGroup(HUMAN)
    .action((id: string) => human.verdict(id, [], 'dismiss'))

  program
    .command('endorse <id>')
    .description('approve a composed message; delivers it with your authority')
    .helpGroup(HUMAN)
    .action(human.endorse)
}

const port = (value: string): number => {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed >= 65536) throw new Error(`bad port: ${value}`)
  return parsed
}

function addServiceCommands(program: Command): void {
  const svc = program.command('service').description('run and inspect the broker daemon')

  svc
    .command('start')
    .description('start the broker, detached by default')
    .option('-p, --port <port>', 'HTTP port to bind', port)
    .option('-f, --foreground', 'run in this terminal instead of detaching')
    .action(service.start)

  svc.command('stop').description('SIGTERM the broker, then SIGKILL if it lingers').action(service.stop)

  svc
    .command('status')
    .description('socket, pid file and /health, reported separately')
    .option('-p, --port <port>', 'port to probe for /health', port)
    .action(service.status)

  svc
    .command('restart')
    .description('stop then start, reusing the port from broker.meta.json')
    .option('-p, --port <port>', 'bind this port instead of the recorded one', port)
    .action(service.restart)

  svc
    .command('logs')
    .description('tail the broker log; no --follow, by design')
    .option('-n, --lines <n>', 'how many lines', (v: string) => Number.parseInt(v, 10), 50)
    .action(service.logs)

  svc
    .command('open')
    .description('open the dashboard, or print its URL when not a TTY')
    .option('-p, --port <port>', 'port the dashboard is on', port)
    .action(service.open)
}

/** The tier the dashboard largely replaces day to day (§10). */
function addDebugCommands(program: Command): void {
  const dbg = program.command('debug').description('diagnostics: sessions, history, routing')

  dbg.command('ps').description('list registered sessions').action(debug.ps)
  dbg.command('claims').description('who holds which worktrees and paths').action(debug.claims)
  dbg
    .command('history [n]')
    .description('recent events from the log (default 30)')
    .action((n?: string) => debug.history(Number(n ?? 30)))
  dbg
    .command('log [n]')
    .description('recent routing decisions')
    .action((n?: string) => debug.routingLog(Number(n ?? 20)))
  dbg.command('send <to> <text...>').description('message a session as the human').action(debug.send)
}

function addAgentCommands(program: Command): void {
  program
    .command('watch <name>')
    .description('stream messages for a session that cannot receive channel pushes')
    .helpGroup(AGENTS)
    .option('--since <id|now|all>', 'start from a log id, the current head, or the whole backlog', 'now')
    .option('--interval <seconds>', 'how often to poll', '2')
    .option('--once', 'print what is waiting and exit, instead of following')
    .action((name: string, options: WatchOptions) => watch(name, options))

  const agent = program.command('agent').description('durable agents').helpGroup(AGENTS)

  agent
    .command('ls', { isDefault: true })
    .description('agents, with lifecycle and presence')
    .action(agents.agentLs)
  agent
    // The brief is OPTIONAL in argv only because `--brief-stdin` is the other
    // way to supply it; `resolveBrief` still refuses a spawn with neither, so
    // the usage error moved rather than disappeared.
    .command('spawn <name> <profile> [brief...]')
    .description('start a new agent')
    .option('--briefing <slug|auto>', "prepend an active-work initiative's orientation to the brief")
    .option('--brief-stdin', 'read the brief from stdin, keeping it out of world-readable argv')
    .action(agents.agentSpawn)
  agent
    .command('retire <name>')
    .description('release isolation, end the process, and free the name')
    .action(agents.agentRetire)
  agent
    .command('surface <name>')
    .description('bring a headless agent into a window you can answer')
    .action(agents.agentSurface)

  program
    .command('teleport')
    .description('teleport control')
    .helpGroup(AGENTS)
    .command('abort <name>')
    .description('stop a session ending itself for a successor')
    .action(agents.teleportAbort)

  program
    .command('profiles')
    .description('agent profiles available to spawn with')
    .helpGroup(AGENTS)
    .action(agents.profiles)
}

/**
 * Two process-launch contracts and one release of grace.
 *
 * `broker` and `mcp` are spelled exactly as they always were because other code
 * spawns them by those strings: `broker-client.ts` spawns `[cliEntry(), 'broker']`
 * and `plugin.json` passes `args: ["mcp"]`. Renaming either breaks agent spawning
 * and the MCP server respectively, with no compile-time warning. Changing them
 * means changing the spawn site and the plugin manifest in the same commit.
 *
 * The flat verbs below are the pre-restructure spelling, kept working for one
 * release because the README and `docs/ideas.md` name them.
 */
function addHiddenCommands(program: Command): void {
  program.command('broker', { hidden: true }).action(() => service.start({ foreground: true }))

  program.command('mcp', { hidden: true }).action(async () => {
    const { startMcpServer } = await import('../server/index.js')
    await startMcpServer()
  })

  program.command('run-agent <id>', { hidden: true }).action(async (id: string) => {
    const { runAgent } = await import('../agents/run-agent.js')
    await runAgent(id)
  })

  program.command('ps', { hidden: true }).action(debug.ps)
  program.command('history [n]', { hidden: true }).action((n?: string) => debug.history(Number(n ?? 30)))
  program.command('log [n]', { hidden: true }).action((n?: string) => debug.routingLog(Number(n ?? 20)))
  program.command('send <to> <text...>', { hidden: true }).action(debug.send)
}

export function buildProgram(): Command {
  const program = new Command('agent-chat')
    .description('cross-session messaging for Claude Code')
    .version(VERSION)
    .addHelpText(
      'after',
      `\nBroker socket: ${socketPath()}\nState lives in ~/.agent-chat (override with AGENT_CHAT_HOME).`,
    )
    .showHelpAfterError()

  addHumanCommands(program)
  addServiceCommands(program)
  addDebugCommands(program)
  program.command('doctor').description('check the things that fail silently').action(doctor)
  addAgentCommands(program)
  addHiddenCommands(program)
  return program
}

export async function run(argv: string[] = process.argv): Promise<void> {
  const program = buildProgram()
  if (argv.length <= 2) {
    program.outputHelp()
    return
  }
  await program.parseAsync(argv)
}
