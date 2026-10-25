import { afterAll, describe, expect, it } from 'vitest'
import { checkCommand, REASONS, type GuardContext } from '../leak-guard/pretool.js'
import { fakeGitShells } from './helpers/fake-git-shells.js'

/**
 * A command word the guard cannot read may be a whole command: an unquoted `$l` that `read`,
 * `mapfile`, `readarray`, `for` or `$(...)` filled splits into `git push --no-verify`, and any
 * expanded word may be a shell that runs its `-c` string or the text it is fed (CC-1411). Real
 * bash and zsh with a fake `git` first on PATH confirm each bypass row runs the push in every
 * shell it names.
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
const BYPASSES: [string, string, string[]][] = [
  // Drop splitsUnreadHead: a split command word read from text allows.
  [`read -r l <<< '${PUSH}'; $l`, REASONS.splitCommand, ['bash']],
  [`read -r l <<< '${PUSH}'; \${=l}`, REASONS.splitCommand, ['zsh']],
  [`read -r l <<< '${PUSH}'; command $l`, REASONS.splitCommand, ['bash']],
  [`IFS= read -r l < push.sh; $l`, REASONS.splitCommand, ['bash']],
  [`read -ra a <<< '${PUSH}'; "\${a[@]}"`, REASONS.splitCommand, ['bash']],
  [`read -rA a <<< '${PUSH}'; "\${a[@]}"`, REASONS.splitCommand, ['zsh']],
  [`mapfile -t a < push.sh; \${a[0]}`, REASONS.splitCommand, ['bash']],
  [`readarray -t a <<< '${PUSH}'; \${a[@]}`, REASONS.splitCommand, ['bash']],
  [`x=$(cat push.sh); $x`, REASONS.splitCommand, ['bash']],
  [`for l in "$(cat push.sh)"; do $l; done`, REASONS.splitCommand, ['bash']],
  [`$(cat push.sh); git status`, REASONS.splitCommand, BOTH],
  [`$(cat push.sh) gh pr create -t x -b y`, REASONS.splitCommand, BOTH],
  // Drop the shell check of an expanded word: a shell behind it runs its -c string or its feed.
  [`while read -r l; do $l; done < push.sh`, REASONS.pipedScript, ['bash']],
  [`while read -r l; do $l; done <<'E'\n${PUSH}\nE`, REASONS.noVerify, ['bash']],
  [`echo '${PUSH}' | while read -r l; do $l; done`, REASONS.noVerify, ['bash']],
  [`b=bash; $b -c '${PUSH}'`, REASONS.noVerify, BOTH],
  [`b=bash; echo '${PUSH}' | "$b"`, REASONS.noVerify, BOTH],
  [`b=bash; "$b" < push.sh`, REASONS.pipedScript, BOTH],
  [`\${SHELL:-bash} -c '${PUSH}'`, REASONS.noVerify, BOTH],
  [`$(echo bash) -c '${PUSH}'`, REASONS.noVerify, BOTH],
  [`echo '${PUSH}' | $(echo bash)`, REASONS.pipedScript, BOTH],
]

// Each row's mutation: count every assignment, a definition's name or xargs' words as unreadable.
const BENIGN: [string, RegExp][] = [
  [`read -r l <<< '${PUSH}'; "$l"`, /^$/],
  [`while read -r f; do echo "$f"; done < push.sh; git status`, /^status$/],
  [`x=git; $x status`, /^status$/],
  [`PY=python3; $PY --version; git status`, /^status$/],
  [`for f in a b; do $EDITOR "$f"; done; git status`, /^status$/],
  [`"$(command -v cat)" push.sh; git status`, /^status$/],
  [`f() { echo hi; }; f < push.sh; git status`, /^status$/],
  [`ls | xargs -P 2 wc -c; git status`, /^status$/],
]

describe('checkCommand on a command word that may be a whole command or a shell', () => {
  it.each(BYPASSES)('denies %j', (src, reason) => {
    expect(checkCommand(src, ctx()) ?? 'allowed').toBe(reason)
  })

  it.each(BENIGN)('allows %j', src => {
    expect(checkCommand(src, ctx())).toBeUndefined()
  })

  it('denies a leading substitution beside gh even when the text is clean', () => {
    expect(checkCommand('$(true) gh pr create -t x -b y', ctx()) ?? 'allowed').toBe(REASONS.splitCommand)
  })

  it('keeps a substitution command word on a line without git or gh to eval-like rules', () => {
    expect(checkCommand('eval "$(ssh-agent -s)"; npm test', ctx())).toBeUndefined()
  })
})

const real = fakeGitShells('agent-chat-pretool-read-word-', PUSH)
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
