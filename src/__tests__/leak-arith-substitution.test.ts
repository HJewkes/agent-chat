import { parseTerms } from '@titan-design/egress-scan'
import { describe, expect, it } from 'vitest'
import { checkCommand, REASONS, type GuardContext } from '../leak-guard/pretool.js'

const ctx: GuardContext = {
  terms: { kind: 'ok', rules: parseTerms('zq7privateseat\n') },
  cwd: '/work',
  env: {},
  protectedPaths: [],
  readFile: () => undefined,
  readAlias: () => undefined,
  readIncludedHooksPath: () => false,
}

// Evaluating an array subscript runs a `$(...)` in it even when the operand is quoted (CC-1473).
describe('a quoted substitution in an arithmetic test operand', () => {
  // bash 5.3 and zsh run it from `[[ ]]`; their `[ ]` and `test` reject the operand, but are held to the same rule.
  it.each([
    "[[ 1 -eq 'a[$(git push --no-verify)]' ]]",
    "[ 1 -eq 'a[$(git push --no-verify)]' ]",
    "test 1 -eq 'a[$(git push --no-verify)]'",
  ])('denies %s', line => {
    expect(checkCommand(line, ctx)).toBe(REASONS.arithSubstitution)
  })

  it.each([
    "[[ 'a[$(git push --no-verify)]' -eq 1 ]]",
    "[[ 1 -ne 'a[$(git push --no-verify)]' ]]",
    "[[ 1 -lt 'a[$(git push --no-verify)]' ]]",
    "[[ 1 -le 'a[$(git push --no-verify)]' ]]",
    "[[ 1 -gt 'a[$(git push --no-verify)]' ]]",
    "[[ 1 -ge 'a[$(git push --no-verify)]' ]]",
    "test 'a[$(git push --no-verify)]' -ne 1",
    "[[ 1 -eq '1+a[$(git push --no-verify)]' ]]",
    "[[ 1 -eq 'a[`git push --no-verify`]' ]]",
    "[[ 1 -eq 'a[${ git push --no-verify;}]' ]]",
    "[[ 1 -eq $'a[\\x24(git push --no-verify)]' ]]",
  ])('denies either side, any comparison and any substitution: %s', line => {
    expect(checkCommand(line, ctx)).toBe(REASONS.arithSubstitution)
  })

  it.each([
    "[[ 1 = 1 && 1 -eq 'a[$(git push --no-verify)]' ]]",
    "[[ 1 = 2 || 1 -lt 'a[$(git push --no-verify)]' ]]",
    "[[ 1 = 1 &&\n1 -eq 'a[$(git push --no-verify)]' ]]",
    "[[ ! 1 -eq 'a[$(git push --no-verify)]' ]]",
    "[[ ( 1 -eq 'a[$(git push --no-verify)]' ) ]]",
    "[ 1 = 1 -a 1 -eq 'a[$(git push --no-verify)]' ]",
    "[ 1 = 2 -o 1 -gt 'a[$(git push --no-verify)]' ]",
    "[[ 1 -eq 1 ]] && [[ 2 -gt 'a[$(git push --no-verify)]' ]]",
    "if [[ 1 -eq 'a[$(git push --no-verify)]' ]]; then :; fi",
    "command test 1 -eq 'a[$(git push --no-verify)]'",
    'bash -c "[[ 1 -eq \'a[\\$(git push --no-verify)]\' ]]"',
  ])('denies the joined and wrapped forms: %s', line => {
    expect(checkCommand(line, ctx)).toBe(REASONS.arithSubstitution)
  })

  it.each(['[[ 1 -eq "a[\\$(git push --no-verify)]" ]]', '[[ 1 -eq a[$\\(git push --no-verify\\)] ]]'])(
    'fails closed on an escaped substitution, which bash leaves literal but the guard cannot tell apart: %s',
    line => {
      expect(checkCommand(line, ctx)).toBe(REASONS.arithSubstitution)
    },
  )
})

describe('a quoted substitution in an arithmetic body', () => {
  it.each([
    "(( 'a[$(git push --no-verify)]' ))",
    "(( '$(git push --no-verify)' ))",
    "(( a['$(git push --no-verify)'] ))",
    "(( 1 < '$(git push --no-verify)' ))",
    "echo $(( 'a[$(git push --no-verify)]' ))",
    "echo $[ 'a[$(git push --no-verify)]' ]",
    "for (( i='a[$(git push --no-verify)]'; 0; )); do :; done",
    "(( $'a[\\x24(git push --no-verify)]' ))",
    "(\\\n( 'a[$(git push --no-verify)]' ))",
    "((\\\n 'a[$(git push --no-verify)]' ))",
    "(( 'a[$(git push --no-verify)]' )\\\n)",
  ])('denies %s', line => {
    expect(checkCommand(line, ctx)).toBe(REASONS.arithSubstitution)
  })
})

describe('a quoted substitution in other text the shell evaluates as arithmetic', () => {
  it.each([
    "let 'a[$(git push --no-verify)]'",
    "declare -i n='a[$(git push --no-verify)]'",
    "typeset -i n='a[$(git push --no-verify)]'",
    "f() { local -i n='a[$(git push --no-verify)]'; }; f",
    "a['$(git push --no-verify)']=1",
    "a['$(git push --no-verify)']+=1",
    "declare -a 'a[$(git push --no-verify)]=1'",
  ])('denies %s', line => {
    expect(checkCommand(line, ctx)).toBe(REASONS.arithSubstitution)
  })

  it.each([
    'let a[$(git push --no-verify)]',
    'declare -i n=a[$(git push --no-verify)]',
    'a[$(git push --no-verify)]=1',
  ])('still checks the unquoted form as a command: %s', line => {
    expect(checkCommand(line, ctx)).toBe(REASONS.noVerify)
  })
})

// Each runs the substitution in bash 5.3, through an attribute, nameref or name operand set elsewhere.
describe('a quoted subscript substitution in any word', () => {
  it.each([
    "declare -ai q=( '1+a[$(git push --no-verify)]' )",
    "declare -i y; y='a[$(git push --no-verify)]'",
    "declare -i y; y+='a[$(git push --no-verify)]'",
    "declare -ai q; q+=( 'a[$(git push --no-verify)]' )",
    "declare -ai q; q[0]='a[$(git push --no-verify)]'",
    "declare -i y; export y='a[$(git push --no-verify)]'",
    "declare -i y; declare y='a[$(git push --no-verify)]'",
    "declare -i y; printf -v y %s 'a[$(git push --no-verify)]'",
    "declare -i y; for y in 'a[$(git push --no-verify)]'; do :; done",
    "RANDOM='a[$(git push --no-verify)]'",
    "SRANDOM='a[$(git push --no-verify)]'",
    "OPTIND='a[$(git push --no-verify)]'",
    "HISTCMD='a[$(git push --no-verify)]'",
    "[[ -v 'a[$(git push --no-verify)]' ]]",
    "test -v 'a[$(git push --no-verify)]'",
    "printf -v 'a[$(git push --no-verify)]' x",
    "read 'a[$(git push --no-verify)]' <<< x",
    "a=( ['$(git push --no-verify)']=1 )",
    "declare -n r='a[$(git push --no-verify)]'; r=1",
  ])('denies %s', line => {
    expect(checkCommand(line, ctx)).toBe(REASONS.arithSubstitution)
  })

  it.each([
    "unset 'a[$(git push --no-verify)]'",
    "mapfile 'a[$(git push --no-verify)]' < /dev/null",
    "declare -A z; z=( ['$(git push --no-verify)']=1 )",
    "[[ x == 'a[$(git status)]' ]]",
    "grep 'a[$(x)]' notes.txt",
  ])('fails closed where bash 5.3 leaves it literal or no subscript is read: %s', line => {
    expect(checkCommand(line, ctx)).toBe(REASONS.arithSubstitution)
  })
})

// The command past its wrappers, so `let` and `declare -i` are found behind any of them.
describe('a wrapped let or integer declaration', () => {
  it.each([
    "builtin let 'a[$(git push --no-verify)]'",
    "command let 'a[$(git push --no-verify)]'",
    "command -p let 'a[$(git push --no-verify)]'",
    "\\builtin let 'a[$(git push --no-verify)]'",
    "x=1 let 'a[$(git push --no-verify)]'",
    "PATH=$PATH let 'a[$(git push --no-verify)]'",
    "time let 'a[$(git push --no-verify)]'",
    "time -p let 'a[$(git push --no-verify)]'",
    "! let 'a[$(git push --no-verify)]'",
    "{ let 'a[$(git push --no-verify)]'; }",
    "if let 'a[$(git push --no-verify)]'; then :; fi",
    "while let 'a[$(git push --no-verify)]'; do break; done",
    "until let 'a[$(git push --no-verify)]'; do break; done",
    "for i in 1; do let 'a[$(git push --no-verify)]'; done",
    "builtin declare -i n='a[$(git push --no-verify)]'",
    "command typeset -i n='a[$(git push --no-verify)]'",
    "f() { builtin local -i n='a[$(git push --no-verify)]'; }; f",
  ])('denies %s', line => {
    expect(checkCommand(line, ctx)).toBe(REASONS.arithSubstitution)
  })

  it.each([
    "builtin let '$(git push --no-verify)'",
    "x=1 declare -i n='$(git push --no-verify)'",
    "time -p let '1+$(git push --no-verify)'",
  ])('fails closed on a bare operand behind a wrapper, which bash 5.3 rejects: %s', line => {
    expect(checkCommand(line, ctx)).toBe(REASONS.arithSubstitution)
  })
})

// zsh drops a continuation when it re-reads a subscript, so `$`, backslash-newline, `(` is `$(` there.
describe('an opener split by a backslash or a line continuation', () => {
  it.each([
    "[[ 1 -eq 'a[$\\\n(git push --no-verify)]' ]]",
    "[[ 1 -eq 'a[$\\\n{ git push --no-verify;}]' ]]",
    "[[ 1 -eq 'a[$\\(git push --no-verify)]' ]]",
    "(( 'a[$\\\n(git push --no-verify)]' ))",
    "let 'a[$\\\n(git push --no-verify)]'",
    "a['$\\\n(git push --no-verify)']=1",
  ])('denies %s', line => {
    expect(checkCommand(line, ctx)).toBe(REASONS.arithSubstitution)
  })
})

// bash joins the text beside a substitution, so what it prints can finish an opener the line does not show.
describe('a substitution that joins or finishes an opener', () => {
  it.each([
    `[[ 1 -eq 'a[$'"$(true)"'(git push --no-verify)]' ]]`,
    `let 'a[$'"$(true)"'(git push --no-verify)]'`,
    `[[ 1 -eq 'a[$'"$(true)"'(gh pr comment 1 --body zq7privateseat)]' ]]`,
    `let 'a[$'"$(true)"'(gh pr comment 1 --body zq7privateseat)]'`,
    `declare -i n='a[$'"$(true)"'(git push --no-verify)]'`,
    `a['$'"$(true)"'(git push --no-verify)']=1`,
    `[[ 1 -eq 'a[$'"$(true)"'{ git push --no-verify;}]' ]]`,
    `(( a['$'"$(true)"'(git push --no-verify)'] ))`,
  ])('denies an empty substitution inside an opener: %s', line => {
    expect(checkCommand(line, ctx)).toBe(REASONS.arithSubstitution)
  })

  it.each([
    `[[ 1 -eq 'a[$'"$(printf '(')"'git push --no-verify)]' ]]`,
    `[[ 1 -eq 'a['"$(printf '$(')"'git push --no-verify)]' ]]`,
    `let 'a['"$(printf '$')"'(git push --no-verify)]'`,
    "let 'a['\"$(printf '%s' '`')\"'git push --no-verify`]'",
    `[[ 1 -eq 'a'"$(printf '[$(')"'git push --no-verify)]' ]]`,
    `let a[$(printf '$(')git\\ push\\ --no-verify\\)]`,
    `[[ 1 -eq 'a[$'"\${x:-(}"'git push --no-verify)]' ]]`,
  ])('denies a substitution whose output could finish the opener: %s', line => {
    expect(checkCommand(line, ctx)).toBe(REASONS.arithSubstitution)
  })

  it.each([
    `[[ 1 -eq 'a[$'"\${x:+}"'(git push --no-verify)]' ]]`,
    `[[ 1 -eq 'a[$'\${x:+}'(git push --no-verify)]' ]]`,
    `let 'a[$'"\${x:+}"'(git push --no-verify)]'`,
    `[[ 1 -eq 'a[$'"$x"'(git push --no-verify)]' ]]`,
    `[[ 1 -eq 'a[$'"$x"'(gh pr comment 1 --body zq7privateseat)]' ]]`,
    `declare -i n='a[$'"$x"'(git push --no-verify)]'`,
    `[[ 1 -eq 'a[$'"$@"'(git push --no-verify)]' ]]`,
    `[[ 1 -eq 'a[$'"$*"'(git push --no-verify)]' ]]`,
    `[[ 1 -eq 'a[$'"$1"'(git push --no-verify)]' ]]`,
    `[[ 1 -eq 'a[$'"\${a[0]}"'(git push --no-verify)]' ]]`,
    `[[ 1 -eq 'a[$'$[0]'(git push --no-verify)]' ]]`,
    `[[ 1 -eq 'a['"$x"'$(git push --no-verify)]' ]]`,
  ])('denies a parameter expansion inside an opener: %s', line => {
    expect(checkCommand(line, ctx)).toBe(REASONS.arithSubstitution)
  })

  it.each(['a[$(wc -l < f)+1]=1', 'echo "$(date) ]"'])(
    'fails closed on text after a substitution in a subscript, though bash runs nothing unseen: %s',
    line => {
      expect(checkCommand(line, ctx)).toBe(REASONS.arithSubstitution)
    },
  )
})

describe('arithmetic the guard reads', () => {
  it.each([
    '[[ $n -eq 3 ]]',
    '[ "$n" -lt 10 ]',
    'test 1 -eq 1',
    '(( n > 2 ))',
    '[ "$a" -eq "$b" ]',
    '[[ ${#a[@]} -ge 2 ]]',
    '[[ $((n + 1)) -le 4 ]]',
    '[[ $(git rev-list --count HEAD) -gt 0 ]]',
    '[ "$(git status --porcelain | wc -l)" -eq 0 ]',
    '[[ $(git -C "$(pwd)" rev-list --count HEAD) -gt 0 ]]',
    '[[ 1 -eq a[$(git status)] ]]',
    "(( $(git rev-list --count 'a..b') > 0 ))",
    '(( "$(wc -l < f)" > 3 ))',
    'for ((i=0;i<3;i++)); do :; done',
    '(( $((n + 1)) > 2 ))',
    'echo $[ n + 1 ]',
    'let n=$(wc -l < f)',
    "let 'n=1+2'",
    'declare -i n=$(wc -l < f)',
    'a[$(wc -l < f)]=1',
    'a[1]=x',
    'declare -a arr',
    'export PATH=/usr/bin',
    '[[ $(echo "x\'s") -eq 1 ]]',
    "awk '{ n[$1]++ } END { for (k in n) print k }' f",
    "grep -E '^[a-z]+$' f",
    "sed 's/[0-9]$//' f",
    "jq '.items[0].name' f",
    '[[ $x == [a-z]* ]]',
    'a[$(git rev-parse --short HEAD)]=1',
    '[[ $(git rev-list --count HEAD) -eq a[$(echo 0)] ]]',
    'echo "[$(date)] done"',
    'echo "[$USER] done"',
    'a[$i]=1',
    'echo "${arr[1]}" $1 "$@"',
    '[[ $1 -eq ${n:-0} ]]',
    'git commit -m "Bump $(git rev-parse --short HEAD) [docs]"',
  ])('allows %s', line => {
    expect(checkCommand(line, ctx)).toBeUndefined()
  })

  it('still checks an unquoted substitution as a command', () => {
    expect(checkCommand('[[ 1 -eq a[$(git push --no-verify)] ]]', ctx)).toBe(REASONS.noVerify)
  })
})
