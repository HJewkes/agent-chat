import { describe, expect, it } from 'vitest'
import { ghConfigProgram } from '../leak-guard/gh-config.js'

const PUSH = 'git push --no-verify'

describe('gh config set writes a value gh runs as a program (TP-2533)', () => {
  it.each(['pager', 'editor', 'browser'])('reads the %s value as a program', key => {
    expect(ghConfigProgram([key, PUSH])).toEqual({ kind: 'program', value: PUSH })
  })

  it.each([
    [['-h', 'github.com', 'editor', 'x']],
    [['--host', 'github.com', 'editor', 'x']],
    [['--host=github.com', 'editor', 'x']],
    [['-hgithub.com', 'editor', 'x']],
    [['editor', '-h', 'github.com', 'x']],
    [['--', 'editor', 'x']],
  ])('reads the key past host flags and -- in %j', rest => {
    expect(ghConfigProgram(rest)).toEqual({ kind: 'program', value: 'x' })
  })

  it('reads a mixed-case key as a program key', () => {
    expect(ghConfigProgram(['PAGER', 'x'])).toEqual({ kind: 'program', value: 'x' })
  })

  it('reads a dash-led value after -- as the value', () => {
    expect(ghConfigProgram(['pager', '--', '-x'])).toEqual({ kind: 'program', value: '-x' })
  })
})

describe('gh config set the guard cannot read', () => {
  it.each([
    [[undefined, 'x']],
    [['pager', undefined]],
    [[undefined]],
    [['--weird', 'pager', 'x']],
    [['-x', 'pager', 'x']],
    [[undefined, '--help', 'pager', 'x']],
    [['-h', undefined, 'x']],
    [['-h', undefined]],
    [['--host', undefined, 'git push --no-verify']],
    [['-h', undefined, 'git_protocol', 'x']],
  ])('reads %j as unread', rest => {
    expect(ghConfigProgram(rest)).toEqual({ kind: 'unread' })
  })

  it.each([
    [['-h', undefined, 'pager', 'x'], 'x'],
    [['--host', undefined, '--host', 'editor', 'pager', PUSH], PUSH],
    [['--host', undefined, '-h', 'pager', 'editor', 'vim'], 'vim'],
    [['-h', 'a', '--host', undefined, '-h', 'b', 'pager', 'x'], 'x'],
  ])('keeps a program write past an unresolved host in %j', (rest, value) => {
    expect(ghConfigProgram(rest)).toEqual({ kind: 'program', value })
  })

  it('reads a later host flag past an unresolved host as taking its own word', () => {
    expect(ghConfigProgram(['-h', undefined, '-h', 'editor', 'git_protocol', 'x'])).toEqual({
      kind: 'unread',
    })
  })
})

describe('gh config set that writes no program key', () => {
  it.each([
    [['git_protocol', 'ssh']],
    [['prompt', 'disabled']],
    [['git_protocol', undefined]],
    [['-h', 'pager', 'git_protocol', 'ssh']],
    [['-h', 'a', '--host', 'pager', 'git_protocol', 'ssh']],
    [['--help', 'pager', 'x']],
    [['pager', 'x', '--help']],
    [['pager']],
    [['--host']],
    [[]],
  ])('reads %j as no program write', rest => {
    expect(ghConfigProgram(rest)).toBeUndefined()
  })
})
