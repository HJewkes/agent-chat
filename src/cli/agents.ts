import os from 'node:os'
import { accountReader, budgetMiss, formatBudget, readBudget } from '../agents/budget.js'
import { findGitRoot } from '../git.js'
import {
  callerName,
  filterRoster,
  isTransientSession,
  newestByName,
  type RosterFilter,
} from '../agents/roster-filter.js'
import { pairPresence, ROSTER_STATUSES, type RosterStatus } from '../agents/identity.js'
import { porcelain, reclaim, sweepWorktrees, type SweptWorktree } from '../agents/isolation/sweep.js'
import {
  BRANCH_PREFIX,
  DEFAULT_REVIEWER_WORKTREE_BUDGET,
  DEFAULT_WORKTREE_BUDGET,
} from '../agents/isolation/worktree.js'
import {
  formatRows,
  lowDiskWarning,
  nonSeatRow,
  repoHeadroom,
  repoSummary,
  stateRow,
  volumeFreeBytes,
  type RepoHeadroom,
} from '../agents/isolation/worktree-states.js'
import { parseWorktreeList } from '../agents/seats/trees.js'
import { resolveReviewerWorktreeBudget, resolveWorktreeBudget, retireThresholdK } from '../config.js'
import { loadResolvedConfig } from '../agents/burndown/settings-store.js'
import {
  contextKOf,
  pastThreshold,
  reportTargets,
  retireCell,
  retireDue,
  type RetireReading,
} from '../agents/retire-due.js'
import { loadProfile, selectProfileNames } from '../agents/profiles.js'
import {
  createProfileIndex,
  findAgentTranscript,
  observedModel,
  transcriptLine,
  type ProfileIndex,
} from '../agents/transcript.js'
import {
  LAUNCHERS,
  launcherOf,
  SURFACE_NAMES,
  type AgentIdentity,
  type Launcher,
  type ServerMessage,
  type SurfaceName,
} from '../protocol.js'
import { InvalidArgumentError } from 'commander'
import type { Report } from './command.js'
import { fail, withBroker } from './client.js'
import type { BrokerClient } from '../client/broker-client.js'
import { launchHereFields, requestSpawn } from '../server/caller-spawn.js'

/**
 * The roster: durable lifecycle paired with ephemeral presence.
 *
 * More truthful than `ps` by construction — a live agent whose broker just
 * bounced shows as reconnecting rather than vanishing, because identity is a
 * query over the log and only presence depends on a socket being up.
 */
export async function agentLs(
  options: {
    json?: boolean
    mine?: boolean
    spawner?: string
    prefix?: string
    state?: string[]
    name?: string
    format?: string
    includeRetired?: boolean
    all?: boolean
  } = {},
): Promise<void> {
  const filter = rosterFilter(options)
  if (options.format !== undefined && options.format !== 'line') fail(`--format must be: line`)
  const states = stateFilter(options.state)
  const frame = lsRosterFrame(options.includeRetired === true || states?.has('retired') === true)
  const [all, sessions] = await withBroker(async b => {
    const roster = (await b.request(frame, 'agents_result')) as Extract<ServerMessage, { t: 'agents_result' }>
    const live = (await b.request({ t: 'list' }, 'list_result')) as Extract<
      ServerMessage,
      { t: 'list_result' }
    >
    return [roster.agents, live.sessions] as const
  })
  const connectedNames = new Set(sessions.map(s => s.name))
  const agents = filterRoster(all, filter).filter(
    a =>
      (options.name === undefined || a.name === options.name) &&
      (options.all === true || options.name !== undefined || !isTransientSession(a)) &&
      (states === undefined || states.has(pairPresence(a, { connected: connectedNames.has(a.name) }).status)),
  )
  const index = createProfileIndex()
  const retire = options.format === 'line' ? new Map<string, RetireRow>() : await retireRows(agents)

  if (options.json) {
    const rows = agents.map(agent =>
      lsJsonRow(
        agent,
        sessions.some(s => s.name === agent.name),
        index,
        retire.get(agent.agentId),
      ),
    )
    console.log(JSON.stringify(rows, null, 2))
    return
  }
  if (options.format === 'line') {
    for (const agent of agents) {
      const { status } = pairPresence(agent, { connected: connectedNames.has(agent.name) })
      console.log([agent.name, status, agent.profile, agent.agentId, agent.cwd].join(' '))
    }
    return
  }
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
    const row = retire.get(agent.agentId)
    const ctx = row === undefined ? '' : retireCell(row, row.retireDue)
    console.log(
      `${agent.name.padEnd(16)} ${status.padEnd(13)} ${agent.profile.padEnd(12)} ${agent.agentId}${lineage}${ctx === '' ? '' : `  ${ctx}`}`,
    )
    console.log(`${' '.repeat(16)} ${agent.cwd}`)
    // CC-100: the full dir, not just the account's short name — this is the
    // operator's view, and "which account, exactly" is the question a spend limit
    // makes urgent. Omitted when the row predates the field.
    if (agent.configDir) console.log(`${' '.repeat(16)} account: ${agent.configDir}`)
    console.log(`${' '.repeat(16)} ${transcriptLine(agent.cwd, agent.sessionId, agent.configDir, index)}`)
  }
}

/**
 * TP-4132: the broker leaves retired rows out unless asked, and a lineage walk needs
 * them. The bare frame stays the default so an older broker sees the frame it knows.
 */
function lsRosterFrame(includeRetired: boolean): { t: 'agents'; includeRetired?: true } {
  return includeRetired ? { t: 'agents', includeRetired: true } : { t: 'agents' }
}

type RetireRow = RetireReading & { retireDue: boolean }

const retirable = (agent: AgentIdentity): boolean => agent.state !== 'exited' && agent.state !== 'retired'

/** A session id the budget reader refuses costs that row its fill, not the whole listing. */
function readingOf(agent: AgentIdentity): RetireReading {
  let contextK: number | null = null
  try {
    contextK = contextKOf(readBudget(agent.sessionId, Date.now(), agent.configDir, agent.cwd))
  } catch {
    contextK = null
  }
  return { contextK, retireK: retireThresholdK(agent.profile) ?? null }
}

/**
 * CC-290 b: each live agent's fill against its role's threshold. The broker is asked
 * about a report only for an agent already past it, so a quiet roster costs no frames.
 * `since` is the spawn, not the current run, so a resumed agent's earlier report counts.
 */
async function retireRows(agents: readonly AgentIdentity[]): Promise<Map<string, RetireRow>> {
  const readings = agents.filter(retirable).map(agent => [agent, readingOf(agent)] as const)
  const past = readings.filter(([, reading]) => pastThreshold(reading))
  const reported =
    past.length === 0
      ? new Set<string>()
      : await withBroker(b =>
          reportedNames(
            b,
            past.map(([agent]) => agent),
            tickReportTo(),
          ),
        )
  return new Map(
    readings.map(([agent, reading]) => [
      agent.agentId,
      { ...reading, retireDue: retireDue(reading, reported.has(agent.agentId)) },
    ]),
  )
}

async function reportedNames(
  broker: BrokerClient,
  agents: readonly AgentIdentity[],
  reportTo: string | undefined,
): Promise<Set<string>> {
  const hits = await Promise.all(
    agents.map(async agent => {
      for (const to of reportTargets(agent.spawnedBy, reportTo)) {
        if (await hasReported(broker, agent, to)) return [agent.agentId]
      }
      return []
    }),
  )
  return new Set(hits.flat())
}

/** An older broker that refuses the frame shows the fill without retire-due rather than failing `agent ls`. */
async function hasReported(broker: BrokerClient, agent: AgentIdentity, to: string): Promise<boolean> {
  try {
    const res = (await broker.request(
      { t: 'reported', from: agent.name, to, since: agent.spawnedAt },
      'reported_result',
    )) as Extract<ServerMessage, { t: 'reported_result' }>
    return res.reported
  } catch {
    return false
  }
}

function tickReportTo(): string | undefined {
  try {
    return loadResolvedConfig().tick.reportTo
  } catch {
    return undefined
  }
}

/** `--state` takes the status column's words; anything else would silently match nothing. */
function stateFilter(raw: string[] | undefined): Set<string> | undefined {
  if (raw === undefined) return undefined
  const bad = raw.filter(s => !ROSTER_STATUSES.includes(s as RosterStatus))
  if (bad.length > 0)
    fail(`--state ${bad.join(', ')} is not a roster state; use: ${ROSTER_STATUSES.join(', ')}`)
  return new Set(raw)
}

/** `--spawner` names the spawner outright; `--mine` resolves the caller or exits; printing everything instead would defeat the flag. */
function rosterFilter(options: { mine?: boolean; spawner?: string; prefix?: string }): RosterFilter {
  try {
    const spawner = options.spawner ?? (options.mine === true ? callerName() : undefined)
    return {
      ...(spawner === undefined ? {} : { spawner }),
      ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
    }
  } catch (err) {
    fail((err as Error).message)
  }
}

/** A transcript that cannot be read costs that row its model, not the whole listing. */
function modelOrNull(agent: AgentIdentity, index: ProfileIndex): string | null {
  try {
    return observedModel(agent.cwd, agent.sessionId, agent.configDir, index) ?? null
  } catch {
    return null
  }
}

/** One roster row for `agent ls --json`: everything the text view shows, as fields. */
function lsJsonRow(agent: AgentIdentity, connected: boolean, index: ProfileIndex, retire?: RetireRow) {
  const { status } = pairPresence(agent, { connected })
  const transcript = findAgentTranscript(agent.cwd, agent.sessionId, agent.configDir, index)
  return {
    name: agent.name,
    agentId: agent.agentId,
    state: agent.state,
    presence: connected ? 'live' : agent.state === 'exited' ? 'exited' : 'detached',
    status,
    profile: agent.profile,
    surface: agent.surface,
    model: modelOrNull(agent, index),
    cwd: agent.cwd,
    sessionId: agent.sessionId,
    transcriptPath: agent.sessionId === '' ? null : transcript.path,
    transcriptExists: transcript.exists,
    spawnedBy: agent.spawnedBy,
    launchedBy: agent.launchedBy ?? null,
    account: agent.configDir || null,
    generation: agent.generation,
    teleportFrom: agent.teleportFrom ?? null,
    // CC-1579: never defaulted to null, which would claim "no takeover" for a row that cannot say.
    ...(agent.predecessor === undefined ? {} : { predecessor: agent.predecessor }),
    // TP-4132: only on retired rows, so the default listing, which has none, keeps its shape.
    ...(agent.state === 'retired' ? { retired: true } : {}),
    inferred: agent.exit?.inferred === true,
    // CC-1671 S4: only while marked, so every other row keeps its shape.
    ...(agent.crashLoop === undefined ? {} : { crashLoop: agent.crashLoop }),
    spawnedAt: new Date(agent.spawnedAt).toISOString(),
    // CC-1577: only once an exit is recorded, so a live row keeps its shape; the numeric field stays internal.
    ...(agent.exitedAt === undefined ? {} : { exitedAt: new Date(agent.exitedAt).toISOString() }),
    contextK: retire?.contextK ?? null,
    retireK: retire?.retireK ?? null,
    retireDue: retire === undefined || retire.contextK === null ? null : retire.retireDue,
  }
}

/**
 * Read stdin to EOF. The one impure half of `--brief-stdin`, kept beside it and
 * nowhere else.
 *
 * A terminal is refused rather than read. `--brief-stdin` with nothing piped in
 * otherwise waits on a human who was given no prompt to answer — it looks like a
 * hang, and the eventual ^D reports the confusing "empty brief" instead of the
 * real mistake. The check is `isTTY`, not emptiness, because an empty PIPE is a
 * legitimate thing to diagnose and a terminal never is.
 */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new Error('--brief-stdin expects the brief piped in; stdin is a terminal')
  }
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Where the brief comes from: argv words, or stdin under `--brief-stdin`.
 *
 * The flag exists for callers whose brief is not theirs — relay dispatches a
 * task body the operator captured by voice, and argv is world-readable via `ps`,
 * so passing it positionally discloses that text to every local process (relay's
 * R-68, which this closes). Nothing downstream changes: the wire `spawn` frame
 * carries the brief over a socket either way, and a headless agent already
 * receives it on the child's stdin rather than in `claude`'s argv.
 *
 * Pure, and throws rather than exiting, so the exclusivity rules are testable
 * without a pipe or a broker — the same seam `resumeWithMessage` draws.
 */
export function resolveBrief(words: string[], stdin: string | undefined): string {
  if (stdin === undefined) {
    if (words.length === 0) throw new Error('usage: agent-chat agent spawn <name> <profile> "<brief>"')
    return words.join(' ')
  }
  // Refused rather than merged, because there is no reading of a split brief
  // that is obviously right, and silently dropping either half sends an agent
  // off with half a task — which costs a whole run to notice.
  if (words.length > 0) {
    throw new Error('--brief-stdin reads the brief from stdin; do not also pass it as arguments')
  }
  // Exactly ONE trailing newline is stripped — the one `echo` or a heredoc adds.
  // Not `\n+$`: a brief deliberately ending in a blank line is prose whose shape
  // is the author's, and there is no way to tell the second newline from the
  // first once both are gone. `\r?` because a CRLF pipe would otherwise leave a
  // stray carriage return welded to the last word.
  const brief = stdin.replace(/\r?\n$/, '')
  if (brief.trim() === '') throw new Error('--brief-stdin got an empty brief on stdin')
  return brief
}

/**
 * What agent-chat is holding in git, and what nobody is using (CC-80).
 *
 * Retire releases a worktree when a person decides they are done with an agent.
 * The leak is the case where nobody decides: an agent exits, is never retired,
 * and holds its worktree and branch indefinitely. This is the verb that asks.
 *
 * `--prune` acts only on what the report calls `reclaimable` — no live agent,
 * past the grace window, nothing uncommitted and no commit that exists nowhere
 * else. `--force` overrides that per the same rule `retire --force` follows: a
 * human deciding to throw work away, never an agent.
 */
export async function agentWorktrees(
  options: { prune?: boolean; force?: boolean; json?: boolean } = {},
): Promise<Report> {
  const roster = await withBroker(async b => {
    const result = (await b.request({ t: 'agents' }, 'agents_result')) as Extract<
      ServerMessage,
      { t: 'agents_result' }
    >
    return result.agents
  })
  const root = await findGitRoot(process.cwd())
  const swept = await sweepWorktrees(roster, { ...(root === null ? {} : { roots: [root] }) })
  const repos = await headroomByRepo(swept, root)

  if (options.json === true) return { ok: true, lines: [JSON.stringify({ repos })] }
  const lines = headroomLines(repos)
  if (swept.length === 0) return { ok: true, lines }

  if (options.prune !== true) {
    const n = swept.filter(e => e.status === 'reclaimable').length
    lines.push(n === 0 ? '\nNothing to reclaim.' : `\n${n} reclaimable. Reclaim with --prune.`)
    return { ok: true, lines }
  }

  lines.push('')
  for (const entry of swept.filter(e => options.force === true || e.status === 'reclaimable')) {
    const result = await reclaim(entry, { ...(options.force === true ? { force: true } : {}) })
    lines.push(result.ok ? `Reclaimed ${entry.branch}.` : `Left ${entry.branch}: ${result.reason}`)
  }
  return { ok: true, lines }
}

/** CC-284: one headroom record per repo the sweep touched, plus the one the CLI ran in. */
async function headroomByRepo(swept: SweptWorktree[], root: string | null): Promise<RepoHeadroom[]> {
  const roots = new Set(swept.map(e => e.gitRoot))
  if (root !== null) roots.add(root)
  const budget = resolveWorktreeBudget(DEFAULT_WORKTREE_BUDGET)
  const reviewerBudget = resolveReviewerWorktreeBudget(DEFAULT_REVIEWER_WORKTREE_BUDGET)
  const repos: RepoHeadroom[] = []
  for (const gitRoot of roots) {
    const listed = parseWorktreeList(await porcelain(gitRoot).catch(() => ''))
    const nonSeat = listed.filter(t => !t.branch?.startsWith(BRANCH_PREFIX)).map(nonSeatRow)
    const seat = swept.filter(e => e.gitRoot === gitRoot).map(stateRow)
    repos.push(repoHeadroom(gitRoot, [...seat, ...nonSeat], budget, reviewerBudget, volumeFreeBytes(gitRoot)))
  }
  return repos
}

function headroomLines(repos: RepoHeadroom[]): string[] {
  const rows = repos.flatMap(repo => formatRows(repo.rows))
  return [
    ...(rows.length === 0 ? ['No agent-chat worktrees on this machine.'] : rows),
    ...repos.map(repoSummary),
    ...repos.flatMap(repo => lowDiskWarning(repo.gitRoot, repo.freeDiskBytes) ?? []),
  ]
}

/** The commander parser for `--surface`: a name outside SURFACE_NAMES is refused before any frame is sent. */
export function parseSurface(value: string): SurfaceName {
  const surface = SURFACE_NAMES.find(name => name === value)
  if (surface === undefined) throw new InvalidArgumentError(`one of: ${SURFACE_NAMES.join(', ')}`)
  return surface
}

const SPAWNED_AS = ['shepherd', 'burndown'] as const
type SpawnedAs = (typeof SPAWNED_AS)[number]

/** The commander parser for `--spawned-as` (CC-973): only the two automations the broker records are accepted. */
export function parseSpawnedAs(value: string): SpawnedAs {
  const spawnedAs = SPAWNED_AS.find(name => name === value)
  if (spawnedAs === undefined) throw new InvalidArgumentError(`one of: ${SPAWNED_AS.join(', ')}`)
  return spawnedAs
}

/** The commander parser for `--launched-by` (CC-1466): only the automations on `LAUNCHERS`. */
export function parseLauncher(value: string): Launcher {
  const launcher = launcherOf(value)
  if (launcher === undefined) throw new InvalidArgumentError(`one of: ${LAUNCHERS.join(', ')}`)
  return launcher
}

/**
 * CC-1206: the agent identity a spawned agent's shell carries (`launch-plan.ts` sets both), so an
 * agent's CLI spawn without `--spawned-as` is not taken for the human's. It only lowers trust: an
 * agent that unsets its env is back to the broker's own checks.
 */
export function callerAgentField(env: NodeJS.ProcessEnv): { callerAgent?: string } {
  const callerAgent = [env.AGENT_CHAT_NAME, env.AGENT_CHAT_AGENT_ID].find(
    v => v !== undefined && v.trim() !== '',
  )
  return callerAgent === undefined ? {} : { callerAgent }
}

export async function agentSpawn(
  name: string,
  profile: string,
  words: string[],
  // CC-63: an active-work initiative slug (or "auto"), prepended to the brief
  // as orientation. Optional, so every call site that predates it still works.
  // CC-100: `--config-dir` names the Claude account the agent runs on. Absent, the
  // shell's own `CLAUDE_CONFIG_DIR` is forwarded instead — there is no registry
  // entry for the human to read one from, and their shell is where the account
  // they think they are on actually lives.
  // CC-915: `--task` and `--role` land on the agent record; the broker validates the role.
  // CC-1666: `--slice` and `--route-override` land on the spawn row for the router to read.
  // `--worktree` adopts an existing tree, as the MCP tool's `worktree` does. It is also the cwd the
  // broker checks (absolute, existing directory), because the cwd this sends would beat it.
  // CC-973: `--spawned-as` lets Shepherd or burndown claim a CLI spawn instead of the human.
  // CC-840: `--remote-control` asks for Remote Control; the broker refuses it for a worker profile.
  // CC-1059: `--host` names the machine to launch on; absent, a remote broker hands the launch back here.
  // TP-4214: `--account` names the account or asks for the least-used one; the broker picks it.
  options: {
    briefing?: string
    briefStdin?: boolean
    configDir?: string
    account?: string
    task?: string
    role?: string
    slice?: string
    routeOverride?: string
    worktree?: string
    surface?: SurfaceName
    spawnedAs?: SpawnedAs
    remoteControl?: boolean
    host?: string
    launchedBy?: Launcher
    launchReason?: string
  } = {},
): Promise<void> {
  let brief: string
  try {
    brief = resolveBrief(words, options.briefStdin === true ? await readStdin() : undefined)
  } catch (err) {
    fail((err as Error).message)
  }
  const res = await withBroker(b =>
    // The human holds no registry entry (§6.4), so the broker has no cwd or host to
    // read for them — send both, or the agent inherits the broker's arbitrary ones.
    requestSpawn(b, {
      t: 'spawn',
      name,
      profile,
      brief,
      cwd: options.worktree ?? process.cwd(),
      ...(options.worktree === undefined ? {} : { worktree: options.worktree }),
      ...(options.briefing === undefined ? {} : { briefing: options.briefing }),
      ...(options.configDir === undefined ? {} : { configDir: options.configDir }),
      ...(options.account === undefined ? {} : { account: options.account }),
      ...(options.task === undefined ? {} : { task: options.task }),
      ...(options.role === undefined ? {} : { workRole: options.role }),
      ...(options.slice === undefined ? {} : { slice: options.slice }),
      ...(options.routeOverride === undefined ? {} : { routeOverride: options.routeOverride }),
      ...(options.surface === undefined ? {} : { surface: options.surface }),
      ...(options.spawnedAs === undefined ? {} : { spawnedAs: options.spawnedAs }),
      ...(options.launchedBy === undefined ? {} : { launchedBy: options.launchedBy }),
      ...(options.launchReason === undefined ? {} : { launchReason: options.launchReason }),
      ...callerAgentField(process.env),
      ...(options.remoteControl === true ? { remoteControl: true } : {}),
      ...(process.env.CLAUDE_CONFIG_DIR === undefined
        ? {}
        : { spawnerConfigDir: process.env.CLAUDE_CONFIG_DIR }),
      ...(options.host === undefined ? {} : { host: options.host }),
      callerHost: os.hostname(),
      ...launchHereFields(),
    }),
  )

  for (const warning of res.warnings ?? []) console.log(warning)
  if (res.account !== undefined) console.log(`account: ${res.account}`)
  const on = res.host === undefined ? '' : ` on ${res.host}`
  console.log(res.ok ? `Spawned ${res.name} (${res.agentId})${on}.` : `Not spawned: ${res.reason}`)
  if (!res.ok && res.code !== undefined)
    console.log(`code: ${res.code}${res.retryable === undefined ? '' : ` retryable: ${res.retryable}`}`)
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
export async function agentSurface(name: string): Promise<Report> {
  const res = (await withBroker(b => b.request({ t: 'surface', name }, 'switch_result'))) as Extract<
    ServerMessage,
    { t: 'switch_result' }
  >
  return {
    ok: res.ok,
    lines: [
      res.ok
        ? `${name} is now in ${res.surface}, resumed on its existing conversation. ` +
          'The turn it was part way through was interrupted.'
        : `Not surfaced: ${res.reason}`,
    ],
  }
}

/**
 * The human's veto on a teleport countdown, and deliberately a CLI verb rather
 * than a tool: the countdown exists so a person can stop a session ending
 * itself, and a veto any agent could exercise is not a veto. The broker refuses
 * this frame from a registered connection; this one holds no registration.
 */
export async function teleportAbort(name: string): Promise<Report> {
  const res = (await withBroker(b => b.request({ t: 'teleport_abort', name }, 'teleport_result'))) as Extract<
    ServerMessage,
    { t: 'teleport_result' }
  >
  return {
    ok: res.ok,
    lines: [res.ok ? `Stopped ${name}'s teleport. It is still live, on the old build.` : String(res.reason)],
  }
}

/**
 * The peer-facing half of `session_budget` — what a planner reads before it
 * decides who gets the next task. `[name]` omitted lists every agent with a
 * reading, because the pacing question is usually "which of these is nearly
 * full", not "how is one of them doing".
 */
export async function agentBudget(
  name?: string,
  options: { mine?: boolean; spawner?: string; prefix?: string } = {},
): Promise<Report> {
  const filter = rosterFilter(options)
  const all = await withBroker(async b => {
    const res = (await b.request({ t: 'agents' }, 'agents_result')) as Extract<
      ServerMessage,
      { t: 'agents_result' }
    >
    return res.agents
  })
  const agents = filterRoster(all, filter)

  const wanted = newestByName(name === undefined ? agents : agents.filter(a => a.name === name))
  if (wanted.length === 0) {
    return {
      ok: false,
      lines: [],
      errors: [name === undefined ? 'No agents have a durable identity.' : `No agent "${name}".`],
    }
  }

  const account = accountReader()
  const lines = wanted.map(agent => {
    const read = readBudget(agent.sessionId, Date.now(), agent.configDir)
    return read.found
      ? formatBudget(agent.name, read, account(agent.configDir))
      : budgetMiss(agent.name, read)
  })
  return { ok: true, lines }
}

export function profiles(only?: string): Report {
  let names: string[]
  try {
    names = selectProfileNames(only)
  } catch (e) {
    return { ok: false, lines: [], errors: [(e as Error).message] }
  }
  const lines: string[] = []
  for (const name of names) {
    const profile = loadProfile(name)
    if ('error' in profile) {
      lines.push(`${name.padEnd(14)} !! ${profile.error}`)
      continue
    }
    lines.push(
      `${name.padEnd(14)} ${profile.model.padEnd(7)} ${profile.surface.padEnd(12)} ${profile.description}`,
    )
    lines.push(`${' '.repeat(14)} tools: ${profile.allowedTools.join(', ')}`)
    for (const warning of profile.warnings ?? []) lines.push(`${' '.repeat(14)} warning: ${warning}`)
  }
  return { ok: true, lines }
}
