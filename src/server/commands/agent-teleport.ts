import { z } from 'zod'
import { present, requiredString } from '../../args.js'
import { AGENT_TELEPORT_REASONS, SURFACE_NAMES, type ServerMessage } from '../../protocol.js'
import { defineTool } from '../command.js'
import { defaultCallerLaunch, runCallerTeleport } from '../caller-teleport.js'
import { hostIdentity } from '../host.js'
import {
  hostCarriedFlags,
  hostRemoteControl,
  isCarriedModel,
  type CarriedFlags,
} from '../../broker/host-channels.js'
import { observedModel } from '../../agents/transcript.js'

const PLACEMENT_WORDS = {
  'same-pane': 'in the same window',
  'new-surface': 'in a new surface, not this window',
  'other-machine': 'on another machine',
  unreported: 'shortly',
} as const

export function describeTeleport(res: Extract<ServerMessage, { t: 'teleport_result' }>): string {
  if (!res.ok) return `Not teleporting: ${res.reason}`
  const warnings = (res.warnings ?? []).map(w => `\n  warning: ${w}`).join('')
  const when =
    res.countdownMs === undefined
      ? 'Your successor is starting now and this session is being shut down.'
      : `Your human has ${Math.round(res.countdownMs / 1000)}s to stop this, then you will be shut ` +
        `down and your successor will open ${PLACEMENT_WORDS[res.placement ?? 'unreported']}.`
  return (
    `Teleport accepted. Handoff recorded; your successor is ${res.agentId} and keeps the name ` +
    `"${res.name}". ${when} Do not start anything new — finish or write down whatever is in ` +
    `flight, because it will not survive this turn.${warnings}`
  )
}

/**
 * CC-1166: a broker on another host cannot read this session's transcript, so this process reports
 * the model it ran on. The observed model wins over argv `--model`, as in `baseConfig`, because a
 * `/model` switch changes it after launch.
 */
export function launchSeenWithModel(
  argv: CarriedFlags | undefined,
  sessionId: string | undefined,
): CarriedFlags | undefined {
  const observed =
    sessionId === undefined
      ? undefined
      : observedModel(process.cwd(), sessionId, process.env.CLAUDE_CONFIG_DIR)
  const model = observed !== undefined && isCarriedModel(observed) ? observed : argv?.model
  if (model === undefined) return argv
  return { ...(argv ?? { channels: [] }), model }
}

/**
 * Hand off and end this session. Nothing here names the subject: the broker resolves it from this
 * connection's own registry entry, which makes "teleport someone else" unrepresentable.
 */
export const agentTeleport = defineTool({
  name: 'agent_teleport',
  description:
    'End this session and start a successor on the CURRENT build, keeping your name, peers, tags, ' +
    'working directory and Claude account (CLAUDE_CONFIG_DIR); teleport cannot change the account, ' +
    'so ask your human to move you. Use it when your context is filling (a `[budget]` line), when ' +
    'you are parked waiting on the human (`reason: "park"`), or when your instructions or code have ' +
    "moved since you started. If you changed agent-chat's own code, run `npm run build` first; " +
    'otherwise skip it. This is not a resume and not a subagent: your transcript does not come ' +
    'with you, the handoff below is all your successor gets, and you will be shut down. If you are ' +
    'visible in a terminal, your human gets 30 seconds to stop it; if you are headless it happens ' +
    'immediately. You cannot cancel it yourself. Your open questions to the human move with your ' +
    'name: your successor is shown each id and its text, and their answers go to it.',
  args: z.object({
    handoff: requiredString('handoff').describe(
      'Everything your successor needs, written by you, stored verbatim, 8 KB max (refused, not ' +
        'truncated). Cover, in this order: (1) what you were mid-way through, in enough detail to ' +
        'resume without you; (2) state on disk — branch, uncommitted files, what builds and what ' +
        'does not; (3) what you would have done next, and why that and not the alternative; (4) ' +
        'what you already tried that did NOT work, which is the most expensive thing to lose; (5) ' +
        'who you owe a reply to and what you promised; (6) files to read first, in order, as ' +
        '@-prefixed absolute paths — Claude Code expands those into your successor’s first turn, ' +
        'so point at files instead of pasting them.',
    ),
    model: z
      .string()
      .describe(
        'Optional. Omit to keep running on the model you are on now, which is the usual case. Set ' +
          'it only to succeed yourself onto a different one deliberately — a cheaper model for a ' +
          'long grind, a stronger one for what is left.',
      )
      .optional(),
    remote_control: z
      .boolean()
      .describe(
        'Optional. Omit to carry Remote Control across when this session was launched with ' +
          '--remote-control; a coordinator seat always keeps it. Set true if you turned it on mid-session with /remote-control, which ' +
          'the broker cannot see; set false to drop it. A worker successor never gets it, and true ' +
          'is refused for one. Headless successors ignore it.',
      )
      .optional(),
    reason: z
      .enum(AGENT_TELEPORT_REASONS)
      .describe(
        'Optional. Omit for an ordinary teleport. Set "park" when you are idle waiting on the human ' +
          'and are handing off to a fresh session: your successor is told to ask your open question ' +
          'from the handoff first, so restate that question in the handoff.',
      )
      .optional(),
    surface: z
      .enum(SURFACE_NAMES)
      .describe(
        'Optional. Omit for your seat or current surface when the destination runs it, else its OS ' +
          'default (tmux-window on Linux, iterm-tab on macOS). One it cannot run is refused.',
      )
      .optional(),
    to: z
      .string()
      .describe(
        'Optional. Omit to stay on this machine; else a machine alias from the broker config, or a ' +
          'hostname. Unknown or unreachable is refused and never ends you.',
      )
      .optional(),
  }),
  result: z.string(),
  async run(
    { handoff, model: requested, remote_control: remoteControl, reason, surface, to: destination },
    ctx,
  ) {
    if (ctx.registeredName === null)
      return (
        'Register with chat_register first: teleport hands your name to a successor, and you do not ' +
        'have one yet.'
      )
    const model = present(requested)
    const to = present(destination)
    // CC-883: a broker on another host cannot read this session's argv, so this process reports it.
    const seen = remoteControl === undefined && hostRemoteControl(hostIdentity().hostPid) === true
    const launchSeen = launchSeenWithModel(hostCarriedFlags(hostIdentity().hostPid), hostIdentity().sessionId)
    const res = (await ctx.broker.request(
      {
        t: 'teleport',
        handoff,
        ...(model === undefined ? {} : { model }),
        ...(remoteControl === undefined ? {} : { remoteControl }),
        ...(seen ? { remoteControlSeen: true } : {}),
        ...(reason === undefined ? {} : { reason }),
        ...(surface === undefined ? {} : { surface }),
        // CC-951: a broker on another host picks this session's default surface by its OS, not its own.
        hostPlatform: process.platform,
        ...(launchSeen === undefined ? {} : { launchSeen }),
        ...(to === undefined ? {} : { to }),
        // CC-951: this build ends its own Claude Code on `endSelf`, so the broker may route it successor first.
        endsSelf: true,
      },
      'teleport_result',
    )) as Extract<ServerMessage, { t: 'teleport_result' }>
    // CC-881: the broker is on another host, so the relaunch runs here once the countdown ends.
    if (res.ok && res.remote === true)
      void runCallerTeleport(ctx.broker, hostIdentity().hostPid, defaultCallerLaunch()).catch(err =>
        process.stderr.write(`agent-chat: teleport launch on this host failed: ${(err as Error).message}\n`),
      )
    return describeTeleport(res)
  },
})
