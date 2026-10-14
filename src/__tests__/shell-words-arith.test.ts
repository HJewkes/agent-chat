import { describe, expect, it } from 'vitest'
import { arithSubscriptNames } from '../leak-guard/arith-subscript.js'
import { parseShell, type SimpleCommand } from '../leak-guard/shell-words.js'

// A variable's value is re-evaluated in arithmetic and subscripts, where a held `$(...)` can run (CC-1249).
const commandOf = (line: string, head: string): SimpleCommand => {
  const found = parseShell(line).find(cmd => cmd.words[0] === head)
  if (found === undefined) throw new Error(`no ${head} in ${line}`)
  return found
}

describe('the splitter tags the body of (( )) and $(( )) as arithmetic', () => {
  it.each([
    ['(( x ))', 'x'],
    ['((x))', 'x'],
    ['echo $(( i ))', 'i'],
    ['n=$(( i )) && :', 'i'],
    ['if (( x )); then :; fi', 'x'],
    ['for ((i=0;i<3;i++)); do :; done', 'i++'],
  ])('%s tags %s', (line, head) => {
    expect(commandOf(line, head).arith).toBe(true)
  })

  it.each([
    ['( git status )', 'git'],
    ['( ( git status ) )', 'git'],
    ['$( (git status) )', 'git'],
    ['git status', 'git'],
    ['for ((i=0;i<3;i++)); do :; done', 'do'],
    ['x=(a b)', 'a'],
    ['(( x )); git status', 'git'],
    ['echo $(( $(git status) ))', 'git'],
    ['((git push) )', 'git'],
    ['((git push)|cat)', 'git'],
    ['echo $((git push) )', 'git'],
    ['((x)); ( ( git status ) )', 'git'],
  ])('%s leaves %s a command', (line, head) => {
    expect(commandOf(line, head).arith).toBe(false)
  })
})

describe('arithSubscriptNames lists the names arithmetic re-evaluates', () => {
  it.each([
    ['(( arr[$i] ))', 'arr[$i]', ['arr', 'i']],
    ['(( arr[0] ))', 'arr[0]', ['arr']],
    ['(( x < y ))', 'x', ['x', 'y']],
    ['(( x > y ))', 'x', ['x', 'y']],
    ['(( a[1<y] ))', 'a[1', ['a', 'y']],
    ['for ((i=0;i<y;i++)); do :; done', 'i=0', ['i', 'y']],
    ['echo $(( x < y ))', 'echo', ['x', 'y']],
    ['echo $(( arr[$i] + n ))', 'echo', ['arr', 'i', 'n']],
    ['echo $(( i ))', 'echo', ['i']],
    ['echo "${arr[$i]}"', 'echo', ['i']],
    ['echo ${arr[$i]}', 'echo', ['i']],
    ['echo $arr[$i]', 'echo', ['i']],
    ['arr[$i]=1', 'arr[$i]=1', ['i']],
    ['declare -i n=arr[$i]', 'declare', ['arr', 'i']],
    ['typeset -i x=arr[$i]', 'typeset', ['arr', 'i']],
    ['integer y=arr[$i]', 'integer', ['arr', 'i']],
    ['let "arr[$i]"', 'let', ['arr', 'i']],
    ['echo $[ arr[$i] ]', 'echo', ['arr', 'i']],
    ['(( n + 1 ))', 'n', ['n']],
    [': $(( $(echo ")" >/dev/null; echo 1) + y ))', ':', ['y']],
    ["(( $(: ')'; echo 1) + y ))", "$(: ')'; echo 1)", ['y']],
    ['(( `: ")"; echo 1` + y ))', '`: ")"; echo 1`', ['y']],
    ['(( $(case q in q) echo 1;; esac) + y ))', '$(case q in q) echo 1;; esac)', ['y']],
    ['echo $(( ${z:-)} + y ))', 'echo', ['z', 'y']],
    ['echo $[ x<y ]', 'echo', ['x', 'y']],
    ['echo "$[ x<y ]"', 'echo', ['x', 'y']],
  ])('%s: %s yields %j', (line, head, names) => {
    expect(arithSubscriptNames(commandOf(line, head), parseShell(line))).toEqual(names)
  })

  it.each([
    ['git status', 'git'],
    ['arr[0]=1', 'arr[0]=1'],
    ['echo "$i"', 'echo'],
    ["echo 'arr[$i]'", 'echo'],
    ['declare n=arr[$i]', 'declare'],
    ['(( 5 ))', '5'],
    ['(( 16#ff + 0x1f ))', '16#ff'],
    ['echo $(( $(date) ))', 'echo'],
    ['((git push) )', 'git'],
  ])('%s: %s yields none', (line, head) => {
    expect(arithSubscriptNames(commandOf(line, head), parseShell(line))).toEqual([])
  })
})

describe('a case pattern ends no substitution', () => {
  it.each([
    ['echo $(case q in q) git push;; esac) z', ['echo', '$(case q in q) git push;; esac)', 'z']],
    [
      'echo $(case q in (a|b) x;; r) git push;; esac) z',
      ['echo', '$(case q in (a|b) x;; r) git push;; esac)', 'z'],
    ],
  ])('%s', (line, words) => {
    expect(commandOf(line, 'echo').words).toEqual(words)
    expect(commandOf(line, 'git').words).toEqual(['git', 'push'])
  })
})
