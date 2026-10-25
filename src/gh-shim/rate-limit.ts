import fs from 'node:fs'
import path from 'node:path'
import { classify403, type GhCallLine } from '../gh-calls/log.js'
import {
  LANES,
  budgetPaths,
  mergeCooldowns,
  observedCooldowns,
  recordHit,
  type BudgetPaths,
  type Cooldown,
  type Cooldowns,
  type Hit,
  type Lane,
} from '../gh-budget/state.js'
import { shimCallLine, shimCaller, type CallLogger, type CallShape } from './call-log.js'
import { callShape } from './call-shape.js'
import { processIo } from './io.js'

/**
 * The shim's half of the shared GitHub cooldown (CC-1162). A passed-through call refused by a rate
 * limit records a cooldown for its lane; while a lane cools, reads fail fast without calling GitHub,
 * writes still go through (gh-write waits instead), and `gh api rate_limit` reports the lane spent.
 * The gateway's own cooldown, from Shepherd serve's `shepherd.ghBudget`, is merged in when serve answers.
 */

export const GH_BUDGET_URL_ENV = 'AGENT_CHAT_GH_BUDGET_URL'
const DEFAULT_GH_BUDGET_URL = 'http://127.0.0.1:7410/rpc/shepherd.ghBudget'
export const GATEWAY_CACHE_MS = 10_000
const GATEWAY_TIMEOUT_MS = 500

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined

const untilOf = (value: unknown): number | undefined => {
  const at = typeof value === 'string' ? Date.parse(value) : value
  return typeof at === 'number' && Number.isFinite(at) ? at : undefined
}

/** `{ok: true, data: {cooldowns: [{lane, until, class}]}}`; anything else reads as no gateway cooldown. */
export function parseGhBudget(envelope: unknown): Cooldowns {
  const data = asRecord(envelope)?.ok === true ? asRecord(envelope)?.data : undefined
  const entries = Array.isArray(data) ? data : asRecord(data)?.cooldowns
  const cooldowns: Cooldowns = {}
  for (const raw of Array.isArray(entries) ? entries : []) {
    const entry = asRecord(raw)
    const lane = LANES.find(name => name === entry?.lane)
    const until = untilOf(entry?.until)
    if (lane === undefined || until === undefined) continue
    const cooldown: Cooldown = {
      until,
      class: entry?.class === 'primary' ? 'primary' : 'secondary',
      source: 'gateway',
    }
    Object.assign(cooldowns, mergeCooldowns(cooldowns, { [lane]: cooldown }))
  }
  return cooldowns
}

async function fetchGhBudget(url: string): Promise<Cooldowns> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-titan-client': 'agent-chat-gh-shim' },
      body: '{}',
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
    })
    return parseGhBudget(await res.json())
  } catch {
    return {}
  }
}

/** Serve down, slow or without the RPC is cached too, so a missing gateway costs one try per 10 s. */
export async function gatewayCooldowns(
  env: NodeJS.ProcessEnv,
  paths: BudgetPaths,
  now: number,
): Promise<Cooldowns> {
  try {
    const cached = JSON.parse(fs.readFileSync(paths.gatewayFile, 'utf8')) as {
      at?: unknown
      cooldowns?: Cooldowns
    }
    if (typeof cached.at === 'number' && cached.at <= now && now - cached.at < GATEWAY_CACHE_MS)
      return cached.cooldowns ?? {}
  } catch {
    // No cache yet, or a torn one: ask the gateway.
  }
  const cooldowns = await fetchGhBudget(env[GH_BUDGET_URL_ENV] || DEFAULT_GH_BUDGET_URL)
  try {
    const tmp = `${paths.gatewayFile}.${process.pid}.tmp`
    fs.mkdirSync(path.dirname(paths.gatewayFile), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify({ at: now, cooldowns }))
    fs.renameSync(tmp, paths.gatewayFile)
  } catch {
    // Without a cache the next call asks again.
  }
  return cooldowns
}

/** The lanes cooling down at `now`: the observed state merged with the gateway's. */
export async function currentCooldowns(env: NodeJS.ProcessEnv, now: number): Promise<Cooldowns> {
  const paths = budgetPaths(env)
  const merged = mergeCooldowns(observedCooldowns(paths, now), await gatewayCooldowns(env, paths, now))
  const active: Cooldowns = {}
  for (const lane of LANES) {
    const cooldown = merged[lane]
    if (cooldown !== undefined && cooldown.until > now) active[lane] = cooldown
  }
  return active
}

/**
 * The cooldown a refused call starts, or undefined for a call no rate limit refused.
 * "API rate limit exceeded" in stderr is also what the secondary limit says, so a hit counts as
 * primary only on a `remaining 0` header; gh-write gives up on a primary hit rather than pausing.
 */
export function hitOf(line: GhCallLine): Hit | undefined {
  const kind = classify403(line)
  if (kind !== 'secondary' && kind !== 'primary') return undefined
  const proven = kind === 'primary' && line.remaining === 0
  return {
    lane: line.api,
    class: proven ? 'primary' : 'secondary',
    retryAfterSeconds: line.retryAfter,
    resetSeconds: line.reset,
  }
}

export const READ_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'view',
  'list',
  'status',
  'checks',
  'diff',
  'watch',
])

/** Reads fail fast during a cooldown; anything not known to be a read is a write and goes through. */
export function isRead(argv: readonly string[], shape: CallShape): boolean {
  if (shape.method === 'GET') return shape.route !== 'rate_limit'
  if (shape.method === 'CLI')
    return argv[0] === 'search' || READ_SUBCOMMANDS.has(shape.route.split(' ')[1] ?? '')
  return shape.api === 'graphql' && !argv.some(arg => /\bmutation\b/.test(arg))
}

/** The lane a gh-write argv calls; leading `-R <repo>` is gh-write's own form. */
export function writeLane(args: readonly string[]): Lane {
  let rest = args
  while (rest[0] === '-R' || rest[0] === '--repo') rest = rest.slice(2)
  return callShape(rest)?.api ?? 'rest'
}

/** `gh api rate_limit [--jq <expr>]`, the only shape answered during a cooldown. */
export function rateLimitQuery(argv: readonly string[]): { jq?: string } | undefined {
  const [command, endpoint, ...flags] = argv
  if (command !== 'api' || (endpoint !== 'rate_limit' && endpoint !== '/rate_limit')) return undefined
  if (flags.length === 0) return {}
  const [flag, expr] = flags
  if (flags.length === 2 && (flag === '--jq' || flag === '-q') && expr !== undefined) return { jq: expr }
  if (flags.length === 1 && flag?.startsWith('--jq=')) return { jq: flag.slice('--jq='.length) }
  return undefined
}

const spent = (current: unknown, cooldown: Cooldown): Record<string, number> => {
  const limit = asRecord(current)?.limit
  const total = typeof limit === 'number' ? limit : 5000
  return { limit: total, used: total, remaining: 0, reset: Math.ceil(cooldown.until / 1000) }
}

/** The real `/rate_limit` body, or a bare one, with every cooling lane spent until its cooldown ends. */
export function rateLimitBody(base: unknown, cooldowns: Cooldowns): Record<string, unknown> {
  const body: Record<string, unknown> = { ...asRecord(base) }
  const resources: Record<string, unknown> = { ...asRecord(body.resources) }
  if (cooldowns.rest !== undefined) {
    resources.core = spent(resources.core, cooldowns.rest)
    body.rate = spent(body.rate, cooldowns.rest)
  }
  if (cooldowns.graphql !== undefined) resources.graphql = spent(resources.graphql, cooldowns.graphql)
  body.resources = resources
  return body
}

export function refusal(lane: Lane, cooldown: Cooldown, now: number): string {
  const seconds = Math.ceil((cooldown.until - now) / 1000)
  return (
    `gh (agent-chat shim): GitHub ${lane} calls are cooling down after a ${cooldown.class} rate limit ` +
    `(${cooldown.source ?? 'observed'}) until ${new Date(cooldown.until).toISOString()}, ${seconds}s from now; ` +
    `this read was not sent. Retry after it; writes through agent-chat gh-write wait for it.\n`
  )
}

export interface BudgetContext {
  env: NodeJS.ProcessEnv
  realGh: string
  jqBin: string | undefined
  log: CallLogger
  enforce: boolean
}

export interface ShimBudget {
  /** An exit code when the call was answered or refused here, undefined to carry on. */
  gate(): Promise<number | undefined>
  log: CallLogger
  settled(): Promise<void>
}

async function answerRateLimit(
  query: { jq?: string },
  cooldowns: Cooldowns,
  ctx: BudgetContext,
): Promise<number | undefined> {
  if (query.jq !== undefined && ctx.jqBin === undefined) return undefined
  const io = processIo(ctx.realGh, ctx.jqBin, ctx.log)
  let base: unknown
  try {
    base = await io.api('rate_limit')
  } catch {
    base = undefined
  }
  const body = rateLimitBody(base, cooldowns)
  try {
    process.stdout.write(
      query.jq === undefined ? `${JSON.stringify(body, null, 2)}\n` : io.jq(body, query.jq),
    )
    return 0
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`)
    return 1
  }
}

async function gateCall(argv: readonly string[], ctx: BudgetContext): Promise<number | undefined> {
  const query = rateLimitQuery(argv)
  const shape = callShape(argv)
  const read = shape !== undefined && isRead(argv, shape)
  if (!ctx.enforce || (query === undefined && !read)) return undefined
  const now = Date.now()
  const cooldowns = await currentCooldowns(ctx.env, now)
  if (query !== undefined)
    return LANES.some(lane => cooldowns[lane]) ? await answerRateLimit(query, cooldowns, ctx) : undefined
  const cooldown = shape === undefined ? undefined : cooldowns[shape.api]
  if (shape === undefined || cooldown === undefined) return undefined
  process.stderr.write(refusal(shape.api, cooldown, now))
  return 1
}

/** Wraps the gh-calls logger so every rate-limited call it sees also records a cooldown. */
export function shimBudget(argv: readonly string[], ctx: BudgetContext): ShimBudget {
  const paths = budgetPaths(ctx.env)
  const pending: Promise<void>[] = []
  const deps = { now: Date.now, sleep: (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)) }
  const log: CallLogger = (shape, outcome) => {
    ctx.log(shape, outcome)
    const hit = hitOf(shimCallLine(shimCaller(ctx.env), shape, outcome))
    if (hit !== undefined) pending.push(recordHit(paths, hit, deps))
  }
  return {
    gate: async () => {
      await Promise.all(pending)
      return gateCall(argv, { ...ctx, log })
    },
    log,
    settled: async () => void (await Promise.all(pending)),
  }
}
