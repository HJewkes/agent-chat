/**
 * Option parsers for the privilege wrappers other than sudo: doas, run0 and systemd-run (one
 * binary), pkexec, su and su-rs, runuser, setpriv and machinectl shell (CC-1218).
 * Each returns where the command it runs starts, or the words of the shell it runs instead, so
 * the guard can read that command. An option a table here does not know, an option with no value,
 * and any option word or value the shell expands give undefined: the caller denies rather than
 * guess where the command starts (an empty unquoted `-u $U` shifts every word after it).
 * Tables: run0 and systemd-run (systemd 259), su, runuser and setpriv (util-linux) and su-rs
 * (sudo-rs) from `--help`, pkexec (polkit 127) from its usage, doas from the OpenBSD and opendoas
 * getopt string `+a:C:Lnsu:`, and machinectl from systemd's docs (doas and machinectl UNVERIFIED on this box).
 */

import { LIVE } from './shell-words.js'

/** The command's first word, or the argv of the shell the wrapper hands the command to. */
export type PrivilegeRun = { at: number } | { shell: string[] }

export interface OptionTable {
  shortValue: string
  shortFlag: string
  /** Letters that run the command through the target user's shell. */
  shortShell: string
  longValue: ReadonlySet<string>
  longFlag: ReadonlySet<string>
  longShell: ReadonlySet<string>
  /** Whether a long option takes its value glued as `--name=value`; pkexec matches whole words only. */
  gluedLong: boolean
  /** Whether the wrapper with no command runs the target user's shell. */
  bareShell: boolean
  /** Whether an option's value may stand; a unit property not allow-listed may set what runs. */
  allows?: (key: string, value: string) => boolean
  /** How the wrapper's words read, when not as getopt stopping at the first operand. */
  read?: Reader
}

type Reader = (t: OptionTable, words: readonly string[], i: number) => PrivilegeRun | undefined

/**
 * Unit properties that bound resources or timing only: none sets what runs, its stdin, environment,
 * working directory or user. Growing this set is a reviewed table edit.
 */
const ALLOWED_PROPERTIES: ReadonlySet<string> = new Set([
  ...['CPUQuota', 'CPUWeight', 'StartupCPUWeight', 'AllowedCPUs', 'MemoryMin', 'MemoryLow'],
  ...['MemoryHigh', 'MemoryMax', 'MemorySwapMax', 'TasksMax', 'IOWeight', 'Nice'],
  ...['CPUSchedulingPolicy', 'CPUSchedulingPriority', 'RuntimeMaxSec', 'TimeoutStopSec'],
])
const PROPERTY_KEYS: ReadonlySet<string> = new Set(['p', '--property'])
const OTHER_UNIT_PROPERTIES: ReadonlySet<string> = new Set([
  '--path-property',
  '--socket-property',
  '--timer-property',
])

/** The property name is the text before the first `=`, compared exactly, so `' ExecStart=…'` is not `ExecStart`. */
function allowedProperty(key: string, value: string): boolean {
  if (OTHER_UNIT_PROPERTIES.has(key)) return false
  const end = value.indexOf('=')
  return !PROPERTY_KEYS.has(key) || (end > 0 && ALLOWED_PROPERTIES.has(value.slice(0, end)))
}

const DOAS: OptionTable = {
  shortValue: 'aCu',
  shortFlag: 'Ln',
  shortShell: 's',
  longValue: new Set(),
  longFlag: new Set(),
  longShell: new Set(),
  gluedLong: true,
  bareShell: false,
}

const RUN0: OptionTable = {
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
  gluedLong: true,
  bareShell: true,
  allows: allowedProperty,
}

const SYSTEMD_RUN: OptionTable = {
  shortValue: 'HMEpu',
  shortFlag: 'hrtTPqvGdR',
  shortShell: 'S',
  longValue: new Set([
    ...['--host', '--machine', '--unit', '--property', '--description', '--slice'],
    ...['--expand-environment', '--service-type', '--uid', '--gid', '--nice', '--working-directory'],
    ...['--root-directory', '--setenv', '--json', '--job-mode', '--background', '--path-property'],
    ...['--socket-property', '--timer-property', '--on-active', '--on-boot', '--on-startup'],
    ...['--on-unit-active', '--on-unit-inactive', '--on-calendar'],
  ]),
  longFlag: new Set([
    ...['--help', '--version', '--no-ask-password', '--user', '--system', '--scope', '--slice-inherit'],
    ...['--no-block', '--remain-after-exit', '--wait', '--send-sighup', '--same-dir', '--same-root-dir'],
    ...['--pty', '--pty-late', '--pipe', '--quiet', '--verbose', '--collect', '--ignore-failure'],
    ...['--no-pager', '--on-timezone-change', '--on-clock-change'],
  ]),
  longShell: new Set(['--shell']),
  gluedLong: true,
  bareShell: false,
  allows: allowedProperty,
  read: readSystemdRun,
}

const PKEXEC: OptionTable = {
  shortValue: '',
  shortFlag: '',
  shortShell: '',
  longValue: new Set(['--user']),
  longFlag: new Set(['--keep-cwd', '--disable-internal-agent', '--help', '--version']),
  longShell: new Set(),
  gluedLong: false,
  bareShell: true,
}

const SU: OptionTable = {
  shortValue: 'cgGsw',
  shortFlag: 'lfmpPThV',
  shortShell: '',
  longValue: new Set([
    '--command',
    '--session-command',
    '--shell',
    '--group',
    '--supp-group',
    '--whitelist-environment',
  ]),
  longFlag: new Set([
    '--login',
    '--fast',
    '--preserve-environment',
    '--pty',
    '--no-pty',
    '--help',
    '--version',
  ]),
  longShell: new Set(),
  gluedLong: true,
  bareShell: true,
  read: readSu,
}

/** sudo-rs's su: util-linux su's words less -f, -T and --session-command, which it refuses. */
const SU_RS: OptionTable = {
  ...SU,
  shortFlag: 'lmpPhV',
  longValue: new Set(['--command', '--shell', '--group', '--supp-group', '--whitelist-environment']),
  longFlag: new Set(['--login', '--preserve-environment', '--pty', '--help', '--version']),
}

const RUNUSER: OptionTable = {
  ...SU,
  shortValue: `${SU.shortValue}u`,
  longValue: new Set([...SU.longValue, '--user']),
  read: readRunuser,
}

const SETPRIV: OptionTable = {
  shortValue: '',
  shortFlag: 'dhV',
  shortShell: '',
  longValue: new Set([
    ...['--ambient-caps', '--inh-caps', '--bounding-set', '--ruid', '--euid', '--rgid', '--egid'],
    ...['--reuid', '--regid', '--groups', '--securebits', '--pdeathsig', '--ptracer', '--selinux-label'],
    ...['--apparmor-profile', '--landlock-access', '--landlock-rule', '--seccomp-filter'],
  ]),
  longFlag: new Set([
    ...['--dump', '--nnp', '--no-new-privs', '--clear-groups', '--keep-groups', '--init-groups'],
    ...['--reset-env', '--help', '--version'],
  ]),
  longShell: new Set(),
  gluedLong: true,
  bareShell: false,
}

const MACHINECTL: OptionTable = {
  shortValue: 'psHMnoE',
  shortFlag: 'halqV',
  shortShell: '',
  longValue: new Set([
    ...['--property', '--signal', '--kill-whom', '--host', '--machine', '--lines', '--output'],
    ...['--setenv', '--uid', '--format', '--max-addresses', '--verify'],
  ]),
  longFlag: new Set([
    ...['--help', '--version', '--no-pager', '--no-legend', '--no-ask-password', '--value', '--all'],
    ...['--full', '--quiet', '--read-only', '--mkdir', '--force', '--now'],
  ]),
  longShell: new Set(),
  gluedLong: true,
  bareShell: false,
  read: readMachinectl,
}

/** Every name of each user-switching binary, sudo's aside. */
export const PRIVILEGE_OPTIONS: ReadonlyMap<string, OptionTable> = new Map([
  ['doas', DOAS],
  ['run0', RUN0],
  ['systemd-run', SYSTEMD_RUN],
  ['pkexec', PKEXEC],
  ['su', SU],
  ['su-rs', SU_RS],
  ['runuser', RUNUSER],
  ['setpriv', SETPRIV],
  ['machinectl', MACHINECTL],
])

export const PRIVILEGE_WRAPPERS: ReadonlySet<string> = new Set(PRIVILEGE_OPTIONS.keys())

/** The names sudo is installed under: sudo-rs's own, and sudo.ws beside it where sudo-rs is the default. */
export const SUDO_NAMES: ReadonlySet<string> = new Set(['sudo', 'sudo-rs', 'sudo.ws'])

/** What `name` (one of PRIVILEGE_WRAPPERS) runs when its options start at `words[i]`. */
export function dropPrivilegeOptions(
  name: string,
  words: readonly string[],
  i: number,
): PrivilegeRun | undefined {
  const table = PRIVILEGE_OPTIONS.get(name)
  if (table === undefined) return undefined
  const run = (table.read ?? readGetopt)(table, words, i)
  // The shell argv is new words the caller cannot trace back to a quoted or split word, so none may be expanded.
  return run !== undefined && 'shell' in run && run.shell.some(word => word.includes(LIVE)) ? undefined : run
}

/** A shell run on the words joined, each character but alnum, _, - and $ escaped, as sudo -s does. */
const joinedShell = (words: readonly string[]): string[] =>
  words.length === 0 ? ['sh'] : ['sh', '-c', words.map(w => w.replace(/[^A-Za-z0-9_$-]/g, '\\$&')).join(' ')]

/** One option: the words after it its value takes, its letter or long name, and its value. */
interface Option {
  width: number
  key: string
  value?: string
  shell: boolean
}

/** The option at `words[i]`, or undefined when it is unknown, lacks its value, or holds an expansion. */
function readOption(t: OptionTable, words: readonly string[], i: number): Option | undefined {
  const a = words[i] as string
  const option = a.startsWith('--') ? longOption(t, a) : shortCluster(t, a)
  if (option === undefined || a.includes(LIVE)) return undefined
  const value = option.width === 0 ? option.value : words[i + 1]
  if (option.width > 0 && (value === undefined || value.includes(LIVE))) return undefined
  if (value === undefined) return option
  return t.allows === undefined || t.allows(option.key, value) ? { ...option, value } : undefined
}

function longOption(t: OptionTable, option: string): Option | undefined {
  const [key, ...rest] = option.split('=') as [string, ...string[]]
  const glued = rest.length > 0
  if (t.longValue.has(key)) {
    if (!glued) return { width: 1, key, shell: false }
    return t.gluedLong ? { width: 0, key, value: rest.join('='), shell: false } : undefined
  }
  if (glued) return undefined
  if (t.longFlag.has(key)) return { width: 0, key, shell: false }
  if (t.longShell.has(key)) return { width: 0, key, shell: true }
  return undefined
}

/** A short cluster's first value letter takes the rest of the cluster, or the next word when it ends it. */
function shortCluster(t: OptionTable, cluster: string): Option | undefined {
  let shell = false
  for (let k = 1; k < cluster.length; k++) {
    const key = cluster[k] as string
    if (t.shortValue.includes(key)) {
      const last = k === cluster.length - 1
      return last ? { width: 1, key, shell } : { width: 0, key, value: cluster.slice(k + 1), shell }
    }
    if (t.shortShell.includes(key)) shell = true
    else if (!t.shortFlag.includes(key)) return undefined
  }
  return cluster.length > 1 ? { width: 0, key: cluster, shell } : undefined
}

/** A getopt reader that stops at the first operand, as doas's `+` and run0's option strings do. */
function readGetopt(t: OptionTable, words: readonly string[], i: number): PrivilegeRun | undefined {
  let shell = false
  for (; i < words.length; i++) {
    const a = words[i] as string
    if (a === '--') {
      i++
      break
    }
    if (!a.startsWith('-') || a === '-') break
    const option = readOption(t, words, i)
    if (option === undefined) return undefined
    shell ||= option.shell
    i += option.width
  }
  if (shell || (t.bareShell && i >= words.length)) return { shell: joinedShell(words.slice(i)) }
  return { at: i }
}

/**
 * systemd-run expands `$NAME` and `${NAME}` in the command from the unit's environment, which `-E`
 * sets, so a word holding `$` may be any word, quoted or not.
 */
function readSystemdRun(t: OptionTable, words: readonly string[], i: number): PrivilegeRun | undefined {
  return words.slice(i).some(word => word.includes('$')) ? undefined : readGetopt(t, words, i)
}

/**
 * machinectl permutes its options, except that for `shell` it stops at the machine name and hands
 * every later word to the command. Any other verb runs no command, so its words are left as they are.
 */
function readMachinectl(t: OptionTable, words: readonly string[], i: number): PrivilegeRun | undefined {
  const verb = nextOperand(t, words, i, false)
  if (verb === undefined || words[verb.at] !== 'shell') return verb === undefined ? undefined : { at: verb.at }
  const host = nextOperand(t, words, verb.at + 1, verb.ended)
  if (host === undefined) return undefined
  return host.at + 1 >= words.length ? { shell: ['sh'] } : { at: host.at + 1 }
}

interface Operand {
  at: number
  /** Whether a `--` ended the options, so every later word is an operand. */
  ended: boolean
}

/** The first operand at or after `words[i]`, past the options, or undefined when one cannot be read. */
function nextOperand(t: OptionTable, words: readonly string[], i: number, ended: boolean): Operand | undefined {
  for (; i < words.length; i++) {
    const a = words[i] as string
    if (a.includes(LIVE)) return undefined
    if (ended || !a.startsWith('-') || a === '-') return { at: i, ended }
    if (a === '--') return nextOperand(t, words, i + 1, true)
    const option = readOption(t, words, i)
    if (option === undefined) return undefined
    i += option.width
  }
  return { at: i, ended }
}

const SU_KEYS: ReadonlyMap<string, string> = new Map([
  ['--command', 'c'],
  ['--session-command', 'c'],
  ['--shell', 's'],
  ['--user', 'u'],
])
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])

/**
 * util-linux su permutes, so options after the user still count. Its first operand is the user and
 * the rest are arguments to the shell, which runs -c's value when one is given.
 */
function readSu(t: OptionTable, words: readonly string[], i: number): PrivilegeRun | undefined {
  const read = readSuWords(t, words, i)
  return read === undefined ? undefined : suShell(read.values, read.operands.slice(1))
}

/** runuser reads su's words; with -u its operands are the command, run with no shell, and -c and -s clash with -u. */
function readRunuser(t: OptionTable, words: readonly string[], i: number): PrivilegeRun | undefined {
  const read = readSuWords(t, words, i)
  if (read === undefined) return undefined
  const { values, operands } = read
  if (!values.has('u')) return suShell(values, operands.slice(1))
  return values.has('c') || values.has('s') ? undefined : { shell: joinedShell(operands) }
}

interface SuWords {
  values: ReadonlyMap<string, string>
  operands: readonly string[]
}

function readSuWords(t: OptionTable, words: readonly string[], i: number): SuWords | undefined {
  const values = new Map<string, string>()
  const operands: string[] = []
  for (; i < words.length; i++) {
    const a = words[i] as string
    // An expanded word may split into a user and a -c script (`su -- $E`), even after `--`, where su takes the user from it.
    if (a === '--') {
      const rest = words.slice(i + 1)
      if (rest.some(word => word.includes(LIVE))) return undefined
      for (const operand of rest) operands.push(operand)
      break
    }
    // An expanded word may be an option wherever it sits, since su reads options past the user.
    if (a.includes(LIVE)) return undefined
    if (!a.startsWith('-') || a === '-') {
      if (a !== '-') operands.push(a)
      continue
    }
    const option = readOption(t, words, i)
    if (option === undefined) return undefined
    if (option.value !== undefined) values.set(SU_KEYS.get(option.key) ?? option.key, option.value)
    i += option.width
  }
  return { values, operands }
}

function suShell(values: ReadonlyMap<string, string>, args: readonly string[]): PrivilegeRun | undefined {
  const shell = values.get('s')
  if (shell !== undefined && !SHELLS.has(shell.split('/').pop() as string)) return undefined
  const command = values.get('c')
  return { shell: command === undefined ? ['sh', ...args] : ['sh', '-c', command, ...args] }
}
