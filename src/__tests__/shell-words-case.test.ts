import { describe, expect, it } from 'vitest'
import { expansionRisk, parseShell, type SimpleCommand } from '../leak-guard/shell-words.js'

// Inside a $( ) the splitter reads only bash's case … in … esac, which zsh shares (CC-1324).
const commandOf = (line: string, head: string): SimpleCommand => {
  const found = parseShell(line).findLast(cmd => cmd.words[0] === head)
  if (found === undefined) throw new Error(`no ${head} in ${line}`)
  return found
}

const PUSH = 'git push --no-verify'

const SHARED = [
  `case q in q) :;; r) echo "a";; esac; ${PUSH}`,
  `case q in\n  q) :;;\n  r) echo "a";;\nesac; ${PUSH}`,
  `case q in (q) :;; (r) echo "a";; esac; ${PUSH}`,
  `case q in q|z) :;& r) echo "a";;& s) :;; esac; ${PUSH}`,
  `case q in q) case r in r) :;; esac;; s) echo "a";; esac; ${PUSH}`,
  `case q in q) :;; esac; case r in r) echo "a";; esac; ${PUSH}`,
]

describe('a case in the shared grammar keeps its $( ) whole', () => {
  it.each(SHARED)('quoted: %s', body => {
    const line = `echo "$(${body})"`
    expect(commandOf(line, 'echo').words).toEqual(['echo', `$(${body})`])
    expect(commandOf(line, 'git').words).toEqual(['git', 'push', '--no-verify'])
    expect(expansionRisk(line)).toBeUndefined()
  })

  it.each(SHARED)('unquoted: %s', body => {
    const line = `echo $(${body}) z`
    expect(commandOf(line, 'echo').words).toEqual(['echo', `$(${body})`, 'z'])
    expect(commandOf(line, 'git').words).toEqual(['git', 'push', '--no-verify'])
  })
})

describe('a case form only one shell reads, where a ) can end the span', () => {
  it.each([
    ['T1', 'echo "$(case q in q) :;| r) echo a;; esac)"'],
    ['T1', 'echo "$(case q in q) :\n;|r) echo a;; esac)"'],
    ['T1', '(echo a;| cat)'],
    ['T2', 'echo "$(case q { q) :;; })"'],
    ['T2', 'echo "$(case q {q) :;; })"'],
    ['T2', 'echo "$(case q;{ q) :;; })"'],
    ['T2', 'echo "$(case q;in q) :;; esac)"'],
    ['T2', 'echo "$(case q\nin q) :;; esac)"'],
    ['T2', 'echo "$(case q # c\nin q) :;; esac)"'],
    ['T2', 'echo "$(case q "in" q) :;; esac)"'],
    ['T2', 'echo "$(case q)"'],
    ['T2', '(case q in q) :;; esac; case r)'],
    ['T3', 'echo "$(case q in q) { :; };; esac)"'],
    ['T3', 'echo "$(case q in q) {:;};; esac)"'],
    ['T3', 'echo "$(case q in q) echo a};; esac)"'],
    ['T3', 'echo "$(case q in q) :;; })"'],
    ['T3', 'echo "$(case q in q) echo };; r) git push;; esac)"'],
    ['T3', '(case q in q) echo {a,b};; esac)'],
    ['T3', 'echo "$(case q in q) case r in r) :;; esac; { :; };; esac)"'],
  ])('is unreadable (%s): %s', (_trigger, line) => {
    expect(expansionRisk(line)).toBe('unreadable')
  })

  it.each([
    'case q { q) :;; }',
    'case q;in q) :;; esac',
    'case q in q) { :; };; esac',
    'echo a;| cat',
    'echo "$(case q in q) echo "{}" \\} \'}\' ${b};; esac)"',
    'echo "$(case q in q) :;; esac; { :; })"',
    'echo "$(case q in q) :;; esac) {a,b}"',
    '{ git status; }',
  ])('is read as before outside a case in such a span: %s', line => {
    expect(expansionRisk(line)).toBeUndefined()
  })

  it('opens nothing on an in after a word that is not case', () => {
    expect(commandOf('echo $(x;in q) z', 'echo').words).toEqual(['echo', '$(x;in q)', 'z'])
  })
})

describe("a | between a case's patterns", () => {
  it.each([
    'case q in (q|r) :;; (*) :;; esac',
    'case q in q) :;; r|s) :;; *) :;; esac',
    'echo "$(case q in q|r) :;; esac)"',
  ])('joins patterns and makes no pipe: %s', line => {
    expect(parseShell(line).some(cmd => cmd.before === '|' || cmd.after === '|')).toBe(false)
  })

  it('still pipes inside a pattern body', () => {
    expect(commandOf('case q in (q|r) echo a | cat;; esac', 'cat').before).toBe('|')
  })
})

describe('a case word the splitter reads as an argument (T4)', () => {
  it.each([
    'echo "$(repeat 1 case q in q) :;; esac)"',
    'echo "$(repeat 1 case q { q) :;; })"',
    'echo "$(repeat 1 case q {q) :;; })"',
    'echo "$(() { case q in q) :;; esac })"',
    'echo "$(() { case q\nin q) :;; esac })"',
    '(repeat 1 case q;in q) :;; esac)',
    'echo "$(repeat 1 case q # c\nin q) :;; esac)"',
    'echo "$(repeat 1 case q #\n{ q) :;; })"',
    'echo "$(repeat 1 case q\n# c\n\nin q) :;; esac)"',
    'echo "$(repeat 1 case q \\\n{ q) :;; })"',
  ])('is unreadable in a $( ) or subshell when in or { follows its subject: %s', line => {
    expect(expansionRisk(line)).toBe('unreadable')
  })

  it.each([
    'echo "$(echo case q)"',
    'echo "$(echo case q info)"',
    'echo "$(echo "case" q in)"',
    'echo case q in r',
  ])('is plain text elsewhere: %s', line => {
    expect(expansionRisk(line)).toBeUndefined()
  })
})
