import { describe, expect, it } from 'vitest'
import { expansionRisk, parseShell, type SimpleCommand } from '../leak-guard/shell-words.js'

// zsh's case grammar, where a pattern's `)` must not end a `$( )` (CC-1324).
const commandOf = (line: string, head: string): SimpleCommand => {
  const found = parseShell(line).findLast(cmd => cmd.words[0] === head)
  if (found === undefined) throw new Error(`no ${head} in ${line}`)
  return found
}

const PUSH = 'git push --no-verify'

const BODIES = [
  `case q in q) :;| r) echo "a" ;; esac; ${PUSH}`,
  `case q in q) :;|r) echo "a" ;; esac; ${PUSH}`,
  `case q in q) :\n;| r) echo "a" ;; esac; ${PUSH}`,
  `case q { q) echo "a"; }; ${PUSH}`,
  `case q {q) echo "a"; }; ${PUSH}`,
  `case q\n{ q) echo "a"; }; ${PUSH}`,
  `case q;{ q) echo "a"; }; ${PUSH}`,
  `case q { q|z) echo "a"; }; ${PUSH}`,
  `case q { (q) echo "a"; }; ${PUSH}`,
  `case q { q) echo "a" ;; esac; ${PUSH}`,
  `case q in q) echo "a" ;; }; ${PUSH}`,
  `case q { q) { :; } ;| r) echo "a";; }; ${PUSH}`,
  `case q;in q) :;; r) echo "a" ;; esac; ${PUSH}`,
  `case q\nin q) :;; r) echo "a" ;; esac; ${PUSH}`,
  `case q { q) :;; }; case r { r) echo "a";; }; ${PUSH}`,
  ...[';;', ';&', ';;&', ';|'].flatMap(op => [
    `case q in q) { :; }${op} r) echo "a";; esac; ${PUSH}`,
    `case q { q) { :; }${op} r) echo "a";; }; ${PUSH}`,
  ]),
  `case q in q) case r in r) :;; esac;; s) echo "a";; esac; ${PUSH}`,
]

describe('a zsh case keeps its $( ) whole', () => {
  it.each(BODIES)('quoted: %s', body => {
    const line = `echo "$(${body})"`
    expect(commandOf(line, 'echo').words).toEqual(['echo', `$(${body})`])
    expect(commandOf(line, 'git').words).toEqual(['git', 'push', '--no-verify'])
  })

  it.each(BODIES)('unquoted: %s', body => {
    const line = `echo $(${body}) z`
    expect(commandOf(line, 'echo').words).toEqual(['echo', `$(${body})`, 'z'])
    expect(commandOf(line, 'git').words).toEqual(['git', 'push', '--no-verify'])
  })
})

describe('words that close or open no case', () => {
  it('reads an argument } in a case body as text, as bash does', () => {
    const body = 'case q in q) echo };; r) git push;; esac'
    expect(commandOf(`echo $(${body}) z`, 'echo').words).toEqual(['echo', `$(${body})`, 'z'])
  })

  it('reads a { } group outside a case as before', () => {
    expect(commandOf('{ git status; }', '{').words).toEqual(['{', 'git', 'status'])
  })

  it('opens nothing on an in after a word that is not case', () => {
    expect(commandOf('echo $(x;in q) z', 'echo').words).toEqual(['echo', '$(x;in q)', 'z'])
  })
})

describe('a } where a pattern is due, before ) or |', () => {
  it.each([
    'echo "$(case q in q) :;; })"',
    'echo "$(case q in q) :;; } )"',
    '(case q in q) :;; }|r) :;; esac)',
  ])('is unreadable after in, since bash reads a pattern and zsh a close: %s', line => {
    expect(expansionRisk(line)).toBe('unreadable')
  })

  it.each([
    'echo "$(case q { q) :;; })"',
    'echo "$(case q in q) :;; };)"',
    'echo "$(case q in (}) :;; esac)"',
    'case q in q) :;; }|r) :;; esac',
    'echo "${ case q in q) :;; }) :;; esac; }"',
  ])('is read the one way that runs: %s', line => {
    expect(expansionRisk(line)).toBeUndefined()
  })
})

describe('a case word the splitter reads as an argument', () => {
  it.each([
    'echo "$(repeat 1 case q in q) :;; esac)"',
    'echo "$(repeat 1 case q { q) :;; })"',
    'echo "$(repeat 1 case q {q) :;; })"',
    'echo "$(() { case q in q) :;; esac })"',
    'echo "$(() { case q\nin q) :;; esac })"',
    '(repeat 1 case q;in q) :;; esac)',
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
