import { findGitRoot } from '../git.js'
import { pairPresence } from '../agents/identity.js'
import { reclaim, sweepWorktrees } from '../agents/isolation/sweep.js'
import { listProfileNames, loadProfile } from '../agents/profiles.js'
import { transcriptLine } from '../agents/transcript.js'
import { type ServerMessage } from '../protocol.js'
import { fail, withBroker } from './client.js'

/**
 * The roster: durable lifecycle paired with ephemeral presence.
 *
 * More truthful than `ps` by construction — a live agent whose broker just
 * bounced shows as reconnecting rather than vanishing, because identity is a
 * query over the log and only presence depends on a socket being up.
 */
export async function agentLs(): Promise<void> {
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
export async function agentWorktrees(options: { prune?: boolean; force?: boolean } = {}): Promise<void> {
  const roster = await withBroker(async b => {
    const result = (await b.request({ t: 'agents' }, 'agents_result')) as Extract<
      ServerMessage,
      { t: 'agents_result' }
    >
    return result.agents
  })
  const root = await findGitRoot(process.cwd())
  const swept = await sweepWorktrees(roster, { ...(root === null ? {} : { roots: [root] }) })

  if (swept.length === 0) return console.log('No agent-chat worktrees on this machine.')
  for (const entry of swept) {
    console.log(`${entry.status.padEnd(12)} ${entry.branch.padEnd(28)} ${entry.worktree}`)
    console.log(`${' '.repeat(12)} ${entry.detail}`)
  }

  if (options.prune !== true) {
    const n = swept.filter(e => e.status === 'reclaimable').length
    return console.log(n === 0 ? '\nNothing to reclaim.' : `\n${n} reclaimable. Reclaim with --prune.`)
  }

  console.log('')
  for (const entry of swept.filter(e => options.force === true || e.status === 'reclaimable')) {
    const result = await reclaim(entry, { ...(options.force === true ? { force: true } : {}) })
    console.log(result.ok ? `Reclaimed ${entry.branch}.` : `Left ${entry.branch}: ${result.reason}`)
  }
}

export async function agentSpawn(
  name: string,
  profile: string,
  words: string[],
  // CC-63: an active-work initiative slug (or "auto"), prepended to the brief
  // as orientation. Optional, so every call site that predates it still works.
  options: { briefing?: string; briefStdin?: boolean } = {},
): Promise<void> {
  let brief: string
  try {
    brief = resolveBrief(words, options.briefStdin === true ? await readStdin() : undefined)
  } catch (err) {
    fail((err as Error).message)
  }
  const res = (await withBroker(b =>
    // The human holds no registry entry (§6.4), so the broker has no cwd to read
    // for them — send it, or the agent inherits the broker's arbitrary one.
    b.request(
      {
        t: 'spawn',
        name,
        profile,
        brief,
        cwd: process.cwd(),
        ...(options.briefing === undefined ? {} : { briefing: options.briefing }),
      },
      'spawn_result',
    ),
  )) as Extract<ServerMessage, { t: 'spawn_result' }>

  for (const warning of res.warnings ?? []) console.log(warning)
  console.log(res.ok ? `Spawned ${res.name} (${res.agentId}).` : `Not spawned: ${res.reason}`)
  process.exit(res.ok ? 0 : 1)
}

/**
 * `--force` is the flag the isolation's own refusal has always told people to
 * use, and until CC-79 it did not exist anywhere: no option here, no field on
 * the wire, and `socket.ts` calling `retire(name)` with the parameter left at
 * its default. Someone whose worktree held uncommitted work was told to pass a
 * flag that was silently ignored, and had to remove the worktree by hand.
 */
export async function agentRetire(name: string, options: { force?: boolean } = {}): Promise<void> {
  const res = (await withBroker(b =>
    b.request({ t: 'retire', name, ...(options.force === true ? { force: true } : {}) }, 'spawn_result'),
  )) as Extract<ServerMessage, { t: 'spawn_result' }>
  // `reason` on a successful retire is a caveat, not a failure: what the broker
  // could not do (CC-77). Dropping it is what let a live process go unnoticed.
  console.log(res.ok ? `Retired ${name}.` : `Not retired: ${res.reason}`)
  if (res.ok && res.reason !== undefined) console.log(res.reason)
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
export async function agentSurface(name: string): Promise<void> {
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

/**
 * The human's veto on a teleport countdown, and deliberately a CLI verb rather
 * than a tool: the countdown exists so a person can stop a session ending
 * itself, and a veto any agent could exercise is not a veto. The broker refuses
 * this frame from a registered connection; this one holds no registration.
 */
export async function teleportAbort(name: string): Promise<void> {
  const res = (await withBroker(b => b.request({ t: 'teleport_abort', name }, 'teleport_result'))) as Extract<
    ServerMessage,
    { t: 'teleport_result' }
  >
  console.log(res.ok ? `Stopped ${name}'s teleport. It is still live, on the old build.` : res.reason)
  process.exit(res.ok ? 0 : 1)
}

export function profiles(): void {
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
