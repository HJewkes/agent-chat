import type { Run } from './pr-ready.js'
import { headIsPushed } from './pr-ready-pushed.js'

export const BASEMENT_HOST_ENV = 'AGENT_CHAT_BASEMENT_HOST'
const DEFAULT_HOST = 'basement'
const OFF = 'off'
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

async function target(run: Run, cwd: string, host: string, env: NodeJS.ProcessEnv): Promise<BasementTarget> {
  const branch = trimmed((await run('git', ['symbolic-ref', '--short', 'HEAD'], cwd)).output)
  const origin = await run('git', ['remote', 'get-url', 'origin'], cwd)
  const repo = repoNameOf(origin.output)
  if (origin.code !== 0 || repo === '')
    throw new Error('no origin remote to name the repo for basement-suite')
  return { host, repo, branch, agent: env.AGENT_CHAT_NAME || branch.split('/').at(-1) || branch }
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
  const probe = await run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=3', host, 'true'], cwd)
  if (probe.code !== 0)
    return {
      kind: 'local',
      warning: `basement unreachable (probe exit ${probe.code}); running checks locally`,
    }
  const t = await target(run, cwd, host, env)
  if (await headIsPushed(run, cwd, base)) return { kind: 'remote', target: t }
  return { kind: 'deferred', commands: scripts.map(script => basementCommandText(t, script)) }
}

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
  }
  return results
}

export const isBusy = (result: BasementResult): boolean => result.code === EXIT_BUSY

export const describeExit = (result: BasementResult): string => `${result.script} exit ${result.code}`
