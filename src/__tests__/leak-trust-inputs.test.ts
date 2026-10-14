import { describe, expect, it } from 'vitest'
import type { SubArgs } from '../leak-guard/git-parse-options.js'
import {
  INTERPRETER_CODE_ENV,
  NAME_FREE_PROGRAMS,
  SHELL_CODE_ENV,
  TRUST_ENV,
  ZSH_IMPORTED_PROMPT_ENV,
  execPathOption,
  runsZsh,
  templateOption,
  trustConfigWrite,
  trustKey,
} from '../leak-guard/trust-inputs.js'

// Words as the shell passes them; a word starting with `$` stands for one the guard cannot read.
const args = (...words: string[]): SubArgs => ({
  resolved: words.map(w => (w.startsWith('$') ? undefined : w)),
  written: words.map(w => (w.startsWith('$') ? `"${w}"` : w)),
})

describe('trust-input environment and keys (TP-2376)', () => {
  it('maps shell startup, exec path and template variables to their input', () => {
    expect(['BASH_ENV', 'ENV', 'ZDOTDIR'].map(name => TRUST_ENV.get(name))).toEqual([
      'shellStartup',
      'shellStartup',
      'shellStartup',
    ])
    expect(TRUST_ENV.get('GIT_EXEC_PATH')).toBe('execPath')
    expect(TRUST_ENV.get('GIT_TEMPLATE_DIR')).toBe('templateDir')
    expect(TRUST_ENV.get('PATH')).toBeUndefined()
  })

  it('reads safe.directory and init.templateDir in any case', () => {
    expect(trustKey('safe.directory')).toBe('safeDirectory')
    expect(trustKey('Safe.Directory')).toBe('safeDirectory')
    expect(trustKey('init.templateDir')).toBe('templateDir')
    expect(trustKey('user.name')).toBeUndefined()
  })
})

describe('shell startup, interpreter and zsh prompt names (TP-2854)', () => {
  const shellCode = new RegExp(`^(?:${SHELL_CODE_ENV.join('|')})$`)

  it.each(['PROMPT', 'PROMPT2', 'PROMPT_COMMAND', 'PROMPT_EOL_MARK', 'RPROMPT', 'RPROMPT2', 'PS1', 'RPS1'])(
    'takes %s as a prompt the shell expands',
    name => expect(shellCode.test(name)).toBe(true),
  )

  it.each(['PROMPTS', 'RPROMPTX', 'MY_PROMPT', 'prompt'])('takes %s for no shell prompt', name =>
    expect(shellCode.test(name)).toBe(false),
  )

  it.each(['zsh -ic x', '/bin/zsh -c x', '$SHELL -ic x', '${SHELL} -i'])('sees zsh run in %s', line =>
    expect(runsZsh(line)).toBe(true),
  )

  it.each(['bash -ic x', 'oh-my-zsh-update', 'echo zshrc', 'git status'])('sees no zsh run in %s', line =>
    expect(runsZsh(line)).toBe(false),
  )

  it('lists the interpreter startup names and leaves the accepted gaps out', () => {
    expect(INTERPRETER_CODE_ENV).toEqual(['PERL5OPT', 'PERL5DB', 'RUBYOPT', 'PYTHONSTARTUP'])
    expect(INTERPRETER_CODE_ENV).not.toContain('NODE_OPTIONS')
    expect(INTERPRETER_CODE_ENV).not.toContain('PYTHONPATH')
    expect(ZSH_IMPORTED_PROMPT_ENV).toEqual(['prompt'])
  })

  it('counts only programs that cannot assign a named variable as name-free', () => {
    expect([...NAME_FREE_PROGRAMS].sort()).toEqual(['echo', 'egrep', 'fgrep', 'grep', 'rg'])
    expect(NAME_FREE_PROGRAMS.has('printf')).toBe(false)
    expect(NAME_FREE_PROGRAMS.has('print')).toBe(false)
  })
})

describe('git config writes to a trust key (TP-2376)', () => {
  it.each([
    [['--global', 'safe.directory', '*'], 'safeDirectory'],
    [['--global', '--add', 'safe.directory', '/x'], 'safeDirectory'],
    [['set', '--global', '--append', 'safe.directory', '/x'], 'safeDirectory'],
    [['--file', 'f', 'init.templateDir', '/t'], 'templateDir'],
    // Legacy grammar stops options at the first positional, so this `--unset` is a value pattern.
    [['safe.directory', '/x', '--unset'], 'safeDirectory'],
    [['rename-section', 'foo', 'safe'], 'safeDirectory'],
    [['rename-section', 'foo', 'init'], 'templateDir'],
    [['rename-section', 'foo', '$S'], 'option'],
    [['$K', '/x'], 'option'],
    [['--frobnicate', 'safe.directory', '/x'], 'option'],
  ])('git config %j writes %s', (words, expected) => {
    expect(trustConfigWrite(args(...words))).toBe(expected)
  })

  it.each([
    [['--get-all', 'safe.directory']],
    [['--unset-all', 'safe.directory']],
    [['--global', '--unset', 'safe.directory', '/x']],
    [['get', 'safe.directory']],
    [['--list']],
    [['--global', 'user.name', 'x']],
    [['rename-section', 'foo', 'bar']],
  ])('git config %j writes none', words => {
    expect(trustConfigWrite(args(...words))).toBeUndefined()
  })
})

describe('git init and clone --template (TP-2376)', () => {
  it.each([
    ['init', ['--template=/t', 'r']],
    ['init', ['--templ', '/t', 'r']],
    ['init', ['--template', '$T', 'r']],
    ['init', ['--t=/t', 'r']],
    ['clone', ['--template=/t', 'https://github.com/o/r']],
    ['clone', ['--templ=/t', 'https://github.com/o/r']],
  ] as const)('git %s %j takes a template', (sub, words) => {
    expect(templateOption(sub, args(...words))).toBe(true)
  })

  it.each([
    ['init', ['--template=', 'r']],
    ['init', ['--no-template', 'r']],
    ['init', ['r']],
    ['init', ['--template=/t', '-h']],
    ['clone', ['https://github.com/o/r']],
  ] as const)('git %s %j takes none', (sub, words) => {
    expect(templateOption(sub, args(...words))).toBe(false)
  })

  it('reads an ambiguous prefix on clone as an unmatched option', () => {
    expect(templateOption('clone', args('--t=/t', 'https://github.com/o/r'))).toBe('option')
  })

  // git init and clone read options anywhere, so an unread word may be `--template=<dir>`.
  it.each([
    ['init', ['$X', 'r']],
    ['init', ['r', '$X']],
    ['clone', ['https://github.com/o/r', '$D']],
  ] as const)('git %s %j with an unread word before -- is an unmatched option', (sub, words) => {
    expect(templateOption(sub, args(...words))).toBe('option')
  })

  it.each([
    ['init', ['--', '$X']],
    ['init', ['-b', '$B', 'r']],
    ['clone', ['--', 'https://github.com/o/r', '$D']],
  ] as const)('git %s %j with unread words only after -- or as a value takes none', (sub, words) => {
    expect(templateOption(sub, args(...words))).toBe(false)
  })

  it('reads options after a -- that is an option value', () => {
    expect(templateOption('init', args('-b', '--', '--template=/t', 'r'))).toBe(true)
  })
})

describe('git --exec-path (TP-2376)', () => {
  it('sets the exec path only with a value', () => {
    expect(execPathOption('--exec-path=/x')).toBe(true)
    expect(execPathOption('--exec-path=')).toBe(true)
    expect(execPathOption('--exec-path')).toBe(false)
  })
})
