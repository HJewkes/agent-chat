import { describe, expect, it } from 'vitest'
import { findClauses, holdsReplacement, parallelCall, type ParallelCall } from '../leak-guard/run-wrappers.js'
import { LIVE, parseShell, unmark } from '../leak-guard/shell-words.js'

/** The marked words after the program name, as the guard sees them. */
const argv = (line: string): string[] => {
  const cmd = parseShell(line)[0]
  if (cmd === undefined) throw new Error(`no command in ${line}`)
  return cmd.marked.slice(1)
}

const clausesOf = (line: string) =>
  findClauses(argv(line)).clauses.map(c => ({
    action: c.action,
    words: c.words.map(unmark),
    terminator: c.terminator,
  }))

const parallel = (line: string): ParallelCall => {
  const call = parallelCall(argv(line))
  if ('unknownOption' in call) throw new Error(`unknown option at ${call.unknownOption} in ${line}`)
  return call
}

describe('find action clauses (CC-1223)', () => {
  it('reads every clause with its terminator', () => {
    expect(clausesOf(String.raw`find . -name x -exec grep -n a {} \; -execdir sh -c s {} +`)).toEqual([
      { action: '-exec', words: ['grep', '-n', 'a', '{}'], terminator: ';' },
      { action: '-execdir', words: ['sh', '-c', 's', '{}'], terminator: '+' },
    ])
  })

  it('ends a clause at + only right after {}', () => {
    expect(clausesOf(String.raw`find . -exec echo + {} \; -ok git push ';'`)).toEqual([
      { action: '-exec', words: ['echo', '+', '{}'], terminator: ';' },
      { action: '-ok', words: ['git', 'push'], terminator: ';' },
    ])
  })

  it('reads an unterminated clause to the end of the words', () => {
    expect(clausesOf('find . -okdir git push')).toEqual([
      { action: '-okdir', words: ['git', 'push'], terminator: undefined },
    ])
  })

  it('records where the first clause command word sits', () => {
    expect(findClauses(argv(String.raw`find . -exec git push \;`)).clauses[0]?.at).toBe(2)
  })

  it('does not read a test value spelled -exec as an action', () => {
    expect(clausesOf(String.raw`find . -name -exec -exec git push \;`)).toEqual([
      { action: '-exec', words: ['git', 'push'], terminator: ';' },
    ])
  })

  it('finds no clause in a find that only prints', () => {
    expect(findClauses(argv("find . -type f -name '*.ts' -print"))).toEqual({ clauses: [] })
  })

  it.each([
    [String.raw`find . $X git push --no-verify \;`, 1],
    ['find "$D" -print', 0],
    [String.raw`find . -name "$N" -exec true \;`, 2],
  ])('stops at an unreadable word outside a clause: %s', (line, at) => {
    expect(findClauses(argv(line)).hiddenAt).toBe(at)
  })

  it('reads an unquoted {} outside a clause as plain', () => {
    expect(findClauses(argv('find {} -print')).hiddenAt).toBeUndefined()
  })

  it('leaves an unreadable word inside a clause to the caller', () => {
    const call = findClauses(argv(String.raw`find . -exec $CMD {} \;`))
    expect(call.hiddenAt).toBeUndefined()
    expect(call.clauses[0]?.words[0]).toBe(LIVE + '$CMD')
  })

  it('starts reading at from', () => {
    expect(findClauses(['-exec', 'a', ';', '-exec', 'b', ';'], 3).clauses.map(c => c.words)).toEqual([['b']])
  })
})

describe('GNU parallel options, command and inputs (CC-1223)', () => {
  it('reads glued values, a custom replacement string and one literal group', () => {
    const call = parallel('parallel -j4 -I% git push % ::: a b')
    expect(call.command.map(unmark)).toEqual(['git', 'push', '%'])
    expect(call.replaceStrings).toEqual(['%'])
    expect(call.quote).toBe(false)
    expect(call.inputs).toEqual({ kind: 'literal', groups: [['a', 'b']] })
  })

  it('reads separate values, long values and bundled flags', () => {
    const call = parallel('parallel -j 4 --jobs=2 --colsep , -kq --halt now,fail=1 gzip :::+ a ::: b c')
    expect(call.command.map(unmark)).toEqual(['gzip'])
    expect(call.quote).toBe(true)
    expect(call.inputs).toEqual({ kind: 'literal', groups: [['a'], ['b', 'c']] })
  })

  it('reads --quote and the --*replace options', () => {
    const call = parallel("parallel --quote --extensionreplace '{e}' --seqreplace=@ echo ::: a")
    expect(call.quote).toBe(true)
    expect(call.replaceStrings).toEqual(['{e}', '@'])
  })

  it('reads the no-command form as inputs alone', () => {
    const call = parallel("parallel -k ::: 'git push --no-verify' ls")
    expect(call.command).toEqual([])
    expect(call.inputs).toEqual({ kind: 'literal', groups: [['git push --no-verify', 'ls']] })
  })

  it('ends options at -- and reads a later -- as an input separator', () => {
    const call = parallel('parallel -- -x git push -- --no-verify')
    expect(call.command.map(unmark)).toEqual(['-x', 'git', 'push'])
    expect(call.inputs).toEqual({ kind: 'literal', groups: [['--no-verify']] })
  })

  it('honours --arg-sep', () => {
    const call = parallel('parallel --arg-sep ,, echo ::: ,, a')
    expect(call.command.map(unmark)).toEqual(['echo', ':::'])
    expect(call.inputs).toEqual({ kind: 'literal', groups: [['a']] })
  })

  it.each([
    'parallel echo',
    'parallel echo :::: list',
    'parallel echo ::: a :::: list',
    'parallel -a list echo',
    'parallel --arg-file=list echo ::: a',
    'parallel echo ::: "$X"',
    'parallel echo ::: *.gz',
  ])('reads inputs it cannot see as unread: %s', line => {
    expect(parallel(line).inputs).toEqual({ kind: 'unread' })
  })

  it.each([
    ['parallel --qu git push ::: a', 0],
    ['parallel -quote git push ::: a', 0],
    ["parallel --rpl '{a} s/a/b/' git push {a} ::: x", 0],
    ['parallel --shebang-wrap git', 0],
    ['parallel --sqlmaster x git', 0],
    ['parallel --retry-failed git', 0],
    ['parallel -J prof git push ::: a', 0],
    ['parallel --profile prof git push ::: a', 0],
    ['parallel -k "$OPT" git push ::: a', 1],
    ['parallel -I "$R" git push ::: a', 0],
    ['parallel -j', 0],
    ['parallel "$CMD" ::: a', 0],
    ['parallel --unknown-flag gzip ::: a', 0],
  ])('refuses an option it cannot read: %s', (line, at) => {
    expect(parallelCall(argv(line))).toEqual({ unknownOption: at })
  })

  it('reads a value it cannot see when the value decides nothing', () => {
    expect(parallel('parallel -j "$N" gzip ::: a').command.map(unmark)).toEqual(['gzip'])
  })
})

describe('parallel replacement strings (CC-1223)', () => {
  it.each(['x{}y', '{1.}', '{2/.}', '{= s/a/b/ =}', LIVE + '{}', '{#}'])('holds one: %s', word => {
    expect(holdsReplacement(word)).toBe(true)
  })

  it.each(['{', 'a}b', '{ a }', 'plain'])('holds none: %s', word => {
    expect(holdsReplacement(word)).toBe(false)
  })

  it('holds a custom string', () => {
    expect(holdsReplacement('push%', ['%'])).toBe(true)
    expect(holdsReplacement('push', ['%'])).toBe(false)
  })
})
