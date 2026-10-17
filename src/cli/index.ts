// FIRST, before anything that can touch node:sqlite — including the imports
// below, which reach the event log transitively. See warnings.ts.
import './warnings.js'

import { Command } from 'commander'
import { brokerCwd } from '../agents/stable-cwd.js'
import { MAX_HOLD_SECONDS } from '../broker/hold.js'
import { VERSION } from '../broker/version.js'
import { socketPath } from '../paths.js'
import { SURFACE_NAMES } from '../protocol.js'
import * as agents from './agents.js'
import { addVerb } from './command.js'
import { agentBudgetVerb } from './verbs/agent-budget.js'
import { agentLsVerb } from './verbs/agent-ls.js'
import { leakScanVerb } from './verbs/leak-scan-command.js'
import { agentRetire } from './verbs/agent-retire.js'
import { agentPark } from './verbs/agent-park.js'
import { agentResume } from './verbs/agent-resume.js'
import { agentSurfaceVerb } from './verbs/agent-surface.js'
import { agentWorktreesVerb } from './verbs/agent-worktrees.js'
import { answersVerb } from './verbs/answers.js'
import { approveVerb } from './verbs/approve.js'
import { askVerb, USAGE_EXIT } from './verbs/ask.js'
import { countsVerb } from './verbs/counts.js'
import { debugClaimsVerb } from './verbs/debug-claims.js'
import { debugHistoryVerb } from './verbs/debug-history.js'
import { debugLogVerb } from './verbs/debug-log.js'
import { debugPsVerb } from './verbs/debug-ps.js'
import { digestVerb } from './verbs/digest.js'
import { dismissVerb } from './verbs/dismiss.js'
import { doctorVerb } from './verbs/doctor.js'
import { endorseVerb } from './verbs/endorse.js'
import { ghCallsVerb } from './verbs/gh-calls.js'
import { handoffLastVerb } from './verbs/handoff-last.js'
import { inboxVerb } from './verbs/inbox.js'
import { addMirrorCommands } from './verbs/mirror.js'
import { addBurndownCommands } from './verbs/burndown.js'
import { addSeatsCommands } from './verbs/seats.js'
import { addHostCommands } from './verbs/host.js'
import { addMachineCommands } from './verbs/machine.js'
import { portFilesClaimsVerb, portInboxSinceVerb, portRosterVerb } from './verbs/port-reads.js'
import { portQueueVerb } from './verbs/port-queue.js'
import { portSendVerb } from './verbs/port-send.js'
import { portResumeVerb, portRetireVerb, portSpawnVerb } from './verbs/port-agent.js'
import { profilesVerb } from './verbs/profiles.js'
import { queueReadVerb } from './verbs/queue-read.js'
import { teleportAbortVerb } from './verbs/teleport-abort.js'
import { teleportRequestVerb } from './verbs/teleport-request.js'
import { debugSendVerb, sendVerb } from './verbs/debug-send.js'
import { doctorLifecycleCommand } from './doctor-lifecycle.js'
import { answerVerb } from './verbs/answer.js'
import { serviceLogsVerb } from './verbs/service-logs.js'
import { serviceOpenVerb } from './verbs/service-open.js'
import { serviceStatusVerb } from './verbs/service-status.js'
import { staleSessionGuardVerb } from './verbs/stale-session-guard-command.js'
import { parsePort } from './service-options.js'
import { addLifecycleCommands } from './lifecycle.js'
import * as service from './service.js'
import { unknownCommand } from './unknown-command.js'
import { watch, type WatchOptions } from './watch.js'

const HUMAN = 'Human commands:'
const AGENTS = 'Agent commands:'
const SERVICES = 'Service commands:'

/**
 * `inbox`/`answer`/`dismiss` are top-level rather than under a `human` noun on
 * purpose: they are the daily verbs and the dashboard's CLI peer, and the whole
 * argument for keeping a CLI at all (§10) is that they stay the shortest thing
 * to type when the dashboard is not reachable. The grouping is in the help.
 */
function addHumanCommands(program: Command): void {
  addVerb(program, inboxVerb, { helpGroup: HUMAN })
  addVerb(program, queueReadVerb, { helpGroup: HUMAN })

  addVerb(program, answerVerb, { helpGroup: HUMAN, exitOnSuccess: false })

  addVerb(program, dismissVerb, { helpGroup: HUMAN })
  addVerb(program, approveVerb, { helpGroup: HUMAN })
  addVerb(program, endorseVerb, { helpGroup: HUMAN })
  addVerb(program, digestVerb, { helpGroup: HUMAN })
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
    .option('-p, --port <port>', 'HTTP port to bind', parsePort)
    .option('-f, --foreground', 'run in this terminal instead of detaching')
    .action(service.start)

  svc
    .command('stop')
    .description(
      'SIGTERM the broker, then SIGKILL if it lingers; refuses while an agent is mid-spawn; --hold keeps auto-starts off for a while',
    )
    .option('--force', 'stop even if a mid-spawn agent would be lost')
    .option(
      '--hold <seconds>',
      `refuse broker starts, including auto-starts, for this long (at most ${MAX_HOLD_SECONDS})`,
      holdSeconds,
    )
    .action(service.stop)

  addVerb(svc, serviceStatusVerb, { exitOnSuccess: false })

  svc
    .command('restart')
    .description(
      'stop then start, reusing the port from broker.meta.json; refuses while an agent is mid-spawn',
    )
    .option('-p, --port <port>', 'bind this port instead of the recorded one', parsePort)
    .option('--force', 'restart even if a mid-spawn agent would be lost')
    .action(service.restart)

  addVerb(svc, serviceLogsVerb, { schemaDefaults: true, exitOnSuccess: false })

  addVerb(svc, serviceOpenVerb, { usageExit: 1, exitOnSuccess: false })
}

/** The tier the dashboard largely replaces day to day (§10). */
function addDebugCommands(program: Command): void {
  const dbg = program.command('debug').description('diagnostics: sessions, history, routing')

  addVerb(dbg, debugPsVerb)
  addVerb(dbg, debugClaimsVerb)
  addVerb(dbg, debugHistoryVerb)
  addVerb(dbg, debugLogVerb)
  addVerb(dbg, debugSendVerb)
}

/** For processes that are not Claude sessions, such as a factory gate notifier (CC-169). */
function addServiceAskCommands(program: Command): void {
  addVerb(program, askVerb, { helpGroup: SERVICES, usageExit: USAGE_EXIT })
  addVerb(program, answersVerb, { helpGroup: SERVICES, usageExit: USAGE_EXIT })
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

  addVerb(agent, agentLsVerb, { isDefault: true, usageExit: 1, exitOnSuccess: false })
  agent
    // The brief is OPTIONAL in argv only because `--brief-stdin` is the other
    // way to supply it; `resolveBrief` still refuses a spawn with neither, so
    // the usage error moved rather than disappeared.
    .command('spawn <name> <profile> [brief...]')
    .description('start a new agent')
    .option('--briefing <slug|auto>', "prepend an active-work initiative's orientation to the brief")
    .option('--brief-stdin', 'read the brief from stdin, keeping it out of world-readable argv')
    .option('--config-dir <path>', 'the Claude config dir, and therefore the account, to run it on')
    .option('--task <id>', 'the task id the agent works on, recorded on its agent record')
    .option('--role <role>', 'implementer, reviewer, fix-round-<n>, shepherd-review, planner or other')
    .option(
      '--surface <surface>',
      `where it runs, overriding the profile's surface: ${SURFACE_NAMES.join(', ')}`,
      agents.parseSurface,
    )
    .option(
      '--spawned-as <who>',
      'shepherd or burndown: the automation this spawn is on behalf of',
      agents.parseSpawnedAs,
    )
    .option('--remote-control', 'run with Remote Control (coordinator profiles only)')
    .option(
      '--host <machine>',
      'the machine to launch on, a configured alias or a hostname (default: this one)',
    )
    .action(agents.agentSpawn)
  addVerb(agent, agentRetire)
  addVerb(agent, agentPark)
  addVerb(agent, agentResume)
  addVerb(agent, agentWorktreesVerb)
  addVerb(agent, agentSurfaceVerb)
  addVerb(agent, agentBudgetVerb)

  const teleport = program.command('teleport').description('teleport control').helpGroup(AGENTS)
  addVerb(teleport, teleportAbortVerb)
  addVerb(teleport, teleportRequestVerb)

  const handoff = program.command('handoff').description('stored teleport handoffs').helpGroup(AGENTS)
  addVerb(handoff, handoffLastVerb)

  addVerb(program, profilesVerb, { helpGroup: AGENTS })
  addVerb(program, ghCallsVerb, { helpGroup: AGENTS })
  addVerb(program, countsVerb, { helpGroup: AGENTS })

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

  addVerb(program, leakScanVerb, { helpGroup: AGENTS, usageExit: 2, reportExit: 'set-code' })

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
        'On the basement host itself pr-ready calls basement-suite directly, without ssh.',
        'AGENT_CHAT_BASEMENT_HOST sets the host (default basement); off forces local checks.',
        'A root lint:types script runs here after <pm> run build, before the push, never deferred.',
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
  // CC-1096: leave whatever agent tree started us, or every child inherits a cwd that parking removes.
  program.command('broker', { hidden: true }).action(() => {
    process.chdir(brokerCwd())
    return service.start({ foreground: true })
  })

  program.command('mcp', { hidden: true }).action(async () => {
    const { startMcpServer } = await import('../server/index.js')
    await startMcpServer()
  })

  program.command('run-agent <id>', { hidden: true }).action(async (id: string) => {
    const { runAgentVerb } = await import('../agents/launch-agent.js')
    runAgentVerb(id)
  })

  // Spawned detached by a teleporting session's MCP process on another host than the broker (CC-913).
  program
    .command('teleport-land <id>', { hidden: true })
    .requiredOption('--pid <pid>', "the predecessor's Claude Code, whose exit frees its pane")
    .requiredOption('--surface <surface>', 'where the successor runs')
    .option('--anchor <anchor>', "the predecessor's pane")
    .option('--now', 'launch at once, beside the running predecessor (CC-951)')
    .action(async (id: string, options: { pid: string; surface: string; anchor?: string; now?: boolean }) => {
      const { runLandVerb } = await import('../server/caller-land.js')
      await runLandVerb(id, options)
    })

  // Run by Claude Code as a headless agent's PermissionRequest hook (CC-144), never by a person.
  program
    .command('permission-hook', { hidden: true })
    .option('--deadline <seconds>', 'give up and withdraw the prompt after this long', '1790')
    .option(
      '--self-grant-skills <root>',
      "allow writes under this worktree's .claude/skills/<name>/ (CC-694)",
    )
    .option(
      '--self-grant-common-dir <dir>',
      'the git common dir pinned at launch; self-grant refuses without it (CC-1200)',
    )
    .action(async (options: { deadline: string; selfGrantSkills?: string; selfGrantCommonDir?: string }) => {
      const { permissionHook } = await import('./verbs/permission-hook.js')
      await permissionHook(options)
    })

  // Run by Claude Code as every spawned agent's UserPromptSubmit hook (CC-762), never by a person.
  addVerb(program, staleSessionGuardVerb, { hidden: true, usageExit: 1, exitOnSuccess: false })

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

  // Run by Claude Code as a spawned agent's tool and turn hooks (CC-1056), never by a person.
  program.command('seat-hook <phase>', { hidden: true }).action(async (phase: string) => {
    const { seatHook } = await import('./verbs/seat-hook.js')
    await seatHook(phase)
  })

  program
    .command('seat-blocks', { hidden: true })
    .description("each seat's blocked minutes over a window, and any block still open")
    .option('--since <window>', 'window such as 90m, 24h or 7d', '24h')
    .action(async (options: { since: string }) => {
      const { seatBlocks } = await import('./verbs/seat-hook.js')
      try {
        console.log(seatBlocks(options).join('\n'))
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err))
        process.exitCode = 1
      }
    })

  addVerb(program, debugPsVerb, { hidden: true })
  addVerb(program, debugHistoryVerb, { hidden: true })
  addVerb(program, debugLogVerb, { hidden: true })

  addVerb(program, sendVerb, { hidden: true })
}

function addPortCommands(program: Command): void {
  const port = program
    .command('port')
    .description('JSON envelope ports for the dispatch factory; none of them starts a broker')
  addVerb(port, portRosterVerb)
  addVerb(port, portInboxSinceVerb)
  addVerb(port, portQueueVerb)
  addVerb(port, portFilesClaimsVerb)
  addVerb(port, portSpawnVerb)
  addVerb(port, portRetireVerb)
  addVerb(port, portResumeVerb)
  addVerb(port, portSendVerb)
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
  addPortCommands(program)
  addMachineCommands(program)
  addHostCommands(program)
  addDebugCommands(program)
  addVerb(program, doctorVerb).addCommand(doctorLifecycleCommand())
  addLifecycleCommands(program)
  addAgentCommands(program)
  addServiceAskCommands(program)
  addHiddenCommands(program)
  return program
}

export async function run(argv: string[] = process.argv): Promise<void> {
  const program = buildProgram()
  if (argv.length <= 2) {
    program.outputHelp()
    return
  }
  const unknown = unknownCommand(program, argv.slice(2))
  if (unknown !== undefined)
    program.error(`error: unknown command '${unknown}'`, { exitCode: 1, code: 'commander.unknownCommand' })
  await program.parseAsync(argv)
}
