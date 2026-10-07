import type { Run } from './pr-ready.js'
import { pushedHeadBranch } from './pr-ready-pushed.js'

export const BASEMENT_HOST_ENV = 'AGENT_CHAT_BASEMENT_HOST'
const DEFAULT_HOST = 'basement'
const OFF = 'off'
const EXIT_USAGE = 64
const EXIT_SETUP = 69
const EXIT_BUSY = 75

export interface BasementTarget {
  host: string
  repo: string
  branch: string
  agent: string
}

export type BasementRoute =
  | { kind: 'local'; warning?: string }
  | { kind: 'deferred'; commands: string[] }
  | { kind: 'remote'; target: BasementTarget }

export interface BasementResult {
  script: string
  code: number
  output: string
}

const trimmed = (text: string): string => text.trim()

export const basementHost = (env: NodeJS.ProcessEnv): string => env[BASEMENT_HOST_ENV]?.trim() || DEFAULT_HOST

/** The repo name an origin URL ends in, for either `https://host/o/r.git` or `git@host:o/r.git`. */
export const repoNameOf = (url: string): string =>
  trimmed(url)
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .split(/[/:]/)
    .at(-1) ?? ''

const commandFor = (t: BasementTarget, script: string): string[] => [
  t.host,
  'basement-suite',
  t.repo,
  t.branch,
  '--agent',
  t.agent,
  '--run',
  script,
]

export const basementCommandText = (t: BasementTarget, script: string): string =>
  ['ssh', ...commandFor(t, script)].join(' ')

// Mirrors basement-suite's parse_args and prepare_python: anything it would refuse with exit 64 runs locally.
const SUITE_REPOS = [
  'agent-chat',
  'titan-platform',
  'titan-design',
  'active-work',
  'codewatch',
  'voltras-mcp',
]
const TEST_ONLY_REPOS = ['royal_road_player']
const BRANCH_RULE = /^[A-Za-z0-9._/-]+$/
const AGENT_RULE = /^[A-Za-z0-9._-]+$/
const SCRIPT_RULE = /^[A-Za-z0-9:._-]+$/

/** Why basement-suite would refuse this target, or undefined when it accepts it. */
export function refusal(t: BasementTarget, scripts: string[]): string | undefined {
  const testOnly = TEST_ONLY_REPOS.includes(t.repo)
  if (!SUITE_REPOS.includes(t.repo) && !testOnly) return `basement-suite does not serve repo '${t.repo}'`
  if (!BRANCH_RULE.test(t.branch)) return `basement-suite refuses branch name '${t.branch}'`
  if (!AGENT_RULE.test(t.agent)) return `basement-suite refuses agent name '${t.agent}'`
  const bad = scripts.find(script => !SCRIPT_RULE.test(script) || (testOnly && script !== 'test'))
  return bad === undefined ? undefined : `basement-suite cannot run script '${bad}' in ${t.repo}`
}

async function target(
  run: Run,
  cwd: string,
  host: string,
  env: NodeJS.ProcessEnv,
  pushed: string | undefined,
): Promise<BasementTarget> {
  const symbolic = await run('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd)
  const local = symbolic.code === 0 ? trimmed(symbolic.output) : ''
  const origin = await run('git', ['remote', 'get-url', 'origin'], cwd)
  const repo = origin.code === 0 ? repoNameOf(origin.output) : ''
  const agent = env.AGENT_CHAT_NAME || local.split('/').at(-1) || local
  return { host, repo, branch: pushed ?? local, agent }
}

/** One short ssh probe per run decides where the repo-wide checks go. */
export async function routeChecks(
  run: Run,
  cwd: string,
  base: string,
  scripts: string[],
  env: NodeJS.ProcessEnv,
): Promise<BasementRoute> {
  const host = basementHost(env)
  if (host === OFF) return { kind: 'local' }
  const pushed = await pushedHeadBranch(run, cwd, base)
  const t = await target(run, cwd, host, env, pushed)
  const refused = refusal(t, scripts)
  if (refused) return { kind: 'local', warning: `${refused}; running checks locally` }
  const probe = await run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=3', host, 'true'], cwd)
  if (probe.code !== 0)
    return {
      kind: 'local',
      warning: `basement unreachable (probe exit ${probe.code}); running checks locally`,
    }
  if (pushed !== undefined) return { kind: 'remote', target: t }
  return { kind: 'deferred', commands: scripts.map(script => basementCommandText(t, script)) }
}

const INFRA_EXITS: Record<number, string> = {
  [EXIT_USAGE]: 'basement-suite refused the arguments',
  [EXIT_SETUP]: 'basement could not set up the run (fetch, install or build failed)',
  [EXIT_BUSY]: 'basement busy, retry in a few minutes',
}

/** Exits 64, 69 and 75 come from basement-suite itself, so they say nothing about the checks. */
export const infraFailure = (result: BasementResult): string | undefined => INFRA_EXITS[result.code]

/** Stops at the first infrastructure exit: the next script would meet the same slots, fetch or install. */
export async function runOnBasement(
  run: Run,
  cwd: string,
  t: BasementTarget,
  scripts: string[],
): Promise<BasementResult[]> {
  const results: BasementResult[] = []
  for (const script of scripts) {
    const { code, output } = await run('ssh', commandFor(t, script), cwd)
    results.push({ script, code, output })
    if (infraFailure(results.at(-1)!) !== undefined) break
  }
  return results
}

export const describeExit = (result: BasementResult): string => `${result.script} exit ${result.code}`
