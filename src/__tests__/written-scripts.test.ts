import { describe, expect, it } from 'vitest'
import { parseReadings, parseShell, unmark, type SimpleCommand } from '../leak-guard/shell-words.js'
import { foreignShebang, keepsContent, scriptRuns, writtenText } from '../leak-guard/written-scripts.js'

// A script one command of a line writes and a later command runs (CC-1340).
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])

const firstCommand = (line: string): SimpleCommand => {
  const found = parseShell(line)[0]
  if (found === undefined) throw new Error(`no command in ${line}`)
  return found
}

/** The last command of the line, the one a writer piped into or the heredoc fed. */
const lastCommand = (line: string): SimpleCommand => {
  const found = parseShell(line).at(-1)
  if (found === undefined) throw new Error(`no command in ${line}`)
  return found
}

/** The runs of the line's last command, the one a pipe feeds. */
const runsOf = (line: string) => {
  const words = lastCommand(line).marked
  const assigns = words.slice(
    0,
    Math.max(
      0,
      words.findIndex(word => !/^\w+=/.test(word)),
    ),
  )
  const [head = '', ...marked] = words.slice(assigns.length)
  return scriptRuns(unmark(head), marked, assigns.map(unmark), SHELLS)
}

const runWords = (line: string): string[] => {
  const runs = runsOf(line)
  return 'runs' in runs ? runs.runs.map(run => unmark(run.word)) : ['<hidden>']
}

describe('writtenText', () => {
  it.each([
    ["cat > s <<'EOF'\ngit push --no-verify\nEOF", 'git push --no-verify'],
    ["cat <<'EOF' > s\na\\b $X\nEOF", 'a\\b $X'],
    ["tee s <<'EOF'\ngit push\nEOF", 'git push'],
    ["tee s >/dev/null <<'EOF'\nls\nEOF", 'ls'],
    ['echo git push --no-verify > s', 'git push --no-verify\n'],
    ['echo > s', '\n'],
    ["echo 'git  push' &> s", 'git  push\n'],
    ["printf 'git push --no-verify' > s", 'git push --no-verify'],
    ["printf 'git push' >| s", 'git push'],
  ])('%j writes %j', (line, text) => {
    expect(writtenText(firstCommand(line))).toBe(text)
  })

  it.each([
    'cat <<EOF > s\n$X\nEOF',
    'cat <<EOF > s\na\\$b\nEOF',
    'cat f > s',
    'cat - > s <<EOF\nx\nEOF',
    "cat <<'EOF'\nls\nEOF",
    'echo -e x > s',
    "echo 'a\\nb' > s",
    'echo $X > s',
    'echo $(date) > s',
    'echo git push',
    "printf '%s' x > s",
    "printf 'x\\n' > s",
    'printf a b > s',
    'printf -v v x',
    "printf -- 'x' > s",
    "tee s -a <<'EOF'\nx\nEOF",
    "tee -a s <<'EOF'\nx\nEOF",
    "tee $F <<'EOF'\nx\nEOF",
    'sed s/a/b/ f > s',
    "printf 'git push' >> s",
    "printf 'git push' &>> s",
    "printf 'git push' <> s",
    "printf '#' 1<> s",
    "printf 'git push' > s 2>> log",
    "tee s >> log <<'EOF'\nx\nEOF",
    "cat <<'EOF' >> s\nx\nEOF",
    'echo git push >> s',
    'cp a s',
  ])('%j writes nothing readable', line => {
    expect(writtenText(firstCommand(line))).toBeUndefined()
  })

  it('reads no text a bare append passes to the next command', () => {
    expect(writtenText(lastCommand(">> s\nprintf 'git push'"))).toBeUndefined()
  })

  it('reads no text for a target the line appends to elsewhere', () => {
    expect(writtenText(firstCommand("printf 'echo ech' > s; printf 'o RAN' >> s"))).toBeUndefined()
  })

  const pushWriter = (line: string): SimpleCommand => {
    const found = parseShell(line).find(cmd => cmd.words[0] === 'printf' && cmd.words[1] === 'git push')
    if (found === undefined) throw new Error(`no writer in ${line}`)
    return found
  }

  it.each([
    "printf 'git push' > s; : $(printf x >> s)",
    "printf 'git push' > s; : `printf x >> s`",
    "printf 'git push' > s; cat <(printf x >> s)",
    "printf 'git push' > s; (printf x >> s)",
    "printf 'git push' > s; { printf x >> s; }",
    "printf 'git push' > s; f() { printf x >> s; }",
    'printf \'git push\' > s; : "$(: $(printf x >> s))"',
    "exec 3>s; printf 'git push' > s; printf x >&3",
    "exec {fd}>s; printf 'git push' > s",
    "printf 'git push' > s; exec >s",
    "printf 'git push' > s; printf x 3> s",
    "printf 'git push' > s; printf x > s",
    "printf 'git push' > s; printf x | tee s",
    "printf 'git push' > s; printf x | tee -a s",
    "printf 'git push' > s; { printf x; } > s",
    "printf 'git push' > s & printf x > ./s",
    "printf 'git push' > s | printf x > ./s",
    "printf 'git push' > s; printf x > //s",
    "printf 'git push' > s; printf x > s/",
    "printf 'git push' > s; printf x > $PWD/s",
    "printf 'git push' > s; printf x > ~/s",
    'printf \'git push\' > s; printf x > "$F"',
    "printf 'git push' > s; printf x > $(echo s)",
    "printf 'git push' > s; printf x > `echo s`",
    "printf 'git push' > s; cd d; printf x > d/s",
    "printf 'git push' > ./s; printf x > s",
    "printf 'git push' > s; printf x | tee ./s",
  ])('%j reads no text for a file another open on the line may change', line => {
    expect(writtenText(pushWriter(line))).toBeUndefined()
  })

  it.each([
    '( x ) > ./s',
    '( x ) >| s',
    '( x ) >> s',
    '( x ) &> s',
    '( x ) &>> s',
    '( x ) <> s',
    '( x ) 3> s',
    '( x ) >& s',
    '(x)>s',
    '( ( x ) ) > s',
    '{ x; } > s',
    'while a; do x; done > s',
    'until a; do x; done > s',
    'for i in a; do x; done > s',
    'select i in a; do x; done > s',
    'if a; then x; fi > s',
    'case a in b) x;; esac > s',
    '[[ a ]] > s',
    '(( 1 )) > s',
    'f() { x; } > s',
    'f() ( x ) > s',
    'coproc ( x ) > s',
    'x >& ./s',
    ': $( > s )',
  ])('reads no text when %j also opens the file', other => {
    expect(writtenText(pushWriter(`printf 'git push' > s & ${other}`))).toBeUndefined()
    expect(writtenText(pushWriter(`printf 'git push' > s; ${other}`))).toBeUndefined()
  })

  // Observed in zsh 5.9 (`zsh -f`): after `echo safe > s`, each leaves `safe evil` or `evil` in s.
  it.each(['>>|', '>>&', '>&|', '&>>|', '&>|', '>!', '>>!', '>&!', '&>!', '>>&!', '&>>!'])(
    'reads no text for a file a later zsh %j write opens',
    op => {
      expect(writtenText(pushWriter(`printf 'git push' > s; echo evil ${op} s`))).toBeUndefined()
      expect(writtenText(pushWriter(`printf 'git push' > s; echo evil ${op}s`))).toBeUndefined()
      expect(writtenText(pushWriter(`printf 'git push' ${op} s`))).toBeUndefined()
    },
  )

  // bash reads `>!s` as a write to the file `!s`, and `>! s` as a write to `!`; zsh writes s.
  it.each(["printf 'git push' > '!s'; echo evil >!s", "printf 'git push' > '!'; echo evil >! s"])(
    '%j reads the text in zsh and none in bash, which writes the file again',
    line => {
      const texts = parseReadings(line).map(commands => {
        const writer = commands.find(cmd => cmd.words[0] === 'printf' && cmd.words[1] === 'git push')
        return writer && writtenText(writer)
      })
      expect(texts).toEqual(['git push', undefined])
    },
  )

  it('reads an operator it does not know as one that keeps the file', () => {
    expect(writtenText(pushWriter("printf 'git push' > s; x >&>> s"))).toBeUndefined()
    expect(writtenText(pushWriter("printf 'git push' >&>> s"))).toBeUndefined()
  })

  it('reads no text a later compound command overwrites', () => {
    const line = "printf ok > s; ( printf 'git push --no-verify' ) > s"
    expect(writtenText(firstCommand(line))).toBeUndefined()
  })

  it('reads no text for a command after a compound redirect it does not own', () => {
    expect(writtenText(lastCommand("( x ) > s; printf 'git push'"))).toBeUndefined()
  })

  it.each([
    ["printf 'git push' > s; : $(printf x > t)", 'git push'],
    ["printf 'git push' > s; printf x | tee t", 'git push'],
    ["printf 'git push' > s; exec 3>t", 'git push'],
    ["printf 'git push' > s; printf x > ./t", 'git push'],
    ["printf 'git push' > d/s; printf x > d/t/", 'git push'],
    ["printf 'git push' > ./s & printf x > /tmp/t", 'git push'],
    ["printf 'git push' > s", 'git push'],
    ["printf 'git push' > s; ( x ) 2>&1", 'git push'],
    ["printf 'git push' > s; x >&-", 'git push'],
    ["printf 'git push' > s; cat < s", 'git push'],
    ["printf 'git push' > s; cat <& 3", 'git push'],
    ["printf 'git push' > s; echo x >! t", 'git push'],
    ["printf 'git push' > s; ( x ) > t", 'git push'],
  ])('%j still reads the text when other opens name other files', (line, text) => {
    expect(writtenText(pushWriter(line))).toBe(text)
  })

  it('reads no text for a tee whose file the line appends to elsewhere', () => {
    expect(writtenText(firstCommand("tee s <<'EOF'\nls\nEOF\nprintf x >> s"))).toBeUndefined()
  })

  it('reads no text a pipe feeds tee', () => {
    expect(writtenText(lastCommand("printf 'git push' | tee s"))).toBeUndefined()
  })
})

describe('keepsContent', () => {
  it.each(['chmod +x s.sh', 'ls -l s.sh', 'cat s.sh', 'grep -l x s.sh'])(
    '%j keeps what the file holds',
    line => {
      expect(keepsContent(firstCommand(line))).toBe(true)
    },
  )

  it.each([
    'sed -i s/a/b/ s.sh',
    'cp a s.sh',
    'cat a > s.sh',
    'chmod +x s.sh > log',
    '$C s.sh',
    './cat s.sh',
    '/bin/chmod 755 s.sh',
  ])('%j may change it', line => {
    expect(keepsContent(firstCommand(line))).toBe(false)
  })
})

describe('scriptRuns', () => {
  it.each([
    ['bash s.sh', ['s.sh']],
    ['sh -eo pipefail s.sh', ['s.sh']],
    ['zsh s.sh x y', ['s.sh']],
    ['/bin/bash -- s.sh', ['/bin/bash', 's.sh']],
    ['./sh s.sh', ['./sh', 's.sh']],
    ['source s.sh', ['s.sh']],
    ['. ./s.sh', ['./s.sh']],
    ['source -- s.sh', ['s.sh']],
    ['./s.sh', ['./s.sh']],
    ['/tmp/s.sh', ['/tmp/s.sh']],
    ['dir/s.sh a', ['dir/s.sh']],
  ])('%j runs %j', (line, words) => {
    expect(runWords(line)).toEqual(words)
  })

  it.each(["bash -c 'x'", 'ls s.sh', 's.sh', 'source'])('%j runs no script file', line => {
    expect(runsOf(line)).toEqual({ runs: [], stdin: false })
  })

  it.each(['bash', 'bash -s x', 'bash < f', 'sh -s < f', 'cat f | bash', "printf 'x' | sh"])(
    '%j runs the script on its stdin',
    line => {
      expect(runsOf(line)).toEqual({ runs: [], stdin: true })
    },
  )

  it.each([
    ['/bin/bash -c x', { runs: [{ word: '/bin/bash', args: ['-c', 'x'], head: true }], stdin: false }],
    ['./bash', { runs: [{ word: './bash', args: [], head: true }], stdin: true }],
    ['/tmp/x/zsh -s', { runs: [{ word: '/tmp/x/zsh', args: ['-s'], head: true }], stdin: true }],
  ])('%j runs its own path as well as the shell call', (line, runs) => {
    expect(runsOf(line)).toEqual(runs)
  })

  it.each([
    'bash $X',
    'source -p d s',
    'source $F',
    '. -x s',
    'bash --rcfile r -i',
    'bash -i s.sh',
    'zsh -i s.sh',
    'BASH_ENV=x bash s.sh',
    './bash -i s.sh',
  ])('%j hides its script', line => {
    expect(runsOf(line)).toEqual({ hidden: true })
  })

  // bash reads `>! s` as a write to the file `!`, leaving s an operand; zsh reads it as a write to s.
  it.each([
    ['bash >! s', []],
    ['source >! s', []],
    ['bash >>! s', []],
    ['bash >&! s', []],
    ['bash &>! s', []],
    ['bash &>>! s', []],
    ['bash >! s -x', ['-x']],
  ])('%j runs s in its bash reading only', (line, args) => {
    const [zsh, bash] = parseReadings(line).map(([cmd]) => cmd?.marked)
    const runs = (marked: string[] | undefined) =>
      scriptRuns(unmark(marked?.[0] ?? ''), marked?.slice(1) ?? [], [], SHELLS)
    expect(runs(bash)).toEqual({ runs: [{ word: 's', args, head: false }], stdin: false })
    expect(runs(zsh)).toEqual({ runs: [], stdin: line.startsWith('bash') })
  })

  it('gives each run the operands after it, and marks a head run', () => {
    expect(runsOf('bash s.sh --no-verify x')).toEqual({
      runs: [{ word: 's.sh', args: ['--no-verify', 'x'], head: false }],
      stdin: false,
    })
    expect(runsOf('./s.sh --no-verify')).toEqual({
      runs: [{ word: './s.sh', args: ['--no-verify'], head: true }],
      stdin: false,
    })
    expect(runsOf('source -- s.sh a')).toEqual({
      runs: [{ word: 's.sh', args: ['a'], head: false }],
      stdin: false,
    })
  })
})

describe('foreignShebang', () => {
  it.each([
    'git push',
    '#!/bin/sh\ngit push',
    '#!/bin/bash -e\nx',
    '#!/usr/bin/env zsh\nx',
    '#! /bin/dash',
    '#!/usr/bin/env /bin/sh\nx',
    '#!/bin/sh -\nx',
    '#!/usr/bin/env bash\nx',
    '#!/usr/local/bin/zsh\nx',
    '#!/opt/homebrew/bin/bash\nx',
  ])('%j runs under a shell', body => {
    expect(foreignShebang(body, SHELLS)).toBe(false)
  })

  it.each([
    '#!/usr/bin/python3\nx',
    '#!/usr/bin/env node\nx',
    '#!/usr/bin/env -S bash -e\nx',
    '#!/usr/bin/env\nx',
    '#!sh\nx',
    '#!./bash\nx',
    '#!bin/sh\nx',
    '#! sh\nx',
    '#!/usr/bin/env ./bash\nx',
    '#!/tmp/x/bash\nx',
    '#!/usr/bin/env /tmp/x/bash\nx',
    '#!/bin/../tmp/sh\nx',
    '#!/bin/./sh\nx',
    '#!//bin/sh\nx',
    '#!/tmp/env bash\nx',
    '#!/bin/bash -i\nx',
    '#!/bin/zsh -i\nx',
    '#!/usr/bin/env bash -i\nx',
    '#!/bin/bash -c\nx',
    '#!/bin/bash -s\nx',
    '#!/bin/bash -e -x\nx',
  ])('%j hands the file to another reader', body => {
    expect(foreignShebang(body, SHELLS)).toBe(true)
  })
})
