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
  ])('%s leaves %s a command', (line, head) => {
    expect(commandOf(line, head).arith).toBe(false)
  })
})

describe('arithSubscriptNames lists the names arithmetic re-evaluates', () => {
  it.each([
    ['(( arr[$i] ))', 'arr[$i]', ['i']],
    ['echo $(( arr[$i] + n ))', 'echo', ['i', 'n']],
    ['echo $(( i ))', 'echo', ['i']],
    ['echo "${arr[$i]}"', 'echo', ['i']],
    ['echo ${arr[$i]}', 'echo', ['i']],
    ['echo $arr[$i]', 'echo', ['i']],
    ['arr[$i]=1', 'arr[$i]=1', ['i']],
    ['declare -i n=arr[$i]', 'declare', ['i']],
    ['typeset -i x=arr[$i]', 'typeset', ['i']],
    ['integer y=arr[$i]', 'integer', ['i']],
    ['let "arr[$i]"', 'let', ['i']],
    ['echo $[ arr[$i] ]', 'echo', ['i']],
    ['(( n + 1 ))', 'n', ['n']],
  ])('%s: %s yields %j', (line, head, names) => {
    expect(arithSubscriptNames(commandOf(line, head))).toEqual(names)
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
  ])('%s: %s yields none', (line, head) => {
    expect(arithSubscriptNames(commandOf(line, head))).toEqual([])
  })
})
