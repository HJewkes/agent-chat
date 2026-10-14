import { describe, expect, it } from 'vitest'
import { parseShell, unmark, type SimpleCommand } from '../leak-guard/shell-words.js'
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

const runsOf = (line: string) => {
  const [head = '', ...marked] = firstCommand(line).marked
  return scriptRuns(unmark(head), marked, [], SHELLS)
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
    ["printf 'git push' >> s", 'git push'],
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
    'cp a s',
  ])('%j writes nothing readable', line => {
    expect(writtenText(firstCommand(line))).toBeUndefined()
  })

  it('reads no text a pipe feeds tee', () => {
    expect(writtenText(lastCommand("printf 'git push' | tee s"))).toBeUndefined()
  })
})

describe('keepsContent', () => {
  it.each(['chmod +x s.sh', 'ls -l s.sh', 'cat s.sh', 'grep -l x s.sh', '/bin/chmod 755 s.sh'])(
    '%j keeps what the file holds',
    line => {
      expect(keepsContent(firstCommand(line))).toBe(true)
    },
  )

  it.each(['sed -i s/a/b/ s.sh', 'cp a s.sh', 'cat a > s.sh', 'chmod +x s.sh > log', '$C s.sh'])(
    '%j may change it',
    line => {
      expect(keepsContent(firstCommand(line))).toBe(false)
    },
  )
})

describe('scriptRuns', () => {
  it.each([
    ['bash s.sh', ['s.sh']],
    ['sh -eo pipefail s.sh', ['s.sh']],
    ['zsh s.sh x y', ['s.sh']],
    ['/bin/bash -- s.sh', ['s.sh']],
    ['bash --rcfile r -i', ['r']],
    ['source s.sh', ['s.sh']],
    ['. ./s.sh', ['./s.sh']],
    ['source -- s.sh', ['s.sh']],
    ['./s.sh', ['./s.sh']],
    ['/tmp/s.sh', ['/tmp/s.sh']],
    ['dir/s.sh a', ['dir/s.sh']],
  ])('%j runs %j', (line, words) => {
    expect(runWords(line)).toEqual(words)
  })

  it.each(["bash -c 'x'", 'bash', 'bash -s x', 'ls s.sh', 's.sh', 'source', '/bin/bash -c x'])(
    '%j runs no script file',
    line => {
      expect(runWords(line)).toEqual([])
    },
  )

  it.each(['bash $X', 'source -p d s', 'source $F', '. -x s'])('%j hides its script', line => {
    expect(runsOf(line)).toEqual({ hidden: true })
  })

  it('gives each run the operands after it, and marks a head run', () => {
    expect(runsOf('bash s.sh --no-verify x')).toEqual({
      runs: [{ word: 's.sh', args: ['--no-verify', 'x'], head: false }],
    })
    expect(runsOf('./s.sh --no-verify')).toEqual({
      runs: [{ word: './s.sh', args: ['--no-verify'], head: true }],
    })
    expect(runsOf('source -- s.sh a')).toEqual({
      runs: [{ word: 's.sh', args: ['a'], head: false }],
    })
  })
})

describe('foreignShebang', () => {
  it.each(['git push', '#!/bin/sh\ngit push', '#!/bin/bash -e\nx', '#!/usr/bin/env zsh\nx', '#! /bin/dash'])(
    '%j runs under a shell',
    body => {
      expect(foreignShebang(body, SHELLS)).toBe(false)
    },
  )

  it.each([
    '#!/usr/bin/python3\nx',
    '#!/usr/bin/env node\nx',
    '#!/usr/bin/env -S bash -e\nx',
    '#!/usr/bin/env\nx',
  ])('%j hands the file to another reader', body => {
    expect(foreignShebang(body, SHELLS)).toBe(true)
  })
})
