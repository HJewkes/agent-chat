import { describe, expect, it } from 'vitest'
import { dropPrivilegeOptions } from '../leak-guard/privilege-wrappers.js'
import { LIVE } from '../leak-guard/shell-words.js'

/** Parses `words` as the wrapper in words[0] would, its options starting at words[1]. */
const run = (...words: string[]) => dropPrivilegeOptions(words[0] as string, words, 1)

/** A word the shell expands, as the guard marks it. */
const live = (text: string) => text.replace('$', `${LIVE}$`)

describe('doas', () => {
  it.each([
    [['doas', '-u', 'root', 'git', 'push'], 3],
    [['doas', '-uroot', 'git'], 2],
    [['doas', '-n', '--', 'git'], 3],
    [['doas', '-nu', 'root', 'git'], 3],
    [['doas', '-C', '/etc/doas.conf', 'git'], 3],
    [['doas', 'git', 'push'], 1],
  ])('finds the command in %j at %i', (words, at) => {
    expect(run(...words)).toEqual({ at })
  })

  it('runs a shell for -s', () => {
    expect(run('doas', '-s')).toEqual({ shell: ['sh'] })
    expect(run('doas', '-u', 'root', '-s', 'git', 'push')).toEqual({ shell: ['sh', '-c', 'git push'] })
  })
})

describe('run0', () => {
  it.each([
    ['-u', 'root'],
    ['--user=root'],
    ['--user', 'root'],
    ['-D', '/tmp'],
    ['--setenv=A=1'],
    ['--no-ask-password'],
    ['-g', 'wheel', '--property', 'A=b'],
  ])('lands on the command after %j', (...options) => {
    expect(run('run0', ...options, 'git', 'push')).toEqual({ at: options.length + 1 })
  })

  it('runs a shell for -i and --via-shell', () => {
    expect(run('run0', '-i', 'git', 'push')).toEqual({ shell: ['sh', '-c', 'git push'] })
    expect(run('run0', '--via-shell')).toEqual({ shell: ['sh'] })
    expect(run('run0', '--via-shell', 'echo', 'a b')).toEqual({ shell: ['sh', '-c', 'echo a\\ b'] })
  })
})

describe('pkexec', () => {
  it('lands on the command after its long options', () => {
    expect(run('pkexec', '--user', 'root', 'git', 'push')).toEqual({ at: 3 })
    expect(run('pkexec', '--keep-cwd', '--disable-internal-agent', 'git')).toEqual({ at: 3 })
  })

  it('fails closed on a short or glued option', () => {
    expect(run('pkexec', '-u', 'root', 'git')).toBeUndefined()
    expect(run('pkexec', '--user=root', 'git')).toBeUndefined()
  })
})

describe('su', () => {
  it.each([
    [['su', '-c', 'git push']],
    [['su', 'root', '-c', 'git push']],
    [['su', '-', 'root', '--command=git push']],
    [['su', '-l', 'root', '--command', 'git push']],
    [['su', '--session-command', 'git push', 'root']],
    [['su', '-lcgit push']],
    [['su', '-s', '/bin/bash', 'root', '-c', 'git push']],
  ])('runs the -c value in %j', words => {
    expect(run(...words)).toEqual({ shell: ['sh', '-c', 'git push'] })
  })

  it('passes words after the user to the shell', () => {
    expect(run('su', 'root', '-c', 'x', 'extra')).toEqual({ shell: ['sh', '-c', 'x', 'extra'] })
    expect(run('su', 'root', 'script.sh', 'a')).toEqual({ shell: ['sh', 'script.sh', 'a'] })
    expect(run('su', 'root', '--', '-c', 'x')).toEqual({ shell: ['sh', '-c', 'x'] })
  })

  it('runs a bare shell with no command', () => {
    expect(run('su')).toEqual({ shell: ['sh'] })
    expect(run('su', 'root')).toEqual({ shell: ['sh'] })
    expect(run('su', '-', 'root')).toEqual({ shell: ['sh'] })
  })

  it('keeps an expanded -c value for the caller to judge', () => {
    expect(run('su', '-c', live('$CMD'))).toEqual({ shell: ['sh', '-c', live('$CMD')] })
  })

  it('fails closed when -s names a program that is not a shell', () => {
    expect(run('su', '-s', '/usr/bin/git', 'root', '-c', 'push')).toBeUndefined()
    expect(run('su', '--shell=git', '-c', 'push')).toBeUndefined()
    expect(run('su', '-s', live('$SH'), '-c', 'push')).toBeUndefined()
  })

  it('fails closed on an expanded word anywhere, since su reads options past the user', () => {
    expect(run('su', live('$U'), '-c', 'ls')).toBeUndefined()
  })
})

describe('fail closed', () => {
  it.each([
    [['doas', '-X', 'git']],
    [['doas', '--user', 'root', 'git']],
    [['run0', '--frob', 'git']],
    [['run0', '--pty=1', 'git']],
    [['run0', live('--user=$u'), 'git']],
    [['pkexec', '--frob', 'git']],
    [['su', '--frob', '-c', 'git push']],
    [['su', '-X']],
    [['su', live('-$o')]],
    [['su', '-c']],
    [['su', '--login=x']],
    [['ls', 'git']],
  ])('%j is undefined', words => {
    expect(run(...words)).toBeUndefined()
  })
})
