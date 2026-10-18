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
    "local -i n='a[$(git push --no-verify)]'",
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
    "[[ x == 'a[$(git status)]' ]]",
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
  ])('allows %s', line => {
    expect(checkCommand(line, ctx)).toBeUndefined()
  })

  it('still checks an unquoted substitution as a command', () => {
    expect(checkCommand('[[ 1 -eq a[$(git push --no-verify)] ]]', ctx)).toBe(REASONS.noVerify)
  })
})
