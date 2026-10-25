import { afterAll, describe, expect, it } from 'vitest'
import { checkCommand, REASONS, type GuardContext } from '../leak-guard/pretool.js'
import { fakeGitShells } from './helpers/fake-git-shells.js'

/**
 * A positional parameter as the command word (`"$@"`, `$1`, `"$*"`, zsh's `$argv`) runs the words a
 * `set --` or a function call put there, which the guard never reads as a command (CC-1624). Real
 * bash and zsh with a fake `git` first on PATH confirm each bypass row runs the push in every shell
 * it names.
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

// Each row: the line and the shells that run its push. Drop runsPositional and every row allows.
const BYPASSES: [string, string[]][] = [
  [`set -- ${PUSH}; "$@"`, BOTH],
  [`set -- ${PUSH}; $@`, BOTH],
  [`set -- ${PUSH}; $*`, BOTH],
  [`set -- ${PUSH}; "\${@}"`, BOTH],
  [`set -- ${PUSH}; "\${@:1}"`, BOTH],
  [`set -- ${PUSH}; \${*}`, BOTH],
  [`f() { "$@"; }; f ${PUSH}`, BOTH],
  [`f() { $*; }; f ${PUSH}`, BOTH],
  [`function f { "$@"; }; f ${PUSH}`, BOTH],
  [`f() { "$@"; }; f bash -c '${PUSH}'`, BOTH],
  [`f() { "$@"; }; f env ${PUSH}`, BOTH],
  [`f() { command "$@"; }; f ${PUSH}`, BOTH],
  [`f() { x=1 "$@"; }; f ${PUSH}`, BOTH],
  [`f() { $argv; }; f ${PUSH}`, ['zsh']],
  [`f() { \${argv}; }; f ${PUSH}`, ['zsh']],
  [`f() { "$argv[@]"; }; f ${PUSH}`, ['zsh']],
  [`f() { "\${argv[@]}"; }; f ${PUSH}`, ['zsh']],
  [`bash -c 'set -- ${PUSH}; "$@"'`, BOTH],
  [`f() { "$@"; }; f g''it push --no-verify`, BOTH],
]

// The guard does not follow which words fill a positional, so any other word that may reach git denies.
const FALSE_DENIES = [`f() { "$@"; }; f ls; git status`, `set -- ls; "$@"; git status`]

// Denied on main already, through the hidden-command rules that read the words after the head.
const PINNED: [string, string[]][] = [
  [`set -- ${PUSH}; $1 $2 $3`, BOTH],
  [`set -- git; "\${1}" push --no-verify`, BOTH],
  [`set -- "${PUSH}"; eval "$*"`, BOTH],
  [`f() { $1 $2 $3; }; f ${PUSH}`, BOTH],
  [`f() { "$@" push --no-verify; }; f git`, BOTH],
  [`bash -c '"$@"' _ ${PUSH}`, BOTH],
  [`sh -c '$1 "$2" $3' _ ${PUSH}`, BOTH],
  [`f() { bash -c '"$@"' _ "$@"; }; f ${PUSH}`, BOTH],
]

// Each row: the line and the git calls every shell makes for it.
const BENIGN: [string, RegExp][] = [
  [`set -- a b; echo "$@"`, /^$/],
  [`f() { echo "$1"; }; f x`, /^$/],
  [`f() { "$@"; }; f ls`, /^$/],
  [`set -- a; git status`, /^status$/],
  [`f() { echo "$@"; }; f ${PUSH}`, /^$/],
  [`bash -c '"$@"' _ ls`, /^$/],
]

describe('checkCommand on a positional parameter as the command word', () => {
  it.each(BYPASSES)('denies %j', src => {
    expect(checkCommand(src, ctx())).toBe(REASONS.positionalCommand)
  })

  it.each(PINNED)('still denies %j', src => {
    expect(checkCommand(src, ctx())).toBeDefined()
  })

  it.each(FALSE_DENIES)('knowingly denies %j', src => {
    expect(checkCommand(src, ctx())).toBe(REASONS.positionalCommand)
  })

  it.each(BENIGN)('allows %j', src => {
    expect(checkCommand(src, ctx())).toBeUndefined()
  })
})

const real = fakeGitShells('agent-chat-pretool-positional-', PUSH)
const shellsNamed = (names: readonly string[]) =>
  real.shells.filter(([shell]) => names.some(name => shell.endsWith(`/${name}`)))

afterAll(real.cleanup)

describe.skipIf(real.shells.length === 0)('real shells run the positional command word', () => {
  it.each([...BYPASSES, ...PINNED])('each named shell pushes for %j', (src, names) => {
    for (const [shell, args] of shellsNamed(names))
      expect(real.gitCalls(shell, args, src)).toBe('push --no-verify')
  })

  it.each(BENIGN)('every shell runs only what the guard read for %j', (src, calls) => {
    for (const [shell, args] of real.shells) expect(real.gitCalls(shell, args, src)).toMatch(calls)
  })
})
