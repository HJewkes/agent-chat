import {
  appendCall,
  callLine,
  ghCallsDir,
  limitFromStderr,
  routeTemplate,
  type GhCallLine,
} from '../gh-calls/log.js'

/**
 * The shim's writer of the gh-calls v1 log (TP-1172 b): one line per real-gh call, whether the shim
 * answered from REST or passed the command through. Stderr is only classified, never stored.
 */

export interface Included {
  status: number
  headers: ReadonlyMap<string, string>
  body: string
}

/** Splits `gh api -i` output into its status line, headers and body; null when there is no status line. */
export function parseIncluded(stdout: string): Included | null {
  const statusLine = /^HTTP\/[\d.]+ (\d{3})/.exec(stdout)
  if (statusLine === null) return null
  const blank = /\r?\n\r?\n/.exec(stdout)
  const head = blank === null ? stdout : stdout.slice(0, blank.index)
  const body = blank === null ? '' : stdout.slice(blank.index + blank[0].length)
  const headers = new Map<string, string>()
  for (const line of head.split(/\r?\n/).slice(1)) {
    const colon = line.indexOf(':')
    if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim())
  }
  return { status: Number(statusLine[1]), headers, body }
}

/** The call a gh argv makes, or undefined for one that never reaches GitHub. */
export interface CallShape {
  api: GhCallLine['api']
  method: string
  route: string
  include: boolean
}

export interface CallOutcome {
  exitCode: number
  stdout: string
  stderr: string
  ms: number
}

const intHeader = (headers: ReadonlyMap<string, string> | undefined, name: string): number | undefined => {
  const value = headers?.get(name)
  return value !== undefined && /^\d+$/.test(value) ? Number(value) : undefined
}

/** `gh` prints `HTTP 404` in its error text when it got a response but no `-i` headers were asked for. */
const statusOf = (outcome: CallOutcome, included: Included | null): GhCallLine['status'] => {
  if (included !== null) return included.status
  const http = /\bHTTP (\d{3})\b/.exec(outcome.stderr)
  if (http !== null) return Number(http[1])
  return outcome.exitCode === 0 ? 'ok' : 'error'
}

const optional = <T>(key: string, value: T | undefined): Record<string, T> =>
  value === undefined ? {} : { [key]: value }

export function shimCallLine(caller: string, shape: CallShape, outcome: CallOutcome, now?: Date): GhCallLine {
  const included = shape.include ? parseIncluded(outcome.stdout) : null
  const headers = included?.headers
  return callLine(
    {
      caller,
      api: shape.api,
      method: shape.method,
      route: shape.route,
      status: statusOf(outcome, included),
      ms: outcome.ms,
      remaining: intHeader(headers, 'x-ratelimit-remaining') ?? null,
      resource: headers?.get('x-ratelimit-resource') ?? null,
      ...optional('limit', limitFromStderr(outcome.stderr)),
      ...optional('retryAfter', intHeader(headers, 'retry-after')),
      ...optional('used', intHeader(headers, 'x-ratelimit-used')),
      ...optional('reset', intHeader(headers, 'x-ratelimit-reset')),
    },
    now,
  )
}

export const shimCaller = (env: NodeJS.ProcessEnv): string => env.AGENT_CHAT_NAME || 'shim'

/** The shim's own reads are always `gh api -i <REST path>`. */
export const restRead = (apiPath: string): CallShape => ({
  api: 'rest',
  method: 'GET',
  route: routeTemplate(apiPath),
  include: true,
})

export type CallLogger = (shape: CallShape, outcome: CallOutcome) => void

export const fileCallLogger =
  (env: NodeJS.ProcessEnv): CallLogger =>
  (shape, outcome) =>
    void appendCall(shimCallLine(shimCaller(env), shape, outcome), undefined, ghCallsDir(env))
