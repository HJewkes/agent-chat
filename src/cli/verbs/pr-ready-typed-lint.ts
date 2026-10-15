import path from 'node:path'
import { packageManager } from './pr-ready-deps.js'
import { changedFiles, readPackage, type Run } from './pr-ready.js'

export const TYPED_LINT_SCRIPT = 'lint:types'

interface TypedLintOutcome {
  ok: boolean
  reason?: string
}

interface Command {
  cmd: string
  args: string[]
}

const TS_SOURCE = /\.(ts|tsx|mts|cts)$/
const MANIFESTS = new Set(['package.json', 'pnpm-lock.yaml', 'package-lock.json'])

/** A typed lint reads TS sources, their configs and the resolved dependency types, nothing else. */
export function needsTypedLint(files: string[]): boolean {
  return files.some(file => {
    const name = path.posix.basename(file)
    return (
      TS_SOURCE.test(name) || name.startsWith('tsconfig') || name.startsWith('eslint') || MANIFESTS.has(name)
    )
  })
}

/**
 * Build first, since a typed lint resolves workspace types through each package's built output.
 * Empty when the root has no typed lint, or owns every check through its own `pr-ready` script.
 */
export function typedLintPlan(root: string): Command[] {
  const scripts = readPackage(root)?.scripts ?? {}
  if (scripts[TYPED_LINT_SCRIPT] === undefined || scripts['pr-ready'] !== undefined) return []
  const pm = packageManager(root)
  const build = scripts.build === undefined ? [] : [{ cmd: pm, args: ['run', 'build'] }]
  return [...build, { cmd: pm, args: ['run', TYPED_LINT_SCRIPT] }]
}

export const hasTypedLint = (root: string): boolean => typedLintPlan(root).length > 0

/** Always in the worktree before the push, never routed to basement: CI fails the PR otherwise. */
export async function typedLintStep(
  run: Run,
  cwd: string,
  base: string,
  err: (line: string) => void,
): Promise<TypedLintOutcome> {
  const plan = typedLintPlan(cwd)
  if (plan.length === 0) return { ok: true, reason: `no ${TYPED_LINT_SCRIPT} script` }
  if (!needsTypedLint(await changedFiles(run, cwd, base)))
    return { ok: true, reason: 'skipped (no TypeScript or config change)' }
  for (const command of plan) {
    const result = await run(command.cmd, command.args, cwd)
    if (result.code === 0) continue
    err(result.output.trimEnd())
    return { ok: false, reason: `failed: ${[command.cmd, ...command.args].join(' ')}` }
  }
  return { ok: true }
}
