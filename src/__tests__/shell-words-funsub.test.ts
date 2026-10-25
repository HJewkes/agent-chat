import { describe, expect, it } from 'vitest'
import { expansionRisk, parseShell, type SimpleCommand } from '../leak-guard/shell-words.js'

// bash 5.3 runs `${ cmd;}` and `${|cmd;}` in the current shell (CC-1327).
const find = (src: string, head: string): SimpleCommand | undefined =>
  parseShell(src).find(cmd => cmd.words[0] === head)

describe('bash 5.3 funsub bodies read as commands', () => {
  it.each([
    'echo ${ git push --no-verify;}',
    'echo ${|git push --no-verify;}',
    'echo "${ git push --no-verify;}"',
    'echo "${|git push --no-verify;}"',
    'echo ${\tgit push --no-verify;}',
    'echo ${\ngit push --no-verify;}',
    'x=${ git push --no-verify;}',
    'echo ${ git push --no-verify;}x',
    'echo $(echo ${ git push --no-verify;})',
  ])('%j holds the push as a nested command', src => {
    const push = find(src, 'git')

    expect(push?.words).toEqual(['git', 'push', '--no-verify'])
    expect(push?.nested).toBe(true)
    expect(expansionRisk(src)).toBeUndefined()
  })

  it('closes only at a } in command position, and a bare } argument is unreadable', () => {
    const src = 'echo ${ echo }; git push --no-verify; }'

    expect(find(src, 'echo')?.words).toEqual(['echo', '}'])
    expect(find(src, 'git')?.words).toEqual(['git', 'push', '--no-verify'])
    expect(expansionRisk(src)).toBe('unreadable')
  })

  it('counts a nested { } group before closing', () => {
    const src = 'echo ${ { git status; }; git push --no-verify; }'

    expect(find(src, '{')?.words).toEqual(['{', 'git', 'status'])
    expect(find(src, 'git')?.words).toEqual(['git', 'push', '--no-verify'])
    expect(expansionRisk(src)).toBeUndefined()
  })

  // bash 5.3.9 runs the push in each of these; a missed `{` closed the funsub at the group's `}`.
  it.each([
    'echo "${ if true; then { :; }; fi; git push --no-verify; }"',
    'echo "${ until false; do { :; }; break; done; git push --no-verify; }"',
    'echo "${ while true; do { :; }; break; done; git push --no-verify; }"',
    'echo "${ if false; then :; else { :; }; fi; git push --no-verify; }"',
    'echo "${ if false; then :; elif { :; }; then :; fi; git push --no-verify; }"',
    'echo "${ if { :; }; then :; fi; git push --no-verify; }"',
    'echo "${ ! { :; }; git push --no-verify; }"',
    'echo "${ time { :; }; git push --no-verify; }"',
    'echo "${ time -p { :; }; git push --no-verify; }"',
    'echo "${ coproc { :; }; git push --no-verify; }"',
    'echo "${ coproc N { :; }; git push --no-verify; }"',
    'echo "${ { { :; }; }; git push --no-verify; }"',
    'echo "${|if true; then { :; }; fi; git push --no-verify; }"',
    'echo ${ if true; then { :; }; fi; git push --no-verify; }',
    'echo "${ case x in\n}) ;; esac; git push --no-verify; }"',
    'echo "${ case x in\n(}) ;; esac; git push --no-verify; }"',
  ])('%j reads the group and closes only at the last }', src => {
    const push = find(src, 'git')

    expect(push?.words).toEqual(['git', 'push', '--no-verify'])
    expect(push?.nested).toBe(true)
    expect(expansionRisk(src)).toBeUndefined()
  })

  // bash 5.3.9 closes at `;}` and runs the push; counting the `{` argument read on into the outer quote.
  it.each([
    'echo "${ echo { ;} #"; git push --no-verify\n}"',
    'echo "${|echo { ;} #"; git push --no-verify\n}"',
    'x="${ echo { ;} #"; git push --no-verify\n}"',
    'printf "${ echo { ;} #"; git push --no-verify\n}"',
    'echo "${ echo { ;} \'"; git push --no-verify; : "\'\n}"',
    'echo "${ "then" { ;} #"; git push --no-verify\n}"',
    'echo "${ x=1 { ;} #"; git push --no-verify\n}"',
  ])('%j has a { argument, so it is unreadable', src => {
    expect(expansionRisk(src)).toBe('unreadable')
  })

  // bash 5.3.9 opens a group at a `{` before any metacharacter, so its `}` is not the close.
  it.each([
    'echo "${ {(:); }; git push --no-verify; }"',
    'echo "${ if true; then {(:); }; fi; git push --no-verify; }"',
    'echo "${ ! {(:); }; git push --no-verify; }"',
    'echo "${ time {(:); }; git push --no-verify; }"',
    'echo "${ f() {(:); }; git push --no-verify; }"',
    'echo "${ for ((;;)) {(:); break; }; git push --no-verify; }"',
    'echo "${ case x in (x) {(:); };; esac; git push --no-verify; }"',
    'echo "${ true && {(:); }; git push --no-verify; }"',
    'echo "${ { {(:); }; }; git push --no-verify; }"',
    'echo "${ coproc echo {(:); }; git push --no-verify; }"',
    'echo "${ {<>/dev/null :; }; git push --no-verify; }"',
    'echo "${|{(:); }; git push --no-verify; }"',
  ])('%j reads the push past a { before a metacharacter', src => {
    const push = find(src, 'git')

    expect(push?.words).toEqual(['git', 'push', '--no-verify'])
    expect(push?.nested).toBe(true)
  })

  // bash 5.3.9 reads CR, VT, FF, NBSP and U+2028 as word characters, so `{` before one is no group.
  it.each(['\r', '\v', '\f', ' ', ' '].flatMap(ch => ['${ ', '${|'].map(open => [open, ch])))(
    '%j{%j;} closes where bash does, so the push after it is a command',
    (open, ch) => {
      const src = `echo "${open}{${ch};} #"; git push --no-verify\n}"`

      const push = find(src, 'git')

      expect(push?.words).toEqual(['git', 'push', '--no-verify'])
      expect(push?.nested).toBe(false)
    },
  )

  // bash 5.3.9 reads a `{` or `}` after a redirect operator as the file name, so it neither opens nor closes.
  it.each([
    'echo "${ >} ; git push --no-verify ;}"',
    'echo ${ >} ; git push --no-verify ;}',
    'echo "${ 2>} ; git push --no-verify ;}"',
    'echo "${|>} ; git push --no-verify ;}"',
    'echo "${ <<<} ; git push --no-verify ;}"',
    'echo "${ >>} ; git push --no-verify ;}"',
  ])('%j reads the } file name and the push inside the funsub', src => {
    const push = find(src, 'git')

    expect(push?.words).toEqual(['git', 'push', '--no-verify'])
    expect(push?.nested).toBe(true)
  })

  it.each([
    'echo "${ >{ ;} #"; git push --no-verify\n}"',
    'echo "${ 2>{ ;} #"; git push --no-verify\n}"',
    'echo "${|>{ ;} #"; git push --no-verify\n}"',
  ])('%j reads the { file name and closes where bash does', src => {
    const push = find(src, 'git')

    expect(push?.words).toEqual(['git', 'push', '--no-verify'])
    expect(push?.nested).toBe(false)
  })

  // bash 5.3.9 reads a brace inside `(( ))`, an array or `[[ ( ) ]]` as text, not as a group or the close.
  it.each([
    'echo "${ (( { )) ;} #"; git push --no-verify\n}"',
    'echo "${ a=( { ) ;} #"; git push --no-verify\n}"',
    'echo "${ a=(\n{ ) ;} #"; git push --no-verify\n}"',
    'echo "${ [[ ( { ) ]] ;} #"; git push --no-verify\n}"',
    'echo "${ (( } )) ; git push --no-verify ;}"',
    'echo "${ a=( } ) ; git push --no-verify ;}"',
    'echo "${ declare -a a=( } ) ; git push --no-verify ;}"',
    'echo "${ [[ ( } ) ]] ; git push --no-verify ;}"',
    'echo "${ ((\n} )) ; git push --no-verify ;}"',
  ])('%j has a brace inside a ( that is no subshell, so it is unreadable', src => {
    expect(expansionRisk(src)).toBe('unreadable')
  })

  it.each([
    'echo "${ ( { :; } ); git push --no-verify; }"',
    'echo "${ if ( true ); then { :; }; fi; git push --no-verify; }"',
    'echo "${ f() { :; }; git push --no-verify; }"',
  ])('%j keeps reading a group inside or after a subshell', src => {
    const push = find(src, 'git')

    expect(push?.words).toEqual(['git', 'push', '--no-verify'])
    expect(expansionRisk(src)).toBeUndefined()
  })

  // bash 5.3.9 starts no command at a newline or && in `[[ ]]`, after an array's `)`, or at `(\<newline>(`.
  it.each(
    [
      '[[ x &&\n( {  ) ]] ;} #"; git push --no-verify\n}"',
      '[[\n( } )\n]] ; git push --no-verify ;}"',
      '[[ x ||\n} ]] ; git push --no-verify ;}"',
      '[[\n} ]] ; git push --no-verify ;}"',
      'a=( x ) { ;} #"; git push --no-verify\n}"',
      'a=( x ) } ; git push --no-verify ;}"',
      'a=() } ; git push --no-verify ;}"',
      'a=(x) b=(y) } ; git push --no-verify ;}"',
      '(\\\n({  )) ;} #"; git push --no-verify\n}"',
      '(\\\n( } )) ; git push --no-verify ;}"',
    ].flatMap(body => ['${ ', '${|'].map(open => `echo "${open}${body}`)),
  )('%j has a brace where bash starts no command, so it is unreadable', src => {
    expect(expansionRisk(src)).toBe('unreadable')
  })

  it.each(['${ ', '${|'])('%j{\\<newline> opens a group, so the push stays inside', open => {
    const src = `echo "${open}{\\\n :; }; git push --no-verify; }"`

    expect(find(src, 'git')?.nested).toBe(true)
    expect(expansionRisk(src)).toBeUndefined()
  })

  // bash 5.3.9 reads `&>` and `&>>` as a redirect, so the command goes on and a brace after it is an argument.
  it.each(
    [
      'echo a &>/dev/null } ; git push --no-verify ;}"',
      'echo a &>/dev/null { ;} #"; git push --no-verify\n}"',
      'echo a&>f } ; git push --no-verify ;}"',
      'echo a &>>f } ; git push --no-verify ;}"',
      'echo a 2&>f } ; git push --no-verify ;}"',
      'echo a &> f } ; git push --no-verify ;}"',
      ': &>f } ; git push --no-verify ;}"',
      'cat &>f <<<x } ; git push --no-verify ;}"',
      'echo a &>f &>g } ; git push --no-verify ;}"',
      'echo a&>f { ;} #"; git push --no-verify\n}"',
      'echo a &>>f { ;} #"; git push --no-verify\n}"',
    ].flatMap(body => ['${ ', '${|'].map(open => `echo "${open}${body}`)),
  )('%j has a brace after &>, so it is unreadable', src => {
    expect(expansionRisk(src)).toBe('unreadable')
  })

  it.each(['${ ', '${|'])(
    '%j a trailing & still ends the command, so the brace after it is reserved',
    open => {
      const grouped = `echo "${open}{ :& } ; git push --no-verify ;}"`
      const closed = `echo "${open}: & } #"; git push --no-verify\n}"`

      expect(find(grouped, 'git')?.nested).toBe(true)
      expect(expansionRisk(grouped)).toBeUndefined()
      expect(find(closed, 'git')?.nested).toBe(false)
      expect(expansionRisk(closed)).toBeUndefined()
    },
  )

  it('records &> and &>> as writes of the command they follow', () => {
    const [cmd] = parseShell('echo a &>f 2&>>g')

    expect(cmd?.words).toEqual(['echo', 'a', '2'])
    expect(cmd?.writes).toEqual(['f', 'g'])
  })

  // bash 5.3.9 removes \<newline> before it reads `&>`, `;;`, `;&`, `>&` or `>|`.
  it.each(
    [
      'echo a &\\\n>f } ; git push --no-verify ;}"',
      'echo a &\\\n>f { ;} #"; git push --no-verify\n}"',
      'echo a &\\\n>\\\n>f } ; git push --no-verify ;}"',
      'case x in x) :;\\\n; }) ;; esac; git push --no-verify ;}"',
      'case x in x) :;\\\n& }) ;; esac; git push --no-verify ;}"',
      'echo a >\\\n&2 } ; git push --no-verify ;}"',
      'echo a 2>\\\n&1 } ; git push --no-verify ;}"',
      'echo a >\\\n|f } ; git push --no-verify ;}"',
    ].flatMap(body => ['${ ', '${|'].map(open => `echo "${open}${body}`)),
  )('%j joins the operator across \\<newline>, so the push is read as a command', src => {
    expect(find(src, 'git')?.words).toEqual(['git', 'push', '--no-verify'])
  })

  it.each(
    [
      "echo 'a &\\\n>f' ; git push --no-verify ;}\"",
      "cat <<'E'\nx &\\\n>f }\nE\ngit push --no-verify ;}\"",
    ].flatMap(body => ['${ ', '${|'].map(open => `echo "${open}${body}`)),
  )('%j keeps a quoted \\<newline> literal', src => {
    expect(find(src, 'git')?.nested).toBe(true)
    expect(expansionRisk(src)).toBeUndefined()
  })

  // bash 5.3.9 removes \<newline> before it reads a `$` opener too.
  it.each([
    'echo $\\\n{ git push --no-verify;}',
    'echo "$\\\n{ git push --no-verify;}"',
    'x="$\\\n{ git push --no-verify;}"',
    'echo $\\\n\\\n{ git push --no-verify;}',
    'echo "$\\\n(git push --no-verify)"',
    'echo ${\\\n git push --no-verify;}',
    'echo ${\\\n|git push --no-verify;}',
    'echo "$\\\n{|git push --no-verify;}"',
  ])('%j reads the opener across \\<newline>', src => {
    const push = find(src, 'git')

    expect(push?.words).toEqual(['git', 'push', '--no-verify'])
    expect(push?.nested).toBe(true)
  })

  it("decodes $\\<newline>'...' as an ANSI-C quote", () => {
    expect(find("$\\\n'\\x67it' push --no-verify", 'git')?.words).toEqual(['git', 'push', '--no-verify'])
  })

  // bash 5.3.9 closes at a `}` right after fi, done, esac, `}`, `]]`, `))` or a subshell's `)`, even before `"` or x.
  it.each(
    [
      'if :; then :; fi }"',
      'if :; then :; fi }x"',
      '(:) }"',
      '(:) }x"',
      'for a in b; do :; done }x"',
      'case a in a) ;; esac }x"',
      '[[ a ]] }x"',
      '(( 1 )) }x"',
      '{ :; } }x"',
      '{ :; } }"',
      'while false; do :; done }"',
    ].flatMap(body => ['${ ', '${|'].map(open => `echo "${open}${body}; git push --no-verify; #"\n}"`)),
  )('%j closes after the compound command, so the push is a command', src => {
    const push = find(src, 'git')

    expect(push?.words).toEqual(['git', 'push', '--no-verify'])
    expect(push?.nested).toBe(false)
  })

  it.each(['echo ${ a=() }x; git push --no-verify; }', 'echo ${ [[ a &&\n}x ]]; git push --no-verify; }'])(
    '%j has a }-word it cannot place, so it is unreadable',
    src => {
      expect(expansionRisk(src)).toBe('unreadable')
    },
  )

  it.each(['${ ', '${|'])('%j keeps }x after another word a plain argument', open => {
    expect(expansionRisk(`echo "${open}echo a }x; date; }"`)).toBeUndefined()
    expect(expansionRisk(`echo "${open}[[ }x ]]; date; }"`)).toBeUndefined()
  })

  // bash 5.3.9 reads `fi` after an assignment as a command name, so `}x` is its argument.
  it.each(['${ ', '${|'])('%j takes }x after a word that is not reserved for an argument', open => {
    expect(expansionRisk(`echo "${open}x=1 fi }x; date; }"`)).toBeUndefined()
  })

  it.each(['${ ', '${|'])(
    '%j never takes }x after a reserved word that a name follows for an argument',
    open => {
      expect(expansionRisk(`echo "${open}case }x in a) ;; esac; date; }"`)).toBe('unreadable')
    },
  )

  // bash 5.3.9 closes at the `}` after chained compound ends, as reserved_word_acceptable allows.
  it.each(
    [
      'if :; then if :; then :; fi fi }',
      'if :; then [[ a ]] fi }',
      '{ { :; } } }',
      'if :; then (:) fi }',
      'while false; do if :; then :; fi done }',
    ].flatMap(body => ['${ ', '${|'].map(open => `echo "${open}${body}"; git push --no-verify; #"\n}"`)),
  )('%j closes after the chained ends, so the push is a command', src => {
    const push = find(src, 'git')

    expect(push?.words).toEqual(['git', 'push', '--no-verify'])
    expect(push?.nested).toBe(false)
  })

  it.each(['echo ${ git push --no-verify', 'echo ${ a ) ; }'])(
    '%j has no close, so it is unreadable',
    src => {
      expect(expansionRisk(src)).toBe('unreadable')
    },
  )

  it('goes on reading the outer command after the close', () => {
    const src = 'echo ${ date;} tail'

    const commands = parseShell(src)

    expect(commands.map(cmd => cmd.words[0])).toEqual(['date', 'echo'])
    expect(commands[1]?.words).toEqual(['echo', '${ date;}', 'tail'])
    expect(commands[1]?.splits).toHaveLength(1)
    expect(expansionRisk(src)).toBeUndefined()
  })
})

// bash 5.3.9 reads a quoted or escaped reserved word as a plain word, so it opens no case, test or
// group; each row was checked against it for CC-1327.
const OPENERS = ['${ ', '${|']
const spellings = (word: string): string[] => [`"${word}"`, `'${word}'`, `\\${word}`]
const opened = (body: string): string[] => OPENERS.map(open => `echo "${open}${body}`)

describe('a quoted reserved word changes no parser state', () => {
  it.each(
    ['"if"', "'then'", '"{"', '"!"', '"time"', '"do"', 'i\\f'].flatMap(prefix =>
      opened(`${prefix} case a in ; } '"; git push --no-verify; : "'\n) }"`),
    ),
  )('%j opens no case, so the } closes and the push is a command', src => {
    const push = find(src, 'git')

    expect(push?.words).toEqual(['git', 'push', '--no-verify'])
    expect(push?.nested).toBe(false)
  })

  const plain = [
    '{',
    '}',
    'then',
    'do',
    'done',
    'fi',
    'esac',
    'if',
    '!',
    'time',
    'else',
    'elif',
    'while',
    'until',
  ]
  it.each(plain.flatMap(word => spellings(word).flatMap(q => opened(`${q} }x; git push --no-verify; }"`))))(
    '%j is a command name, so }x is its argument and the push stays inside',
    src => {
      expect(find(src, 'git')?.nested).toBe(true)
      expect(expansionRisk(src)).toBeUndefined()
    },
  )

  it.each(
    [
      ...spellings('esac').map(q => `case a in ${q}|}) ;; esac; git push --no-verify; }"`),
      ...spellings('in').map(q => `case ${q} in ${q}|}) ;; esac; git push --no-verify; }"`),
      ...spellings('}').map(q => `{ :; ${q}; } ; git push --no-verify; }"`),
    ].flatMap(opened),
  )('%j keeps the } a pattern or the group open, so the push stays inside', src => {
    expect(find(src, 'git')?.nested).toBe(true)
    expect(expansionRisk(src)).toBeUndefined()
  })

  it.each(spellings('[[').flatMap(q => opened(`${q} a; } #"; git push --no-verify\n}"`)))(
    '%j opens no test, so the } closes and the push is a command',
    src => {
      expect(find(src, 'git')?.nested).toBe(false)
      expect(expansionRisk(src)).toBeUndefined()
    },
  )

  it.each(spellings(']]').flatMap(q => opened(`[[ a == ${q} || } ]]; git push --no-verify; }"`)))(
    '%j closes no test, and a lone } operand is unreadable',
    src => {
      expect(expansionRisk(src)).toBe('unreadable')
    },
  )
})

// bash 5.3.9 opens these from the token before them, wherever the words of the command stand.
describe('reserved words read token by token', () => {
  it.each(
    [
      'case a\nin }) ;; esac; git push --no-verify; }"',
      'case in in in|}) ;; esac; git push --no-verify; }"',
      'case a in a) case b in }) ;; esac ;; esac; git push --no-verify; }"',
      'for i do { :; }; done; git push --no-verify; }"',
      'for i\ndo { :; }; done; git push --no-verify; }"',
      'time -p { :; }; git push --no-verify; }"',
      'function f () { :; }; git push --no-verify; }"',
      "$'fi' }x; git push --no-verify; }\"",
      'case a in (esac|}) ;; esac; git push --no-verify; }"',
      'case a in a|esac|}) ;; esac; git push --no-verify; }"',
      'time -- { :; }; git push --no-verify; }"',
      'time -p -- { :; }; git push --no-verify; }"',
    ].flatMap(opened),
  )('%j reads the case or group, so the push stays inside', src => {
    expect(find(src, 'git')?.nested).toBe(true)
    expect(expansionRisk(src)).toBeUndefined()
  })

  // bash 5.3.9 reserves no `}` after an assignment named by coproc and no `time` after a pipe or coproc
  // (reserved_word_acceptable and time_command_acceptable), so the } is an argument and the push runs.
  it.each(
    [
      'coproc x=1 }; git push --no-verify; }"',
      ': | time }; git push --no-verify; }"',
      ': |& time }; git push --no-verify; }"',
      ': |\ntime }; git push --no-verify; }"',
      'coproc x time }; git push --no-verify; }"',
      'coproc time -p }; git push --no-verify; }"',
    ].flatMap(opened),
  )('%j has a } argument, so it is unreadable', src => {
    expect(expansionRisk(src)).toBe('unreadable')
  })
})

describe('other ${...} forms are unchanged', () => {
  it.each([
    ['echo ${X:-y}', 'operator'],
    ['echo ${(e)x}', 'unreadable'],
    ['echo ${HOME}', undefined],
  ])('%j stays %j', (src, risk) => {
    expect(expansionRisk(src)).toBe(risk)
  })
})

// Each line chains two or three compound ends before `}`; bash 5.3.9 closes the funsub there and runs
// the push in every one (checked against bash for CC-1327, 1176 lines).
const LEAVES = [
  'if :; then :; fi',
  'for a in b; do :; done',
  'case a in a) ;; esac',
  '{ :; }',
  '[[ a ]]',
  '(( 1 ))',
  '(:)',
]
const WRAPPERS = [
  'if :; then @ fi',
  'while false; do @ done',
  '{ @ }',
  '( @ )',
  'case a in a) @ esac',
  'for a in b; do @ done',
]
const chained = WRAPPERS.flatMap(outer =>
  LEAVES.flatMap(leaf =>
    [outer, ...WRAPPERS.map(inner => outer.replace('@', inner))].map(w => w.replace('@', leaf)),
  ),
)
const matrix = chained.flatMap(body =>
  ['${ ', '${|'].flatMap(open =>
    [' }', ' }x'].map(tail => `echo "${open}${body}${tail}"; git push --no-verify; #"\n}"`),
  ),
)

// A `{ }` group in a case inside a subshell is refused: the accepted cost of CC-1324's case boundary.
const refused = (src: string): boolean => src.includes('( case a in a) { :; } esac )')

describe('chained compound ends before a funsub }', () => {
  it('covers every leaf, wrapper pair, opener and tail', () => {
    expect(matrix).toHaveLength(1176)
    expect(matrix.filter(refused)).toHaveLength(4)
  })

  it.each(matrix)('%j closes where bash does', src => {
    const push = find(src, 'git')

    expect(push?.nested).toBe(false)
    expect(expansionRisk(src)).toBe(refused(src) ? 'unreadable' : undefined)
  })
})
