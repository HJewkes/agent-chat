import fs from 'node:fs'
import path from 'node:path'
import type { Run } from './pr-ready.js'

/** agent-chat's own guard against real seat and seat-agent names in tests; other repos lack it. */
export const PRIVACY_TEST = 'src/__tests__/fixtures-privacy.test.ts'

/** `--no-install` so npx never downloads an unrelated package when vitest is missing. */
export const privacyCommand = { cmd: 'npx', args: ['--no-install', 'vitest', 'run', PRIVACY_TEST] }

const LEAK_MARKER = 'privacy leak:'
/** vitest appends the failed comparison to the assertion message; the leak list already says it. */
const VITEST_DIFF = ': expected ['

export interface PrivacyOutcome {
  ok: boolean
  reason?: string
}

export const hasPrivacyTest = (cwd: string): boolean => fs.existsSync(path.join(cwd, PRIVACY_TEST))

/** The reason is the test's own `privacy leak: <file>: <name>` line, so the FAIL line names both. */
function leakReason(output: string): string {
  const line = output.split('\n').find(l => l.includes(LEAK_MARKER))
  if (line === undefined) return `failed: ${[privacyCommand.cmd, ...privacyCommand.args].join(' ')}`
  const message = line.slice(line.indexOf(LEAK_MARKER))
  const diff = message.lastIndexOf(VITEST_DIFF)
  return (diff === -1 ? message : message.slice(0, diff)).trim()
}

export async function privacyStep(
  run: Run,
  cwd: string,
  err: (line: string) => void,
): Promise<PrivacyOutcome> {
  const result = await run(privacyCommand.cmd, privacyCommand.args, cwd)
  if (result.code === 0) return { ok: true }
  if (result.output.trim() !== '') err(result.output.trimEnd())
  return { ok: false, reason: leakReason(result.output) }
}
