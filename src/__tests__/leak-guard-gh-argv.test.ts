import { describe, expect, it } from 'vitest'
import { ghCommand, mayWrite, parseGhApi } from '../leak-guard/gh-argv.js'

const words = (line: string): string[] => line.split(' ')

describe('parseGhApi reads flags the way pflag does', () => {
  it('pairs a value flag with the next word even when it starts with a dash', () => {
    expect(parseGhApi(words('-X PUT repos/o/r/pulls/5/merge -p -XGET'))).toEqual({
      flags: [
        ['-X', 'PUT'],
        ['-p', '-XGET'],
      ],
      positionals: ['repos/o/r/pulls/5/merge'],
    })
  })

  it('splits a short cluster until a value letter, which takes the rest of the word', () => {
    expect(parseGhApi(['-iXPUT', 'e'])).toEqual({
      flags: [
        ['-i', ''],
        ['-X', 'PUT'],
      ],
      positionals: ['e'],
    })
    expect(parseGhApi(['-ifk=v', 'e'])).toEqual({
      flags: [
        ['-i', ''],
        ['-f', 'k=v'],
      ],
      positionals: ['e'],
    })
  })

  it('gives a value letter at the end of a cluster the next word', () => {
    expect(parseGhApi(words('-iX PUT e'))).toEqual({
      flags: [
        ['-i', ''],
        ['-X', 'PUT'],
      ],
      positionals: ['e'],
    })
  })

  it('reads --method=PUT as one flag with its value', () => {
    expect(parseGhApi(['--method=PUT', 'e'])).toEqual({ flags: [['--method', 'PUT']], positionals: ['e'] })
  })

  it('reads every word after -- as a positional', () => {
    expect(parseGhApi(words('--paginate -- e -X'))).toEqual({
      flags: [['--paginate', '']],
      positionals: ['e', '-X'],
    })
  })

  it.each([
    ['--bogus', 'e'],
    ['-Z', 'e'],
    ['-iZ', 'e'],
    ['e', '-X'],
  ])('is unknown-flag for an argv gh api would reject: %s %s', (...argv) => {
    expect(parseGhApi(argv)).toBe('unknown-flag')
  })

  it('is unresolved when any word is unresolved', () => {
    expect(parseGhApi(['-X', 'GET', undefined])).toBe('unresolved')
  })
})

describe('ghCommand finds the group and verb the way cobra does', () => {
  it('finds the group past a root -R flag', () => {
    expect(ghCommand(words('-R o/r pr view 5'))).toEqual({ group: 'pr', verb: 'view', rest: ['5'] })
  })

  it('finds the verb past -R between group and verb', () => {
    expect(ghCommand(words('pr --repo o/r merge 5'))).toMatchObject({ group: 'pr', verb: 'merge' })
  })

  it('hands api every other word, root flags included', () => {
    expect(ghCommand(words('-X PUT api e'))).toEqual({
      group: 'api',
      verb: undefined,
      rest: ['-X', 'PUT', 'e'],
    })
  })

  it.each(['-X PUT pr view', '-- pr merge 5', '--bogus pr view'])(
    'is unknown-flag for a root flag gh does not take: gh %s',
    line => {
      expect(ghCommand(words(line))).toBe('unknown-flag')
    },
  )

  it('is unresolved when the group or verb is unresolved', () => {
    expect(ghCommand(['pr', undefined, '5'])).toBe('unresolved')
    expect(ghCommand([undefined, 'merge', '5'])).toBe('unresolved')
    expect(ghCommand(['-R', undefined, 'pr', 'view'])).toBe('unresolved')
  })

  it('keeps an unresolved word after the verb, which cannot change the command', () => {
    expect(ghCommand(['pr', 'view', undefined])).toEqual({ group: 'pr', verb: 'view', rest: [undefined] })
  })
})

describe('mayWrite flags any word that looks like a write', () => {
  it.each([
    ['-XGET', false],
    ['-XHEAD', false],
    ['-iXget', false],
    ['--method=GET', false],
    ['-X', false],
    ['--method', false],
    ['repos/o/r', false],
    ['.check_runs[]|.name', false],
    ['-XPUT', true],
    ['-iXPUT', true],
    ['--method=PUT', true],
    ['--jq=-XPUT', true],
    ['-f', true],
    ['-fk=v', true],
    ['-if', true],
    ['-F', true],
    ['--field', true],
    ['--raw-field=k=v', true],
    ['--input', true],
    ['X-HTTP-Method-Override: PUT', true],
    ['X-Override: 1', true],
  ])('%s on its own is %s', (word, expected) => {
    expect(mayWrite([word])).toBe(expected)
  })
})
