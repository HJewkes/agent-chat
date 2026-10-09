// FIRST, before anything that can touch node:sqlite — including the imports
// below, which reach the event log transitively. See warnings.ts.
import './warnings.js'

import { Command } from 'commander'
import { MAX_HOLD_SECONDS } from '../broker/hold.js'
import { VERSION } from '../broker/version.js'
import { socketPath } from '../paths.js'
import * as agents from './agents.js'
import { addVerb } from './command.js'
import { agentBudgetVerb } from './verbs/agent-budget.js'
import { agentRetire } from './verbs/agent-retire.js'
import { agentPark } from './verbs/agent-park.js'
import { agentResume } from './verbs/agent-resume.js'
import { agentSurfaceVerb } from './verbs/agent-surface.js'
import { agentWorktreesVerb } from './verbs/agent-worktrees.js'
import { approveVerb } from './verbs/approve.js'
import { debugClaimsVerb } from './verbs/debug-claims.js'
import { debugHistoryVerb } from './verbs/debug-history.js'
import { debugLogVerb } from './verbs/debug-log.js'
import { debugPsVerb } from './verbs/debug-ps.js'
import { digestVerb } from './verbs/digest.js'
import { dismissVerb } from './verbs/dismiss.js'
import { doctorVerb } from './verbs/doctor.js'
import { endorseVerb } from './verbs/endorse.js'
import { handoffLastVerb } from './verbs/handoff-last.js'
import { inboxVerb } from './verbs/inbox.js'
import { addMirrorCommands } from './verbs/mirror.js'
import { addBurndownCommands } from './verbs/burndown.js'
import { addSeatsCommands } from './verbs/seats.js'
import { profilesVerb } from './verbs/profiles.js'
import { teleportAbortVerb } from './verbs/teleport-abort.js'
import * as debug from './debug.js'
import { doctorLifecycleCommand } from './doctor-lifecycle.js'
import * as human from './human.js'
import { addLifecycleCommands } from './lifecycle.js'
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
  addVerb(program, inboxVerb, { helpGroup: HUMAN })

  program
    .command('answer <id> <text...>')
    .description('answer a question; routes back to the asker')
    .helpGroup(HUMAN)
    .action((id: string, text: string[]) => human.verdict(id, text, 'answer'))

  addVerb(program, dismissVerb, { helpGroup: HUMAN })
  addVerb(program, approveVerb, { helpGroup: HUMAN })
  addVerb(program, endorseVerb, { helpGroup: HUMAN })
  addVerb(program, digestVerb, { helpGroup: HUMAN })
}

const port = (value: string): number => {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed >= 65536) throw new Error(`bad port: ${value}`)
  return parsed
}

const holdSeconds = (value: string): number => {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > MAX_HOLD_SECONDS)
    throw new Error(`bad --hold: ${value} (whole seconds, 1 to ${MAX_HOLD_SECONDS})`)
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

  svc
    .command('stop')
    .description(
      'SIGTERM the broker, then SIGKILL if it lingers; refuses while an agent is mid-spawn or an ask is unanswered; --hold keeps auto-starts off for a while',
    )
    .option('--force', 'stop even if a spawn or an unanswered ask would be lost')
    .option(
      '--hold <seconds>',
      `refuse broker starts, including auto-starts, for this long (at most ${MAX_HOLD_SECONDS})`,
      holdSeconds,
    )
    .action(service.stop)

  svc
    .command('status')
    .description('socket, pid file and /health, reported separately')
    .option('-p, --port <port>', 'port to probe for /health', port)
    .action(service.status)

  svc
    .command('restart')
    .description(
      'stop then start, reusing the port from broker.meta.json; refuses while an agent is mid-spawn or an ask is unanswered',
    )
    .option('-p, --port <port>', 'bind this port instead of the recorded one', port)
    .option('--force', 'restart even if a spawn or an unanswered ask would be lost')
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

  addVerb(dbg, debugPsVerb)
  addVerb(dbg, debugClaimsVerb)
  addVerb(dbg, debugHistoryVerb)
  addVerb(dbg, debugLogVerb)
  dbg
    .command('send <to> <text...>')
    .description('message a session as the human')
    .option(
      '--source <source>',
      'record the send as made by this source (watchdog, shepherd) in the event log',
    )
    .action(debug.send)
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
    .option('--json', 'print one JSON array, one object per agent')
    .option('--mine', 'only agents you spawned (needs a registered session name)')
    .option('--spawner <name>', 'only agents spawned by <name>')
    .option('--prefix <p>', 'only agents whose name starts with <p>')
    .action(agents.agentLs)
  agent
    // The brief is OPTIONAL in argv only because `--brief-stdin` is the other
    // way to supply it; `resolveBrief` still refuses a spawn with neither, so
    // the usage error moved rather than disappeared.
    .command('spawn <name> <profile> [brief...]')
    .description('start a new agent')
    .option('--briefing <slug|auto>', "prepend an active-work initiative's orientation to the brief")
    .option('--brief-stdin', 'read the brief from stdin, keeping it out of world-readable argv')
    .option('--config-dir <path>', 'the Claude config dir, and therefore the account, to run it on')
    .action(agents.agentSpawn)
  addVerb(agent, agentRetire)
  addVerb(agent, agentPark)
  addVerb(agent, agentResume)
  addVerb(agent, agentWorktreesVerb)
  addVerb(agent, agentSurfaceVerb)
  addVerb(agent, agentBudgetVerb)

  const teleport = program.command('teleport').description('teleport control').helpGroup(AGENTS)
  addVerb(teleport, teleportAbortVerb)

  const handoff = program.command('handoff').description('stored teleport handoffs').helpGroup(AGENTS)
  addVerb(handoff, handoffLastVerb)

  addVerb(program, profilesVerb, { helpGroup: AGENTS })

  program
    .command('gh-write <gh-args...>')
    .description('one gh write after --, spaced machine-wide and retried on the secondary rate limit')
    .helpGroup(AGENTS)
    .addHelpText(
      'after',
      [
        '',
        'Every title and body is leak-scanned before gh starts. Post a body in one call from a quoted heredoc:',
        "  agent-chat gh-write -- pr create -R <owner>/<repo> -t <title> --body-file - <<'EOF'",
        '  ...',
        '  EOF',
        '--body-file <path> works too, for pr and issue create, edit and comment.',
      ].join('\n'),
    )
    .action(async (args: string[]) => {
      const { ghWriteCommand } = await import('./gh-write.js')
      await ghWriteCommand(args)
    })

  program
    .command('suite-slot <command...>')
    .description('run a full test suite after --, holding one of the machine-wide full-suite slots')
    .helpGroup(AGENTS)
    .action(async (command: string[]) => {
      const { suiteSlotCommand } = await import('./suite-slot.js')
      await suiteSlotCommand(command)
    })

  program
    .command('leak-scan')
    .description('scan added lines for private data; exit 0 clean, 1 findings, 2 cannot pass')
    .helpGroup(AGENTS)
    .option('--range <from..to>', 'scan added lines, added file names and commit messages in this range')
    .option('--text-file <file>', 'scan every line of a file, such as a PR body')
    .option('--json', 'print one JSON object with the findings')
    // A usage error must not exit 1, which means "findings".
    .exitOverride(err => process.exit(err.exitCode === 0 ? 0 : 2))
    .action(async (options: { range?: string; textFile?: string; json?: boolean }) => {
      const { leakScan } = await import('./verbs/leak-scan.js')
      process.exitCode = await leakScan(options)
    })

  program
    .command('pr-ready')
    .description(
      'before gh pr create: clean tree, rebase, checks, changeset, leak scan; exit 0 only when all pass',
    )
    .helpGroup(AGENTS)
    .option('--title <t>', "PR title, scanned with gh-write's leak scan")
    .option('--body-file <path>', "PR body file, scanned with gh-write's leak scan")
    .option('--no-rebase', 'check and report only; do not rebase onto the default branch')
    .option('--strict', 'fail, not just note, a pushed branch that is behind the default branch')
    .addHelpText(
      'after',
      [
        '',
        'Checks run on basement (ssh <host> basement-suite) when it answers a probe and the head is pushed;',
        'with an unpushed head they are deferred until after the push, and with basement unreachable they run here.',
        'AGENT_CHAT_BASEMENT_HOST sets the host (default basement); off forces local checks.',
      ].join('\n'),
    )
    .action(async (options: { title?: string; bodyFile?: string; rebase?: boolean; strict?: boolean }) => {
      const { prReady } = await import('./verbs/pr-ready.js')
      process.exitCode = await prReady(options)
    })
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
    const { runAgentVerb } = await import('../agents/launch-agent.js')
    runAgentVerb(id)
  })

  // Run by Claude Code as a headless agent's PermissionRequest hook (CC-144), never by a person.
  program
    .command('permission-hook', { hidden: true })
    .option('--deadline <seconds>', 'give up and withdraw the prompt after this long', '1790')
    .action(async (options: { deadline: string }) => {
      const { permissionHook } = await import('./verbs/permission-hook.js')
      await permissionHook(options)
    })

  // Run by Claude Code as every spawned agent's PreToolUse hook (CC-270), never by a person.
  program
    .command('leak-guard', { hidden: true })
    .description('hooks Claude Code runs for the leak guard')
    .command('pretool')
    .description('deny a tool call that would bypass the leak scan or post a finding')
    .action(async () => {
      const { leakPretool } = await import('./verbs/leak-pretool.js')
      await leakPretool()
    })

  addVerb(program, debugPsVerb, { hidden: true })
  addVerb(program, debugHistoryVerb, { hidden: true })
  addVerb(program, debugLogVerb, { hidden: true })

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
  addMirrorCommands(program)
  addBurndownCommands(program)
  addSeatsCommands(program)
  addDebugCommands(program)
  addVerb(program, doctorVerb).addCommand(doctorLifecycleCommand())
  addLifecycleCommands(program)
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
