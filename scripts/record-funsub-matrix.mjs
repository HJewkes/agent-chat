#!/usr/bin/env node
// Records what bash 5.3 does with every three tokens before a `}` in a funsub, for
// src/__tests__/shell-words-funsub-matrix.test.ts (CC-1327). CI replays the fixture without bash 5.3.
// Usage: node scripts/record-funsub-matrix.mjs [bash] > src/__tests__/fixtures/funsub-token-matrix.json
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const bash = process.argv[2] ?? 'bash'
const RESERVED = ['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'case', 'esac', 'while', 'until']
const tokens = [
  ...RESERVED,
  ...['for', 'select', 'function', 'in', 'time', '!', '{', '}', '[[', ']]', 'coproc'],
  ...['-p', 'x=1', 'w', '|', '|&', ';', '&&', '\n', '('],
]
const openers = ['${ ', '${|']
// git reports whether it ran inside the funsub, where stdout is a file or REPLY is local, or outside it.
const prelude =
  'git() { if [[ $(readlink /proc/$$/fd/1) == /* ]] || declare -p REPLY >/dev/null 2>&1; then echo NESTED >&2; else echo TOP >&2; fi; }\n'

// The test builds the same line from the recorded openers and tokens.
const matrixLine = (open, a, b, c) => `echo "${open}${a} ${b} ${c} }; git push --no-verify; }"`

const lines = openers.flatMap(open =>
  tokens.flatMap(a => tokens.flatMap(b => tokens.map(c => matrixLine(open, a, b, c)))),
)
const dir = mkdtempSync(join(tmpdir(), 'funsub-matrix-'))

function run(line, i) {
  const file = join(dir, `${i}.sh`)
  writeFileSync(file, prelude + line + '\n')
  return new Promise(resolve => {
    const child = spawn('timeout', ['5', bash, file], { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    child.stderr.on('data', chunk => (err += chunk))
    child.on('close', () => resolve(/NESTED/.test(err) ? 'N' : /TOP/.test(err) ? 'T' : '-'))
  })
}

const results = new Array(lines.length)
let next = 0
async function worker() {
  while (next < lines.length) {
    const i = next++
    results[i] = await run(lines[i], i)
  }
}
await Promise.all(Array.from({ length: 16 }, worker))
rmSync(dir, { recursive: true, force: true })
const version = spawnSync(bash, ['-c', 'echo "$BASH_VERSION"'], { encoding: 'utf8' }).stdout.trim()
console.log(JSON.stringify({ bash: version, openers, tokens, results: results.join('') }))
