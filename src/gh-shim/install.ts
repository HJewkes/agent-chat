import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** Set by the shim script so the shim can skip its own directory when it looks for the real gh. */
export const GH_SHIM_DIR_ENV = 'AGENT_CHAT_GH_SHIM_DIR'

/** `1` sends every command straight to the real gh, for when the shim itself is the suspect. */
export const GH_SHIM_OFF_ENV = 'AGENT_CHAT_GH_SHIM_OFF'

const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`

/** Falls back to the real gh when the node or the build it was written against has gone. */
export const ghShimScript = (dir: string, node: string, main: string): string =>
  [
    '#!/bin/sh',
    '# Written by agent-chat at each spawn (CC-395); answers read-only gh commands from REST.',
    `if [ -x ${quote(node)} ] && [ -f ${quote(main)} ]; then`,
    `  ${GH_SHIM_DIR_ENV}=${quote(dir)} exec ${quote(node)} ${quote(main)} "$@"`,
    'fi',
    `PATH=$(printf '%s' "$PATH" | tr ':' '\\n' | grep -vxF ${quote(dir)} | paste -sd: -)`,
    'export PATH',
    'exec gh "$@"',
    '',
  ].join('\n')

/** One directory per build, so a spawn from a worktree's dist never repoints the script other agents run. */
export const shimDirFor = (root: string, main: string): string =>
  path.join(root, createHash('sha256').update(main).digest('hex').slice(0, 12))

/** Rewritten through a rename on every launch, so a concurrent spawn never execs a half-written file. */
export function writeGhShim(root: string, node: string, main: string): string {
  const dir = shimDirFor(root, main)
  fs.mkdirSync(dir, { recursive: true })
  const target = path.join(dir, 'gh')
  const temp = `${target}.${process.pid}.tmp`
  fs.writeFileSync(temp, ghShimScript(dir, node, main), { mode: 0o755 })
  fs.renameSync(temp, target)
  return dir
}

export function withShimOnPath(env: Record<string, string>, dir: string): Record<string, string> {
  const rest = (env.PATH ?? '').split(path.delimiter).filter(entry => entry !== '' && entry !== dir)
  return { ...env, PATH: [dir, ...rest].join(path.delimiter) }
}
