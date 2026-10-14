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

const commandOf = (line: string, index = -1): SimpleCommand => {
  const found = parseShell(line).at(index)
  if (found === undefined) throw new Error(`no command in ${line}`)
  return found
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
    ['x=([$i]=1)', ['i']],
    ['declare -a x=( [n+1]=a [m]+=b )', ['n', 'm']],
    ['declare -n r="x[$i]"', ['i']],
    ['local -n r="$a"', ['a']],
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
    expect(arithSubscriptNames(commandOf(line, index))).toEqual(names)
  })

  it.each(['[[ $a == 0 ]]', '[ "$a" -eq 0 ]', 'test "$a" -gt 1', 'printf %s "$a"', 'echo -v "$a"'])(
    '%s yields none',
    line => {
      expect(arithSubscriptNames(commandOf(line))).toEqual([])
    },
  )
})

describe('arithSubstitutions returns each quoted substitution the shell runs as arithmetic', () => {
  it.each([
    [`[[ 'x[$(${P})]' -eq 1 ]]`, [P]],
    [`[[ 1 -gt 'x[$(${P})]' ]]`, [P]],
    [`[[ 'x[$(${P})]' -eq 1 && b -lt 2 ]]`, [P], 0],
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
    [`while read 'x[$(${P})]'; do :; done <<< 1`, [P], 0],
    [`if test -v 'x[$(${P})]'; then :; fi`, [P], 0],
    [`if [ -v 'x[$(${P})]' ]; then :; fi`, [P], 0],
    [`! printf -v 'x[$(${P})]' 1`, [P]],
    [`if let 'x[$(${P})]=1'; then :; fi`, [P], 0],
    [`while let 'x[$(${P})]=1'; do :; done`, [P], 0],
    [`if declare -i 'n=x[$(${P})]'; then :; fi`, [P], 0],
    [`time read 'x[$(${P})]' <<< 1`, [P]],
    [`time -p read 'x[$(${P})]' <<< 1`, [P]],
    [`{ read 'x[$(${P})]'; } <<< 1`, [P], 0],
    [`command read 'x[$(${P})]' <<< 1`, [P]],
    [`command -p printf -v 'x[$(${P})]' 1`, [P]],
    [`builtin printf -v 'x[$(${P})]' 1`, [P]],
    [`if command let 'x[$(${P})]=1'; then :; fi`, [P], 0],
    [`LC_ALL=C read 'x[$(${P})]' <<< 1`, [P]],
    // A declarer or unset resolves each operand's name, subscript included, with or without -i.
    [`declare -a x; declare 'x[$(${P})]=1'`, [P]],
    [`declare -A x; declare 'x[$(${P})]=1'`, [P]],
    [`typeset -a x; typeset 'x[$(${P})]=1'`, [P]],
    [`f() { local 'x[$(${P})]=1'; }`, [P], -2],
    [`readonly 'x[$(${P})]=1'`, [P]],
    [`declare -g 'x[$(${P})]'`, [P]],
    [`! declare 'x[$(${P})]=1'`, [P]],
    [`declare 'x[$(echo a=b; ${P})]=1'`, [`echo a=b; ${P}`]],
    [`unset 'x[$(${P})]'`, [P]],
    [`unset -v 'x[$(${P})]'`, [P]],
    [`if unset 'x[$(${P})]'; then :; fi`, [P], 0],
    [`builtin unset 'x[$(${P})]'`, [P]],
    // An assignment word, an attached -vNAME and a coproc's command resolve names too.
    [`x['$(${P})']=1`, [P]],
    [`a=1 x['$(${P})']=1`, [P]],
    [`x['$(${P})']+=1`, [P]],
    [`x['$(${P})']=1 true`, [P]],
    [`if x['$(${P})']=1; then :; fi`, [P], 0],
    [`printf -vx'[$(${P})]' 1`, [P]],
    [`printf '-vx[$(${P})]' 1`, [P]],
    [`builtin printf -vx'[$(${P})]' 1`, [P]],
    [`coproc read 'x[$(${P})]'`, [P]],
    [`coproc r { read 'x[$(${P})]'; }`, [P], 0],
    [`coproc { read 'x[$(${P})]'; }`, [P], 0],
    [`coproc r while read 'x[$(${P})]'; do :; done`, [P], 0],
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
    [`f() { x=(['$(${P})']=1); }`, [P], -2],
    // The splitter ends this element at the `)` in its key; with no `]=` to find, the rest of the word is read.
    [`x=(['$(echo ])')']=1)`, ['echo ]'], 1],
    [`declare -n r='x[$(${P})]'`, [P]],
    [`local -n r='x[$(${P})]'`, [P]],
    [`typeset -n r='x[$(${P})]'`, [P]],
    [`declare -gn r='x[$(${P})]'`, [P]],
    [`if declare -n r='x[$(${P})]'; then :; fi`, [P], 0],
    [`let 'x[$(echo ")"; ${P})]=1'`, [`echo ")"; ${P}`]],
  ] satisfies Row[])('%s yields %j', (line: string, bodies: string[], index = -1) => {
    expect(arithSubstitutions(commandOf(line, index))).toEqual(bodies)
  })

  it.each([
    `[[ x -eq $(${P}) ]]`,
    `[[ "$(${P})" -eq 1 ]]`,
    `[[ 'x[$(${P})]' == 1 ]]`,
    `test 'x[$(${P})]' -eq 1`,
    `echo 'x[$(${P})]'`,
    `declare 'n=x[$(${P})]'`,
    `read -a 'x[$(${P})]'`,
    `declare 'n=$(${P})'`,
    `export 'n=x[$(${P})]'`,
    `unset -f 'f'`,
    `x[$(${P})]=1`,
    `x='$(${P})'`,
    `printf -vx 1`,
    `coproc r`,
    `x=('[$(${P})]=1')`,
    `x=(['k']='$(${P})')`,
    `declare -A x=( ["$(${P})"]=1 )`,
    `declare r='x[$(${P})]'`,
    `[ -v x ]`,
    `[[ -v x ]]`,
    `[[ $n -eq 3 ]]`,
    `let i=i+1`,
    `! test 'x[$(${P})]' -eq 1`,
    `command echo 'x[$(${P})]'`,
  ])('%s yields none', line => {
    expect(arithSubstitutions(commandOf(line))).toEqual([])
  })
})

describe('the pretool guard and arithSubstitutions share one list of name-operand builtins', () => {
  it('pretool.ts imports both sets rather than defining its own', () => {
    const source = fs.readFileSync(new URL('../leak-guard/pretool.ts', import.meta.url), 'utf8')
    expect(source).toMatch(/import \{ ENV_DECL, NAME_OPERAND_BUILTINS \} from '\.\/arith-subscript\.js'/)
    expect(source).not.toMatch(/const (ENV_DECL|NAME_OPERAND_BUILTINS)\b/)
  })

  it.each([...NAME_OPERAND_BUILTINS, ...ENV_DECL])('%s resolves a quoted subscript in its operand', head => {
    expect(arithSubstitutions(commandOf(`${head} 'x[$(${P})]'`))).toEqual([P])
  })
})
