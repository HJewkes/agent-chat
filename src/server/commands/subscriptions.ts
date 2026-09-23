import { z } from 'zod'
import { present } from '../../args.js'
import { SUBSCRIBABLE_KINDS } from '../../protocol.js'
import type { ServerMessage, SubscribableKind, SubscriptionSelector } from '../../protocol.js'
import { defineTool } from '../command.js'

const SCOPES = ['all', 'name', 'tag', 'spawned'] as const
type Scope = (typeof SCOPES)[number]

// Missing and misspelled keep the two refusals the hand-written check gave them.
const scope = () =>
  z.enum(SCOPES, {
    error: issue =>
      issue.input === undefined
        ? `scope is required and must be one of: ${SCOPES.join(', ')}`
        : `scope must be one of: ${SCOPES.join(', ')}`,
  })

/** Joins and leaves — what someone asking to be told about comings and goings means. */
const DEFAULT_SUBSCRIBED_KINDS: SubscribableKind[] = [
  'registered',
  'deregistered',
  'agent_attached',
  'agent_detached',
]

const describeSelector = (selector: SubscriptionSelector): string =>
  'all' in selector
    ? 'everything'
    : 'name' in selector
      ? `agent "${selector.name}"`
      : 'spawnedBy' in selector
        ? 'agents you spawned'
        : `tag "${selector.tag}"`

/**
 * "all" and "spawned" need no target; "name" and "tag" are meaningless without
 * one. Checked in run rather than the schema, which cannot say it, because a
 * scope silently defaulting to global is the one mistake that turns a quiet bus
 * into a loud one.
 */
function selectorFrom(scope: Scope, rawTarget: string | undefined): SubscriptionSelector {
  if (scope === 'all') return { all: true }
  if (scope === 'spawned') return { spawnedBy: 'self' }
  const target = present(rawTarget)
  if (target === undefined) throw new Error(`scope "${scope}" needs target set to the ${scope} to watch`)
  return scope === 'name' ? { name: target } : { tag: target }
}

type SubscribeResult = Extract<ServerMessage, { t: 'subscribe_result' }>

export const chatSubscribe = defineTool({
  name: 'chat_subscribe',
  description:
    'Ask to be told when sessions and agents come and go. Scope it: "name" for one agent, "tag" for ' +
    'everything carrying a tag, "spawned" for agents you yourself spawned (auto-applied on agent_spawn, ' +
    'so you rarely need to set this by hand), or "all" — which is genuinely noisy on a busy bus and ' +
    'worth avoiding unless you are coordinating. Events arrive batched and marked from agent-chat, and ' +
    'are LIFECYCLE ONLY: you learn who is here, never what anyone said. Re-subscribing with the same ' +
    'scope replaces that rule rather than adding a second one. Subscriptions last as long as this session.',
  args: z.object({
    scope: scope().describe('What to watch. "name" and "tag" need target set; "spawned" and "all" do not.'),
    target: z.string().describe('The agent name, or the tag. Omit for scope "all" or "spawned".').optional(),
    kinds: z
      .array(
        z.enum(SUBSCRIBABLE_KINDS, { error: `kinds must all be one of: ${SUBSCRIBABLE_KINDS.join(', ')}` }),
      )
      .describe(`Which events. Defaults to joins and leaves. One of: ${SUBSCRIBABLE_KINDS.join(', ')}`)
      .optional(),
  }),
  result: z.string(),
  async run(input, ctx) {
    const selector = selectorFrom(input.scope, input.target)
    const kinds = input.kinds ?? DEFAULT_SUBSCRIBED_KINDS
    const res = (await ctx.broker.request(
      { t: 'subscribe', subscriptions: [{ selector, kinds }] },
      'subscribe_result',
    )) as SubscribeResult
    if (!res.ok) return `Not subscribed: ${res.reason}`
    return `Subscribed to ${describeSelector(selector)} for ${kinds.join(', ')}. Holding ${res.held}.`
  },
})

export const chatUnsubscribe = defineTool({
  name: 'chat_unsubscribe',
  description:
    'Stop being told. Pass the same scope and target to drop one rule, or no arguments at all to drop ' +
    'every subscription this session holds.',
  args: z.object({
    scope: scope().optional(),
    target: z.string().optional(),
  }),
  result: z.string(),
  async run(input, ctx) {
    const selector = input.scope === undefined ? undefined : selectorFrom(input.scope, input.target)
    const res = (await ctx.broker.request(
      { t: 'unsubscribe', ...(selector === undefined ? {} : { selector }) },
      'subscribe_result',
    )) as SubscribeResult
    return selector === undefined
      ? `Dropped every subscription. Holding ${res.held}.`
      : `Unsubscribed from ${describeSelector(selector)}. Holding ${res.held}.`
  },
})
