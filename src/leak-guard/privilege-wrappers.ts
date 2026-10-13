/**
 * Option parsers for the privilege wrappers other than sudo: doas, run0, pkexec and su (CC-1218).
 * Each returns where the command it runs starts, or the words of the shell it runs instead, so
 * the guard can read that command. Any option a table here does not know, and any option word
 * the shell expands, gives undefined: the caller denies rather than guess where the command starts.
 * Tables: run0 (systemd 259) and su (util-linux) from `--help`, pkexec (polkit 127) from its usage,
 * doas from the OpenBSD and opendoas getopt string `+a:C:Lnsu:` (UNVERIFIED on this box).
 */

import { LIVE } from './shell-words.js'

/** The command's first word, or the argv of the shell the wrapper hands the command to. */
export type PrivilegeRun = { at: number } | { shell: string[] }

interface Getopt {
  shortValue: string
  shortFlag: string
  /** Letters that run the command through the target user's shell. */
  shortShell: string
  longValue: ReadonlySet<string>
  longFlag: ReadonlySet<string>
  longShell: ReadonlySet<string>
}

const DOAS: Getopt = {
  shortValue: 'aCu',
  shortFlag: 'Ln',
  shortShell: 's',
  longValue: new Set(),
  longFlag: new Set(),
  longShell: new Set(),
}

const RUN0: Getopt = {
  shortValue: 'ugD',
  shortFlag: 'hV',
  shortShell: 'i',
  longValue: new Set([
    '--machine',
    '--unit',
    '--property',
    '--description',
    '--slice',
    '--user',
    '--group',
    '--nice',
    '--chdir',
    '--setenv',
    '--background',
    '--shell-prompt-prefix',
    '--lightweight',
    '--area',
  ]),
  longFlag: new Set([
    '--no-ask-password',
    '--slice-inherit',
    '--pty',
    '--pty-late',
    '--pipe',
    '--empower',
    '--help',
    '--version',
  ]),
  longShell: new Set(['--via-shell']),
}

export const PRIVILEGE_WRAPPERS: ReadonlySet<string> = new Set(['doas', 'run0', 'pkexec', 'su'])

/** What `name` (one of PRIVILEGE_WRAPPERS) runs when its options start at `words[i]`. */
export function dropPrivilegeOptions(
  name: string,
  words: readonly string[],
  i: number,
): PrivilegeRun | undefined {
  if (name === 'doas') return readGetopt(DOAS, words, i)
  if (name === 'run0') return readGetopt(RUN0, words, i)
  if (name === 'pkexec') return readPkexec(words, i)
  if (name === 'su') return readSu(words, i)
  return undefined
}

/** A shell run on the words joined, each character but alnum, _, - and $ escaped, as sudo -s does. */
const joinedShell = (words: readonly string[]): string[] =>
  words.length === 0 ? ['sh'] : ['sh', '-c', words.map(w => w.replace(/[^A-Za-z0-9_$-]/g, '\\$&')).join(' ')]

interface Option {
  width: number
  shell: boolean
}

/** A getopt reader that stops at the first operand, as doas's `+` and run0's option strings do. */
function readGetopt(g: Getopt, words: readonly string[], i: number): PrivilegeRun | undefined {
  let shell = false
  for (; i < words.length; i++) {
    const a = words[i] as string
    if (a === '--') {
      i++
      break
    }
    if (!a.startsWith('-') || a === '-') break
    if (a.includes(LIVE)) return undefined
    const option = a.startsWith('--') ? longOption(g, a) : shortCluster(g, a)
    if (option === undefined) return undefined
    shell ||= option.shell
    i += option.width
  }
  const at = Math.min(i, words.length)
  return shell ? { shell: joinedShell(words.slice(at)) } : { at }
}

function longOption(g: Getopt, option: string): Option | undefined {
  const name = option.split('=')[0] as string
  const glued = option.includes('=')
  if (g.longValue.has(name)) return { width: glued ? 0 : 1, shell: false }
  if (glued) return undefined
  if (g.longFlag.has(name)) return { width: 0, shell: false }
  if (g.longShell.has(name)) return { width: 0, shell: true }
  return undefined
}

/** A short cluster takes the next word only when its first value letter ends it. */
function shortCluster(g: Getopt, cluster: string): Option | undefined {
  let shell = false
  for (let k = 1; k < cluster.length; k++) {
    const letter = cluster[k] as string
    if (g.shortValue.includes(letter)) return { width: k === cluster.length - 1 ? 1 : 0, shell }
    if (g.shortShell.includes(letter)) shell = true
    else if (!g.shortFlag.includes(letter)) return undefined
  }
  return { width: 0, shell }
}

const PKEXEC_FLAG = new Set(['--keep-cwd', '--disable-internal-agent', '--help', '--version'])

/** pkexec matches whole words only; anything starting with `-` it does not list fails closed. */
function readPkexec(words: readonly string[], i: number): PrivilegeRun | undefined {
  for (; i < words.length; i++) {
    const a = words[i] as string
    if (!a.startsWith('-')) break
    if (a === '--user') i++
    else if (!PKEXEC_FLAG.has(a)) return undefined
  }
  return { at: Math.min(i, words.length) }
}

const SU_SHORT_VALUE = 'cgGsw'
const SU_SHORT_FLAG = 'lfmpPThV'
const SU_LONG_VALUE: ReadonlyMap<string, string> = new Map([
  ['--command', 'c'],
  ['--session-command', 'c'],
  ['--shell', 's'],
  ['--group', 'g'],
  ['--supp-group', 'G'],
  ['--whitelist-environment', 'w'],
])
const SU_LONG_FLAG = new Set([
  '--login',
  '--fast',
  '--preserve-environment',
  '--pty',
  '--no-pty',
  '--help',
  '--version',
])
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])

/** One su option word: how many words after it its value takes, and the value of -c or -s. */
interface SuOption {
  width: number
  letter?: string
  value?: string
}

/**
 * util-linux su permutes, so options after the user still count. Its first operand is the user and
 * the rest are arguments to the shell, which runs -c's value when one is given.
 */
function readSu(words: readonly string[], i: number): PrivilegeRun | undefined {
  const values = new Map<string, string>()
  const operands: string[] = []
  for (; i < words.length; i++) {
    const a = words[i] as string
    if (a === '--') {
      operands.push(...words.slice(i + 1))
      break
    }
    // An expanded word may be an option wherever it sits, since su reads options past the user.
    if (a.includes(LIVE)) return undefined
    if (!a.startsWith('-') || a === '-') {
      if (a !== '-') operands.push(a)
      continue
    }
    const option = a.startsWith('--') ? suLong(a, words[i + 1]) : suCluster(a, words[i + 1])
    if (option === undefined) return undefined
    if (option.letter !== undefined && option.value !== undefined) values.set(option.letter, option.value)
    i += option.width
  }
  return suShell(values, operands.slice(1))
}

function suShell(values: ReadonlyMap<string, string>, args: readonly string[]): PrivilegeRun | undefined {
  const shell = values.get('s')
  if (shell !== undefined && (shell.includes(LIVE) || !SHELLS.has(shell.split('/').pop() as string)))
    return undefined
  const command = values.get('c')
  return { shell: command === undefined ? ['sh', ...args] : ['sh', '-c', command, ...args] }
}

function suLong(option: string, next: string | undefined): SuOption | undefined {
  const [name, ...rest] = option.split('=')
  const letter = SU_LONG_VALUE.get(name as string)
  if (letter === undefined)
    return rest.length === 0 && SU_LONG_FLAG.has(name as string) ? { width: 0 } : undefined
  if (rest.length > 0) return { width: 0, letter, value: rest.join('=') }
  return next === undefined ? undefined : { width: 1, letter, value: next }
}

/** A value letter takes the rest of its cluster, or the next word when it ends the cluster. */
function suCluster(cluster: string, next: string | undefined): SuOption | undefined {
  for (let k = 1; k < cluster.length; k++) {
    const letter = cluster[k] as string
    if (SU_SHORT_VALUE.includes(letter)) {
      if (k < cluster.length - 1) return { width: 0, letter, value: cluster.slice(k + 1) }
      return next === undefined ? undefined : { width: 1, letter, value: next }
    }
    if (!SU_SHORT_FLAG.includes(letter)) return undefined
  }
  return { width: 0 }
}
