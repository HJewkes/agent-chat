import { describe, expect, it } from 'vitest'
import { findClauses, holdsReplacement, parallelCall, type ParallelCall } from '../leak-guard/run-wrappers.js'
import { LIVE, parseShell, unmark } from '../leak-guard/shell-words.js'

const parsed = (line: string) => {
  const cmd = parseShell(line)[0]
  if (cmd === undefined) throw new Error(`no command in ${line}`)
  return cmd
}

/** The marked words after the program name, as the guard sees them. */
const argv = (line: string): string[] => parsed(line).marked.slice(1)

const parallelOf = (line: string) => parallelCall(argv(line), parsed(line).splits)

const clausesOf = (line: string) =>
  findClauses(argv(line)).clauses.map(c => ({
    action: c.action,
    words: c.words.map(unmark),
    terminator: c.terminator,
  }))

const parallel = (line: string): ParallelCall => {
  const call = parallelOf(line)
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

  it('ends an -ok or -okdir clause only at ;, since find reads + there as a word', () => {
    expect(clausesOf(String.raw`find d -ok echo A {} + B \;`)).toEqual([
      { action: '-ok', words: ['echo', 'A', '{}', '+', 'B'], terminator: ';' },
    ])
    expect(clausesOf(String.raw`find . -okdir sh -c 'shift; "$@"' {} + git push --force \;`)).toEqual([
      {
        action: '-okdir',
        words: ['sh', '-c', 'shift; "$@"', '{}', '+', 'git', 'push', '--force'],
        terminator: ';',
      },
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

  it('skips both -fprintf values', () => {
    expect(clausesOf(String.raw`find . -fprintf out -exec -exec tool \;`)).toEqual([
      { action: '-exec', words: ['tool'], terminator: ';' },
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

  it('keeps a + after an unreadable word inside the clause, for the caller to deny', () => {
    const call = findClauses(argv(String.raw`find . -exec tool $X + -exec git push \;`))
    expect(call.clauses).toHaveLength(1)
    expect(call.clauses[0]?.words.map(unmark)).toEqual(['tool', '$X', '+', '-exec', 'git', 'push'])
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
    const call = parallel('parallel -j 4 --jobs=2 -kq --halt now,fail=1 gzip :::+ a ::: b c')
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
    ['parallel -j $N main ::: x', 0],
    ['parallel -j$N main ::: x', 0],
    ['parallel --jobs=$N main ::: x', 0],
    ['parallel -k --tagstring $T main ::: x', 1],
    ['parallel env -- tool sub ::: x', 1],
    ['parallel -k tool sub -- --flag', 3],
    ['parallel -S host tool ::: x', 0],
    ['parallel -kS host tool ::: x', 0],
    ["parallel --sshlogin 'wrap -c tool host' main ::: x", 0],
    ['parallel --sshlogin=host main ::: x', 0],
    ["parallel --tagstring '{= qx(tool) =}' main ::: x", 0],
    ["parallel echo '{= qx(tool) =}' ::: x", 1],
    ['parallel -- -x tool sub ::: -- y', 0],
    ["parallel -- ls 'tool sub --flag'", 0],
    ['parallel tool ::: -- y', 2],
    ['parallel -X tool ::: sub --flag', 0],
    ['parallel -m tool ::: sub --flag', 0],
    ['parallel --xargs tool ::: sub --flag', 0],
    ['parallel -n2 tool ::: sub --flag', 0],
    ['parallel -N2 {1} {2} ::: tool sub', 0],
    ['parallel -L 2 tool ::: sub --flag', 0],
    ['parallel --max-args=2 tool ::: sub --flag', 0],
    ['parallel --max-replace-args 2 {1} {2} ::: tool sub', 0],
    ['parallel --max-lines=2 tool ::: sub --flag', 0],
    ['parallel -C , {1} {2} ::: tool,sub', 0],
    ['parallel --colsep , {1} {2} ::: tool,sub', 0],
    ['parallel -kX tool ::: sub --flag', 0],
    ['parallel --frobnicate tool ::: x', 0],
    ["parallel --plus tool '{/a b/sub}' ::: 'a b'", 0],
    ['parallel -k --tagstring "$T" tool ::: x', 1],
    ['parallel --results "$R" tool ::: x', 0],
    ['parallel --joblog="$J" tool ::: x', 0],
    ['parallel --arg-sep AA --arg-sep BB tool BB x', 2],
    ['parallel --arg-file-sep AA --arg-file-sep BB tool ::: x', 2],
    ['parallel --arg-sep -k -k tool sub -k x', 0],
    ["parallel --arg-sep '' tool ::: x", 0],
    ['parallel -I % -I @ tool @ ::: x', 2],
    ['parallel --quote=x tool ::: a', 0],
  ])('refuses an option it cannot read: %s', (line, at) => {
    expect(parallelOf(line)).toEqual({ unknownOption: at })
  })

  it('reads literal evaluated values and a repeated inert option', () => {
    const call = parallel("parallel -j 2 -j 4 --tagstring '{}:' --results out tool ::: x")
    expect(call.command.map(unmark)).toEqual(['tool'])
    expect(call.inputs).toEqual({ kind: 'literal', groups: [['x']] })
  })

  it.each([
    'parallel --memfree 1G --delay 0.5 --timeout 10s --load 80% tool ::: x',
    'parallel -j 100% -P +2 --retries 3 --nice -5 --timeout 200% tool ::: x',
    "parallel --memfree '512m' --delay 2 --halt soon,fail=10% tool ::: x",
  ])('reads numeric values that match their grammar: %s', line => {
    expect(parallel(line).command.map(unmark)).toEqual(['tool'])
  })

  it.each(['memfree', 'delay', 'timeout', 'load', 'jobs', 'max-procs', 'halt', 'retries', 'nice'])(
    'refuses a perl payload or an expansion as --%s',
    name => {
      const payload = String.raw`"qx(\164\157\157\154)"`
      expect(parallelOf(`parallel --${name} ${payload} echo ::: x`)).toEqual({ unknownOption: 0 })
      expect(parallelOf(`parallel --${name}='qx(tool)' echo ::: x`)).toEqual({ unknownOption: 0 })
      expect(parallelOf(`parallel --${name} "$X" echo ::: x`)).toEqual({ unknownOption: 0 })
    },
  )

  it.each([
    'parallel -j "$N" tool ::: x',
    'parallel -j4x tool ::: x',
    'parallel -P ./procs tool ::: x',
    'parallel --memfree 1G+1 tool ::: x',
    'parallel --delay 1s2 tool ::: x',
    'parallel --timeout 1e3 tool ::: x',
    "parallel --delay ' 1' tool ::: x",
  ])('refuses a numeric value off its grammar: %s', line => {
    expect(parallelOf(line)).toHaveProperty('unknownOption')
  })

  it.each<[string, number]>([
    [`parallel --arg-file-sep '{}' sh -c ::: 'eval "$0"' {} cmds.txt`, 0],
    ["parallel --arg-sep '{}' {} 'tool sub --flag'", 0],
    ...['{}', '{.}', '{/}', '{#}', '{1}'].flatMap((rs): [string, number][] => [
      [`parallel --arg-sep '${rs}' ${rs} 'tool sub'`, 0],
      [`parallel --arg-sep "${rs}" tool ::: x`, 0],
      [`parallel --arg-file-sep=${rs.replace('{', '\\{').replace('}', '\\}')} tool ::: x`, 0],
      [`parallel -k --arg-file-sep ${rs} tool ::: x`, 1],
    ]),
    ['parallel -I @@ --arg-sep @@ tool @@ x', 2],
    ['parallel --arg-sep @@ -I @@ tool @@ x', 2],
    ['parallel -I ::: tool ::: x', 0],
    ['parallel --arg-sep :::: tool :::: x', 0],
    ['parallel --arg-file-sep ::: tool ::: x', 0],
    ['parallel --arg-sep A --arg-file-sep A+ tool A x', 2],
    ["parallel --arg-sep '*' tool '*' x", 0],
    ["parallel --arg-sep '$S' tool '$S' x", 0],
    ["parallel --arg-sep 'a b' tool 'a b' x", 0],
  ])('refuses a separator it could read differently from parallel: %s', (line, at) => {
    expect(parallelOf(line)).toEqual({ unknownOption: at })
  })

  it.each([
    'parallel --arg-sep AA tool AA x',
    'parallel --arg-sep AA tool "AA" x',
    "parallel --arg-sep AA tool A'A' x",
  ])('matches a separator after quote removal: %s', line => {
    const call = parallel(line)
    expect(call.command.map(unmark)).toEqual(['tool'])
    expect(call.inputs).toEqual({ kind: 'literal', groups: [['x']] })
  })

  it('reads a quoted file separator as unread inputs', () => {
    expect(parallel("parallel --arg-file-sep FF tool ::: x 'F'F list").inputs).toEqual({ kind: 'unread' })
  })

  it.each([
    "parallel -a 'tool|' echo",
    "parallel --joblog '>out' echo ::: x",
    "parallel --results 'a|b' echo ::: x",
  ])('refuses a path perl may open as a command: %s', line => {
    expect(parallelOf(line)).toHaveProperty('unknownOption')
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
