import { parseTerms } from '@titan-design/egress-scan'
import { describe, expect, it } from 'vitest'
import { checkCommand, REASONS, type GuardContext } from '../leak-guard/pretool.js'
import { COMMAND_LOOKUP, COMMAND_LOOKUP_BUILTINS } from '../leak-guard/trust-inputs.js'

const ctx: GuardContext = {
  terms: { kind: 'ok', rules: parseTerms('zq7privateseat\n') },
  cwd: '/work',
  env: {},
  protectedPaths: ['titan-egress/private-terms', '.agent-chat/git-hooks'],
  readFile: () => undefined,
  readAlias: () => undefined,
  readIncludedHooksPath: () => false,
}

// Asserting defined first keeps a row failing where REASONS.searchPathEnv does not exist.
function expectSearchDeny(command: string): void {
  const reason = checkCommand(command, ctx)
  expect(reason).toBeDefined()
  expect(reason).toBe(REASONS.searchPathEnv)
}

describe('PATH or a loader variable set to a value the guard cannot read, on a line that may reach git (CC-1236)', () => {
  it.each([
    'LD_PRELOAD=$X git push',
    'LD_PRELOAD="$X" git push',
    'env LD_PRELOAD="$X" git push',
    'PATH=$(mktemp -d) git push',
    'PATH="$X" git push',
    'env PATH="$X" git push',
    'export PATH="$X"; git push',
    'PATH=/usr/bin:$X git push',
    'PATH+=:$X git push',
    'read PATH; git push',
    ': ${PATH:=/x}; git push',
    'env -S "PATH=/x git push"',
    'LD_LIBRARY_PATH=$X git push',
    'LD_AUDIT=$X git push',
    'DYLD_INSERT_LIBRARIES=$X git push',
    'DYLD_LIBRARY_PATH=$X git push',
    'echo p | xargs env PATH="$X" git push origin --',
  ])('denies searchPathEnv: %s', command => {
    expectSearchDeny(command)
  })

  it.each([
    'HOME=$X PATH=$HOME/bin git push',
    'export HOME=$(mktemp -d); PATH=$HOME:$PATH git push',
    'HOME=$X; PATH=~/bin:$PATH git push',
    'HOME=$X; PATH=~ git push',
    'HOME=$X LD_PRELOAD=$HOME/l.so git push',
    'HOME=$X LD_PRELOAD=~/x.so git push',
    'read HOME; LD_PRELOAD=~/l.so git push',
    ': ${HOME:=/x}; PATH=~/bin git push',
    "HOME=$X bash -c 'PATH=~/bin git push'",
    'HOME=/h LD_PRELOAD=$HOME/l.so git push',
  ])('denies searchPathEnv when the line may write HOME: %s', command => {
    expectSearchDeny(command)
  })

  it.each([
    'cd "$X"; PATH=~+ git push',
    'cd "$X"; cd /; PATH=~- git push',
    'pushd "$X"; pushd /; PATH=~1 git push',
    'PWD=$X; PATH=~+ git push',
    'cd "$X"; LD_PRELOAD=~+/x.so git push',
  ])('denies searchPathEnv for a tilde prefix other than a bare ~: %s', command => {
    expectSearchDeny(command)
  })

  it.each([
    'LD_ORIGIN_PATH=$X git push',
    'GCONV_PATH=$X git push',
    'DYLD_FALLBACK_LIBRARY_PATH=$X git push',
    'DYLD_FRAMEWORK_PATH=$X git push',
    'DYLD_FALLBACK_FRAMEWORK_PATH=$X git push',
  ])('denies searchPathEnv for every loader variable: %s', command => {
    expectSearchDeny(command)
  })

  it.each([
    'path=($X $path); git push',
    'path+=($X); git push',
    'path[1]=$X; git push',
    'path=(~+ $path); git push',
    'path=(/usr/bin); git push',
    'typeset path=($X); git push',
    'read -A path; git push',
    'for path in $X; do git push; done',
    ': ${path:=/x}; git push',
    'pa""th=($X); git push',
    'cd path && git status',
    'cd functions && git status',
  ])("denies searchPathEnv for zsh's path, tied to PATH: %s", command => {
    expectSearchDeny(command)
  })

  it.each([
    'hash -p "$X" git; git push',
    'hash git=$X; git push',
    'builtin hash -p $X git; git push',
    'command hash git=$X; git status',
    'hash -p $(mktemp -d)/git git; gh pr create',
  ])('denies searchPathEnv for hash given a value the guard cannot read: %s', command => {
    expectSearchDeny(command)
  })

  // A family pattern such as LD_[A-Z0-9_]+ stands for any member, so one member stands in for it.
  const member = (name: string): string => name.replace('[A-Z0-9_]+', 'VERSIONED_LIBRARY_PATH')
  const lookupRows = (name: string): string[] => [
    `${name}=$X git push`,
    `${name}="$X"; gh pr create`,
    `${name}+=($X); git push`,
    `${name}[git]=$X; git push`,
    `${name}[git]=$X git push`,
    `typeset ${name}=$X; git push`,
    `read -A ${name}; git push`,
    `: \${${name}:=/x}; git push`,
  ]

  it.each(COMMAND_LOOKUP.flatMap(({ name }) => lookupRows(member(name))))(
    'denies searchPathEnv for every COMMAND_LOOKUP entry given an unread value: %s',
    command => {
      expectSearchDeny(command)
    },
  )

  it.each(
    COMMAND_LOOKUP.filter(({ literal }) => !literal).map(({ name }) => `${name}[git]=/bin/echo; git push`),
  )('denies searchPathEnv for a command table or tied array even given a literal: %s', command => {
    expectSearchDeny(command)
  })

  it.each(
    [...COMMAND_LOOKUP_BUILTINS].flatMap(builtin => [
      `${builtin} -p "$X" git; git push`,
      `${builtin} git=$X; gh pr create`,
    ]),
  )('denies searchPathEnv for every COMMAND_LOOKUP_BUILTINS entry given an unread value: %s', command => {
    expectSearchDeny(command)
  })

  it.each([
    'commands[git]=$X; git push',
    'commands[git]=$X git push',
    'BASH_CMDS[git]=$X; git push',
    'functions[git]=$X; git push',
    'aliases[git]=$X; git push',
    'DYLD_VERSIONED_LIBRARY_PATH=$X git push',
    'DYLD_VERSIONED_FRAMEWORK_PATH=$X git push',
    'DYLD_IMAGE_SUFFIX=$X git push',
  ])('denies searchPathEnv for the forms the second review found: %s', command => {
    expectSearchDeny(command)
  })

  it('lets a per-command reason win over an unreadable PATH on the same line', () => {
    expect(checkCommand('PATH="$X" git push --no-verify', ctx)).toBe(REASONS.noVerify)
  })

  it.each([
    'PATH=/usr/bin:/bin git push',
    'PATH=/opt/git/bin:$PATH git push',
    'PATH="/opt/git/bin:${PATH}" git status',
    'LD_PRELOAD=/usr/lib/libfake.so git status',
    'env PATH=/usr/bin git push',
    'PATH+=:/opt/bin git push',
    'PATH=~/bin:$PATH git push',
    'export PATH=$HOME/bin:$PATH; git fetch x',
    'PATH=~:$PATH git push',
    'echo "${HOME:-/h}"; LD_PRELOAD=~/l.so git status',
    'XDG_CONFIG_HOME=$X PATH=~/bin git push',
    'echo "$PATH"; git status',
    'unset LD_PRELOAD; git push',
    'PATH=$X make',
    "git commit -m 'set PATH and LD_PRELOAD'",
    'NODE_PATH=$X git status',
    'git add src/path.ts lib/path/x.ts',
    'cat docs/path.md; git status',
    'git log -- path',
    'hash -r; git push',
    'hash -p /usr/bin/git git; git push',
    'hash -p "$X" make',
    'git add src/functions/x.ts',
    'BUILD_DIR=$X git status',
    'LD_BIND_NOW=1 git push',
  ])('allows %s', command => {
    expect(checkCommand(command, ctx)).toBeUndefined()
  })
})
