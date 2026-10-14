import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  arithSubscriptNames,
  arithSubstitutions,
  ENV_DECL,
  NAME_OPERAND_BUILTINS,
} from '../leak-guard/arith-subscript.js'
import { parseShell, type SimpleCommand } from '../leak-guard/shell-words.js'

// Operands bash evaluates as arithmetic or resolves as a subscripted name, where a quoted `$(...)` runs (CC-1334).
const P = 'git push --no-verify'

type Row = [line: string, expected: string[], index?: number]

/** Applies `read` to the command at `index` of `line`, with the parsed line beside it, as the guard would. */
const readAt =
  <T>(read: (cmd: SimpleCommand, line: SimpleCommand[]) => T) =>
  (line: string, index = -1): T => {
    const commands = parseShell(line)
    const found = commands.at(index)
    if (found === undefined) throw new Error(`no command in ${line}`)
    return read(found, commands)
  }
const namesOf = readAt(arithSubscriptNames)
/** Every quoted substitution the whole parsed `line` runs as arithmetic or as a name. */
const bodiesOf = (line: string): string[] => arithSubstitutions(parseShell(line))

/** The names every command of `line` lists, so a none row cannot pass by looking at the wrong one. */
const everyName = (line: string): string[] => {
  const commands = parseShell(line)
  return commands.flatMap(cmd => arithSubscriptNames(cmd, commands))
}

describe('arithSubscriptNames lists the names arithmetic operands and resolved names read', () => {
  it.each([
    ['[[ $a -eq 0 ]]', ['a']],
    ['[[ 0 -lt $a ]]', ['a']],
    ['if [[ $n -ge $m ]]; then :; fi', ['n', 'm'], 0],
    ['[[ ( a -ne 1 ) ]]', ['a'], 1],
    ['test -v "$a"', ['a']],
    ['[ -v "$a" ]', ['a']],
    ['[[ -v x[$i] ]]', ['i']],
    ['printf -v "$a" 1', ['a']],
    ['read -r "$a" b', ['a']],
    ['while read -r "$a"; do :; done', ['a'], 0],
    ['declare "x[$i]=1"', ['i']],
    ['x["$i"]=1', ['i']],
    ['a=1 x["$i"]+=1 true', ['i']],
    ['printf -v"x[$i]" 1', ['i']],
    ['coproc read "x[$i]"', ['i']],
    ['x=([$i]=1)', ['i'], 0],
    ['declare -a x=( [n+1]=a [m]+=b )', ['n', 'm'], 0],
    ['declare -n r="x[$i]"', ['i']],
    ['local -n r="$a"', ['a']],
    ['x=([ k ]=1)', ['k'], 0],
    ['echo "$(x=([$i]=1))"', ['i'], 0],
    ['cat <(x=([$i]=1))', ['i'], 1],
    ['declare -ai x=(n "y[$i]")', ['n', 'y', 'i'], 0],
    ['declare -a x=(n "y[$i]")', [], 0],
    ['local "x[$i]+=1"', ['i']],
    ['unset "x[$i]"', ['i']],
    ['unset -v "x[$i]" "y[$j]"', ['i', 'j']],
    ['if unset "x[$i]"; then :; fi', ['i'], 0],
    ['mapfile -d , -u 3 "x[$i]"', ['i']],
    ['declare -i "x[$i]=n"', ['n', 'i']],
    ['if let "x + y"; then :; fi', ['x', 'y'], 0],
    ['declare "n=$v"', []],
    ['export "x=y[$i]"', []],
    ['builtin printf -v "$a" 1', ['a']],
    ['read -p "$p" -t 1 "x[$i]"', ['i']],
  ] satisfies Row[])('%s yields %j', (line: string, names: string[], index = -1) => {
    expect(namesOf(line, index)).toEqual(names)
  })

  it.each(['[[ $a == 0 ]]', '[ "$a" -eq 0 ]', 'test "$a" -gt 1', 'printf %s "$a"', 'echo -v "$a"'])(
    '%s yields none',
    line => {
      expect(everyName(line)).toEqual([])
    },
  )
})

describe('arithSubstitutions returns each quoted substitution the shell runs as arithmetic', () => {
  it.each([
    [`[[ 'x[$(${P})]' -eq 1 ]]`, [P]],
    [`[[ 1 -gt 'x[$(${P})]' ]]`, [P]],
    [`[[ 'x[$(${P})]' -eq 1 && b -lt 2 ]]`, [P]],
    [`test -v 'x[$(${P})]'`, [P]],
    [`[ -v 'x[$(${P})]' ]`, [P]],
    [`[[ -v 'x[$(${P})]' ]]`, [P]],
    [`[[ a -eq 1 || -v 'y[$(${P})]' ]]`, [P]],
    [`printf -v 'x[$(${P})]' 1`, [P]],
    [`read 'x[$(${P})]' <<< 1`, [P]],
    [`read -r -p hi 'x[$(${P})]'`, [P]],
    [`let 'x[$(${P})]=1'`, [P]],
    [`declare -i 'n=x[$(${P})]'`, [P]],
    [`declare -i 'x[$(${P})]=1'`, [P]],
    [`echo $(( x['$(${P})'] ))`, [P]],
    ["test -v 'x[`" + P + "`]'", [P]],
    [`let 'x[$(git push $(echo --no-verify))]=1'`, ['git push $(echo --no-verify)']],
    // The splitter keeps keywords before the command word, and command/builtin run the builtin they name.
    [`while read 'x[$(${P})]'; do :; done <<< 1`, [P]],
    [`if test -v 'x[$(${P})]'; then :; fi`, [P]],
    [`if [ -v 'x[$(${P})]' ]; then :; fi`, [P]],
    [`! printf -v 'x[$(${P})]' 1`, [P]],
    [`if let 'x[$(${P})]=1'; then :; fi`, [P]],
    [`while let 'x[$(${P})]=1'; do :; done`, [P]],
    [`if declare -i 'n=x[$(${P})]'; then :; fi`, [P]],
    [`time read 'x[$(${P})]' <<< 1`, [P]],
    [`time -p read 'x[$(${P})]' <<< 1`, [P]],
    [`{ read 'x[$(${P})]'; } <<< 1`, [P]],
    [`command read 'x[$(${P})]' <<< 1`, [P]],
    [`command -p printf -v 'x[$(${P})]' 1`, [P]],
    [`builtin printf -v 'x[$(${P})]' 1`, [P]],
    [`if command let 'x[$(${P})]=1'; then :; fi`, [P]],
    [`LC_ALL=C read 'x[$(${P})]' <<< 1`, [P]],
    // A declarer or unset resolves each operand's name, subscript included, with or without -i.
    [`declare -a x; declare 'x[$(${P})]=1'`, [P]],
    [`declare -A x; declare 'x[$(${P})]=1'`, [P]],
    [`typeset -a x; typeset 'x[$(${P})]=1'`, [P]],
    [`f() { local 'x[$(${P})]=1'; }`, [P]],
    [`readonly 'x[$(${P})]=1'`, [P]],
    [`declare -g 'x[$(${P})]'`, [P]],
    [`! declare 'x[$(${P})]=1'`, [P]],
    [`declare 'x[$(echo a=b; ${P})]=1'`, [`echo a=b; ${P}`]],
    [`unset 'x[$(${P})]'`, [P]],
    [`unset -v 'x[$(${P})]'`, [P]],
    [`if unset 'x[$(${P})]'; then :; fi`, [P]],
    [`builtin unset 'x[$(${P})]'`, [P]],
    // An assignment word, an attached -vNAME and a coproc's command resolve names too.
    [`x['$(${P})']=1`, [P]],
    [`a=1 x['$(${P})']=1`, [P]],
    [`x['$(${P})']+=1`, [P]],
    [`x['$(${P})']=1 true`, [P]],
    [`if x['$(${P})']=1; then :; fi`, [P]],
    [`printf -vx'[$(${P})]' 1`, [P]],
    [`printf '-vx[$(${P})]' 1`, [P]],
    [`builtin printf -vx'[$(${P})]' 1`, [P]],
    [`coproc read 'x[$(${P})]'`, [P]],
    [`coproc r { read 'x[$(${P})]'; }`, [P]],
    [`coproc { read 'x[$(${P})]'; }`, [P]],
    [`coproc r while read 'x[$(${P})]'; do :; done`, [P]],
    // A compound array element's key and a nameref's value are names too, though they sit in a value.
    [`x=(['$(${P})']=1)`, [P]],
    [`x+=(['$(${P})']=1)`, [P]],
    [`declare -a x=(['$(${P})']=1)`, [P]],
    [`typeset -A x=(['$(${P})']=1)`, [P]],
    [`local -a x=(['$(${P})']+=1)`, [P]],
    [`x=( a  ['$(${P})']=1  b )`, [P]],
    [`x=( [0]=a ['$(${P})']=1 )`, [P]],
    [`x=( [$'$(${P})']=1 )`, [P]],
    [`x=( ["k"'$(${P})']=1 )`, [P]],
    [`x=(['$(echo "]"; ${P})']=1)`, [`echo "]"; ${P}`]],
    [`f() { x=(['$(${P})']=1); }`, [P]],
    // The splitter ends this element at the `)` in its key; with no `]=` to find, the rest of the word is read.
    [`x=(['$(echo ])')']=1)`, ['echo ]']],
    // The list after x=( is one element list: a key may span words, and -i makes every value arithmetic.
    [`declare -ai x=([0]='y[$(${P})]')`, [P]],
    [`declare -i x=('y[$(${P})]')`, [P]],
    [`declare -ai x=('y[$(${P})]')`, [P]],
    [`declare -ai x=(1 'y[$(${P})]' 3)`, [P]],
    [`declare -Ai x=(['k']='y[$(${P})]')`, [P]],
    [`local -ai x=('y[$(${P})]')`, [P]],
    [`typeset -ia x=('y[$(${P})]' 2)`, [P]],
    [`integer x=('y[$(${P})]')`, [P]],
    [`x=([ '$(${P})' ]=1)`, [P]],
    [`x+=([ '$(${P})' ]+=1)`, [P]],
    [`x=( [ 'k' '$(${P})' ]=1 )`, [P]],
    [`declare -a x=( [ '$(${P})' ]+=1 )`, [P]],
    [`x=(\n  ['$(${P})']=1\n)`, [P]],
    [`declare -ai x=(\n  1\n  'y[$(${P})]'\n)`, [P]],
    [`x=( [ '$(${P})' )`, [P]],
    // A list inside a substitution is read from that substitution's own commands.
    [`echo "$(x=(['$(${P})']=1))"`, [P]],
    ["echo `x=(['$(" + P + ")']=1)`", [P]],
    [`echo $(echo $(x=(['$(${P})']=1)))`, [P]],
    [`echo "$(echo "$(declare -ai x=('y[$(${P})]'))")"`, [P]],
    [`cat <(x=(['$(${P})']=1))`, [P]],
    [`declare -n r='x[$(${P})]'`, [P]],
    [`local -n r='x[$(${P})]'`, [P]],
    [`typeset -n r='x[$(${P})]'`, [P]],
    [`declare -gn r='x[$(${P})]'`, [P]],
    [`if declare -n r='x[$(${P})]'; then :; fi`, [P]],
    [`let 'x[$(echo ")"; ${P})]=1'`, [`echo ")"; ${P}`]],
  ] satisfies Row[])('%s yields %j', (line: string, bodies: string[]) => {
    expect(bodiesOf(line)).toEqual(bodies)
  })

  it.each([
    `[[ x -eq $(${P}) ]]`,
    `[[ "$(${P})" -eq 1 ]]`,
    `unset -f 'f'`,
    `x[$(${P})]=1`,
    `printf -vx 1`,
    `coproc r`,
    `declare -A x=( ["$(${P})"]=1 )`,
    `[ -v x ]`,
    `[[ -v x ]]`,
    `[[ $n -eq 3 ]]`,
    `let i=i+1`,
  ])('%s yields none', line => {
    expect(bodiesOf(line)).toEqual([])
  })
})

// An integer attribute may come from an earlier command or from before the line, so every assigned value
// is read as possible arithmetic: a quoted $(...) in a subscript of it runs.
describe('arithSubstitutions reads a subscript in any assigned value', () => {
  const forms = [
    `n='x[$(${P})]'`,
    `n+='x[$(${P})]'`,
    `x[0]='y[$(${P})]'`,
    `n='x[$(${P})]' true`,
    `x+=('y[$(${P})]')`,
    `x=(['k']='y[$(${P})]')`,
    `declare n='x[$(${P})]'`,
    `declare 'n=x[$(${P})]'`,
    `declare r='x[$(${P})]'`,
    `declare -a x=('y[$(${P})]')`,
    `declare -A x=(['k']='y[$(${P})]')`,
    `export n='x[$(${P})]'`,
    `local n='x[$(${P})]'`,
    `readonly n='x[$(${P})]'`,
    `read n <<< 'x[$(${P})]'`,
    `read n <<'EOF'\nx[$(${P})]\nEOF`,
  ]
  it.each(forms.flatMap(form => [form, `declare -i n; declare -ai x; ${form}`]))('%s', line => {
    expect(bodiesOf(line)).toEqual([P])
  })
})

// Text reaches an integer variable through any word or stdin, and its name or `[` can be built at runtime,
// so every quoted $(...) in every word, here-string and heredoc is reported, whatever the command. A row
// whose command never consumes the text (echo, cat, test, foo) is over-reported on purpose: fail closed.
describe('arithSubstitutions reports every quoted substitution in any word or stdin', () => {
  it.each([
    `printf -v n 'x[$(${P})]'`,
    `printf -vn 'x[$(${P})]'`,
    `printf -v n '%s' 'x[$(${P})]'`,
    `readarray -t x <<< 'y[$(${P})]'`,
    `mapfile -t x <<'EOF'\ny[$(${P})]\nEOF`,
    `mapfile -t x <<EOF\ny[$(${P})]\nEOF`,
    `for n in 'x[$(${P})]'; do :; done`,
    `echo 'x[$(${P})]' | read n`,
    `shopt -s lastpipe; echo 'x[$(${P})]' | read n`,
    `set -- 'x[$(${P})]'; n=$1`,
    `cat <<< 'x[$(${P})]'`,
    `foo 'x[$(${P})]'`,
    `echo 'x[$(${P})]'`,
    `command echo 'x[$(${P})]'`,
    `echo n='x[$(${P})]'`,
    `test 'x[$(${P})]' -eq 1`,
    `! test 'x[$(${P})]' -eq 1`,
    `[[ 'x[$(${P})]' == 1 ]]`,
    `read -a 'x[$(${P})]'`,
    `declare -ai x=(1); echo 'y[$(${P})]'`,
    `echo \${n:='x[$(${P})]'}`,
    `echo \${z['$(${P})']}`,
    // The name or the `[` built at runtime.
    `n=$y'[$(${P})]'`,
    `n=\${y}'[$(${P})]'`,
    `n="$y"'[$(${P})]'`,
    `n=x$b'$(${P})]'`,
    `n=$z'$(${P})]'`,
    `v='$(${P})'; n=x[$v]`,
    `v='[$(${P})]'; n=x$v`,
    `n=$(printf x)'[$(${P})]'`,
    "n=`printf x`'[$(" + P + ")]'",
    `n=$(echo x)\\['$(${P})'\\]`,
    `printf -v n '%s[%s]' x '$(${P})'`,
    `printf -v n 'x\\x5b$(${P})]'`,
    `printf -v n 'x\\133$(${P})]'`,
    `printf -v n %b 'x\\x5b$(${P})]'`,
    `printf '%s[%s]' x '$(${P})' | read n`,
    `read n < <(printf '%s[%s]' x '$(${P})')`,
    // Values with no subscript, once held out by a NAME[ gate.
    `x='$(${P})'`,
    `declare 'n=$(${P})'`,
    `read n <<< '$(${P})'`,
    `cat <<< '$(${P})'`,
    `x=('[$(${P})]=1')`,
    `x=(['k']='$(${P})')`,
    `x=(a b) && echo '[$(${P})]=1'`,
    `foo '$y[$(${P})]'`,
    `foo 'x [$(${P})]'`,
    `foo '(x)[$(${P})]'`,
  ])('%s', line => {
    expect(bodiesOf(line)).toContain(P)
  })

  // A live substitution is a command of its own, which the guard checks already.
  it.each(['echo hi', "n='x[1]'", 'x=([k]=v)', 'cat <<< x', `echo "$(${P})"`, `foo "\${y}['$(${P})']"`])(
    '%s reports nothing: no quoted substitution',
    line => {
      expect(bodiesOf(line)).toEqual([])
    },
  )
})

// The splitter marks the literal `$` of `"$"` LIVE too, so a `$(` it marks live but never read as a
// substitution is reported: bash joins the quoted pieces into `$(P)` and runs it.
describe('arithSubstitutions does not trust a LIVE $( with no substitution behind it', () => {
  it.each([
    `n=x["$"'(${P})]'`,
    `n="x[$"'(${P})]'`,
    `n=x[$"$"'(${P})]'`,
    `n=x[$'\\x24''(${P})]'`,
    `n=x["$""("'${P})]'`,
  ])('%s', line => {
    expect(bodiesOf(line).some(body => body.includes(P))).toBe(true)
  })
})

// The splitter cuts a funsub at its first `}`, even a quoted one, so the rest of the command is reported unread.
describe('arithSubstitutions reports a funsub unread, from its ${ on', () => {
  it.each([
    "echo ${ x=([$'}']=1); }",
    "echo ${ x=([$'\\'}']=1); }",
    'echo ${ x=([$"}"]=1); }',
    'echo ${ x=(["$(echo "}")"]=1); }',
    'echo "${ x=([\'}\']=1); }"',
    "y=${ x=(['}']=1); }",
    "echo ${| x=(['$(P)']=1); }",
    'echo ${ echo ${ x=([k]=1); }; }',
    // A funsub reaches arithmetic from any word, so a non-live ${ or ${| is reported too (CC-1334 round 10).
    `n='x[\${ ${P}; }]'`,
    `n='x[\${| ${P}; }]'`,
    `n="x[\\\${ ${P}; }]"`,
    `for n in '\${ ${P}; }'; do :; done`,
    `echo '\${ ${P}; }'`,
  ])('%s', line => {
    expect(bodiesOf(line).some(body => body.startsWith('${'))).toBe(true)
  })

  it.each(['echo ${x}', 'echo "${x[1]}"', 'echo ${#x}'])('%s is no funsub', line => {
    expect(bodiesOf(line)).toEqual([])
  })
})

// bash reads a $(( that is not well-formed arithmetic as $( (..) ), and the literal $ of "$" is marked LIVE,
// so an opener's reality is judged per recorded substitution (spent once), not by its mark or text (round 10).
describe('arithSubstitutions reads $(( and a faked-live opener', () => {
  // A `$((` runs its body as a subshell `$( (..) )`, so the reported body wraps the payload in parens.
  it.each([`n='x[$((${P}) )]'`, `n=x["$"'((${P}) )]'`, `n='x[$( (${P}) )]'`])('%s', line => {
    expect(bodiesOf(line).some(body => body.includes(P))).toBe(true)
  })

  it.each([
    `n=x["$"'(${P})]'`,
    `n="x[$"'(${P})]'`,
    // A fake sharing a real $(P)'s text in the same command is still reported: trust is spent once.
    `echo $(${P}) x["$"'(${P})]'`,
    `echo "$(${P})" "$"'(${P})]'`,
  ])('%s', line => {
    expect(bodiesOf(line)).toContain(P)
  })

  it.each(['echo $((1 + 1))', 'echo "$((a))"', 'n=$((1 + 1))', 'echo $(( $(date) ))', `echo "$(${P})"`])(
    '%s is a genuine opener and is not reported',
    line => {
      expect(bodiesOf(line)).toEqual([])
    },
  )
})

// The opener's end comes from parseShell, so a case pattern, a # comment or a heredoc inside it, which a paren
// count mistakes for the close, no longer cuts the body short and hides the payload after it (round 11).
describe('arithSubstitutions ends an opener where the lexer does, not at a counted paren', () => {
  it.each([
    `n='x[$(case a in a) ${P};; esac)]'`,
    `n='x[$(echo # )\n${P})]'`,
    `n='x[$(cat <<E\n)\nE\n${P})]'`,
    `read n <<'E'\nx[$(case a in a) ${P};; esac)]\nE`,
  ])('%s', line => {
    expect(bodiesOf(line).some(body => body.includes(P))).toBe(true)
  })

  it.each([`n='x[$(${P}`, `n='x[$(case a in a) ${P}`])('%s fails closed on no close', line => {
    expect(bodiesOf(line).some(body => body.startsWith('$('))).toBe(true)
  })
})

describe('the pretool guard and arithSubstitutions share one list of name-operand builtins', () => {
  it('pretool.ts imports both sets rather than defining its own', () => {
    const source = fs.readFileSync(new URL('../leak-guard/pretool.ts', import.meta.url), 'utf8')
    expect(source).toMatch(/import \{ ENV_DECL, NAME_OPERAND_BUILTINS \} from '\.\/arith-subscript\.js'/)
    expect(source).not.toMatch(/const (ENV_DECL|NAME_OPERAND_BUILTINS)\b/)
  })

  it.each([...NAME_OPERAND_BUILTINS, ...ENV_DECL])('%s resolves a quoted subscript in its operand', head => {
    expect(bodiesOf(`${head} 'x[$(${P})]'`)).toEqual([P])
  })
})

// The guard allows a call it cannot decide within its deadline (failopen.ts), so a slow read is a fail-open:
// each text is parsed from its first opener once, re-parses are bounded, and past a cap the rest fails closed.
describe('arithSubstitutions stays linear on long texts', () => {
  const lines = (line: string): string => Array.from({ length: 3000 }, () => line).join('\n')
  const timed = (line: string): { ms: number; bodies: string[] } => {
    const parsed = parseShell(line)
    const start = performance.now()
    const bodies = arithSubstitutions(parsed)
    return { ms: performance.now() - start, bodies }
  }

  it.each([
    ['a heredoc', `cat <<'E'\n${lines('Run `npm test` then `git status` here')}\nE`],
    ['a quoted word', `n='${lines('Run `npm test` then `git status` here')}'`],
    ['a heredoc with a quote on every line', `cat <<'E'\n${lines("it's `npm test` and x' `ls`")}\nE`],
  ])('3000 lines of backticked markdown in %s finish well under the deadline', (_, line) => {
    expect(timed(line).ms).toBeLessThan(2000)
  })

  it('a text past the opener cap reports the rest as the sentinel, without reading it', () => {
    const { ms, bodies } = timed(`n='${'`a`'.repeat(10_001)}'`)
    expect(ms).toBeLessThan(2000)
    expect(bodies).toEqual(['`a`'.repeat(10_001)])
  })
})
