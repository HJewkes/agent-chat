// FIRST, before anything that can touch node:sqlite — including the imports
// below, which reach the event log transitively. See warnings.ts.
import './warnings.js'

import { Command, Option } from 'commander'
import { brokerCwd } from '../agents/stable-cwd.js'
import { MAX_HOLD_SECONDS } from '../broker/hold.js'
import { VERSION } from '../broker/version.js'
import { socketPath } from '../paths.js'
import { LAUNCHERS, SURFACE_NAMES } from '../protocol.js'
import * as agents from './agents.js'
import { addVerb } from './command.js'
import { agentBudgetVerb } from './verbs/agent-budget.js'
import { agentRetire } from './verbs/agent-retire.js'
import { agentPark } from './verbs/agent-park.js'
import { agentResume } from './verbs/agent-resume.js'
import { agentMoveAccount } from './verbs/agent-move-account.js'
import { agentSurfaceVerb } from './verbs/agent-surface.js'
import { agentWorktreesVerb } from './verbs/agent-worktrees.js'
import { answersVerb } from './verbs/answers.js'
import { approveVerb } from './verbs/approve.js'
import { askVerb, USAGE_EXIT } from './verbs/ask.js'
import { addCodexCommands } from './verbs/codex-run.js'
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
import { operatorBriefVerb } from './verbs/operator-brief.js'
import { addMirrorCommands } from './verbs/mirror.js'
import { addBurndownCommands } from './verbs/burndown.js'
import { addSeatsCommands } from './verbs/seats.js'
import { addHostCommands } from './verbs/host.js'
import { addMachineCommands } from './verbs/machine.js'
import {
  portFilesClaimsVerb,
  portInboxSinceVerb,
  portMessageVerb,
  portRosterVerb,
} from './verbs/port-reads.js'
import { portQueueVerb } from './verbs/port-queue.js'
import { portSendVerb } from './verbs/port-send.js'
import { portResumeVerb, portRetireVerb, portSpawnVerb } from './verbs/port-agent.js'
import { profilesVerb } from './verbs/profiles.js'
import { queueReadVerb } from './verbs/queue-read.js'
import { teleportAbortVerb } from './verbs/teleport-abort.js'
import { teleportRequestVerb } from './verbs/teleport-request.js'
import * as debug from './debug.js'
import { doctorLifecycleCommand } from './doctor-lifecycle.js'
import * as human from './human.js'
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
      'SIGTERM the broker, then SIGKILL if it lingers; refuses while an agent is mid-spawn; --hold keeps auto-starts off for a while',
    )
    .option('--force', 'stop even if a mid-spawn agent would be lost')
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
      'stop then start, reusing the port from broker.meta.json; refuses while an agent is mid-spawn',
    )
    .option('-p, --port <port>', 'bind this port instead of the recorded one', port)
    .option('--force', 'restart even if a mid-spawn agent would be lost')
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
      'record the send as made by this source (watchdog, shepherd, console) in the event log',
    )
    .action(debug.send)
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

  agent
    .command('ls', { isDefault: true })
    .description('agents, with lifecycle and presence')
    .option('--json', 'print one JSON array, one object per agent')
    .option('--mine', 'only agents you spawned (needs a registered session name)')
    .option('--spawner <name>', 'only agents spawned by <name>')
    .option('--prefix <p>', 'only agents whose name starts with <p>')
    .option(
      '--state <state>',
      'only agents showing this status, e.g. running, finished, retired (repeatable)',
      (value: string, previous: string[] | undefined) => [...(previous ?? []), value],
    )
    .option('--name <name>', 'only the agent with exactly this name')
    .option('--format <format>', 'line: one line per agent (name state profile id cwd)')
    .option('--include-retired', 'also list retired agents, which carry retired: true in --json')
    .option('--all', 'also list headless sessions a cache directory left behind')
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
    .addOption(
      new Option(
        '--account <name|least-used>',
        "the account to run it on by name, or least-used: the broker host's logged-in account with the most fresh headroom",
      ).conflicts('configDir'),
    )
    .option('--task <id>', 'the task id the agent works on, recorded on its agent record')
    .option('--role <role>', 'implementer, reviewer, fix-round-<n>, shepherd-review, planner or other')
    .option('--slice <id>', 'the plan slice of --task the agent runs, recorded on its spawn row')
    .option('--route-override <reason>', 'why it keeps the named profile unrouted, recorded on its spawn row')
    .option(
      '--worktree <abs-path>',
      'adopt this existing worktree: no new branch, no budget slot, and retire leaves it in place',
    )
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
    .option(
      '--launched-by <who>',
      `${LAUNCHERS.join(' or ')}: the automation running this spawn as you; shown on the roster, grants nothing`,
      agents.parseLauncher,
    )
    .option('--launch-reason <text>', 'why it launched, recorded with --launched-by')
    .option('--remote-control', 'run with Remote Control (coordinator profiles only)')
    .option(
      '--host <machine>',
      'the machine to launch on, a configured alias or a hostname (default: this one)',
    )
    .action(agents.agentSpawn)
  addVerb(agent, agentRetire)
  addVerb(agent, agentPark)
  addVerb(agent, agentResume)
  addVerb(agent, agentMoveAccount)
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
  addVerb(program, operatorBriefVerb, { helpGroup: AGENTS })

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
      'before gh pr create: clean tree, merge the base, checks, changeset, leak scan; exit 0 only when all pass',
    )
    .helpGroup(AGENTS)
    .option('--title <t>', "PR title, scanned with gh-write's leak scan")
    .option('--body-file <path>', "PR body file, scanned with gh-write's leak scan")
    .option('--rebase', 'rebase unpushed commits onto the base instead of merging it (rewrites their shas)')
    .option('--no-rebase', 'check and report only; neither merge nor rebase the base')
    .option('--strict', 'fail, not just note, a pushed branch that is behind the default branch')
    .addHelpText(
      'after',
      [
        '',
        'The update step merges the base into an unpushed branch, so existing commits keep their shas;',
        'it rebases only under --rebase, and never touches a pushed branch or one with an open PR.',
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
    await runAgentVerb(id)
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
  program.command('stale-session-guard <agentId>', { hidden: true }).action(async (agentId: string) => {
    const { staleSessionGuard } = await import('./verbs/stale-session-guard.js')
    staleSessionGuard(agentId)
  })

  // Run by Claude Code as a spawned agent's tool, prompt and turn-end hook (CC-1455), never by a person.
  program
    .command('inbox-hook <agentId> [phase]', { hidden: true })
    .option('--block', 'at Stop, block the turn end to show what is waiting')
    .option('--host <host>', 'codex: the first argument is the phase and the output a notice')
    .action(async (agentId: string, phase: string | undefined, opts: { block?: boolean; host?: string }) => {
      const { codexInboxHook, inboxHook } = await import('./verbs/inbox-hook.js')
      if (opts.host === 'codex') await codexInboxHook(agentId)
      else await inboxHook(agentId, phase ?? '', opts.block === true)
    })

  // Run by Claude Code as every spawned agent's PreToolUse hook (CC-270), never by a person.
  const leakGuard = program
    .command('leak-guard', { hidden: true })
    .description('hooks Claude Code runs for the leak guard')
  leakGuard
    .command('pretool')
    .description('deny a tool call that would bypass the leak scan or post a finding')
    .option('--integrity <nonce>', 'also deny once a file a later shell sources changed (TP-4256)')
    .action(async (opts: { integrity?: string }) => {
      const { leakPretool } = await import('./verbs/leak-pretool.js')
      await leakPretool(undefined, opts.integrity)
    })
  // TP-4256: the PostToolUse twin of `pretool --integrity`, so a change a call made reaches the model.
  leakGuard
    .command('posttool')
    .description('block with a reason once a file a later shell sources changed')
    .requiredOption('--integrity <nonce>', 'the launch nonce the broker minted')
    .action(async (opts: { integrity: string }) => {
      const { leakPosttool } = await import('./verbs/leak-pretool.js')
      await leakPosttool(opts.integrity)
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

  program.command('send <to> <text...>', { hidden: true }).action(debug.send)
}

function addPortCommands(program: Command): void {
  const port = program
    .command('port')
    .description('JSON envelope ports for the dispatch factory; none of them starts a broker')
  addVerb(port, portRosterVerb)
  addVerb(port, portInboxSinceVerb)
  addVerb(port, portMessageVerb)
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
  addCodexCommands(program, AGENTS)
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
