import { describe, expect, it } from 'vitest'
import { parseShell } from '../leak-guard/shell-words.js'

// A reader of a cut text decides a substitution's extent from this flag, never from its last character (CC-1334).
describe('the splitter records whether it consumed a substitution closer', () => {
  const closedFlags = (line: string): boolean[] =>
    parseShell(line).flatMap(cmd => cmd.substitutions.map(sub => sub.closed))

  it.each([
    ['echo $(a)', [true]],
    ['echo `a`', [true]],
    ['echo $((1 + 2))', [true]],
    ['echo "$(a)"', [true]],
    ['echo $(a', [false]],
    ['echo `a', [false]],
    ['echo $(echo ")"', [false]],
    ["echo $(cat <<'E'\n)", [false]],
  ])('%j records closed %j', (line, expected) => {
    expect(closedFlags(line)).toEqual(expected)
  })
})
