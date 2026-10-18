// FIRST, before anything that can touch node:sqlite — including the imports
// below, which reach the event log transitively. See warnings.ts.
import './warnings.js'

import { seatBlocksVerb } from './verbs/seat-blocks-command.js'
import { prReadyVerb } from './verbs/pr-ready-command.js'

import { Command } from 'commander'
import { brokerCwd } from '../agents/stable-cwd.js'
import { VERSION } from '../broker/version.js'
import { socketPath } from '../paths.js'
import * as agents from './agents.js'
import { addVerb } from './command.js'
import { agentBudgetVerb } from './verbs/agent-budget.js'
import { agentLsVerb } from './verbs/agent-ls.js'
import { agentSpawnVerb } from './verbs/agent-spawn-command.js'
import { ghWriteVerb, suiteSlotVerb } from './verbs/command-wrappers.js'
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
import { doctorLifecycleVerb, lifecycleBackfillVerb } from './verbs/ledger-commands.js'
import { answerVerb } from './verbs/answer.js'
import { seatHookVerb, leakPretoolVerb } from './verbs/hook-declarations.js'
import { serviceLogsVerb } from './verbs/service-logs.js'
import { serviceOpenVerb } from './verbs/service-open.js'
import { serviceStatusVerb } from './verbs/service-status.js'
import { staleSessionGuardVerb } from './verbs/stale-session-guard-command.js'
import { holdSeconds, parsePort } from './service-options.js'
import { serviceStartVerb, serviceStopVerb, serviceRestartVerb } from './verbs/service-controls.js'
import { days } from './lifecycle.js'
import * as service from './service.js'
import { unknownCommand } from './unknown-command.js'
import { watchVerb } from './verbs/watch-command.js'

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

function addServiceCommands(program: Command): void {
  const svc = program.command('service').description('run and inspect the broker daemon')

  const start = addVerb(svc, serviceStartVerb, { usageExit: 1, exitOnSuccess: false })
  for (const option of start.options) if (option.long === '--port') option.argParser(parsePort)

  const stop = addVerb(svc, serviceStopVerb, { usageExit: 1, exitOnSuccess: false })
  for (const option of stop.options) if (option.long === '--hold') option.argParser(holdSeconds)

  addVerb(svc, serviceStatusVerb, { exitOnSuccess: false })

  const restart = addVerb(svc, serviceRestartVerb, { usageExit: 1, exitOnSuccess: false })
  for (const option of restart.options) if (option.long === '--port') option.argParser(parsePort)

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
  addVerb(program, watchVerb, { helpGroup: AGENTS, schemaDefaults: true, usageExit: 1, exitOnSuccess: false })

  const agent = program.command('agent').description('durable agents').helpGroup(AGENTS)

  addVerb(agent, agentLsVerb, { isDefault: true, usageExit: 1, exitOnSuccess: false })
  const spawn = addVerb(agent, agentSpawnVerb, { usageExit: 1, exitOnSuccess: false })
  for (const option of spawn.options) {
    if (option.long === '--surface') option.argParser(agents.parseSurface)
    if (option.long === '--spawned-as') option.argParser(agents.parseSpawnedAs)
  }
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

  addVerb(program, ghWriteVerb, { helpGroup: AGENTS, usageExit: 1, exitOnSuccess: false }).addHelpText(
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

  addVerb(program, suiteSlotVerb, { helpGroup: AGENTS, usageExit: 1, exitOnSuccess: false })

  addVerb(program, leakScanVerb, { helpGroup: AGENTS, usageExit: 2, reportExit: 'set-code' })

  addVerb(program, prReadyVerb, { helpGroup: AGENTS, usageExit: 1, reportExit: 'set-code' }).addHelpText(
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
  const leakGuard = program
    .command('leak-guard', { hidden: true })
    .description('hooks Claude Code runs for the leak guard')
  addVerb(leakGuard, leakPretoolVerb, { usageExit: 1, exitOnSuccess: false })

  // Run by Claude Code as a spawned agent's tool and turn hooks (CC-1056), never by a person.
  addVerb(program, seatHookVerb, { hidden: true, usageExit: 1, exitOnSuccess: false })

  addVerb(program, seatBlocksVerb, {
    hidden: true,
    schemaDefaults: true,
    usageExit: 1,
    reportExit: 'set-failure-code',
  }).description(seatBlocksVerb.description)

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
  const doctor = addVerb(program, doctorVerb)
  addVerb(doctor, doctorLifecycleVerb, { usageExit: 1, exitOnSuccess: false }).showHelpAfterError(false)
  const lifecycle = program
    .command('lifecycle')
    .description('offline maintenance of the agent lifecycle ledger')
  const backfill = addVerb(lifecycle, lifecycleBackfillVerb, { usageExit: 1, exitOnSuccess: false })
  for (const option of backfill.options) if (option.long === '--since') option.argParser(days)
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
