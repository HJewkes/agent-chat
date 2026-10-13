import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fillScriptArgs, type ScriptArgs } from '../leak-guard/shell-args.js'

const args = (overrides: Partial<ScriptArgs>): ScriptArgs => ({
  zero: 'sh',
  params: [],
  more: false,
  ...overrides,
})
const filled = (script: string, overrides: Partial<ScriptArgs> = {}) =>
  fillScriptArgs(script, args(overrides))

describe('sh -c positionals filled with their words (CC-1201)', () => {
  it('fills $0 with ARG0', () => {
    expect(filled('git push $0', { zero: '--no-verify' })).toEqual({ text: 'git push --no-verify' })
  })

  it.each([
    ['git push $1', ['--no-verify'], 'git push --no-verify'],
    ['git push ${1}', ['--no-verify'], 'git push --no-verify'],
    ['git push "$2"', ['a', '--no-verify'], 'git push "--no-verify"'],
  ])('fills %s from the params', (script, params, text) => {
    expect(filled(script, { params })).toEqual({ text })
  })

  it('fills an unreadable word as $@ in its own quote context', () => {
    expect(filled('git push "$1"', { params: [undefined] })).toEqual({ text: 'git push "$@"' })
  })

  it('reads a positional past the end as unreadable when more words may follow, else as empty', () => {
    expect(filled('git push $2', { params: ['a'], more: true })).toEqual({ text: 'git push $@' })
    expect(filled('git push $2', { params: ['a'], more: false })).toEqual({ text: 'git push ' })
  })

  it('leaves positionals inside single quotes alone', () => {
    expect(filled("echo '$1' $1", { params: ['x'] })).toEqual({ text: "echo '$1' x" })
  })

  it("reads a $' inside double quotes as text, as every shell does", () => {
    expect(filled(`echo "$'x" $1`, { params: ['a'] })).toEqual({ text: `echo "$'x" a` })
  })

  it('leaves an escaped dollar, $$ and $# alone', () => {
    expect(filled('echo \\$1 $$1 $#', { params: ['x'] })).toEqual({ text: 'echo \\$1 $$1 $#' })
  })

  it('replaces a whole "$@" token with the joined words', () => {
    expect(filled('git push "$@"', { params: ['origin', 'main'] })).toEqual({ text: 'git push origin main' })
    expect(filled('git log "$@"; true', { params: [] })).toEqual({ text: 'git log ; true' })
  })

  it('keeps a quoted $@ beside other text as $@ unless it has exactly one word', () => {
    expect(filled('git push "x$@"', { params: ['a', 'b'] })).toEqual({ text: 'git push "x$@"' })
    expect(filled('git push x"$@"', { params: ['a', 'b'] })).toEqual({ text: 'git push x"$@"' })
    expect(filled('git push "x$@"', { params: ['a'] })).toEqual({ text: 'git push "xa"' })
  })

  it('joins $* and unquoted $@ with spaces', () => {
    expect(filled('git push $* "$*" $@', { params: ['a', 'b'] })).toEqual({ text: 'git push a b "a b" a b' })
  })

  it.each([
    ['an unreadable param', [undefined]],
    ['more words that may follow', ['a']],
  ])('fills $@ and $* as $@ given %s', (_, params) => {
    const more = params[0] !== undefined
    expect(filled('git push $@ "$*"', { params, more })).toEqual({ text: 'git push $@ "$@"' })
  })

  it.each([['a b'], ['$(x)'], ["'q'"], ['*']])('fills the non-plain word %j as $@', word => {
    expect(filled('git push $1', { params: [word] })).toEqual({ text: 'git push $@' })
  })

  it.each([
    '${1:-x}',
    '${#1}',
    '${10}',
    '${@:2}',
    '${!1}',
    '${!#}',
    '${=1}',
    '$=1',
    '$argv',
    '${argv[1]}',
    '$BASH_ARGV',
    '$10',
  ])('fills the modified or other-shell read %s as $@', use => {
    expect(filled(`git push ${use}`, { params: ['a'] })).toEqual({ text: 'git push $@' })
  })

  it('returns a script without positionals unchanged', () => {
    expect(filled('git status; echo "$HOME"', { params: ['a'] })).toEqual({
      text: 'git status; echo "$HOME"',
    })
  })
})

describe('sh -c scripts that read their arguments implicitly (CC-1201)', () => {
  it.each([
    ['shift; git push $1', 'shift'],
    ['while getopts n o; do :; done; git push', 'getopts'],
    ['set -- x; git push $1', 'set'],
    ['set x; git push $1', 'set'],
    ['set -e x; git push $1', 'set'],
    ['for a; do git push $a; done', 'for'],
    ['for a\ndo git push $a; done', 'for'],
    ['for a do git push $a; done', 'for'],
    ['f() { git push $1; }; f x', 'function'],
    ['function f { git push $1; }; f x', 'function'],
    // Any word counts, so a mention over-denies, on a git line only.
    ['echo shift; git push', 'shift'],
    ['sh\\ift; git push $1', 'shift'],
    ['"shift"; git push $1', 'shift'],
    ["sh''ift; git push $1", 'shift'],
    ['command shift; git push $1', 'shift'],
    ["eval 'shift'; git push $1", 'eval'],
    ['alias s=shift\ns; git push $1', 'alias'],
    ['set - --no-verify; git push $1', 'set'],
    ['set -o -- --no-verify; git push $1', 'set'],
    ['set -o; git push $1', 'set'],
    ['x=shift; $x; git push $1', 'command word'],
    ['$1; git push $2', 'command word'],
    ['"$0" push', 'command word'],
    ['. ./lib.sh; git push $1', 'source'],
    ['source lib.sh; git push $1', 'source'],
    ['IFS=.; git push $1', 'IFS'],
    [': ${IFS:=.}; git push $1', 'IFS'],
    ['export IF""S=.; git push $1', 'IFS'],
    ['readonly IF\\S=.; git push $1', 'IFS'],
    ['declare -n r=IF""S; r=.; git push $1', 'IFS'],
    ['declare -n r=v; r=.; git push $1', 'nameref'],
    ['typeset -rn r=v; git push $1', 'nameref'],
    ['nameref r=v; git push $1', 'nameref'],
    ["echo $'x' $1", 'ansi-c quoting'],
    ["x=$'\\'\ngit push $1\n: \\'", 'ansi-c quoting'],
    ["# it's a comment\ngit push $1", 'comment'],
    ['git push "$(echo "\'")" $1', 'nested quoting'],
    ['git push "${x:-"\'"}" $1', 'nested quoting'],
    ['git push `echo $1`', 'nested quoting'],
    ["cat <<E\nit's $1\nE", 'heredoc'],
    ['git push "$1', 'unclosed quote'],
  ])('reads %j through %s', (script, implicit) => {
    expect(filled(script, { params: ['a'] })).toEqual({ implicit })
  })

  it('reads an implicit reader when only more words may follow', () => {
    expect(filled('shift; git push', { more: true })).toEqual({ implicit: 'shift' })
  })

  it.each([
    ['set -e; git push $1', 'set -e; git push a'],
    ['set -euo pipefail; git push $1', 'set -euo pipefail; git push a'],
    ['for a in x y; do git push $1; done', 'for a in x y; do git push a; done'],
    ['git log --format=%s $1', 'git log --format=%s a'],
    ['echo $(date) $1', 'echo $(date) a'],
    ['git push origin a#b $1', 'git push origin a#b a'],
    ['echo "$HOME" $# ${#x} $1', 'echo "$HOME" $# ${#x} a'],
    ['git config --unset x $1', 'git config --unset x a'],
  ])('fills %j, which sets options or loops over a list', (script, text) => {
    expect(filled(script, { params: ['a'] })).toEqual({ text })
  })

  it('reads an implicit reader even with no params, since $0 and the defaults may still be read', () => {
    expect(filled('shift; git push $0', { zero: 'x' })).toEqual({ implicit: 'shift' })
  })
})

const SHELLS = ['dash', 'bash'].filter(shell => {
  try {
    execFileSync(shell, ['-c', ':'])
    return true
  } catch {
    return false
  }
})

// Each runs `git push` with `--no-verify` in a real shell, though its text never spells it out.
const HIDDEN_SPLITS: [string, string, string[], string[]][] = [
  ['export IF""S', 'export IF""S=.; git push $1', ['a.--no-verify'], ['dash', 'bash']],
  ['readonly IF\\S', 'readonly IF\\S=.; git push $1', ['a.--no-verify'], ['dash', 'bash']],
  ['a nameref to IFS', 'declare -n r=IF""S; r=.; git push $1', ['a.--no-verify'], ['bash']],
  ["dash's $'", "x=$'\\'\ngit push $1\n: \\'", ['--no-verify'], ['dash']],
]

describe.skipIf(SHELLS.length === 0)(
  'scripts that hide a split from the scan, against real shells (CC-1201)',
  () => {
    let bin: string
    beforeAll(() => {
      bin = fs.mkdtempSync(path.join(os.tmpdir(), 'cc1201-shell-args-'))
      fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\nprintf "[%s]" "$@"\n', { mode: 0o755 })
    })
    afterAll(() => fs.rmSync(bin, { recursive: true, force: true }))

    const ran = (shell: string, script: string, params: string[]) =>
      execFileSync(shell, ['-c', script, '_', ...params], {
        env: { PATH: `${bin}:${process.env.PATH ?? ''}` },
        encoding: 'utf8',
      })

    it.each(HIDDEN_SPLITS)(
      'returns implicit for %s, which pushes --no-verify',
      (_, script, params, shells) => {
        for (const shell of shells.filter(name => SHELLS.includes(name))) {
          expect(ran(shell, script, params)).toContain('[--no-verify]')
        }
        expect(filled(script, { params })).toHaveProperty('implicit')
      },
    )
  },
)
