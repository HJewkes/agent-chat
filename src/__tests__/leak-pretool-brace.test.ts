import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { checkCommand, REASONS, type GuardContext } from '../leak-guard/pretool.js'

/**
 * A brace expansion after a git subcommand that may spell an option, a sequence such as
 * `--no-verif{y..y}` as much as a list such as `--no-verif{y,}`, is denied (CC-1427, CC-1434), and a
 * push word is judged at its first character, which zsh's braceccl also expands (CC-1432). Real
 * shells with a fake `git` first on PATH confirm what each line runs.
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

const NESTED_ALLOWED: [string, string][] = [['git push origin feat/{{a},b}', 'push origin feat/{a} feat/b']]

// A push word led by a live `{` is denied whatever the group holds (CC-1432): harmless here, and accepted as rare.
const BRACE_LED: [string, string][] = [
  ['git push origin {a,b}-x', 'push origin a-x b-x'],
  ['git push origin {a,{b}}-x', 'push origin a-x {b}-x'],
]

// Each line with what zsh 5.9 -f passes git once braceccl is set, which expands any `{chars}`: allowed
// on main, where only a comma list or a sequence read as a group (CC-1432). bash leaves each as written.
const BRACECCL: [string, string][] = [
  ['git push {-}-no-verify origin HEAD:main', 'push --no-verify origin HEAD:main'],
  ['git push --no-verif{y} origin HEAD:main', 'push --no-verify origin HEAD:main'],
  ['git push --forc{e} origin HEAD:main', 'push --force origin HEAD:main'],
  ['git push {-}-delete origin x', 'push --delete origin x'],
  ['git fetch --upload-pac{k}=x origin', 'fetch --upload-pack=x origin'],
  ['git fetch {-}-upload-pack=x origin', 'fetch --upload-pack=x origin'],
]
// Off push under braceccl, which does not nest: in `{+-{b}}` the inner braces are class characters and
// `+-{` is a range that takes in `-` (CC-1437). Each line with the option word zsh 5.9 passes git.
const NESTED_CLASS: [string, string][] = [
  ['git fetch {+-{b}}{+-{b}}upload-pack=x origin', '--upload-pack=x'],
  ['git fetch {x,{+-{b}}{+-{b}}upload-pack=x} origin', '--upload-pack=x'],
  ['git commit {+-{b}}{+-{b}}no-verify -m x', '--no-verify'],
  ['git fetch {*-{b}}{*-{b}}upload-pack=x origin', '--upload-pack=x'],
  ['git fetch {+-{{b}}}{+-{{b}}}upload-pack=x origin', '--upload-pack=x'],
  ['git commit {*-{b}}{*-{b}}no-verify -m x', '--no-verify'],
]
// The ways a line turns braceccl on before git runs.
const BRACECCL_FORMS = [
  (src: string) => `zsh -f -o braceccl -c '${src}'`,
  (src: string) => `zsh -f --braceccl -c '${src}'`,
  (src: string) => `zsh -f -c 'setopt braceccl; ${src}'`,
  (src: string) => src,
]

// Brace-built push options other than --no-verify, each what bash 5.3 and zsh 5.9 pass git. git itself
// refuses `--forc` as ambiguous and `--mirrr` as unknown, while `--force`, `--force-with-lease`,
// `--delete` and `--mirro` run.
const PUSH_OPTIONS: [string, string][] = [
  ['git push {,}--forc origin HEAD:main', 'push --forc --forc origin HEAD:main'],
  ['git push {,}--force origin HEAD:main', 'push --force --force origin HEAD:main'],
  ['git push --delet{e,} origin x', 'push --delete --delet origin x'],
  ['git push --mirr{o,}r origin', 'push --mirror --mirrr origin'],
  ['git push --mirro{r,} origin', 'push --mirror --mirro origin'],
  [
    'git push {,}--force-with-lease origin HEAD:main',
    'push --force-with-lease --force-with-lease origin HEAD:main',
  ],
]

// Brace-spelled options off push, which the guard denies as text: allowed on main, where braceOption ran
// on push alone (CC-1434). Each line with what bash 5.3 and zsh 5.9 both pass git.
const OFF_PUSH: [string, string][] = [
  [
    'git fetch --upload-pac{k..k}="git push --no-verify origin HEAD:main" origin',
    'fetch --upload-pack=git push --no-verify origin HEAD:main origin',
  ],
  ['git fetch --upload-pack{,}="x" origin', 'fetch --upload-pack=x --upload-pack=x origin'],
  ['git pull --upload-pac{k..k}="x" origin main', 'pull --upload-pack=x origin main'],
  ['git difftool --ext{c..c}md="x" HEAD~1', 'difftool --extcmd=x HEAD~1'],
  ['git init --templat{e..e}=/tmp/t', 'init --template=/tmp/t'],
  // As `git commit --no-verif[y]` is under CC-728.
  ['git commit --no-verif{y,} -m x', 'commit --no-verify --no-verif -m x'],
  ['git commit --no-verif{y..y} -m x', 'commit --no-verify -m x'],
  // A `-` inside the run of groups that leads the word, or a brace before the option name's `=`.
  ['git fetch {a,-}-upload-pack=x', 'fetch a-upload-pack=x --upload-pack=x'],
  ['git fetch {-x,y}upload-pack=x', 'fetch -xupload-pack=x yupload-pack=x'],
  ['git fetch --{upload-pack=x,y}', 'fetch --upload-pack=x --y'],
  ['git fetch {,}-x', 'fetch -x -x'],
]

// Off push, read by the guard alone: zsh sequences and braceccl that yield `-`, which CI cannot run,
// and a group that never closes, which the shells pass as written but which fails closed.
const OFF_PUSH_GUARD = [
  'git fetch {+../}{+../}upload-pack=x',
  'git fetch {+..0}{+..0}upload-pack=x',
  "zsh -f -o braceccl -c 'git fetch {a,}{-}x'",
  // zsh runs `fetch -upload-pack=x …`: a class with no `,`, after a list that may be empty.
  "zsh -f -o braceccl -c 'git fetch {,}{a-}upload-pack=x'",
  'git fetch {-x-upload-pack=x',
  'git fetch {x-upload-pack=x',
]

// Braces off push that cannot lead a word with `-`, or that sit in an option's value.
const OFF_PUSH_ALLOWED: [string, string][] = [
  ['git log -{1..1}', 'log -1'],
  ['git add f{1..3}.txt', 'add f1.txt f2.txt f3.txt'],
  ['git add {src,test}/x', 'add src/x test/x'],
  ['git log --format=%H{x}', 'log --format=%H{x}'],
  ['git log --format=\'{"sha":"%H"}\'', 'log --format={"sha":"%H"}'],
  // A `-` after the leading group is copied after every alternative, so it never leads the word.
  ['git add {src,test}/foo-bar.ts', 'add src/foo-bar.ts test/foo-bar.ts'],
  [
    'git add {src/leak-guard/brace-option.ts,docs/leak-guard.md}',
    'add src/leak-guard/brace-option.ts docs/leak-guard.md',
  ],
  ['git diff -- {src,test}/foo-bar.ts', 'diff -- src/foo-bar.ts test/foo-bar.ts'],
  ['git rm {a,b}-old.txt', 'rm a-old.txt b-old.txt'],
  ['git branch -D {old,older}-branch', 'branch -D old-branch older-branch'],
  ['git show {HEAD,main}:a-b.txt', 'show HEAD:a-b.txt main:a-b.txt'],
  ['git add {src/{a,b},test}/x-y.ts', 'add src/a/x-y.ts src/b/x-y.ts test/x-y.ts'],
  ['git show HEAD:{a,b}/c-d.md', 'show HEAD:a/c-d.md HEAD:b/c-d.md'],
  // A brace after a long option's `=` copies the option into every word.
  ['git log --grep={fix,feat}', 'log --grep=fix --grep=feat'],
  ['git log --pretty=format:{%h,%s}', 'log --pretty=format:%h --pretty=format:%s'],
  ['git log --since={1..2}', 'log --since=1 --since=2'],
  ['git log --format={a,b}', 'log --format=a --format=b'],
  ['git diff --color={always,never}', 'diff --color=always --color=never'],
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
  ...OFF_PUSH_ALLOWED.map(([src]) => src),
  'git push origin feat/{a,b}',
  'git push origin HEAD:refs/heads/feat/{a,b}-x',
  'git push origin {owner}/{repo}',
  'git push origin {}',
  'for i in {1..3}; do echo $i; done',
  'mkdir -p d{1..3}',
  'echo {a..c}',
  'touch f{01..03}.txt',
  'git push origin HEAD:feat/{a,b}',
  'gh api repos/{owner}/{repo}/pulls',
  'mv file{,.bak}',
  'find . -exec rm {} +',
]

const DENIED_PAIRS = [
  ...EMPTY_LED,
  ...QUOTED_TEXT,
  ...NESTED,
  ...SENTINELS,
  ...BRACE_LED,
  ...PUSH_OPTIONS,
  ...OFF_PUSH,
]

describe('checkCommand on brace expansions (CC-1427, CC-1432, CC-1434)', () => {
  it.each([
    ...DENIED,
    ...OFF_PUSH_GUARD,
    ...DENIED_PAIRS.map(([src]) => src),
    ...BRACECCL.flatMap(([src]) => BRACECCL_FORMS.map(form => form(src))),
    ...NESTED_CLASS.flatMap(([src]) => BRACECCL_FORMS.map(form => form(src))),
  ])('denies %j', src => {
    expect(checkCommand(src, ctx())).toBe(REASONS.noVerify)
  })

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
  it.each([...BRACE_LED, ...PUSH_OPTIONS, ...OFF_PUSH, ...OFF_PUSH_ALLOWED])(
    'runs %j as git %j',
    (src, call) => {
      expect(bash(src)).toEqual([call])
    },
  )
  it.each(BRACECCL)('leaves %j as written', src => {
    expect(bash(src)).toEqual([src.slice('git '.length)])
  })
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
  it.each([...BRACE_LED, ...PUSH_OPTIONS, ...OFF_PUSH, ...OFF_PUSH_ALLOWED])(
    'runs %j as git %j',
    (src, call) => {
      expect(zsh(src)).toEqual([call])
    },
  )
})

describe.skipIf(ZSH === undefined)(
  'zsh under braceccl expands any {chars} in what git receives (CC-1432)',
  () => {
    it.each(BRACECCL)('runs %j as git %j under -o braceccl, --braceccl and setopt braceccl', (src, call) => {
      expect(gitCalls(ZSH as string, ['-f', '-o', 'braceccl'], src)).toEqual([call])
      expect(gitCalls(ZSH as string, ['-f', '--braceccl'], src)).toEqual([call])
      expect(gitCalls(ZSH as string, ['-f'], `setopt braceccl; ${src}`)).toEqual([call])
    })
  },
)

describe.skipIf(ZSH === undefined)('zsh under braceccl reads a nested class as one range (CC-1437)', () => {
  it.each(NESTED_CLASS)('passes git the option word from %j', (src, option) => {
    const words = gitCalls(ZSH as string, ['-f', '-o', 'braceccl'], src)
      .join(' ')
      .split(' ')
    expect(words).toContain(option)
  })
})
