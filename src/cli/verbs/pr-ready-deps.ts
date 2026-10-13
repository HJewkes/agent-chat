import fs from 'node:fs'
import path from 'node:path'
import type { Run } from './pr-ready.js'

interface DepsOutcome {
  ok: boolean
  reason: string
}

export const packageManager = (cwd: string): 'pnpm' | 'npm' =>
  fs.existsSync(path.join(cwd, 'pnpm-lock.yaml')) ? 'pnpm' : 'npm'

/** Lockfile-frozen and script-free, so pr-ready never runs a package's install hooks. */
export const installCommand = (cwd: string): { cmd: string; args: string[] } =>
  packageManager(cwd) === 'pnpm'
    ? { cmd: 'pnpm', args: ['install', '--frozen-lockfile', '--ignore-scripts'] }
    : { cmd: 'npm', args: ['ci', '--ignore-scripts'] }

const lastLine = (text: string): string =>
  text
    .trim()
    .split('\n')
    .filter(line => line.trim() !== '')
    .at(-1) ?? 'no output'

/**
 * A fresh worktree has no node_modules, and every later step would then fail with a message
 * such as `Command changeset not found` that hides the cause. `existsSync` follows a symlink,
 * so a dangling link counts as missing. Undefined when there is nothing to install.
 */
export async function depsStep(run: Run, cwd: string): Promise<DepsOutcome | undefined> {
  if (!fs.existsSync(path.join(cwd, 'package.json'))) return undefined
  if (fs.existsSync(path.join(cwd, 'node_modules'))) return undefined
  const { cmd, args } = installCommand(cwd)
  const text = [cmd, ...args].join(' ')
  const result = await run(cmd, args, cwd)
  if (result.code === 0) return { ok: true, reason: `installed with ${text}` }
  return {
    ok: false,
    reason: `${text} failed (${lastLine(result.output)}); run it in this worktree, then re-run pr-ready`,
  }
}
