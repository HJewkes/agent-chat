import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { ALIAS_TIMEOUT_MS, withOverrides, type Overrides } from './git-alias.js'

/**
 * Reads the config files a git command pulls in with `-c include.path` or `includeIf.*.path`
 * (TP-602), so the bypass guard can tell whether they set core.hooksPath. git follows nested
 * includes and stops at its own depth cap. Unlike the alias lookup, a read that times out or
 * fails, or an include file that does not exist yet, counts as setting it.
 */

/** Whether the files the command's own `-c` and `--config-env` include may set core.hooksPath. */
export type ReadIncludedHooksPath = (dir: string, globals: readonly string[], env: Overrides) => boolean

const INCLUDE_KEY = /^include(?:if\..*)?\.path$/i
// The agent's own hooks path arrives as command-scope config too, so the lookup runs without it.
const GUARD_VARS = /^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+|PARAMETERS)$/
const CONFIG_ENV_OPT = '--config-env='

interface Param {
  key: string
  /** The value for `-c`, or the variable `--config-env` reads it from. */
  value: string
  fromEnv: boolean
}

/** The `-c` and `--config-env` params: git splits `-c` at the first `=`, `--config-env` at the last. */
function parseParams(params: readonly string[]): Param[] {
  const parsed: Param[] = []
  for (let i = 0; i < params.length; i++) {
    const param = params[i] as string
    if (param === '-c') {
      const kv = params[++i] ?? ''
      const eq = kv.indexOf('=')
      parsed.push({
        key: eq < 0 ? kv : kv.slice(0, eq),
        value: eq < 0 ? '' : kv.slice(eq + 1),
        fromEnv: false,
      })
    } else if (param.startsWith(CONFIG_ENV_OPT)) {
      const eq = param.lastIndexOf('=')
      parsed.push({ key: param.slice(CONFIG_ENV_OPT.length, eq), value: param.slice(eq + 1), fromEnv: true })
    }
  }
  return parsed
}

export const includesConfig = (params: readonly string[]): boolean =>
  parseParams(params).some(({ key }) => INCLUDE_KEY.test(key))

/** The include files named by absolute or `~/` paths; git itself refuses a relative one. */
function includeFiles(params: readonly string[], env: NodeJS.ProcessEnv): string[] {
  const files: string[] = []
  for (const { key, value, fromEnv } of parseParams(params)) {
    if (!INCLUDE_KEY.test(key)) continue
    const file = fromEnv ? (env[value] ?? '') : value
    if (file.startsWith('~/')) files.push(path.join(env.HOME ?? '', file.slice(2)))
    else if (path.isAbsolute(file)) files.push(file)
  }
  return files
}

/** Exit 1 with no output is a clean read; a timeout, a failure or a command-scope value is not. */
function readsHooksPath(args: readonly string[], dir: string, env: NodeJS.ProcessEnv): boolean {
  const run = spawnSync('git', args, {
    cwd: dir,
    env,
    encoding: 'utf8',
    timeout: ALIAS_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  if (run.status === 1 && run.stdout === '') return false
  return run.status !== 0 || run.stdout.split('\n').some(line => line.startsWith('command\t'))
}

export const includedHooksPathReader =
  (base: NodeJS.ProcessEnv): ReadIncludedHooksPath =>
  (dir, globals, overrides) => {
    const own = Object.fromEntries(Object.entries(base).filter(([name]) => !GUARD_VARS.test(name)))
    const env = withOverrides(own, overrides)
    if (includeFiles(globals, env).some(file => !fs.existsSync(file))) return true
    const args = [...globals, 'config', '--show-scope', '--includes', '--get-regexp', '^core\\.hookspath$']
    return readsHooksPath(args, dir, env)
  }
