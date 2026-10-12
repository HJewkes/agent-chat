import { routeTemplate } from '../gh-calls/log.js'
import type { CallShape } from './call-log.js'

/** What a passed-through gh command calls, for its gh-calls line (TP-1172 b). */

/** Commands that never reach GitHub, so they get no line. */
const LOCAL = new Set(['help', 'version', 'completion', 'config', 'alias', '--version', '--help', '-h'])

/** Top-level commands gh serves from REST; the rest (pr, issue, repo, ...) read through GraphQL. */
const REST_COMMANDS = new Set(['run', 'workflow', 'release', 'cache', 'secret', 'variable', 'gist'])

/** `gh api` flags that take a value, so the value is never read as the endpoint. */
const VALUED = new Set([
  '-X',
  '--method',
  '-H',
  '--header',
  '-f',
  '--raw-field',
  '-F',
  '--field',
  '--input',
  '-q',
  '--jq',
  '-t',
  '--template',
  '--hostname',
  '--cache',
  '-p',
  '--preview',
])
const BODY_FLAGS = new Set(['-f', '--raw-field', '-F', '--field', '--input'])

interface ApiArgs {
  endpoint?: string
  method?: string | undefined
  hasBody: boolean
  include: boolean
}

function flagValue(
  arg: string,
  next: string | undefined,
): { name: string; value?: string | undefined; used: number } {
  const eq = arg.startsWith('--') ? arg.indexOf('=') : -1
  if (eq > 0) return { name: arg.slice(0, eq), value: arg.slice(eq + 1), used: 1 }
  if (/^-[A-Za-z].+/.test(arg) && VALUED.has(arg.slice(0, 2))) {
    return { name: arg.slice(0, 2), value: arg.slice(2), used: 1 }
  }
  return VALUED.has(arg) ? { name: arg, value: next, used: 2 } : { name: arg, used: 1 }
}

function readApiArgs(args: readonly string[]): ApiArgs {
  const parsed: ApiArgs = { hasBody: false, include: false }
  for (let i = 0; i < args.length;) {
    const arg = args[i] ?? ''
    if (!arg.startsWith('-') || arg === '-') {
      parsed.endpoint ??= arg
      i += 1
      continue
    }
    const flag = flagValue(arg, args[i + 1])
    if (flag.name === '-i' || flag.name === '--include') parsed.include = true
    if (flag.name === '-X' || flag.name === '--method') parsed.method = flag.value?.toUpperCase()
    if (BODY_FLAGS.has(flag.name)) parsed.hasBody = true
    i += flag.used
  }
  return parsed
}

function apiShape(args: readonly string[]): CallShape {
  const { endpoint = '', method, hasBody, include } = readApiArgs(args)
  if (endpoint === 'graphql') return { api: 'graphql', method: method ?? 'POST', route: 'graphql', include }
  const route = routeTemplate(endpoint.replace(/^https:\/\/api\.github\.com\//, ''))
  return { api: 'rest', method: method ?? (hasBody ? 'POST' : 'GET'), route, include }
}

/** `CLI` marks a gh command line rather than one HTTP method: the route is `<command> <subcommand>`. */
export function callShape(argv: readonly string[]): CallShape | undefined {
  const [command, ...rest] = argv
  if (command === undefined || LOCAL.has(command) || rest.includes('--help') || rest.includes('-h'))
    return undefined
  if (command === 'api') return apiShape(rest)
  const sub = rest.find(arg => !arg.startsWith('-'))
  const route = sub === undefined ? command : `${command} ${sub}`
  return { api: REST_COMMANDS.has(command) ? 'rest' : 'graphql', method: 'CLI', route, include: false }
}
