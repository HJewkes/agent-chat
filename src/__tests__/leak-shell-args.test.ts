import { describe, expect, it } from 'vitest'
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
    ['git push $10', ['a'], 'git push a0'],
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

  it('leaves positionals inside single quotes and $-quoted strings alone', () => {
    expect(filled("echo '$1' $1", { params: ['x'] })).toEqual({ text: "echo '$1' x" })
    expect(filled("echo $'\\'$1' $1", { params: ['x'] })).toEqual({ text: "echo $'\\'$1' x" })
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

  it.each(['${1:-x}', '${#1}', '${10}', '${@:2}', '${!1}'])('fills the modified %s as $@', use => {
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
    // A regex over the text: a quoted mention matches too, which over-denies on a git line only.
    ['echo shift; git push', 'shift'],
  ])('reads %j through %s when params are present', (script, implicit) => {
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
    // Known gap: a backslash inside the word hides it from the regex.
    ['sh\\ift; git push $1', 'sh\\ift; git push a'],
  ])('fills %j, which sets options or loops over a list', (script, text) => {
    expect(filled(script, { params: ['a'] })).toEqual({ text })
  })

  it('ignores an implicit reader when there are no params to read', () => {
    expect(filled('shift; git push $0', { zero: 'x' })).toEqual({ text: 'shift; git push x' })
  })
})
