import { afterAll, describe, expect, it } from 'vitest'
import { checkCommand, REASONS, type GuardContext } from '../leak-guard/pretool.js'
import { fakeGitShells } from './helpers/fake-git-shells.js'

/**
 * An expanded command word may be a shell that runs its `-c` string or the text it is fed
 * (CC-1411, CC-1428). Real bash and zsh with a fake `git` first on PATH confirm each bypass row
 * runs the push in every shell it names.
 */

const ctx = (): GuardContext => ({
  terms: { kind: 'ok', rules: [] },
  cwd: '/work',
  env: {},
  protectedPaths: [],
  readFile: () => undefined,
  readAlias: () => undefined,
  readIncludedHooksPath: () => false,
})

const PUSH = 'git push --no-verify'
const BOTH = ['bash', 'zsh']

// Each row: the line, the reason the guard gives, and the shells that run its push.
// Drop the shell check of an expanded word: a shell behind it runs its -c string or its feed.
const BYPASSES: [string, string, string[]][] = [
  [`while read -r l; do $l; done < push.sh`, REASONS.pipedScript, ['bash']],
  [`while read -r l; do $l; done <<'E'\n${PUSH}\nE`, REASONS.noVerify, ['bash']],
  [`echo '${PUSH}' | while read -r l; do $l; done`, REASONS.noVerify, ['bash']],
  [`b=bash; $b -c '${PUSH}'`, REASONS.noVerify, BOTH],
  [`b=bash; echo '${PUSH}' | "$b"`, REASONS.noVerify, BOTH],
  [`b=bash; "$b" < push.sh`, REASONS.pipedScript, BOTH],
  [`\${SHELL:-bash} -c '${PUSH}'`, REASONS.noVerify, BOTH],
  [`$(echo bash) -c '${PUSH}'`, REASONS.noVerify, BOTH],
  [`echo '${PUSH}' | $(echo bash)`, REASONS.pipedScript, BOTH],
  [`X=bash; $X -c '${PUSH} origin HEAD:main'`, REASONS.noVerify, BOTH],
  [`X=bash; nice $X -c '${PUSH} origin HEAD:main'`, REASONS.noVerify, BOTH],
  [`X=/bin/sh; $X -c '${PUSH} origin HEAD:main'`, REASONS.noVerify, BOTH],
  // Join a case's patterns at a | as a pipe or not at all: a pipe in a pattern body still feeds the shell.
  [`b=bash; case q in (q|r) echo '${PUSH}' | $b;; esac`, REASONS.noVerify, BOTH],
]

// Each row's mutation: read a definition's name, xargs' words or a clean -c string as a push.
const BENIGN: [string, RegExp][] = [
  [`read -r l <<< '${PUSH}'; "$l"`, /^$/],
  [`while read -r f; do echo "$f"; done < push.sh; git status`, /^status$/],
  [`x=git; $x status`, /^status$/],
  [`PY=python3; $PY --version; git status`, /^status$/],
  [`for f in a b; do $EDITOR "$f"; done; git status`, /^status$/],
  [`"$(command -v cat)" push.sh; git status`, /^status$/],
  [`f() { echo hi; }; f < push.sh; git status`, /^status$/],
  [`ls | xargs -P 2 wc -c; git status`, /^status$/],
  [`X=bash; $X -c 'echo hi'`, /^$/],
  // Mutation: read the | between case patterns as a pipe, which feeds the glob pattern after it.
  [`case "$a" in (q|r) echo 1;; (*) ;; esac; git status`, /^status$/],
]

describe('checkCommand on a command word that may be a shell', () => {
  it.each(BYPASSES)('denies %j', (src, reason) => {
    expect(checkCommand(src, ctx()) ?? 'allowed').toBe(reason)
  })

  it.each(BENIGN)('allows %j', src => {
    expect(checkCommand(src, ctx())).toBeUndefined()
  })

  it('keeps a substitution command word on a line without git or gh to eval-like rules', () => {
    expect(checkCommand('eval "$(ssh-agent -s)"; npm test', ctx())).toBeUndefined()
  })
})

const real = fakeGitShells('agent-chat-pretool-shell-word-', PUSH)
const shellsNamed = (names: readonly string[]) =>
  real.shells.filter(([shell]) => names.some(name => shell.endsWith(`/${name}`)))

afterAll(real.cleanup)

describe.skipIf(real.shells.length === 0)('real shells run the command word the guard denies', () => {
  it.each(BYPASSES)('each named shell pushes for %j', (src, _, names) => {
    for (const [shell, args] of shellsNamed(names))
      expect(real.gitCalls(shell, args, src)).toMatch(/^push --no-verify\b/)
  })

  it.each(BENIGN)('every shell runs only what the guard read for %j', (src, calls) => {
    for (const [shell, args] of real.shells) expect(real.gitCalls(shell, args, src)).toMatch(calls)
  })
})
