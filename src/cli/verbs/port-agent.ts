import { z } from 'zod'
import { EXIT } from '@titan-design/registry'
import { requiredString } from '../../args.js'
import type { ClientMessage, ServerMessage } from '../../protocol.js'
import type { BrokerClient } from '../../client/broker-client.js'
import { defineVerb, Report, type VerbContext } from '../command.js'
import { PortRefusal, runPort, type PortEnvelope } from '../port.js'
import { readStdin } from './permission-hook.js'

type SpawnResult = Extract<ServerMessage, { t: 'spawn_result' }>
type ReadInput = () => Promise<string>

const nonBlank = z.string().refine(s => s.trim() !== '', 'must be a non-empty string')

/**
 * The tick's own `SpawnFrame` and nothing more. Strict, so a caller cannot add a field
 * the tick never sends (`forkFrom`, `inherit`, `resumeSession`, `override`, `host`,
 * `remoteControl`, `spawnerConfigDir`): this port spawns exactly as burndown does.
 */
export const PortSpawnFrame = z
  .object({
    t: z.literal('spawn'),
    name: nonBlank,
    profile: nonBlank,
    brief: nonBlank,
    cwd: nonBlank,
    configDir: nonBlank,
    surface: z.literal('headless'),
    briefing: z.string(),
    tags: z.array(z.string()),
    task: nonBlank,
    predecessor: z.string().exactOptional(),
    worktree: z.string().exactOptional(),
    tier: z.number().int().exactOptional(),
    spawnedAs: z.literal('burndown'),
    claimPaths: z.array(z.string()).exactOptional(),
    baseRef: nonBlank.exactOptional(),
  })
  .strict()
export type PortSpawnFrame = z.infer<typeof PortSpawnFrame>

/** `data` of a `port spawn|retire|resume` envelope: every `SpawnResultFields` the broker answered with. */
export const SpawnPortOutput = z.object({
  ok: z.literal(true),
  agentId: z.string().optional(),
  name: z.string().optional(),
  /** On a retire, a caveat: what the broker could not do (CC-77). */
  reason: z.string().optional(),
  code: z.string().optional(),
  retryable: z.boolean().optional(),
  retryAfterMs: z.number().optional(),
  warnings: z.array(z.string()).optional(),
  disallowedTools: z.array(z.string()).optional(),
  transcript: z.object({ path: z.string(), found: z.boolean() }).optional(),
  base: z.object({ ref: z.string(), sha: z.string() }).optional(),
  launch: z.unknown().optional(),
  host: z.string().optional(),
})
export type SpawnPortOutput = z.infer<typeof SpawnPortOutput>

/** A refused frame or message is a usage error: one envelope line, exit 64, and nothing sent. */
function invalidInput(message: string): Report {
  const envelope: PortEnvelope = { ok: false, error: { code: 'invalid_input', message, retryable: false } }
  return { ok: false, lines: [JSON.stringify(envelope)], errors: [message], exit: EXIT.USAGE }
}

type SpawnFields = Omit<PortSpawnFrame, 't'>

function parseFrame(raw: string): SpawnFields | string {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return 'stdin is not a JSON spawn frame'
  }
  const parsed = PortSpawnFrame.safeParse(json)
  if (!parsed.success)
    return parsed.error.issues.map(i => `${i.path.join('.') || 'frame'}: ${i.message}`).join('; ')
  const { t: _t, ...fields } = parsed.data
  return fields
}

/** A refusal keeps the broker's `code`, `retryable` and `retryAfterMs` (`broker_draining`, CC-1179). */
async function spawnResult(
  broker: BrokerClient,
  frame: ClientMessage,
  refused: string,
): Promise<SpawnPortOutput> {
  const { t: _t, ...res } = (await broker.request(frame, 'spawn_result')) as SpawnResult
  if (!res.ok)
    throw new PortRefusal(
      res.code ?? refused,
      res.reason ?? refused,
      res.retryable === true,
      res.retryAfterMs,
    )
  return { ...res, ok: true }
}

const sendOnce = (ctx: VerbContext, frame: ClientMessage, refused: string): Promise<Report> =>
  runPort(ctx, broker => spawnResult(broker, frame, refused))

/**
 * The frame comes on stdin, so the brief stays off argv (R-68). The connection is
 * never registered, which is the only connection whose `spawnedAs` the broker reads.
 */
export const portSpawnVerbWith = (read: ReadInput) =>
  defineVerb({
    name: 'port.spawn',
    description:
      "spawn from burndown's spawn frame on stdin as one JSON envelope line; never starts a broker",
    args: z.object({ frameStdin: z.literal(true) }).strict(),
    result: Report,
    cli: {
      options: { frameStdin: { long: '--frame-stdin', description: 'read the spawn frame JSON from stdin' } },
    },
    async run(_args, ctx) {
      const fields = parseFrame(await read())
      if (typeof fields === 'string') return invalidInput(fields)
      return sendOnce(ctx, { t: 'spawn', ...fields }, 'spawn_refused')
    },
  })

export const portSpawnVerb = portSpawnVerbWith(readStdin)

/** The tick's retire: by name, never forced, and naming no caller. */
export const portRetireVerb = defineVerb({
  name: 'port.retire',
  description: 'retire one agent as burndown does, as one JSON envelope line; never starts a broker',
  args: z.object({ name: requiredString('name') }).strict(),
  result: Report,
  cli: { positional: ['name'] },
  run: ({ name }, ctx) => sendOnce(ctx, { t: 'retire', name }, 'retire_refused'),
})

/** The tick's resume: headless, on a wake message read from stdin. */
export const portResumeVerbWith = (read: ReadInput) =>
  defineVerb({
    name: 'port.resume',
    description: 'resume an agent headless on a message from stdin, as one JSON envelope line',
    args: z.object({ name: requiredString('name'), messageStdin: z.literal(true) }).strict(),
    result: Report,
    cli: {
      positional: ['name'],
      options: { messageStdin: { long: '--message-stdin', description: 'read the wake message from stdin' } },
    },
    async run({ name }, ctx) {
      const message = await read()
      if (message.trim() === '') return invalidInput('--message-stdin got an empty message on stdin')
      return sendOnce(ctx, { t: 'resume', name, surface: 'headless', message }, 'resume_refused')
    },
  })

export const portResumeVerb = portResumeVerbWith(readStdin)
