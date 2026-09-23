import { z } from 'zod'
import { patternList, present, requiredString } from '../../args.js'
import { ISOLATION_NAMES, SURFACE_NAMES, type ClientMessage, type ServerMessage } from '../../protocol.js'
import { verdictLine } from '../../agents/resume-session.js'
import { defineTool } from '../command.js'

/** The wording `optionalEnum` used, which callers (and agent-presence.test.ts) match on. */
const oneOf = (field: string, allowed: readonly string[]) => ({
  error: `${field} must be one of: ${allowed.join(', ')}`,
})

const INHERIT_NAMES = ['context'] as const

const args = z.object({
  name: requiredString('name').describe('Short handle for the agent, e.g. "auth-review". Must be free.'),
  profile: requiredString('profile').describe('Profile name; see agent_profiles for what each grants.'),
  brief: requiredString('brief').describe(
    'What the agent should do, in full. It starts with only this — it does not inherit your ' +
      'conversation, so state the task, the context needed to act, and what to report back.',
  ),
  surface: z
    .enum(SURFACE_NAMES, oneOf('surface', SURFACE_NAMES))
    .describe(
      "Overrides the profile's surface. Visible surfaces land in your window and can answer " +
        'permission prompts; headless cannot be prompted at all.',
    )
    .optional(),
  isolation: z
    .enum(ISOLATION_NAMES, oneOf('isolation', ISOLATION_NAMES))
    .describe("Overrides the profile's isolation, e.g. worktree to keep it out of your checkout.")
    .optional(),
  cwd: z.string().describe('Working directory. Defaults to yours.').optional(),
  worktree: z
    .string()
    .describe(
      'Absolute path of a worktree the TASK SYSTEM already assigned to this work. Pass it when ' +
        'something upstream decided where this task runs — a parent task, a wave plan — rather than ' +
        'letting the profile pick. It is ADOPTED, not created: it must already exist, no branch is ' +
        'made, no worktree-budget slot is taken, and retiring the agent leaves it in place, because ' +
        'sibling agents may still be working in it. Do not pass a path you invented; if nobody ' +
        'assigned a worktree, omit this and let the profile decide.',
    )
    .optional(),
  owns: z
    .array(z.string())
    .describe(
      'Path globs INSIDE the worktree that this agent owns, e.g. ["src/broker/**", ' +
        '"src/protocol.ts"]. This is what lets several agents share one worktree: each is given a ' +
        'disjoint set of paths, and a spawn overlapping what a live peer already holds is warned ' +
        'about by name. Advisory, like chat_claim — it records who was given what, and cannot stop ' +
        'an agent that writes outside its set.',
    )
    .optional(),
  inherit: z
    .enum(INHERIT_NAMES, oneOf('inherit', INHERIT_NAMES))
    .describe(
      'Set to "context" to start the agent from a COPY of YOUR OWN conversation instead of an ' +
        'empty one — the closest thing here to "fork me". It can only ever fork you: there is no ' +
        'field for whose conversation, and a request to fork a peer is refused. Reach for it when ' +
        'the agent needs what you have been doing and re-describing it would cost more than it is ' +
        'worth. KNOW WHAT IT IS NOT: still a separate process paying its own input tokens, so it ' +
        'is not the cheap built-in fork; and it sees only your COMPLETED turns, never the one you ' +
        'are in, so do not refer to work you have not finished narrating. Also weigh what it ' +
        'carries — the agent inherits everything you have said, including anything its profile was ' +
        'never meant to see. A brief is the narrower and usually better tool.',
    )
    .optional(),
  resume_session: z
    .string()
    .describe(
      "A Claude session uuid to CONTINUE instead of starting fresh, e.g. a retired agent's " +
        'session id from agent_list. Its transcript must already exist under the account ' +
        '(config_dir) and cwd the agent will run in; otherwise the spawn is refused and names the ' +
        'path it checked. The brief becomes its next turn. For an agent that is finished but not ' +
        'retired, agent_resume is simpler.',
    )
    .optional(),
  predecessor: z
    .string()
    .describe(
      'Name of an agent YOU spawned whose work this one takes over, for a follow-up assignment ' +
        'sent to a fresh worker instead of the one that did the first piece. The broker adds a ' +
        "section to the brief with the predecessor's last report (its newest chat_send to you), " +
        'its branch and worktree, and its session id and transcript path, so the brief need only ' +
        'say what to do next. Refused for an agent someone else spawned. It does not retire the ' +
        'predecessor: the spawn warns while it is unretired, and retiring it is yours to do once ' +
        'this one registers.',
    )
    .optional(),
  config_dir: z
    .string()
    .describe(
      'Absolute path of the Claude config dir the agent should run under, and therefore WHICH ' +
        'ACCOUNT it spends, e.g. "/Users/you/.claude-profiles/agents". Omit it in the ordinary ' +
        "case: the agent inherits YOUR account automatically, then the briefing initiative's " +
        "declared profile, then the broker's. Pass it only to bill an account deliberately. It " +
        'must already exist and be under your home directory; anything else is refused rather than ' +
        'quietly replaced, because running on the wrong account is the failure this prevents.',
    )
    .optional(),
  briefing: z
    .string()
    .describe(
      'Optional active-work initiative slug (e.g. "claude-channels"), or "auto". The broker reads ' +
        "that initiative's brief.md, open tasks and latest session note and prepends them to your " +
        'brief, so you do not have to re-describe the project — write the ASSIGNMENT in brief and ' +
        'let this carry the orientation. It also asks the active-work daemon for up to six notes, ' +
        'sources, tasks or sessions ranked against your brief text (any initiative, foreign ones ' +
        'labelled) and lists them with absolute paths; if the daemon does not answer within 1 second ' +
        'that list is left out and the spawn carries a warning. So the brief itself is the query: ' +
        'name the specifics. "auto" resolves from your own directory first, then from ' +
        'cwd; if neither is inside an initiative the spawn still succeeds, with a warning and no ' +
        'briefing. Omit it when the work has no active-work initiative behind it.',
    )
    .optional(),
})

type SpawnArgs = z.infer<typeof args>

/** Blank optional strings leave the frame, exactly as `optionalString` dropped them. */
function spawnFrame(input: SpawnArgs): ClientMessage {
  const configDir = present(input.config_dir)
  // CC-100: the broker's own CLAUDE_CONFIG_DIR is an accident of which session autostarted it.
  const spawnerConfigDir = process.env.CLAUDE_CONFIG_DIR
  const cwd = present(input.cwd)
  const briefing = present(input.briefing)
  const worktree = present(input.worktree)
  const owns = patternList('owns', input.owns)
  const resumeSession = present(input.resume_session)
  const predecessor = present(input.predecessor)
  return {
    t: 'spawn',
    name: input.name,
    profile: input.profile,
    brief: input.brief,
    ...(configDir === undefined ? {} : { configDir }),
    ...(spawnerConfigDir === undefined ? {} : { spawnerConfigDir }),
    ...(input.surface === undefined ? {} : { surface: input.surface }),
    ...(input.isolation === undefined ? {} : { isolation: input.isolation }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(briefing === undefined ? {} : { briefing }),
    ...(worktree === undefined ? {} : { worktree }),
    ...(owns === undefined ? {} : { owns }),
    ...(input.inherit === undefined ? {} : { inherit: input.inherit }),
    ...(resumeSession === undefined ? {} : { resumeSession }),
    ...(predecessor === undefined ? {} : { predecessor }),
  }
}

function describeSpawn(res: Extract<ServerMessage, { t: 'spawn_result' }>, forkedContext: boolean): string {
  if (!res.ok) return `Not spawned: ${res.reason}`
  const warnings = (res.warnings ?? []).map(w => `\n  warning: ${w}`).join('')
  // Spawn time is the only place a toolset-confined agent's missing tools are knowable with certainty.
  const denied = res.disallowedTools?.length ? `\n  denied tools: ${res.disallowedTools.join(', ')}` : ''
  // The one caveat a forking session cannot check for itself: its current turn is not in the transcript yet.
  const forked = forkedContext
    ? '\n  it holds a copy of your conversation up to your last COMPLETED turn — not this one'
    : ''
  const resumed = res.transcript === undefined ? '' : `\n  resumed session: ${verdictLine(res.transcript)}`
  return (
    `Spawned "${res.name}" (${res.agentId}). It is a peer now — reach it with chat_send, ` +
    `not by spawning again.${forked}${resumed}${warnings}${denied}`
  )
}

/**
 * The anchor is deliberately absent from the request. The broker resolves it from THIS session's
 * registry entry, so a spawn cannot be aimed at a pane the caller does not hold (§5.4).
 */
export const agentSpawn = defineTool({
  name: 'agent_spawn',
  description:
    'Spawn a durable agent that runs as its own Claude Code session and joins the bus as an ordinary ' +
    'peer, addressable by name with chat_send. Reach for this — without being asked — when work needs a ' +
    'second, longer-lived context: a review that should run while you keep working, an exploration whose ' +
    "search shouldn't clutter your own context, or a task that must outlive your session. Do NOT spawn " +
    'to parallelise something you could just finish yourself, or to look busy. ' +
    'Register first — the spawn is attributed to you, and a ' +
    'visible agent is placed in YOUR terminal, which the broker resolves from your own registration ' +
    'rather than from anything you pass here. The agent outlives this session: it belongs to the ' +
    'broker, not to you, so spawning is not a way to get work done before your turn ends. The profile ' +
    'decides the model, the tool set and where the agent appears — read agent_profiles before choosing ' +
    'one, and prefer the narrowest that fits.',
  args,
  result: z.string(),
  async run(input, ctx) {
    if (ctx.registeredName === null)
      return 'Register with chat_register first: a spawn is attributed to the session that asked for it.'
    const res = (await ctx.broker.request(spawnFrame(input), 'spawn_result')) as Extract<
      ServerMessage,
      { t: 'spawn_result' }
    >
    return describeSpawn(res, input.inherit !== undefined)
  },
})
