import fs from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { checkCommand, REASONS, type GuardContext } from '../leak-guard/pretool.js'
import { fakeGitShells } from './helpers/fake-git-shells.js'

/**
 * An unresolved command word may run the positionals however the line reads them (`"$@"`, `$x` after
 * `x="$*"`, `$OPTARG`, a backtick), so the guard keys on where they are filled: a `set` with operands,
 * a call to a function the line defines, shell `-c` arguments and a zsh `argv` write (CC-1624). Real
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

// Each row: the line and the shells that run its push.
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
  [`bash -c '"$@"' _ ${PUSH}`, BOTH],
  [`f() { bash -c '"$@"' _ "$@"; }; f ${PUSH}`, BOTH],
  // A zsh flag between `$` and the positional, and bash's last argument (review of #1240).
  [`f() { \${=@}; }; f ${PUSH}`, ['zsh']],
  [`f() { \${~@}; }; f ${PUSH}`, ['zsh']],
  [`f() { $=@; }; f ${PUSH}`, ['zsh']],
  [`f() { $=*; }; f ${PUSH}`, ['zsh']],
  [`f() { \${^@}; }; f ${PUSH}`, ['zsh']],
  [`set -- ${PUSH}; \${~*}`, ['zsh']],
  [`set -- ${PUSH}; $^@`, ['zsh']],
  [`f() { \${!#}; }; f "${PUSH}"`, ['bash']],
  // Second review of #1240: bash's own positional array, and the positionals copied into a variable.
  [`shopt -s extdebug; f() { \${BASH_ARGV[@]}; }; f --no-verify push git`, ['bash']],
  [`shopt -s extdebug; f() { \${BASH_ARGV[*]}; }; f --no-verify push git`, ['bash']],
  [`set -- ${PUSH}; x="$*"; $x`, ['bash']],
  [`f() { x="$*"; $x; }; f ${PUSH}`, ['bash']],
  [`f() { local x="$*"; $x; }; f ${PUSH}`, ['bash']],
  [`f() { x=$@; $x; }; f ${PUSH}`, ['bash']],
  [`f() { printf -v x %s "$*"; $x; }; f ${PUSH}`, ['bash']],
]

// Readers no spelling list held (rounds 3 and 4 of #1240): a loop with no list, getopts, a backtick, an array copy.
const READERS: [string, string[]][] = [
  [`f() { for a; do x="$x $a"; done; $x; }; f ${PUSH}`, ['bash']],
  [`f() { getopts x: o; $OPTARG; }; f -x "${PUSH}"`, ['bash']],
  [`f() { \`echo "$@"\`; }; f ${PUSH}`, BOTH],
  [`f() { \`printf '%s ' "$@"\`; }; f ${PUSH}`, BOTH],
  [`f() { for x; do $x; done; }; f '${PUSH}'`, ['bash']],
  [`set -- '${PUSH}'; for x; do $x; done`, ['bash']],
  [`f() { for x; do a+=($x); done; "\${a[@]}"; }; f ${PUSH}`, BOTH],
  [`f() { for x do a="$a $x"; done; $a; }; f ${PUSH}`, ['bash']],
  [`f() { getopts x: o; $OPTARG; }; f "-x${PUSH}"`, ['bash']],
  [`f() { while getopts x: o; do $OPTARG; done; }; f "-x${PUSH}"`, ['bash']],
  [`set -- ${PUSH}; for x; do a+=($x); done; "\${a[@]}"`, BOTH],
  [`bash -c 'for x; do a+=($x); done; "\${a[@]}"' _ ${PUSH}`, BOTH],
  [`f() { select x; do $x; break; done <<< 1; }; f "${PUSH}"`, ['bash']],
  // Controls from the reviews of #1240.
  [`f() { \${(@)argv}; }; f ${PUSH}`, ['zsh']],
  [`set -- ${PUSH}; "\${@:-x}"`, BOTH],
  [`f() { $argv[1,-1]; }; f ${PUSH}`, ['zsh']],
  [`f() { $(echo "$@"); }; f ${PUSH}`, BOTH],
  [`f() { a=@; "\${!a}"; }; f ${PUSH}`, ['bash']],
  [`f() { "$@"; }; f "$(printf g%s it)" push --no-verify`, BOTH],
  [`f() { nice "$@"; }; f ${PUSH}`, BOTH],
  [`f() { exec "$@"; }; f ${PUSH}`, BOTH],
  // A call the line makes inside a script it runs fills the positionals of a function it defined.
  [`f() { "$@"; }; eval 'f ${PUSH}'`, BOTH],
  [`f() { "$@"; }; export -f f; bash -c 'f ${PUSH}'`, ['bash']],
  // A shell whose options the guard cannot read may take any word as a positional.
  [`o=-c; bash $o '"$@"' _ ${PUSH}`, BOTH],
  [`b=bash; $b -c '"$@"' _ ${PUSH}`, BOTH],
]

// zsh fills the positionals from a file through `read -A argv`, so they are not the line's own words.
const FILED: [string, string[]][] = [
  [`read -A argv < f; "$@"`, ['zsh']],
  [`read -rA argv < f; "$@"`, ['zsh']],
  [`read -A argv < f; $@`, ['zsh']],
  [`argv=($(<f)); "$@"`, ['zsh']],
]

// The fill reaches git, so a hidden word that ignores the positionals denies too; and a fill word the
// guard cannot read may hold git, since `"$@"` alone may reach it.
const FALSE_DENIES = [`f() { $EDITOR x; }; f git status`, `f() { "$@"; }; f "$X"`]

// Denied on main already, through the hidden-command rules that read the words after the head.
const PINNED: [string, string[]][] = [
  [`set -- ${PUSH}; $1 $2 $3`, BOTH],
  [`set -- git; "\${1}" push --no-verify`, BOTH],
  [`set -- "${PUSH}"; eval "$*"`, BOTH],
  [`f() { $1 $2 $3; }; f ${PUSH}`, BOTH],
  [`f() { "$@" push --no-verify; }; f git`, BOTH],
  [`sh -c '$1 "$2" $3' _ ${PUSH}`, BOTH],
]

// Each row: the line and the git calls every shell makes for it.
const BENIGN: [string, RegExp][] = [
  [`set -- a b; echo "$@"`, /^$/],
  [`f() { echo "$1"; }; f x`, /^$/],
  [`f() { "$@"; }; f ls`, /^$/],
  [`set -- a; git status`, /^status$/],
  [`f() { echo "$@"; }; f ${PUSH}`, /^$/],
  [`bash -c '"$@"' _ ls`, /^$/],
  [`"$@"`, /^$/],
  // The positionals hold only ls, so git elsewhere on the line no longer denies (#1240's false denies).
  [`f() { "$@"; }; f ls; git status`, /^status$/],
  [`set -- ls; "$@"; git status`, /^status$/],
]

describe('checkCommand on a positional parameter as the command word', () => {
  it.each(BYPASSES)('denies %j', src => {
    const reason = checkCommand(src, ctx())
    expect(reason).toBeDefined()
    expect(reason).toBe(REASONS.positionalCommand)
  })

  it.each(READERS)('denies %j, however it reads the positionals', src => {
    expect(checkCommand(src, ctx())).toBeDefined()
  })

  it.each(FILED)('denies %j, whose positionals a file fills', src => {
    expect(checkCommand(src, ctx())).toBeDefined()
  })

  it.each(PINNED)('still denies %j', src => {
    expect(checkCommand(src, ctx())).toBeDefined()
  })

  it.each(FALSE_DENIES)('knowingly denies %j', src => {
    expect(checkCommand(src, ctx())).toBeDefined()
  })

  it.each(BENIGN)('allows %j', src => {
    expect(checkCommand(src, ctx())).toBeUndefined()
  })
})

const real = fakeGitShells('agent-chat-pretool-positional-', PUSH)
// A name that does not say push, so only the read itself can tie the line to git.
fs.writeFileSync(path.join(real.root, 'f'), `${PUSH}\n`)
const shellsNamed = (names: readonly string[]) =>
  real.shells.filter(([shell]) => names.some(name => shell.endsWith(`/${name}`)))

afterAll(real.cleanup)

describe.skipIf(real.shells.length === 0)('real shells run the positional command word', () => {
  it.each([...BYPASSES, ...READERS, ...FILED, ...PINNED])('each named shell pushes for %j', (src, names) => {
    for (const [shell, args] of shellsNamed(names))
      expect(real.gitCalls(shell, args, src)).toBe('push --no-verify')
  })

  it.each(BENIGN)('every shell runs only what the guard read for %j', (src, calls) => {
    for (const [shell, args] of real.shells) expect(real.gitCalls(shell, args, src)).toMatch(calls)
  })
})
