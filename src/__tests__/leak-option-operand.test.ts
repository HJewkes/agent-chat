import { describe, expect, it } from 'vitest'
import { operandMaySpellOption } from '../leak-guard/option-operand.js'
import { LIVE, parseShell } from '../leak-guard/shell-words.js'

const pushedWord = (word: string): string => {
  const marked = parseShell(`git push origin ${word}`).find(command => command.words[1] === 'push')?.marked[3]
  if (marked === undefined) throw new Error(`no fourth word in: ${word}`)
  return marked
}

describe('a ${...} operand that may yield an option word (CC-1286)', () => {
  it.each([
    'main${X:- --no-verify}',
    '${X:---no-verify}',
    '"${X:---no-verify}"',
    '${X- --no-verify}',
    '${X:= -x}',
    '${X=--no-verify}',
    '${X::=--no-verify}',
    '${X:+ --no-verify}',
    '${X+--no-veri}',
    '${X:? --no-verify}',
    '${X? --no-verify}',
    '${=X:- --no-verify}',
    '${^X:- -x}',
    '${arr[1]:- --no-verify}',
    '${X:-ax--no-verify}',
    '${X/#/--no-verify }',
    '${X/%/ --no-verify}',
    '${X//a/--no-verify}',
    '${X/a/-n}',
    '${X:/a/--no-verify}',
    '${X:s./.--no-verify .}',
    '${=X:s./.--no-verify .}',
    '${X:gs/a/--no-verify}',
    '${X:&}',
    '${X:g&}',
    '${X:h:s/a/b}',
    '${X:N}',
    '--push-option=${X:- --no-verify}',
    'main${B}${X:- --no-verify}',
    '${X:-{a,--no-verify}}',
    '${X:-a',
    '${!X:- --no-verify}',
    '${!X- --no-verify}',
    '${!X}',
    '${!}',
    '${X:-{a,-f}}',
    '${X:-{-f,a}}',
    '${X:-{a,}-f}',
    '${X:-{0..-1}}',
    '${X:-{a,b}}',
    '${X:-{+../}{+../}no{+../}verify}',
    '${X/#/{+../}{+../}no{+../}verify}',
    '"${X:-{+../}{+../}no{+../}verify}"',
    '"${X/#/{+../}{+../}no{+../}verify}"',
    'main${X:-{+../}x}',
    '${X:-$Y}',
    '${X:-*}',
    '${X@P}',
    '${X^^}',
    '${(e)X}',
    '${X#$Y}',
    '${X/$Y/a}',
    '${X:-{a} -x}',
    '${X/{a}/-b}',
  ])('is true for %s', word => {
    expect(operandMaySpellOption(pushedWord(word))).toBe(true)
  })

  it.each([
    '${X:- }--no-verify',
    '${X:-a }--no-verify',
    '${X/#/ }--no-verify',
    '${=X:- }--no-verify',
    '${X:+ }--x',
    '${X/#/ }--x',
    '${X:-a b}--x',
    '${X:-a b}-x',
    '${X:-a\t-x}',
    '"${X:-\t}"--x',
    '"${X:-a\n-x}"',
    '"${X:-\n}"--x',
    '${X:- }${Y:- }--x',
    '${X:-a}${Y:- -x}',
    'main${X}${Y:- }-x',
    '$X${Y:- }-x',
    'main${X:-a}--zz',
    '${X}-x',
    '--no-veri${X:-fy}',
    '$(x)${Y:- }-x',
    '$X--no-verify',
    '$(x)-y',
    '`x`--no-verify',
  ])('is true when the text around the expansion may start an option word: %s', word => {
    expect(operandMaySpellOption(pushedWord(word))).toBe(true)
  })

  it.each([
    'main$=X--no-verify',
    'main$~X--no-verify',
    'main$^X--no-verify',
    'main$+X--no-verify',
    'main$#X--no-verify',
    'main$[0]--zz',
    'main$X[1]--zz',
    '$X:s/a/-b/',
    '${X:- }--x=--no-verify',
    '-n:-a=${X}',
    'main${X:- }*',
    'main${X:- }?',
  ])('is true for a $ form it cannot read, an option after an expansion, or a glob word start: %s', word => {
    expect(operandMaySpellOption(pushedWord(word))).toBe(true)
  })

  it.each([`${LIVE}main`, `main${LIVE}%`])(
    'is true for a mark it cannot read, such as a word the splitter is unsure of: %j',
    marked => {
      expect(operandMaySpellOption(marked)).toBe(true)
    },
  )

  it.each([`${LIVE}$(x -y`, `${LIVE}\`x -y`])('is true for a substitution that never closes: %j', marked => {
    expect(operandMaySpellOption(marked)).toBe(true)
  })

  it.each([
    '$(: ")")--no-verify',
    '$(case a in a) :;; esac)--no-verify',
    '"$(: ")")"--no-verify',
    "$(: ')')--no-verify",
    '$(: \\))--no-verify',
    '$(echo ${X:-)})--no-verify',
    '`echo "\\`"`--no-verify',
    '$(: #)',
    'main$(cat <<E)',
    '$(: `)`)--no-verify',
    'main$(echo `)`)-x',
    'main$((1))',
    'main$(echo $X)',
    '${a[$(x)]}',
  ])('is true for a substitution whose end the scanner may misplace: %s', word => {
    expect(operandMaySpellOption(pushedWord(word))).toBe(true)
  })

  it.each([
    'main{a,$X}--zz',
    'main$X{-f,a}',
    'main$X{,-}-zz',
    'main${X}{a,--no-verify}',
    'main$=X{a,-f}',
    'main${=X}{-f,a}',
    'main$X{0..-1}',
    'main{$X,-x}',
    'main$X{a{b}c,-d}',
    'main$X{a,b-',
    'main$X{a-',
    'main$X{a"}",-b}',
    'main${X}{a,b}',
    'main${=X}{+../}{+../}no{+../}verify',
    'main$=X{+../}{+../}no{+../}verify',
    'main$X{,../}',
    'main${X}{a}-x',
    'main${=X}{+-/}{+-/}no{+-/}verify',
    'main$X{+-/}',
    'main$X{"}",-x}',
  ])('is true for a brace expansion beside an expansion: %s', word => {
    expect(operandMaySpellOption(pushedWord(word))).toBe(true)
  })

  it.each(["'{a,-b}'${X}", '"{a,-b}"$X', 'main$X{}'])(
    'is false for a quoted brace or a lone {}: %s',
    word => {
      expect(operandMaySpellOption(pushedWord(word))).toBe(false)
    },
  )

  it('splits injected text on the IFS the line sets', () => {
    const word = pushedWord('main${X:-a-n}')

    expect(operandMaySpellOption(word)).toBe(false)
    expect(operandMaySpellOption(word, 'a')).toBe(true)
  })

  it.each([
    'main',
    '${BRANCH}',
    '"${BRANCH:-main}"',
    '${BRANCH:-feat-x}',
    '${R:-origin}',
    '${X#-}',
    '${X%--x}',
    '${=X%--x}',
    '${X:0:1}',
    '${#X}',
    '${X/-/a}',
    '${X/--no-verify}',
    '${X:-main}',
    '${X-main}',
    '${X:=main}',
    '${X:+main}',
    '${X:?main}',
    '${X::=main}',
    '${X:h}',
    '${X:t:r}',
    '${X:h2}',
    '${X:-a-b}',
    '${X:-feat/a-b}',
    '${X%%-*}',
    '${X: -2}',
    '${#}',
    '$X',
    "'${X:---no-verify}'",
    '--force-with-lease=main:${SHA}',
    '${BRANCH}/x',
    'refs/heads/${B}:refs/heads/${B}',
    '$(git branch --show-current)',
    'a*-${B}',
  ])('is false for %s', word => {
    expect(operandMaySpellOption(pushedWord(word))).toBe(false)
  })
})
