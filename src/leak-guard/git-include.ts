import { gitOutput, withOverrides, type Overrides } from './git-alias.js'

/**
 * Reads the config files a git command pulls in with `-c include.path` or `includeIf.*.path`
 * (TP-602), so the bypass guard can tell whether they set core.hooksPath. git follows nested
 * includes and stops at its own depth cap; the read has the alias lookup's 1 s timeout.
 */

/** Whether the files the command's own `-c` and `--config-env` include set core.hooksPath. */
export type ReadIncludedHooksPath = (dir: string, globals: readonly string[], env: Overrides) => boolean

const INCLUDE_KEY = /^include(?:if\..*)?\.path$/i
// The agent's own hooks path arrives as command-scope config too, so the lookup runs without it.
const GUARD_VARS = /^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+|PARAMETERS)$/

/** The config keys in `-c` and `--config-env` params: git splits `-c` at the first `=`, `--config-env` at the last. */
function paramKeys(params: readonly string[]): string[] {
  const keys: string[] = []
  for (let i = 0; i < params.length; i++) {
    const param = params[i] as string
    if (param === '-c') keys.push((params[++i] ?? '').split('=')[0] as string)
    else keys.push(param.slice('--config-env='.length, param.lastIndexOf('=')))
  }
  return keys
}

export const includesConfig = (params: readonly string[]): boolean =>
  paramKeys(params).some(key => INCLUDE_KEY.test(key))

export const includedHooksPathReader =
  (base: NodeJS.ProcessEnv): ReadIncludedHooksPath =>
  (dir, globals, overrides) => {
    const own = Object.fromEntries(Object.entries(base).filter(([name]) => !GUARD_VARS.test(name)))
    const args = [...globals, 'config', '--show-scope', '--includes', '--get-regexp', '^core\\.hookspath$']
    const found = gitOutput(args, dir, withOverrides(own, overrides))
    return found?.split('\n').some(line => line.startsWith('command\t')) === true
  }
