import { parseTerms } from '@titan-design/egress-scan'
import { describe, expect, it } from 'vitest'
import { checkCommand, pretoolDecision, REASONS, type GuardContext } from '../leak-guard/pretool.js'

// Synthetic only.
const TERM = 'zq7privateseat'

const ctx: GuardContext = {
  terms: { kind: 'ok', rules: parseTerms(`${TERM}\n`) },
  cwd: '/work',
  env: { HOME: '/srv/agent' },
  protectedPaths: [],
  readFile: () => undefined,
  readAlias: () => undefined,
  readIncludedHooksPath: () => false,
  readGhAliases: () => ({ kind: 'ok', aliases: new Map() }),
}

/** The deny reason the hook entry point prints for one Bash command, undefined when it allows. */
function hookReason(command: string): string | undefined {
  const raw = JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: '/work', session_id: 's' })
  const out = pretoolDecision(raw, () => ctx)
  if (out === '') return undefined
  return (JSON.parse(out) as { hookSpecificOutput: Record<string, string> }).hookSpecificOutput
    .permissionDecisionReason
}

describe("gh's program env vars on a gh line (TP-2533 a)", () => {
  it.each(['GH_PAGER', 'GH_EDITOR', 'GH_BROWSER'])('checks a literal %s value as a nested script', name => {
    expect(checkCommand(`${name}='git push --no-verify' gh pr view 1`, ctx)).toBe(REASONS.noVerify)
  })

  it.each([`GH_PAGER="$X" gh pr view 1`, 'export GH_EDITOR=$E; gh pr create', `GH_BROWSER+=x gh browse`])(
    'denies %s as an unreadable program env',
    command => {
      expect(checkCommand(command, ctx)).toBe(REASONS.programEnv)
    },
  )

  it('checks the nested value under env -S', () => {
    const command = `env -S "GH_BROWSER='git push --no-verify' gh browse"`
    expect(checkCommand(command, ctx)).toBeDefined()
  })

  it.each(['GH_PAGER=less gh pr view 1', 'GH_EDITOR=vim gh pr create', 'GH_PAGER=x ls'])(
    'allows %s',
    command => {
      expect(checkCommand(command, ctx)).toBeUndefined()
    },
  )

  it('denies at the hook entry point', () => {
    expect(hookReason(`GH_PAGER='git push --no-verify' gh pr view 1`)).toBe(REASONS.noVerify)
  })
})
