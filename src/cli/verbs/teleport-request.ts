import { z } from 'zod'
import { requiredString } from '../../args.js'
import { resolveMachines } from '../../config.js'
import { SURFACE_NAMES, type ServerMessage, type SurfaceName } from '../../protocol.js'
import { defineVerb, Report } from '../command.js'

/** A hostname's characters only, so the machine the owner typed cannot carry words into the request. */
const HOSTNAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/

/** Why `to` is refused before anything is sent, or undefined when it names an alias or a hostname. */
export function machineBlocker(to: string, aliases: Readonly<Record<string, string>>): string | undefined {
  if (Object.keys(aliases).some(alias => alias.toLowerCase() === to.toLowerCase())) return undefined
  if (HOSTNAME.test(to)) return undefined
  const known = Object.keys(aliases)
  return `--to ${JSON.stringify(to)} is neither a configured machine${known.length ? ` (${known.join(', ')})` : ''} nor a hostname`
}

/** Pure: the owner-sourced message asking a session to teleport itself with these arguments. */
export function teleportRequestText(surface: SurfaceName | undefined, to: string | undefined): string {
  const args = [
    ...(surface === undefined ? [] : [`surface: "${surface}"`]),
    ...(to === undefined ? [] : [`to: "${to}"`]),
  ]
  const call = args.length ? `agent_teleport with ${args.join(' and ')}` : 'agent_teleport'
  return (
    `Teleport request from your human (agent-chat teleport request): at your next safe point, write ` +
    `your State at teleport section as usual, then call ${call}. If it is refused, or you cannot ` +
    `teleport now, tell your human why with chat_notify.`
  )
}

/**
 * CC-951 c: asks, never forces. The broker resolves a teleport's subject from the caller's own
 * connection, so the CLI sends no `teleport` frame; it sends the named session one message as the
 * human, and that session calls `agent_teleport` itself.
 */
export const teleportRequestVerb = defineVerb({
  name: 'teleport.request',
  description: 'ask a session to teleport itself, optionally to a surface or another machine',
  args: z.object({
    name: requiredString('name'),
    surface: z.enum(SURFACE_NAMES).optional(),
    to: z.string().optional(),
  }),
  result: Report,
  cli: {
    positional: ['name'],
    options: {
      surface: {
        long: '--surface <surface>',
        description: `where the successor runs: ${SURFACE_NAMES.join(', ')}`,
      },
      to: {
        long: '--to <machine>',
        description: 'the machine it lands on: an alias from config machines, or a hostname',
      },
    },
  },
  async run({ name, surface, to }, ctx) {
    const blocked = to === undefined ? undefined : machineBlocker(to, resolveMachines())
    if (blocked !== undefined) return { ok: false, lines: [], errors: [`Not requested: ${blocked}`] }
    const res = (await ctx.withBroker(b =>
      b.request({ t: 'human_send', to: name, text: teleportRequestText(surface, to) }, 'send_result'),
    )) as Extract<ServerMessage, { t: 'send_result' }>
    if (!res.ok) return { ok: false, lines: [], errors: [`Not requested: ${res.reason ?? 'send refused'}`] }
    return { ok: true, lines: [`Asked ${name} to teleport (msg_id ${res.msgId}); it teleports itself.`] }
  },
})
