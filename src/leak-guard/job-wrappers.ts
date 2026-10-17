/**
 * Reads util-linux's setsid, flock, taskset, chrt, script and unshare (CC-1414), which run a
 * command they are given. Pure: words come in marked (LIVE before what the shell expands).
 * Option tables are from util-linux 2.41. Unlike the guard's other getopt wrappers, an option
 * missing from a table fails closed, since these programs gain options between releases.
 */

import { LIVE } from './shell-words.js'

interface StrictGetopt {
  /** Short letters that take the rest of the word or the next word as their value. */
  value: string
  /** Short letters that take only a value glued to them, as script's `-t[file]`. */
  glued?: string
  flag: string
  /** Each long name, with whether it takes a value as the next word. */
  long: Readonly<Record<string, boolean>>
  /** getopt permutes, so operands may come before options (script). */
  permute?: boolean
}

const flags = (...names: string[]): Record<string, boolean> => Object.fromEntries(names.map(n => [n, false]))
const values = (...names: string[]): Record<string, boolean> => Object.fromEntries(names.map(n => [n, true]))

const GETOPTS: Readonly<Record<string, StrictGetopt>> = {
  setsid: { value: '', flag: 'cfwhV', long: flags('ctty', 'fork', 'wait', 'help', 'version') },
  flock: {
    value: 'wE',
    flag: 'sexunoFhV',
    long: {
      ...flags('shared', 'exclusive', 'unlock', 'nonblocking', 'nonblock', 'nb', 'close', 'no-fork'),
      ...flags('fcntl', 'verbose', 'help', 'version'),
      ...values('timeout', 'wait', 'conflict-exit-code'),
    },
  },
  taskset: { value: '', flag: 'apchV', long: flags('all-tasks', 'pid', 'cpu-list', 'help', 'version') },
  chrt: {
    value: 'TPD',
    flag: 'bdfiorRamphvV',
    long: {
      ...flags('batch', 'deadline', 'fifo', 'idle', 'other', 'rr', 'reset-on-fork', 'all-tasks', 'max'),
      ...flags('pid', 'verbose', 'help', 'version'),
      ...values('sched-runtime', 'sched-period', 'sched-deadline'),
    },
  },
  script: {
    value: 'IOBTmcEo',
    glued: 't',
    flag: 'aefqhV',
    long: {
      ...flags('append', 'return', 'flush', 'force', 'quiet', 'timing', 'help', 'version'),
      ...values('log-in', 'log-out', 'log-io', 'log-timing', 'logging-format', 'command', 'echo'),
      ...values('output-limit'),
    },
    permute: true,
  },
  unshare: {
    value: 'RwSGl',
    flag: 'muinpUCTrcfhV',
    long: {
      ...flags('mount', 'uts', 'ipc', 'net', 'pid', 'user', 'cgroup', 'time', 'mount-proc', 'mount-binfmt'),
      ...flags('map-root-user', 'map-current-user', 'map-auto', 'fork', 'kill-child', 'keep-caps'),
      ...flags('help', 'version'),
      ...values('load-interp', 'propagation', 'root', 'wd', 'setuid', 'setgid', 'map-user', 'map-group'),
      ...values('map-users', 'map-groups', 'owner', 'setgroups', 'monotonic', 'boottime'),
    },
  },
}

export const JOB_WRAPPERS: ReadonlySet<string> = new Set(Object.keys(GETOPTS))

/** One option as getopt reads it: a short letter or a full long name, and its value. */
interface Option {
  name: string
  value?: string
}

interface Parsed {
  options: Option[]
  /** Where the operands start; for a permuting getopt, the words left after `--`. */
  end: number
}

/**
 * The words a wrapper runs from `at`, or a `-c` string it runs through `$SHELL -c` (`script`
 * undefined: an interactive shell, which reads stdin). Undefined on an option the table lacks
 * or an option word the shell expands. `chdir` is set when the command may run elsewhere.
 */
export type JobRun = { at: number; chdir?: boolean } | { script: string | undefined; chdir?: boolean }

export function jobRun(words: readonly string[], i: number, name: string): JobRun | undefined {
  const spec = GETOPTS[name] as StrictGetopt
  const parsed = readOptions(words, i, spec)
  if (parsed === undefined) return undefined
  const { options, end } = parsed
  if (name === 'script') return { script: options.filter(o => o.name === 'command').at(-1)?.value }
  if (name === 'unshare')
    return end < words.length ? { at: end, chdir: true } : { script: undefined, chdir: true }
  if (name === 'setsid') return { at: end }
  return afterOperand(words, end, name)
}

const CHRT_PRIORITY = /^\s*[+-]?\d+$/

/**
 * flock, taskset and chrt take one operand before the command: a lock file, a CPU mask, a
 * priority. With -p the pid is the last word, and pid 0 runs the command, so -p reads the same.
 * A word the shell expands may be none or several, so the command may start at it or after it.
 */
function afterOperand(words: readonly string[], end: number, name: string): JobRun | undefined {
  const operand = words[end]
  if (operand === undefined) return { at: end }
  const script = name === 'flock' ? flockScript(words[end + 1], words[end + 2]) : null
  if (script !== null) return script
  // Reading only the operand as the command would leave the words after it unread.
  if (operand.includes(LIVE)) return undefined
  // chrt reads the priority with strtoimax; a version that drops it for SCHED_OTHER would run any other word.
  if (name === 'chrt' && !CHRT_PRIORITY.test(operand)) return { at: end }
  return { at: end + 1 }
}

/** The text after flock's `-c`, whatever its lock file; null when no `-c` follows the file. */
function flockScript(flag: string | undefined, next: string | undefined): JobRun | undefined | null {
  const glued = flag?.startsWith('--command=') === true ? flag.slice('--command='.length) : undefined
  if (glued === undefined && flag !== '-c' && flag !== '--command') return null
  const script = glued ?? next ?? ''
  // Like script's -c value, text the shell expands cannot be read as a script.
  return script.includes(LIVE) ? undefined : { script }
}

function readOptions(words: readonly string[], i: number, spec: StrictGetopt): Parsed | undefined {
  const options: Option[] = []
  for (; i < words.length; i++) {
    const word = words[i] as string
    if (word === '--') return { options, end: i + 1 }
    if (!word.startsWith('-') || word === '-') {
      // A permuting getopt reads options anywhere, and an expanded operand may be one.
      if (spec.permute === true && word.includes(LIVE)) return undefined
      if (spec.permute === true) continue
      return { options, end: i }
    }
    if (word.includes(LIVE)) return undefined
    const read = word.startsWith('--') ? longOption(word.slice(2), spec) : cluster(word.slice(1), spec)
    if (read === undefined) return undefined
    for (const option of read.options) options.push(option)
    if (read.next) {
      const value = words[++i] ?? ''
      // The shell may split an expanded value into words that move the operands.
      if (value.includes(LIVE)) return undefined
      options.push({ name: read.next, value })
    }
  }
  return { options, end: words.length }
}

/** An option read from one word; `next` names the option that takes the following word. */
interface Read {
  options: Option[]
  next?: string
}

/** A long name as getopt_long resolves it: exact, or a prefix of exactly one name. */
function longOption(body: string, spec: StrictGetopt): Read | undefined {
  const eq = body.indexOf('=')
  const given = eq < 0 ? body : body.slice(0, eq)
  const names = given in spec.long ? [given] : Object.keys(spec.long).filter(n => n.startsWith(given))
  const name = names[0]
  if (given === '' || name === undefined || names.length > 1) return undefined
  if (eq >= 0) return { options: [{ name, value: body.slice(eq + 1) }] }
  return spec.long[name] === true ? { options: [], next: name } : { options: [{ name }] }
}

const LONG_OF: Readonly<Record<string, string>> = { c: 'command', p: 'pid' }

function cluster(letters: string, spec: StrictGetopt): Read | undefined {
  const options: Option[] = []
  for (let k = 0; k < letters.length; k++) {
    const letter = letters[k] as string
    const name = LONG_OF[letter] ?? letter
    const rest = letters.slice(k + 1)
    if (spec.value.includes(letter))
      return rest === '' ? { options, next: name } : { options: [...options, { name, value: rest }] }
    if (spec.glued?.includes(letter) === true) return { options: [...options, { name, value: rest }] }
    if (!spec.flag.includes(letter)) return undefined
    options.push({ name })
  }
  return { options }
}
