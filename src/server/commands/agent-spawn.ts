import { AgentSpawnArgsSchema } from '@titan-design/agent-protocol/wire'
import { z } from 'zod'
import { patternList, present } from '../../args.js'
import { type ClientMessage, type ServerMessage } from '../../protocol.js'
import { verdictLine } from '../../agents/resume-session.js'
import { defineTool } from '../command.js'
import { launchHereFields, requestSpawn } from '../caller-spawn.js'

const args = AgentSpawnArgsSchema

type SpawnArgs = z.infer<typeof args>

/** Blank optional strings leave the frame, exactly as `optionalString` dropped them. */
function spawnFrame(input: SpawnArgs): Extract<ClientMessage, { t: 'spawn' }> {
  const configDir = present(input.config_dir)
  // CC-100: the broker's own CLAUDE_CONFIG_DIR is an accident of which session autostarted it.
  const spawnerConfigDir = process.env.CLAUDE_CONFIG_DIR
  const cwd = present(input.cwd)
  const briefing = present(input.briefing)
  const worktree = present(input.worktree)
  const owns = patternList('owns', input.owns)
  const resumeSession = present(input.resume_session)
  const predecessor = present(input.predecessor)
  const task = present(input.task)
  const host = present(input.host)
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
    ...(input.remote_control === undefined ? {} : { remoteControl: input.remote_control }),
    ...(resumeSession === undefined ? {} : { resumeSession }),
    ...(predecessor === undefined ? {} : { predecessor }),
    ...(input.experiment === undefined ? {} : { experiment: input.experiment }),
    ...(input.return_contract === undefined ? {} : { returnContract: input.return_contract }),
    ...(task === undefined ? {} : { task }),
    ...(input.role === undefined ? {} : { workRole: input.role }),
    ...(input.override === undefined ? {} : { override: input.override }),
    ...(host === undefined ? {} : { host }),
    // CC-1059: this process can launch here, so a broker on another host hands it the launch.
    ...launchHereFields(),
  }
}

/** CC-445: a parseable trailer so a caller can branch on the cause instead of the prose. */
export const refusalLine = (res: { code?: string; retryable?: boolean }): string =>
  res.code === undefined
    ? ''
    : `\n  code: ${res.code}${res.retryable === undefined ? '' : ` retryable: ${res.retryable}`}`

function describeSpawn(res: Extract<ServerMessage, { t: 'spawn_result' }>, forkedContext: boolean): string {
  if (!res.ok) return `Not spawned: ${res.reason}${refusalLine(res)}`
  const warnings = (res.warnings ?? []).map(w => `\n  warning: ${w}`).join('')
  // Spawn time is the only place a toolset-confined agent's missing tools are knowable with certainty.
  const denied = res.disallowedTools?.length ? `\n  denied tools: ${res.disallowedTools.join(', ')}` : ''
  // The one caveat a forking session cannot check for itself: its current turn is not in the transcript yet.
  const forked = forkedContext
    ? '\n  it holds a copy of your conversation up to your last COMPLETED turn — not this one'
    : ''
  const resumed = res.transcript === undefined ? '' : `\n  resumed session: ${verdictLine(res.transcript)}`
  const base = res.base === undefined ? '' : `\n  branched from ${res.base.ref} at ${res.base.sha}`
  const on = res.host === undefined ? '' : ` on ${res.host}`
  return (
    `Spawned "${res.name}" (${res.agentId})${on}. It is a peer now — reach it with chat_send, ` +
    `not by spawning again.${forked}${resumed}${base}${warnings}${denied}`
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
    const res = await requestSpawn(ctx.broker, spawnFrame(input))
    return describeSpawn(res, input.inherit !== undefined)
  },
})
