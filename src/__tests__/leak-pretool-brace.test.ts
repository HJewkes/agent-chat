import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { checkCommand, REASONS, type GuardContext } from '../leak-guard/pretool.js'

/**
 * A brace expansion after `git push` that may spell an option, a sequence such as
 * `--no-verif{y..y}` as much as a list such as `--no-verif{y,}`, is denied (CC-1427). Real shells
 * with a fake `git` first on PATH confirm what each line runs.
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

// On main every row here was allowed. Dropping braceOption from hasOptionAlternation allows them all again.
const DENIED = [
  // CI has no zsh, so this wrapping is checked by the guard alone.
  "zsh -c 'git push origin {{repo},}--no-verify'",
  'git push --no-verif{y..y} origin HEAD:main',
  // bash runs `git push --no-verifx --no-verify origin HEAD:main`.
  'git push --no-verif{x..y} origin HEAD:main',
  'git push --no-verif{y,} origin HEAD:main',
  'git push origin {main,--no-verify}',
  "bash -c 'git push --no-verif{y..y} origin HEAD:main'",
  "zsh -c 'git push --no-verif{y..y} origin HEAD:main'",
  // zsh's sequence runs over any single characters, and `{+../}` yields `-`.
  'git push origin {+../}-no-verify',
  "git push --rec{e..e}ive-pack='git push --no-verify' origin",
]

// A group that may expand to nothing, glued before a `-`: allowed at 97ff08e9; dropping mayLeadWithDash allows them again.
// Each line with what bash 5.3 and zsh 5.9 both pass git.
const EMPTY_LED: [string, string][] = [
  ['git push {,}--no-verify origin HEAD:main', 'push --no-verify --no-verify origin HEAD:main'],
  ['git push {"",}--no-verify o', 'push --no-verify --no-verify o'],
  ["git push {'',}--no-verify o", 'push --no-verify --no-verify o'],
  ['git push {,,}--no-verify o', 'push --no-verify --no-verify --no-verify o'],
  ['git push {a,{,}}--no-verify o', 'push a--no-verify --no-verify --no-verify o'],
  ['git push {,}{,}--no-verify o', 'push --no-verify --no-verify --no-verify --no-verify o'],
  ['git push {,}--no-verif{y,} o', 'push --no-verify --no-verif --no-verify --no-verif o'],
  ['bash -c "git push {,}--no-verify origin HEAD:main"', 'push --no-verify --no-verify origin HEAD:main'],
  ['git push origin HEAD:main {,}--no-verify', 'push origin HEAD:main --no-verify --no-verify'],
  ['git push {{,}-x,a} o', 'push -x -x a o'],
]

// A group glued before a `-` that cannot expand to nothing, and a count, which git reads as no option.
const GLUED_ALLOWED: [string, string][] = [
  [
    'git push origin feat/{a,b}-x HEAD:refs/heads/feat-{1..2}',
    'push origin feat/a-x feat/b-x HEAD:refs/heads/feat-1 HEAD:refs/heads/feat-2',
  ],
  ['git push origin {a,b}-x', 'push origin a-x b-x'],
  ['git push -{1..3} origin HEAD', 'push -1 -2 -3 origin HEAD'],
]

// A quoted or escaped `{`, `,` or `}` is text to the shell, not the group's structure: allowed at fda21f05,
// where quotes were removed before the group was read. Each line with what bash 5.3 and zsh 5.9 both pass git.
const QUOTED_TEXT: [string, string][] = [
  [
    'git push origin HEAD:main {,HEAD:x"}"}--no-verify',
    'push origin HEAD:main --no-verify HEAD:x}--no-verify',
  ],
  [
    'git push origin HEAD:main {,HEAD:x\\}}--no-verify',
    'push origin HEAD:main --no-verify HEAD:x}--no-verify',
  ],
  ['git push origin HEAD:main {"{",}--no-verify', 'push origin HEAD:main {--no-verify --no-verify'],
  [
    'git push origin HEAD:main {HEAD:x"{",}--no-verify',
    'push origin HEAD:main HEAD:x{--no-verify --no-verify',
  ],
  ['git push origin {,a"}"}--no-verify', 'push origin --no-verify a}--no-verify'],
  ["git push origin {,a'}'}--no-verify", 'push origin --no-verify a}--no-verify'],
  ['git push origin {\\{,}--no-verify', 'push origin {--no-verify --no-verify'],
  ["git push origin {'{',}--no-verify", 'push origin {--no-verify --no-verify'],
  // The splitter leaves an empty `{}` unmarked, so a `{` before a quoted `}` reads both ways.
  ['git push origin {"}",}--no-verify', 'push origin }--no-verify --no-verify'],
  ['git push origin {,{}}--no-verify', 'push origin --no-verify {}--no-verify'],
  ['git push origin {"}",{}}--no-verify', 'push origin }--no-verify {}--no-verify'],
]

// A comma list whose alternative holds a nested group: allowed at fda21f05 and f4badd13, whose list gate
// matched only a list with no group inside. Each line with what bash 5.3 and zsh 5.9 both pass git.
const NESTED: [string, string][] = [
  ['git push {{a},}--no-verify origin HEAD:main', 'push {a}--no-verify --no-verify origin HEAD:main'],
  ['git push {{},}--no-verify origin HEAD:main', 'push {}--no-verify --no-verify origin HEAD:main'],
  ['git push {a{b},}--no-verify origin HEAD:main', 'push a{b}--no-verify --no-verify origin HEAD:main'],
  ['git push {{a}{b},}--no-verify origin HEAD:main', 'push {a}{b}--no-verify --no-verify origin HEAD:main'],
  ['git push origin HEAD:main {{a},}--no-verify', 'push origin HEAD:main {a}--no-verify --no-verify'],
  [
    "bash -c 'git push {{a},}--no-verify origin HEAD:main'",
    'push {a}--no-verify --no-verify origin HEAD:main',
  ],
  // A gh api placeholder is a nested group to the shell, not the close of the list around it.
  ['git push origin {{repo},}--no-verify', 'push origin {repo}--no-verify --no-verify'],
  ['git push {{owner},}--no-verify origin HEAD:main', 'push {owner}--no-verify --no-verify origin HEAD:main'],
  [
    'git push origin HEAD:main {{branch},}--no-verify',
    'push origin HEAD:main {branch}--no-verify --no-verify',
  ],
  ['git push origin {{owner},HEAD:main,--no-verify}', 'push origin {owner} HEAD:main --no-verify'],
  ['git push origin {{owner},--no-verify}', 'push origin {owner} --no-verify'],
  ['git push {{repo},-}-no-verify origin HEAD:main', 'push {repo}-no-verify --no-verify origin HEAD:main'],
  ['git push origin {{owner}{repo},}--no-verify', 'push origin {owner}{repo}--no-verify --no-verify'],
  ["bash -c 'git push origin {{repo},}--no-verify'", 'push origin {repo}--no-verify --no-verify'],
]

const NESTED_ALLOWED: [string, string][] = [
  ['git push origin {a,{b}}-x', 'push origin a-x {b}-x'],
  ['git push origin feat/{{a},b}', 'push origin feat/{a} feat/b'],
]

// Quoted braces the shell leaves as text, or that yield no option.
const QUOTED_ALLOWED: [string, string][] = [
  ['git push origin "feat/{a,b}"', 'push origin feat/{a,b}'],
  ['git push origin feat/{a,b}"-x"', 'push origin feat/a-x feat/b-x'],
  ['git commit -m "{,}--no-verify"', 'commit -m {,}--no-verify'],
  ['git push origin x{}', 'push origin x{}'],
]

// The structure sentinels brace-option.ts substitutes, written raw into the word: allowed at d026ea2b,
// where they read as structure the shell never sees. Each line with what bash 5.3 passes git.
const SENTINELS: [string, string][] = [
  ['git push {,}--no-verify origin HEAD:main', 'push --no-verify --no-verify origin HEAD:main'],
  ['git push {,}--no-verify origin HEAD:main', 'push --no-verify --no-verify origin HEAD:main'],
  ['git push {,}--no-verify origin HEAD:main', 'push --no-verify --no-verify origin HEAD:main'],
  // Fails closed, though git gets no bare --no-verify here.
  ['git push {,}--no-verify origin HEAD:main', 'push --no-verify --no-verify origin HEAD:main'],
  ['bash -c "git push {,}--no-verify origin HEAD:main"', 'push --no-verify --no-verify origin HEAD:main'],
]

// A sentinel or HOLE in a word with no brace expansion, read as the text the shell passes.
const SENTINEL_ALLOWED: [string, string][] = [
  ['git push origin feat/x', 'push origin feat/x'],
  ['git push origin feat/\x01x', 'push origin feat/\x01x'],
]

const ALLOWED = [
  ...GLUED_ALLOWED.map(([src]) => src),
  ...QUOTED_ALLOWED.map(([src]) => src),
  ...NESTED_ALLOWED.map(([src]) => src),
  ...SENTINEL_ALLOWED.map(([src]) => src),
  'git push origin feat/{a,b}',
  'git commit --no-verif{y,} -m x',
  'for i in {1..3}; do echo $i; done',
  'mkdir -p d{1..3}',
  'echo {a..c}',
  'touch f{01..03}.txt',
  'git log -{1..1}',
  'git add f{1..3}.txt',
  'git push origin HEAD:feat/{a,b}',
  // As `git commit --no-verify` is: the pre-push scan still runs.
  'git commit --no-verif{y..y} -m x',
  'gh api repos/{owner}/{repo}/pulls',
]

describe('checkCommand on brace expansions (CC-1427)', () => {
  it.each([...DENIED, ...[...EMPTY_LED, ...QUOTED_TEXT, ...NESTED, ...SENTINELS].map(([src]) => src)])(
    'denies %j',
    src => {
      expect(checkCommand(src, ctx())).toBe(REASONS.noVerify)
    },
  )

  it.each(ALLOWED)('allows %j', src => {
    expect(checkCommand(src, ctx())).toBeUndefined()
  })

  // The splitter strips a raw NUL, its own LIVE mark, while zsh cuts the word there and runs `--no-veri`.
  it('denies a line that holds a raw NUL', () => {
    expect(checkCommand('git push --no-veri\0x origin HEAD:main', ctx())).toBe(REASONS.operatorExpansion)
  })

  it('denies a long empty-group chain inside an alternative without overflowing the stack', () => {
    const src = `git push {a,${'{,}'.repeat(20000)}}--no-verify origin HEAD:main`
    expect(checkCommand(src, ctx())).toBe(REASONS.noVerify)
  })

  it('reads a sequence that spells a branch as the branch it spells', () => {
    expect(checkCommand('git push origin HEAD:mai{n..n}', ctx())).toBe(
      checkCommand('git push origin HEAD:main', ctx()),
    )
  })
})

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-pretool-brace-')))
const BIN = path.join(ROOT, 'bin')
const RECORD = path.join(ROOT, 'git-calls')
const ENV = { PATH: `${BIN}:/usr/bin:/bin`, HOME: ROOT, RECORD }

fs.mkdirSync(BIN)
fs.writeFileSync(path.join(BIN, 'git'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$RECORD"\n', { mode: 0o755 })

afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }))

const BASH = fs.existsSync('/bin/bash') ? '/bin/bash' : undefined
const ZSH = fs.existsSync('/bin/zsh') ? '/bin/zsh' : undefined

/** The argument lines `shell -c src` passed the fake git. */
function gitCalls(shell: string, args: string[], src: string): string[] {
  fs.rmSync(RECORD, { force: true })
  execFileSync(shell, [...args, '-c', src], { env: ENV, cwd: ROOT, stdio: 'ignore' })
  return fs.existsSync(RECORD) ? fs.readFileSync(RECORD, 'utf8').trim().split('\n') : []
}

describe.skipIf(BASH === undefined)('bash expands brace sequences in what git receives (CC-1427)', () => {
  const bash = (src: string): string[] => gitCalls(BASH as string, ['--noprofile', '--norc'], src)

  it.each([
    ['git push --no-verif{y..y} origin HEAD:main', 'push --no-verify origin HEAD:main'],
    ['git push origin HEAD:mai{n..n}', 'push origin HEAD:main'],
    ['git push --no-verif{x..y} origin HEAD:main', 'push --no-verifx --no-verify origin HEAD:main'],
  ])('runs %j as git %j', (src, call) => {
    expect(bash(src)).toEqual([call])
  })

  it('leaves a zsh character sequence as written', () => {
    expect(bash('git push origin {+../}-no-verify')).toEqual(['push origin {+../}-no-verify'])
  })

  it.each([...EMPTY_LED, ...GLUED_ALLOWED, ...QUOTED_TEXT, ...QUOTED_ALLOWED, ...NESTED, ...NESTED_ALLOWED])(
    'runs %j as git %j',
    (src, call) => {
      expect(bash(src)).toEqual([call])
    },
  )
  it.each([...SENTINELS, ...SENTINEL_ALLOWED])('runs %j as git %j', (src, call) => {
    expect(bash(src)).toEqual([call])
  })
})

describe.skipIf(ZSH === undefined)('zsh expands brace sequences in what git receives (CC-1427)', () => {
  const zsh = (src: string): string[] => gitCalls(ZSH as string, ['-f'], src)

  it('runs a letter sequence as the flag it spells', () => {
    expect(zsh('git push --no-verif{y..y} origin HEAD:main')).toEqual(['push --no-verify origin HEAD:main'])
  })

  it('runs a character sequence that yields - as --no-verify', () => {
    expect(zsh('git push origin {+../}-no-verify')).toEqual([
      'push origin +-no-verify ,-no-verify --no-verify .-no-verify /-no-verify',
    ])
  })

  it.each([...EMPTY_LED, ...GLUED_ALLOWED, ...QUOTED_TEXT, ...QUOTED_ALLOWED, ...NESTED, ...NESTED_ALLOWED])(
    'runs %j as git %j',
    (src, call) => {
      expect(zsh(src)).toEqual([call])
    },
  )
})
