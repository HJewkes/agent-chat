import { currentCooldowns, GH_BUDGET_URL_ENV } from './rate-limit.js'

/**
 * Shim reads through Shepherd serve's `shepherd.ghRead` gateway (CC-1178 b), so the machine's agents
 * share its ETag cache and throttle instead of each calling GitHub. A gateway answer is not a real-gh
 * call and gets no gh-calls line; the gateway journals its own. Anything the gateway does not answer
 * from GitHub or its memory falls back, for that path only, to the direct `gh api` read under the
 * REST cooldown.
 */

const DEFAULT_GH_READ_URL = 'http://127.0.0.1:7410/rpc/shepherd.ghRead'
const GATEWAY_TIMEOUT_MS = 2_000
const MAX_AGE_MS = 10_000

export interface GatewayAnswer {
  kind: 'answer'
  status: number
  body: unknown
  at: number
  stale: boolean
}

/** `miss`: the gateway answered but not with GitHub JSON for this path; `down`: it did not answer. */
export type GatewayReply = GatewayAnswer | { kind: 'miss' } | { kind: 'down' }

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined

/** The ghRead RPC beside the configured ghBudget one, so one variable points the shim at serve. */
export function ghReadUrl(env: NodeJS.ProcessEnv): string {
  const budgetUrl = env[GH_BUDGET_URL_ENV]
  return budgetUrl ? budgetUrl.replace(/[^/]*$/, 'shepherd.ghRead') : DEFAULT_GH_READ_URL
}

/** A snapshot answer is the port's PullRequest, not GitHub JSON, so it is a miss like a refusal. */
export function parseGhRead(envelope: unknown): GatewayReply {
  const data = asRecord(envelope)?.ok === true ? asRecord(asRecord(envelope)?.data) : undefined
  const at = typeof data?.at === 'string' ? Date.parse(data.at) : Number.NaN
  if (data === undefined || (data.source !== 'github' && data.source !== 'memory')) return { kind: 'miss' }
  if (typeof data.status !== 'number' || !Number.isFinite(at)) return { kind: 'miss' }
  return { kind: 'answer', status: data.status, body: data.body, at, stale: data.stale === true }
}

/** `raw` asks serve to skip its PR snapshot; a serve that predates it drops the key and may still send one. */
export async function askGateway(
  url: string,
  path: string,
  caller: string,
  signal: AbortSignal,
): Promise<GatewayReply> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-titan-client': 'agent-chat-gh-shim' },
      body: JSON.stringify({ path, maxAgeMs: MAX_AGE_MS, caller, raw: true }),
      signal,
    })
    return parseGhRead(await res.json())
  } catch {
    return { kind: 'down' }
  }
}

/** One try per process: once serve is down or slow, every later path goes straight to gh. */
export function gatewayReader(env: NodeJS.ProcessEnv): (path: string) => Promise<GatewayReply> {
  const url = ghReadUrl(env)
  const caller = env.AGENT_CHAT_NAME || 'shim'
  let down = false
  return async path => {
    if (down || path.includes('{')) return { kind: 'miss' }
    const reply = await askGateway(url, path, caller, AbortSignal.timeout(GATEWAY_TIMEOUT_MS))
    if (reply.kind === 'down') down = true
    return reply
  }
}

export const staleLine = (at: number, now: number): string =>
  `gh-budget: stale ${Math.round((now - at) / 1000)}s\n`

/** Thrown instead of a direct read while REST cools; the shim then gates or passes the command through. */
export class RestCoolingDown extends Error {}

/** `io.api` for the shim's answers: the gateway first, then the direct read unless the REST lane cools. */
export function gatewayApi(
  env: NodeJS.ProcessEnv,
  direct: (path: string) => Promise<unknown>,
  err: (text: string) => void,
): (path: string) => Promise<unknown> {
  const read = gatewayReader(env)
  return async path => {
    const reply = await read(path)
    if (reply.kind === 'answer') {
      if (reply.stale) err(staleLine(reply.at, Date.now()))
      if (reply.status !== 200) throw new Error(`gh api ${path}: HTTP ${reply.status} (gateway)`)
      return reply.body
    }
    if ((await currentCooldowns(env, Date.now())).rest !== undefined) throw new RestCoolingDown(path)
    return direct(path)
  }
}
