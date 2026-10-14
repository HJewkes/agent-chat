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
    'zsh -O -i',
    'zsh -Oi',
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
    ['BASH_ENV=./rc bash s.sh', 0, true],
    ['ENV=./rc sh s.sh', 0, true],
    ['bash -l s.sh', 1, true],
    ['bash --login s.sh', 1, true],
    ['zsh + -s', 1, false],
    ['zsh +- -s', 1, false],
    ['zsh + -i', 1, false],
    ['zsh +- -i s.sh', 1, false],
    ['bash + -i s.sh', 2, true],
    ['ksh +i s.sh', 1, true],
    ['ksh + -i s.sh', 2, true],
    ['zsh -O s.sh', 1, false],
    ['zsh +O x', 1, false],
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
    'ksh -ox pipefail s.sh',
    'ksh -oemacs s.sh',
    'ksh -ointeractive s.sh',
    'ksh -oposix s.sh',
    "ksh -oemacs <<'EOF'\necho hi\nEOF",
    'bash -e "$X" <<<x',
    'bash *.sh',
  ])('%s hides its options', line => {
    expect(call(line)).toEqual({ script: { from: 'hidden' }, history: true })
  })

  it.each([
    ['ksh -ic x', 1],
    ['ksh -c x', 1],
    ['tcsh -c x', 1],
    ['csh -c x', 1],
  ])('%s runs the string at %s and reports history, as an unobserved shell', (line, at) => {
    expect(call(line)).toEqual({ script: { from: 'command', at }, history: true })
  })

  it('reads an expansion after the options as an operand', () => {
    expect(call('bash -- $X')).toEqual({ script: { from: 'file', at: 1 }, history: false })
  })
})

type Effect = 'stdin' | 'command' | 'history' | 'end'

// Each spelling observed to take effect on zsh 5.9, bash 5.3 or dash, run with a script file and a here-string.
const SPELLINGS: Record<string, Record<Effect, string[]>> = {
  zsh: {
    stdin: [
      '-s',
      '-o shinstdin',
      '-o shin_stdin',
      '-o SHIN_STDIN',
      '-o stdin',
      '-oshinstdin',
      '--shinstdin',
      '--stdin',
      '--shin-stdin',
      '+o noshinstdin',
      '+-noshinstdin',
    ],
    history: [
      '-i',
      '-o INTERACTIVE',
      '-ointeractive',
      '--interactive',
      '+o nointeractive',
      '+-nointeractive',
      '+K',
      '-o BANG_HIST',
      '-obanghist',
      '--banghist',
      '+o nobanghist',
      '+-nobanghist',
      '-o HIST_EXPAND',
      '-l',
      '-o LOGIN',
      '-ologin',
      '--login',
      '+o nologin',
      '+-nologin',
    ],
    command: ['-c', '+c'],
    end: ['-b', '+b'],
  },
  bash: {
    stdin: ['-s', '+s'],
    history: ['-i', '-H', '-o history', '-o histexpand', '-l', '--login'],
    command: ['-c', '+c'],
    end: [],
  },
  dash: {
    stdin: ['-s', '-o stdin'],
    history: ['-i', '-o interactive', '-l'],
    command: ['-c', '+c'],
    end: [],
  },
}

// Each spelling observed to leave its option off.
const OFF: Record<string, Record<'stdin' | 'history', string[]>> = {
  zsh: {
    stdin: ['+s', '+o shinstdin', '-o noshinstdin', '+-shinstdin', '--noshinstdin'],
    history: ['-K', '+i', '+o interactive', '-o nointeractive', '+-interactive'],
  },
  bash: { stdin: [], history: ['+i', '+o history', '+o histexpand', '+H'] },
  dash: { stdin: ['+s'], history: ['+i'] },
}

const rows = <K extends string>(table: Record<string, Record<K, string[]>>, effect: K) =>
  Object.entries(table).flatMap(([shell, byEffect]) => byEffect[effect].map(sp => `${shell} ${sp}`))

const operands = (line: string): number => line.split(' ').length - 1

describe('every spelling of an option reaches its effect (CC-1288)', () => {
  it.each(rows(SPELLINGS, 'stdin'))('%s s.sh reads stdin', line => {
    expect(call(`${line} s.sh`).script).toEqual({ from: 'stdin' })
  })

  it.each(rows(SPELLINGS, 'history'))('%s s.sh reports history', line => {
    expect(call(`${line} s.sh`)).toEqual({ script: { from: 'file', at: operands(line) }, history: true })
  })

  it.each(rows(SPELLINGS, 'command'))("%s 'x' runs the string", line => {
    expect(call(`${line} 'x'`).script).toEqual({ from: 'command', at: operands(line) })
  })

  it.each(rows(SPELLINGS, 'end'))('%s -c x ends the options', line => {
    expect(call(`${line} -c x`).script).toEqual({ from: 'file', at: operands(line) })
  })

  it.each(rows(OFF, 'stdin'))('%s s.sh reads the file', line => {
    expect(call(`${line} s.sh`).script).toEqual({ from: 'file', at: operands(line) })
  })

  it.each(rows(OFF, 'history'))('%s s.sh reports no history', line => {
    expect(call(`${line} s.sh`).history).toBe(false)
  })
})

/**
 * Each observed shell's operand-taking options, with an operand the shell accepts, and the letters
 * observed to take none (zsh's `-O`). Every row ends `-i s.sh`, so an operand read wrongly either
 * swallows `-i` or leaves the operand as the script file. Run against zsh 5.9, bash 5.3 and dash;
 * the `sh` rows hold for bash as `sh`, and dash as `sh` rejects `-O` and runs nothing.
 */
const OPERANDS: Record<
  string,
  { named: Record<string, string>; plain: string[]; long: Record<string, string> }
> = {
  zsh: { named: { o: 'extendedglob' }, plain: ['O'], long: { '--emulate': 'zsh' } },
  bash: { named: { o: 'pipefail', O: 'extglob' }, plain: [], long: { '--rcfile': 'x', '--init-file': 'x' } },
  dash: { named: { o: 'nolog' }, plain: [], long: {} },
  sh: { named: { o: 'nolog', O: 'extglob' }, plain: [], long: {} },
}

const RCFILES = new Set(['--rcfile', '--init-file'])

const operandRows = Object.entries(OPERANDS).flatMap(([shell, { named, long }]) => [
  ...Object.entries(named).flatMap(([letter, operand]) =>
    ['-', '+'].map(sign => `${shell} ${sign}${letter} ${operand}`),
  ),
  ...Object.entries(long).map(([option, operand]) => `${shell} ${option} ${operand}`),
])

const sourced = (line: string) => (RCFILES.has(line.split(' ')[1] ?? '') ? { rcfile: 1 } : {})

const plainRows = Object.entries(OPERANDS).flatMap(([shell, { plain }]) =>
  plain.flatMap(letter => ['-', '+'].map(sign => `${shell} ${sign}${letter}`)),
)

describe("each shell's options that take an operand (CC-1288)", () => {
  it.each(operandRows)('%s -i s.sh reads the operand and then -i', line => {
    expect(call(`${line} -i s.sh`)).toEqual({
      script: { from: 'file', at: 3 },
      history: true,
      ...sourced(line),
    })
  })

  it.each(plainRows)('%s -i s.sh takes no operand', line => {
    expect(call(`${line} -i s.sh`)).toEqual({ script: { from: 'file', at: 2 }, history: true })
  })
})

describe('where dash and bash read the script source differently (CC-1288)', () => {
  // Observed: dash runs f.sh, bash reads stdin; `sh` may be either.
  it.each(['sh +s f.sh', 'sh +es f.sh', 'sh +is f.sh', 'sh +xs f.sh', 'sh +ls f.sh', 'sh +sx f.sh'])(
    '%s hides the call',
    line => {
      expect(call(line)).toEqual({ script: { from: 'hidden' }, history: true })
    },
  )

  // Observed: dash runs the -c string and then stdin.
  it.each([
    "dash -s -c 'x'",
    "dash -sc 'x'",
    "dash -cs 'x'",
    "dash -o stdin -c 'x'",
    "sh -s -c 'x'",
    "sh -sc 'x'",
  ])('%s runs two scripts, so it hides the call', line => {
    expect(call(line)).toEqual({ script: { from: 'hidden' }, history: true })
  })

  // Observed: bash and zsh run only the -c string, and dash +s leaves stdin off.
  it.each([
    ["bash -s -c 'x'", 2],
    ["bash -sc 'x'", 1],
    ["bash -cs 'x'", 1],
    ["zsh -sc 'x'", 1],
    ["dash +s -c 'x'", 2],
  ])('%s runs only the string at %s', (line, at) => {
    expect(call(line)).toEqual({ script: { from: 'command', at }, history: false })
  })
})

describe('a startup file bash runs when interactive (CC-1288)', () => {
  it.each([
    ['bash --rcfile rc -i f.sh', { script: { from: 'file', at: 3 }, history: true, rcfile: 1 }],
    ['bash --init-file rc -i f.sh', { script: { from: 'file', at: 3 }, history: true, rcfile: 1 }],
    ["bash --init-file rc -ic 'x'", { script: { from: 'command', at: 3 }, history: false, rcfile: 1 }],
    ['bash --rcfile rc f.sh', { script: { from: 'file', at: 2 }, history: false }],
  ])('%s', (line, expected) => {
    expect(call(line)).toEqual(expected)
  })
})
