import { describe, expect, it } from 'vitest'
import { readShellCall, type ShellCall } from '../leak-guard/shell-invocation.js'
import { parseShell } from '../leak-guard/shell-words.js'

const ASSIGNMENT = /^[A-Za-z_]\w*=/

const call = (line: string): ShellCall => {
  const cmd = parseShell(line)[0]
  if (cmd === undefined) throw new Error(`no command in ${line}`)
  const name = cmd.words.findIndex(word => !ASSIGNMENT.test(word))
  return readShellCall(cmd.words[name] ?? '', cmd.marked.slice(name + 1), cmd.marked.slice(0, name))
}

describe("a shell's options and the script it reads (CC-1288)", () => {
  it.each([
    'bash',
    'bash -eo pipefail',
    'bash -e -o pipefail',
    'bash -O extglob',
    'bash +o history',
    'bash --rcfile /dev/null',
    'bash -s foo',
    'bash -s -- foo',
    'bash --',
    'bash -x',
    'zsh -o extendedglob',
    'zsh -o nobanghist',
    'zsh -K',
    'zsh +-interactive',
    'zsh --no-interactive',
    'bash -s foo -i',
  ])('%s reads stdin without history', line => {
    expect(call(line)).toEqual({ script: { from: 'stdin' }, history: false })
  })

  it.each([
    'bash -H',
    'bash -o histexpand',
    'bash -o history',
    'bash -o history -H',
    'bash -i',
    'bash -is',
    'bash --norc -i',
    "bash '-i'",
    'zsh -i',
    'zsh -o BANG_HIST',
    'zsh -o bang-hist',
    'zsh +o nobanghist',
    'zsh --interactive',
    'zsh +K',
    'zsh -ointeractive',
    'zsh -xointeractive',
    'zsh +onobanghist',
    'zsh +-nointeractive',
    'zsh --emulate zsh -i',
    'zsh --emulate ksh -o banghist -i',
    'zsh -isb',
    'SHELLOPTS=history:histexpand bash',
  ])('%s reads stdin with history', line => {
    expect(call(line)).toEqual({ script: { from: 'stdin' }, history: true })
  })

  it.each([
    ['bash s.sh', 0, false],
    ['bash -i s.sh', 1, true],
    ['bash -eo pipefail s.sh', 2, false],
    ['bash --rcfile x s.sh', 2, false],
    ['SHELLOPTS=history bash s.sh', 0, true],
    ['zsh -b -i', 1, false],
    ['zsh -ib s.sh', 1, true],
    ['zsh --emulate sh s.sh', 2, false],
    ['bash -oi pipefail s.sh', 2, true],
    ['bash -oO pipefail extglob s.sh', 3, false],
    ['dash -oi nolog s.sh', 2, true],
    ['sh -ox pipefail s.sh', 2, false],
    ['ksh -ox pipefail s.sh', 2, true],
  ])('%s reads the file at %i', (line, at, history) => {
    expect(call(line)).toEqual({ script: { from: 'file', at }, history })
  })

  it.each([
    ["bash -c 'x'", 1],
    ["bash -Hc 'x'", 1],
    ["bash -Ec 'x'", 1],
    ["bash -c -- 'x'", 2],
    ["bash -c -e 'x'", 2],
    ["bash -lc 'x'", 1],
    ["bash -ic 'x'", 1],
    ["bash -O extglob -c 'x'", 3],
    ["zsh -c -x 'x'", 2],
    ["zsh --emulate sh -c 'x'", 3],
    ["zsh -bc 'x'", 1],
    ["bash -oc pipefail 'x'", 2],
    ["dash -oc nolog 'x'", 2],
    ["SHELLOPTS=history:histexpand bash -c 'x'", 1],
    ['bash -c', undefined],
  ])('%s runs the string at %s, without history', (line, at) => {
    expect(call(line)).toEqual({ script: { from: 'command', at }, history: false })
  })

  it.each([
    'bash $X',
    'bash "-$Y"',
    'bash -o $X',
    'bash -o$X',
    'zsh --emulate $E -i',
    'bash -e "$X" <<<x',
    'bash *.sh',
  ])('%s hides its options', line => {
    expect(call(line)).toEqual({ script: { from: 'hidden' }, history: true })
  })

  it('reads an expansion after the options as an operand', () => {
    expect(call('bash -- $X')).toEqual({ script: { from: 'file', at: 1 }, history: false })
  })
})
